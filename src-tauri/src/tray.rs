// 系统托盘：自绘 Win32 实现（Shell_NotifyIconW + 隐藏顶层窗口 + 动态右键菜单）。
//
// v0.0.4 起不再依赖 tauri tray-icon 的注册逻辑（其构造 NOTIFYICONDATAW 时未显式设置 cbSize，
// 且受限 token 下 NIM_ADD 失败会被静默忽略，用户看不到任何托盘图标）：
// - 专用线程 + 隐藏顶层窗口（不是 HWND_MESSAGE，才能接收 Explorer 的 TaskbarCreated 广播）
// - Shell_NotifyIconW(NIM_ADD) 显式设置 cbSize / uFlags / hIcon / uCallbackMessage / szTip
// - 注册失败记录 Windows 错误文本，1 秒重试、最多 15 秒；仍失败则 available=false（程序继续运行）
// - 右键菜单每次弹出时按当前配置动态构建（网页版管理开启时才出现「打开管理界面/重启管理界面」）
use std::ffi::c_void;
use std::mem::size_of;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde_json::json;
use windows::core::{w, HSTRING};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::{
  Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
};
use windows::Win32::UI::WindowsAndMessaging::{
  AppendMenuW, CreateIconFromResourceEx, CreatePopupMenu, CreateWindowExW, DefWindowProcW,
  DestroyIcon, DestroyMenu, DispatchMessageW, GetCursorPos, GetMessageW, PostMessageW,
  PostQuitMessage, RegisterClassW, RegisterWindowMessageW, SetForegroundWindow, TrackPopupMenu,
  TranslateMessage, HICON, HMENU, LR_DEFAULTCOLOR, MF_SEPARATOR, MF_STRING, MSG,
  TPM_LEFTALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_APP, WM_DESTROY, WM_LBUTTONUP, WM_NULL,
  WM_RBUTTONUP, WNDCLASSW, WNDCLASS_STYLES, WS_POPUP,
};
use windows::Win32::UI::WindowsAndMessaging::WINDOW_EX_STYLE;

use tauri::{AppHandle, Manager};

use crate::state::{self, AppState};
use crate::{logging, node_proc, window, winutil};

pub const TRAY_ID: &str = "main-tray";
pub const MENU_OPEN: &str = "tray-open";
pub const MENU_HIDE: &str = "tray-hide";
pub const MENU_OPEN_WEBADMIN: &str = "tray-open-webadmin";
pub const MENU_RESTART_WEBADMIN: &str = "tray-restart-webadmin";
pub const MENU_RESTART_REGISTRY: &str = "tray-restart-registry";
pub const MENU_QUIT: &str = "tray-quit";

/// 托盘回调消息：WM_APP + 1（隐藏窗口收到鼠标事件）
const WM_TRAY_CALLBACK: u32 = WM_APP + 1;
/// 托盘图标 id
const TRAY_UID: u32 = 1;
/// 注册失败重试：每秒一次、最多 15 秒
const REGISTER_RETRY_SECS: u32 = 15;

static TRAY_APP: OnceLock<AppHandle> = OnceLock::new();
static TRAY_HWND: AtomicIsize = AtomicIsize::new(0);
static TRAY_ICON_HANDLE: AtomicIsize = AtomicIsize::new(0);
static TASKBAR_CREATED_MSG: AtomicU32 = AtomicU32::new(0);
static REGISTER_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// 最近一次构建的菜单项文本（启动失败报告/冒烟证据用，无需 AppHandle）。
static LAST_LABELS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// 内嵌程序图标（v0.0.4 起与网页版图标 public/favicon.ico 完全一致，由
/// tools/compose-desktop-icon.ps1 逐字节复制生成），用于从其中解析 HICON。
static ICON_ICO: &[u8] = include_bytes!("../icons/icon.ico");

/// 读取最近一次托盘菜单文本（报告/诊断用）。
pub fn labels_snapshot() -> Vec<String> {
  LAST_LABELS
    .lock()
    .map(|guard| guard.clone())
    .unwrap_or_default()
}

/// 网页版管理是否开启（与 config_watch 实时刷新一致：config.admin.enabled 或 Node 桥报告已开启）。
fn menu_enabled(app: &AppHandle) -> bool {
  let state = app.state::<AppState>();
  state.config_snapshot().admin_enabled || state.web_admin_snapshot().enabled
}

/// 初始化托盘：启动专用线程创建隐藏窗口并注册图标。
/// 隐藏窗口创建失败返回 Err（启动失败路径）；图标注册失败不阻塞启动（异步重试 + available=false）。
pub fn init(app: &AppHandle) -> Result<(), String> {
  update_labels(app, menu_enabled(app));
  let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
  let app_clone = app.clone();
  thread::spawn(move || tray_thread(app_clone, ready_tx));
  match ready_rx.recv_timeout(Duration::from_secs(5)) {
    Ok(Ok(())) => Ok(()),
    Ok(Err(err)) => Err(err),
    Err(_) => Err("托盘线程启动超时（5 秒内未创建隐藏窗口）".to_string()),
  }
}

fn tray_thread(app: AppHandle, ready_tx: Sender<Result<(), String>>) {
  // 全局保存 AppHandle，消息回调里需要窗口/退出等操作
  let _ = TRAY_APP.set(app.clone());

  // Explorer 的 TaskbarCreated 广播消息号（必须在创建窗口前注册）
  let taskbar_msg = unsafe { RegisterWindowMessageW(w!("TaskbarCreated")) };
  TASKBAR_CREATED_MSG.store(taskbar_msg, Ordering::SeqCst);

  let hwnd = match create_hidden_window() {
    Ok(hwnd) => hwnd,
    Err(err) => {
      let _ = ready_tx.send(Err(err));
      return;
    }
  };
  TRAY_HWND.store(hwnd.0 as isize, Ordering::SeqCst);
  let _ = ready_tx.send(Ok(()));

  // 首次注册：成功则直接可用；失败则记录原因并启动 1 秒间隔的后台重试
  match try_add_icon(&app) {
    Ok(()) => {}
    Err(err) => {
      logging::warn(format!(
        "托盘图标首次注册失败：{err}；1 秒后开始重试（最多 {REGISTER_RETRY_SECS} 秒）"
      ));
      register_with_retries(app.clone());
    }
  }

  // 消息循环：处理托盘鼠标事件、TaskbarCreated 广播
  let mut msg = MSG::default();
  loop {
    let ret = unsafe { GetMessageW(&mut msg, None, 0, 0) };
    if ret.0 <= 0 {
      break;
    }
    unsafe {
      let _ = TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
  }
}

fn create_hidden_window() -> Result<HWND, String> {
  unsafe {
    let module = GetModuleHandleW(None)
      .map_err(|err| format!("获取模块句柄失败（GetModuleHandleW）：{}", err.message()))?;
    let instance = HINSTANCE(module.0);
    let class_name = w!("LiYueNpmMirrorTrayWindow");

    let wc = WNDCLASSW {
      style: WNDCLASS_STYLES(0),
      lpfnWndProc: Some(wnd_proc),
      hInstance: instance,
      lpszClassName: class_name,
      ..Default::default()
    };
    let atom = RegisterClassW(&wc);
    if atom == 0 {
      let err = std::io::Error::last_os_error();
      // 1410 = ERROR_CLASS_ALREADY_EXISTS：同进程重复初始化时可直接复用
      if err.raw_os_error() != Some(1410) {
        return Err(format!("注册托盘窗口类失败（RegisterClassW）：{err}"));
      }
    }

    let hwnd = CreateWindowExW(
      WINDOW_EX_STYLE::default(),
      class_name,
      w!("LiYueNpmMirrorTrayWindow"),
      WS_POPUP,
      0,
      0,
      0,
      0,
      None,
      None,
      Some(instance),
      None,
    )
    .map_err(|err| format!("创建托盘隐藏窗口失败（CreateWindowExW）：{}", err.message()))?;
    Ok(hwnd)
  }
}

unsafe extern "system" fn wnd_proc(
  hwnd: HWND,
  msg: u32,
  wparam: WPARAM,
  lparam: LPARAM,
) -> LRESULT {
  let taskbar_created = TASKBAR_CREATED_MSG.load(Ordering::SeqCst);
  if taskbar_created != 0 && msg == taskbar_created {
    logging::info("收到 TaskbarCreated 广播：重新注册托盘图标");
    if let Some(app) = TRAY_APP.get() {
      register_with_retries(app.clone());
    }
    return LRESULT(0);
  }
  if msg == WM_TRAY_CALLBACK {
    let mouse_message = (lparam.0 & 0xFFFF) as u32;
    if let Some(app) = TRAY_APP.get() {
      match mouse_message {
        WM_LBUTTONUP => {
          logging::info("托盘左键单击：显示主窗口");
          run_on_main(app, |app| window::show(app));
        }
        WM_RBUTTONUP => {
          show_context_menu(app, hwnd);
        }
        _ => {}
      }
    }
    return LRESULT(0);
  }
  if msg == WM_DESTROY {
    PostQuitMessage(0);
    return LRESULT(0);
  }
  DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn run_on_main(app: &AppHandle, action: impl FnOnce(&AppHandle) + Send + 'static) {
  let app_clone = app.clone();
  if let Err(err) = app.run_on_main_thread(move || action(&app_clone)) {
    logging::warn(format!("切换到主线程执行窗口操作失败：{err}"));
  }
}

// ---------------------------------------------------------------- 托盘注册

/// 解析内嵌 icon.ico，按 32 → 48 → 256 顺序查找帧并创建 HICON。
fn load_tray_icon() -> Result<HICON, String> {
  if ICON_ICO.len() < 6 {
    return Err("内嵌 icon.ico 数据过小".to_string());
  }
  let reserved = u16::from_le_bytes([ICON_ICO[0], ICON_ICO[1]]);
  let icon_type = u16::from_le_bytes([ICON_ICO[2], ICON_ICO[3]]);
  let count = u16::from_le_bytes([ICON_ICO[4], ICON_ICO[5]]) as usize;
  if reserved != 0 || icon_type != 1 || count == 0 {
    return Err(format!(
      "内嵌 icon.ico 不是有效 ICO（reserved={reserved} type={icon_type} count={count}）"
    ));
  }

  struct Frame {
    width: usize,
    height: usize,
    offset: usize,
    size: usize,
  }
  let mut frames = Vec::with_capacity(count);
  for index in 0..count {
    let base = 6 + index * 16;
    if base + 16 > ICON_ICO.len() {
      return Err(format!("内嵌 icon.ico 目录越界（帧 {index}）"));
    }
    // ICO 目录里 0 表示 256
    let width = if ICON_ICO[base] == 0 { 256 } else { ICON_ICO[base] as usize };
    let height = if ICON_ICO[base + 1] == 0 { 256 } else { ICON_ICO[base + 1] as usize };
    let size = u32::from_le_bytes([
      ICON_ICO[base + 8],
      ICON_ICO[base + 9],
      ICON_ICO[base + 10],
      ICON_ICO[base + 11],
    ]) as usize;
    let offset = u32::from_le_bytes([
      ICON_ICO[base + 12],
      ICON_ICO[base + 13],
      ICON_ICO[base + 14],
      ICON_ICO[base + 15],
    ]) as usize;
    if offset + size > ICON_ICO.len() {
      return Err(format!("内嵌 icon.ico 帧越界（{width}x{height}）"));
    }
    frames.push(Frame {
      width,
      height,
      offset,
      size,
    });
  }

  let mut errors: Vec<String> = Vec::new();
  for wanted in [32usize, 48, 256] {
    let frame = frames.iter().find(|frame| frame.width == wanted);
    let Some(frame) = frame else {
      continue;
    };
    let bytes = &ICON_ICO[frame.offset..frame.offset + frame.size];
    match unsafe {
      CreateIconFromResourceEx(bytes, true, 0x0003_0000, 0, 0, LR_DEFAULTCOLOR)
    } {
      Ok(icon) => {
        logging::info(format!(
          "托盘图标 HICON 已创建：使用内嵌 icon.ico 中 {}x{} 帧（{size} 字节）",
          frame.width,
          frame.height,
          size = frame.size
        ));
        return Ok(icon);
      }
      Err(err) => errors.push(format!(
        "{}x{} 帧失败：{}",
        frame.width,
        frame.height,
        err.message()
      )),
    }
  }
  Err(format!(
    "从内嵌 icon.ico 创建托盘图标失败（{}）",
    if errors.is_empty() {
      "找不到 32/48/256 帧".to_string()
    } else {
      errors.join("；")
    }
  ))
}

/// 尝试注册托盘图标；失败返回中文原因（含 Windows 错误码/文本）。
fn try_add_icon(app: &AppHandle) -> Result<(), String> {
  let hwnd_value = TRAY_HWND.load(Ordering::SeqCst);
  let state = app.state::<AppState>();
  state.mark_tray_attempted();
  if hwnd_value == 0 {
    let reason = "托盘隐藏窗口尚未创建".to_string();
    state.set_tray_available(false, reason.clone());
    return Err(reason);
  }
  let hwnd = HWND(hwnd_value as *mut c_void);
  let icon = match load_tray_icon() {
    Ok(icon) => icon,
    Err(err) => {
      state.set_tray_available(false, err.clone());
      return Err(err);
    }
  };
  TRAY_ICON_HANDLE.store(icon.0 as isize, Ordering::SeqCst);

  let tooltip = format!("{}（单击打开窗口）", state.product_name);
  let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
  data.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
  data.hWnd = hwnd;
  data.uID = TRAY_UID;
  data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
  data.uCallbackMessage = WM_TRAY_CALLBACK;
  data.hIcon = icon;
  let wide: Vec<u16> = tooltip.encode_utf16().take(127).collect();
  data.szTip[..wide.len()].copy_from_slice(&wide);

  let ok = unsafe { Shell_NotifyIconW(NIM_ADD, &data) };
  if ok.as_bool() {
    state.set_tray_available(true, String::new());
    logging::info(format!("托盘图标注册成功：{tooltip}"));
    Ok(())
  } else {
    let err = std::io::Error::last_os_error();
    let reason = format!(
      "Shell_NotifyIconW(NIM_ADD) 返回失败：{err}（GetLastError={:?}）",
      err.raw_os_error()
    );
    state.set_tray_available(false, reason.clone());
    Err(reason)
  }
}

/// 启动后台重试线程：每 1 秒重试一次，最多 15 次；仍失败则记录「托盘注册失败：…」。
fn register_with_retries(app: AppHandle) {
  if REGISTER_IN_PROGRESS.swap(true, Ordering::SeqCst) {
    return;
  }
  thread::spawn(move || {
    let mut last_error = app
      .state::<AppState>()
      .tray_error_snapshot();
    for attempt in 1..=REGISTER_RETRY_SECS {
      thread::sleep(Duration::from_secs(1));
      match try_add_icon(&app) {
        Ok(()) => {
          logging::info(format!(
            "托盘图标注册成功（第 {attempt} 次重试，共重试 {REGISTER_RETRY_SECS} 秒窗口内）"
          ));
          REGISTER_IN_PROGRESS.store(false, Ordering::SeqCst);
          return;
        }
        Err(err) => last_error = err,
      }
    }
    let state = app.state::<AppState>();
    state.set_tray_available(false, last_error.clone());
    logging::error(format!(
      "托盘注册失败：{last_error}（重试 {REGISTER_RETRY_SECS} 次仍失败，程序继续运行；托盘菜单可通过主窗口/网页版管理界面操作）"
    ));
    REGISTER_IN_PROGRESS.store(false, Ordering::SeqCst);
  });
}

/// 退出前清理托盘图标与 HICON（主线程 RunEvent::Exit 调用，任意线程可执行）。
pub fn shutdown() {
  let hwnd_value = TRAY_HWND.load(Ordering::SeqCst);
  if hwnd_value != 0 {
    let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    data.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
    data.hWnd = HWND(hwnd_value as *mut c_void);
    data.uID = TRAY_UID;
    unsafe {
      let _ = Shell_NotifyIconW(NIM_DELETE, &data);
    }
  }
  let icon_value = TRAY_ICON_HANDLE.swap(0, Ordering::SeqCst);
  if icon_value != 0 {
    unsafe {
      let _ = DestroyIcon(HICON(icon_value as *mut c_void));
    }
  }
  logging::info("托盘图标已清理（NIM_DELETE）");
}

// ---------------------------------------------------------------- 右键菜单

fn show_context_menu(app: &AppHandle, hwnd: HWND) {
  let enabled = menu_enabled(app);
  let menu = match unsafe { CreatePopupMenu() } {
    Ok(menu) => menu,
    Err(err) => {
      logging::warn(format!("创建托盘右键菜单失败：{}", err.message()));
      return;
    }
  };
  unsafe {
    append_item(menu, 1, "打开窗口");
    append_item(menu, 2, "关闭窗口");
    append_separator(menu);
    if enabled {
      append_item(menu, 3, "打开管理界面");
      append_item(menu, 4, "重启管理界面");
    }
    append_item(menu, 5, "重启镜像源服务");
    append_separator(menu);
    append_item(menu, 6, "退出程序");
  }

  let mut point = POINT::default();
  if unsafe { GetCursorPos(&mut point) }.is_err() {
    logging::warn("获取鼠标位置失败，托盘右键菜单在默认位置弹出");
  }
  unsafe {
    let _ = SetForegroundWindow(hwnd);
    let result = TrackPopupMenu(
      menu,
      TPM_RETURNCMD | TPM_LEFTALIGN | TPM_RIGHTBUTTON,
      point.x,
      point.y,
      None,
      hwnd,
      None,
    );
    // 让菜单正常关闭（TrackPopupMenu 的经典要求）
    let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
    let _ = DestroyMenu(menu);
    let command = result.0 as u32;
    if command > 0 {
      let id = match command {
        1 => MENU_OPEN,
        2 => MENU_HIDE,
        3 => MENU_OPEN_WEBADMIN,
        4 => MENU_RESTART_WEBADMIN,
        5 => MENU_RESTART_REGISTRY,
        6 => MENU_QUIT,
        _ => {
          logging::warn(format!("未知的托盘菜单命令 id：{command}"));
          return;
        }
      };
      handle_menu_action(app, id);
    }
  }
}

unsafe fn append_item(menu: HMENU, command: usize, text: &str) {
  let text = HSTRING::from(text);
  let _ = AppendMenuW(menu, MF_STRING, command, &text);
}

unsafe fn append_separator(menu: HMENU) {
  let empty = HSTRING::default();
  let _ = AppendMenuW(menu, MF_SEPARATOR, 0, &empty);
}

// ---------------------------------------------------------------- 菜单动作

/// 更新托盘菜单文本（4 项/6 项），供 config_watch 实时刷新与日志/报告核对。
fn update_labels(app: &AppHandle, web_admin_enabled: bool) {
  let mut labels = vec!["打开窗口".to_string(), "关闭窗口".to_string()];
  if web_admin_enabled {
    labels.push("打开管理界面".to_string());
    labels.push("重启管理界面".to_string());
  }
  labels.push("重启镜像源服务".to_string());
  labels.push("退出程序".to_string());
  let state = app.state::<AppState>();
  *state::lock(&state.tray_labels) = labels.clone();
  if let Ok(mut guard) = LAST_LABELS.lock() {
    *guard = labels;
  }
}

/// 网页版管理开/关变化时刷新托盘菜单状态（目标 <1 秒内出现/消失）。
/// 自绘菜单在每次右键时读取当前状态，这里只需更新文本缓存与日志。
pub fn rebuild(app: &AppHandle, web_admin_enabled: bool) -> Result<(), String> {
  update_labels(app, web_admin_enabled);
  logging::info(format!(
    "托盘菜单已刷新：{}「打开管理界面」「重启管理界面」",
    if web_admin_enabled {
      "已显示"
    } else {
      "已隐藏"
    }
  ));
  Ok(())
}

/// 供冒烟测试模拟点击托盘菜单项（语义与真实点击一致）。
pub fn activate_menu(app: &AppHandle, id: &str) {
  handle_menu_action(app, id);
}

fn handle_menu_action(app: &AppHandle, id: &str) {
  logging::info(format!("托盘菜单点击：{id}"));
  match id {
    MENU_OPEN => {
      node_proc::log_to_gui(app, "info", "托盘操作：打开窗口");
      run_on_main(app, |app| window::show(app));
    }
    MENU_HIDE => {
      node_proc::log_to_gui(app, "info", "托盘操作：关闭窗口");
      run_on_main(app, |app| window::hide(app));
    }
    MENU_RESTART_REGISTRY => {
      node_proc::log_to_gui(app, "info", "托盘操作：重启镜像源服务");
      let app = app.clone();
      thread::spawn(move || {
        if !node_proc::node_alive(&app) {
          logging::warn("Node 未运行：重启镜像源服务改为完整重启程序");
          node_proc::restart_app(&app);
          return;
        }
        match node_proc::send_cmd(
          &app,
          "restartRegistry",
          json!({}),
          Duration::from_secs(20),
        ) {
          Ok(value) => logging::info(format!("镜像源服务已重启：{value}")),
          Err(err) => {
            logging::error(format!("重启镜像源服务失败：{err}"));
            node_proc::log_to_gui(&app, "error", format!("重启镜像源服务失败：{err}"));
          }
        }
      });
    }
    MENU_OPEN_WEBADMIN => {
      node_proc::log_to_gui(app, "info", "托盘操作：打开管理界面");
      open_web_admin_panel(app);
    }
    MENU_RESTART_WEBADMIN => {
      node_proc::log_to_gui(app, "info", "托盘操作：重启管理界面");
      open_web_admin_panel(app);
    }
    MENU_QUIT => {
      node_proc::log_to_gui(app, "info", "托盘操作：退出程序");
      logging::info("托盘：退出程序");
      node_proc::shutdown_and_exit(app, 0);
    }
    other => logging::warn(format!("未知的托盘菜单 id：{other}")),
  }
}

/// 在浏览器打开网页版管理界面（「打开管理界面」与「重启管理界面」共用）：
/// 先向 Node 发 showWebAdmin 取现有地址；失败再发 restartWebAdmin 重建监听并取地址。
fn open_web_admin_panel(app: &AppHandle) {
  let app = app.clone();
  thread::spawn(move || {
    let mut url = match node_proc::send_cmd(
      &app,
      "showWebAdmin",
      json!({}),
      Duration::from_secs(20),
    ) {
      Ok(value) => value
        .get("url")
        .and_then(|value| value.as_str())
        .map(str::to_string),
      Err(err) => {
        logging::warn(format!("showWebAdmin 失败，改用 restartWebAdmin：{err}"));
        None
      }
    };
    if url.is_none() {
      match node_proc::send_cmd(
        &app,
        "restartWebAdmin",
        json!({}),
        Duration::from_secs(20),
      ) {
        Ok(value) => {
          if let Some(enabled) = value.get("enabled").and_then(|value| value.as_bool()) {
            app.state::<AppState>().update_web_admin(
              enabled,
              value
                .get("url")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            );
          }
          url = value
            .get("url")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        }
        Err(err) => logging::error(format!("重启管理界面失败：{err}")),
      }
    }
    match url {
      Some(url) => {
        if winutil::open_path(&url) {
          logging::info(format!("已在浏览器打开管理界面：{url}"));
        } else {
          logging::warn(format!("打开管理界面失败：{url}"));
        }
      }
      None => logging::warn("打开管理界面：Node 未返回可用地址"),
    }
  });
}
