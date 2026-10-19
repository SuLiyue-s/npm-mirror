// 主窗口管理：隐藏创建、Node ready 后导航、关闭=隐藏、标题与位置记忆
use std::sync::atomic::Ordering;
use std::sync::Mutex;

use tauri::image::Image;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::logging;
use crate::node_proc;
use crate::paths;
use crate::state::{self, AppState};

pub const WINDOW_LABEL: &str = "main";

// 由 tools/compose-desktop-icon.ps1 生成，纯 RGBA 字节（256x256）
static WINDOW_ICON: &[u8] = include_bytes!("../icons/window-256.rgba");

// 最近一次窗口动作（创建/显示/隐藏/导航/标题）的结果，供冒烟报告与日志诊断使用。
// 窗口 API 在 WebView2 初始化失败等异常下会返回 Err，这里显式记录错误而不是静默丢弃。
static LAST_WINDOW_ACTION: Mutex<Option<String>> = Mutex::new(None);

/// 主窗口创建/WebView2 可用性校验失败信息：用于非 smoke 模式的可操作提示框与 smoke 报告。
#[derive(Clone, Debug)]
pub struct WindowFailure {
  /// 失败类别（webview/window），写入冒烟报告
  pub kind: &'static str,
  /// 面向用户的简短原因
  pub reason: String,
  /// 底层错误详情（WebView2 的 runtime error 文本等）
  pub detail: String,
}

// 启动阶段窗口校验失败信息（smoke 模式继续运行时供报告读取；成功启动后保持 None）
static STARTUP_FAILURE: Mutex<Option<WindowFailure>> = Mutex::new(None);

fn set_startup_failure(failure: &WindowFailure) {
  if let Ok(mut guard) = STARTUP_FAILURE.lock() {
    *guard = Some(failure.clone());
  }
}

fn clear_startup_failure() {
  if let Ok(mut guard) = STARTUP_FAILURE.lock() {
    *guard = None;
  }
}

/// 读取启动阶段窗口失败信息（无失败返回 None）。
pub fn startup_failure() -> Option<WindowFailure> {
  STARTUP_FAILURE.lock().ok().and_then(|guard| guard.clone())
}

// 最近一次窗口校验状态快照：窗口创建失败时无法拿到 AppHandle 写详细报告，先记录关键字段。
static LAST_WINDOW_STATUS: Mutex<Option<serde_json::Value>> = Mutex::new(None);

fn record_status(patch: serde_json::Value) {
  if let Ok(mut guard) = LAST_WINDOW_STATUS.lock() {
    let mut merged = guard.take().unwrap_or_else(|| serde_json::json!({}));
    if let (Some(target), Some(extra)) = (merged.as_object_mut(), patch.as_object()) {
      for (key, value) in extra {
        target.insert(key.clone(), value.clone());
      }
    }
    *guard = Some(merged);
  }
}

/// 读取最近一次窗口校验状态快照（启动失败报告用）。
pub fn failure_snapshot() -> serde_json::Value {
  LAST_WINDOW_STATUS
    .lock()
    .ok()
    .and_then(|guard| guard.clone())
    .unwrap_or_else(|| serde_json::json!({}))
}

fn window_failure(kind: &'static str, reason: &str, detail: impl Into<String>) -> WindowFailure {
  let failure = WindowFailure {
    kind,
    reason: reason.to_string(),
    detail: detail.into(),
  };
  logging::error(format!(
    "窗口校验失败：kind={} reason={} detail={}",
    failure.kind, failure.reason, failure.detail
  ));
  set_startup_failure(&failure);
  failure
}


fn record_action(message: String) {
  logging::info(format!("窗口动作：{message}"));
  if let Ok(mut guard) = LAST_WINDOW_ACTION.lock() {
    *guard = Some(message);
  }
}

pub fn last_action() -> Option<String> {
  LAST_WINDOW_ACTION.lock().ok().and_then(|guard| guard.clone())
}

fn window_of(app: &AppHandle) -> Option<WebviewWindow> {
  app.get_webview_window(WINDOW_LABEL)
}

pub fn hwnd_of(app: &AppHandle) -> Option<isize> {
  window_of(app)
    .and_then(|webview_window| webview_window.hwnd().ok())
    .map(|hwnd| hwnd.0 as isize)
}

pub fn exists(app: &AppHandle) -> bool {
  window_of(app).is_some()
}

// 详细窗口诊断（供 --smoke-report 使用）：区分「窗口对象存在」与「窗口真的可用」
pub fn diagnostics(app: &AppHandle) -> serde_json::Value {
  let window = window_of(app);
  let created = exists(app);
  let hwnd_value = hwnd_of(app);
  let (visible, visible_error) = match &window {
    Some(webview_window) => match webview_window.is_visible() {
      Ok(value) => (Some(value), None),
      Err(err) => (None, Some(err.to_string())),
    },
    None => (None, Some("窗口对象不存在".to_string())),
  };
  let (url, url_error) = match &window {
    Some(webview_window) => match webview_window.url() {
      Ok(value) => (Some(value.to_string()), None),
      Err(err) => (None, Some(err.to_string())),
    },
    None => (None, Some("窗口对象不存在".to_string())),
  };
  let startup_failure = startup_failure();
  serde_json::json!({
    "label": WINDOW_LABEL,
    "created": created,
    "hwnd": hwnd_value,
    "visible": visible,
    "visibleError": visible_error,
    "url": url,
    "urlError": url_error,
    "lastAction": last_action(),
    // 启动阶段窗口/WebView2 校验失败原因（正常启动为 null）
    "failureKind": startup_failure.as_ref().map(|failure| failure.kind),
    "failureReason": startup_failure.as_ref().map(|failure| failure.reason.clone()),
    "failureDetail": startup_failure.as_ref().map(|failure| failure.detail.clone()),
  })
}


pub fn create(app: &AppHandle) -> Result<WebviewWindow, WindowFailure> {
  let state = app.state::<AppState>();
  let prefs = state::lock(&state.prefs).clone();
  let width = prefs.width.unwrap_or(1280.0).max(1024.0);
  let height = prefs.height.unwrap_or(860.0).max(700.0);
  // 初始先打开空白页，等 Node ready 后再导航到内部管理地址
  let placeholder = match "about:blank".parse::<tauri::Url>() {
    Ok(url) => url,
    Err(err) => {
      return Err(window_failure("window", "解析初始 URL 失败", err.to_string()));
    }
  };
  let mut builder = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(placeholder))
    .title(state.window_title())
    .inner_size(width, height)
    .min_inner_size(1024.0, 700.0)
    .visible(false)
    .resizable(true);
  // WebView2 用户数据目录放到桌面配置目录下：避免写入 %LOCALAPPDATA% 默认位置带来的
  // 权限问题（受限账户/沙箱/便携场景），也便于测试时用 MIRROR_DESKTOP_HOME 完全隔离。
  let webview_data_dir = state.home_dir.join("webview2");
  match std::fs::create_dir_all(&webview_data_dir) {
    Ok(()) => {
      builder = builder.data_directory(webview_data_dir.clone());
    }
    Err(err) => {
      crate::logging::warn(format!(
        "创建 WebView2 数据目录 {} 失败：{err}（回退到系统默认目录）",
        webview_data_dir.display()
      ));
    }
  }
  builder = match (prefs.x, prefs.y) {
    (Some(x), Some(y)) => builder.position(x, y),
    _ => builder.center(),
  };
  logging::info(format!(
    "创建主窗口（隐藏）：label={WINDOW_LABEL} size={width}x{height} webview2Dir={}",
    webview_data_dir.display()
  ));
  let icon = Image::new(WINDOW_ICON, 256, 256);
  let built = builder.icon(icon);
  let built = match built {
    Ok(builder_with_icon) => builder_with_icon,
    Err(err) => {
      record_status(serde_json::json!({
        "created": false,
        "failureKind": "window",
        "failureReason": "设置窗口图标失败",
        "failureDetail": err.to_string(),
      }));
      return Err(window_failure("window", "设置窗口图标失败", err.to_string()));
    }
  };
  let webview_window = match built.build() {
    Ok(webview_window) => webview_window,
    Err(err) => {
      record_status(serde_json::json!({
        "created": false,
        "failureKind": "window",
        "failureReason": "创建主窗口失败",
        "failureDetail": err.to_string(),
      }));
      return Err(window_failure("window", "创建主窗口失败", err.to_string()));
    }
  };
  // 关键校验：窗口对象创建成功不代表 WebView2 可用。受限环境（沙箱/预览面板/受限 token）
  // 下 build() 可能返回 Ok，但窗口句柄/is_visible/url 均返回 runtime error，导致窗口永远不可见。
  let created_hwnd = match webview_window.hwnd() {
    Ok(hwnd) => hwnd.0 as isize,
    Err(err) => {
      record_status(serde_json::json!({
        "created": true,
        "hwnd": null,
        "hwndError": err.to_string(),
        "failureKind": "webview",
        "failureReason": "窗口句柄不可用：WebView2 运行时初始化失败",
      }));
      return Err(window_failure(
        "webview",
        "窗口句柄不可用：WebView2 运行时初始化失败",
        err.to_string(),
      ));
    }
  };
  let created_visible = match webview_window.is_visible() {
    Ok(value) => value,
    Err(err) => {
      record_status(serde_json::json!({
        "created": true,
        "hwnd": created_hwnd,
        "visible": null,
        "visibleError": err.to_string(),
        "failureKind": "webview",
        "failureReason": "WebView2 渲染进程不可用：窗口无法显示",
      }));
      return Err(window_failure(
        "webview",
        "WebView2 渲染进程不可用：窗口无法显示",
        err.to_string(),
      ));
    }
  };
  if let Err(err) = webview_window.url() {
    record_status(serde_json::json!({
      "created": true,
      "hwnd": created_hwnd,
      "visible": created_visible,
      "url": null,
      "urlError": err.to_string(),
      "failureKind": "webview",
      "failureReason": "WebView2 通信失败：无法读取窗口地址",
    }));
    return Err(window_failure(
      "webview",
      "WebView2 通信失败：无法读取窗口地址",
      err.to_string(),
    ));
  }
  clear_startup_failure();
  logging::info(format!(
    "主窗口校验通过：hwnd={created_hwnd} is_visible={created_visible}（WebView2 可用）"
  ));
  record_action(format!(
    "主窗口创建并校验通过：hwnd={created_hwnd} is_visible={created_visible}"
  ));
  record_status(serde_json::json!({
    "label": WINDOW_LABEL,
    "created": true,
    "hwnd": created_hwnd,
    "visible": created_visible,
    "url": null,
    "urlError": null,
    "failureKind": null,
    "failureReason": null,
    "failureDetail": null,
  }));
  if prefs.maximized {
    let _ = webview_window.maximize();
  }
  state.window_visible.store(false, Ordering::SeqCst);

  let app_for_events = app.clone();
  let window_for_events = webview_window.clone();
  webview_window.on_window_event(move |event| match event {
    WindowEvent::CloseRequested { api, .. } => {
      // v0.0.4 语义：托盘可用时关闭=隐藏到托盘；托盘不可用（受限环境/注册失败）时关闭=退出程序，
      // 与「关闭窗口时不可用则退出」一致，避免程序变成无法唤出的后台常驻进程。
      api.prevent_close();
      handle_close_request(&app_for_events, "WM_CLOSE");
    }
    WindowEvent::Resized(size) => {
      let scale = window_for_events.scale_factor().unwrap_or(1.0);
      let maximized = window_for_events.is_maximized().unwrap_or(false);
      record_geometry(
        &app_for_events,
        Some((size.width as f64 / scale, size.height as f64 / scale)),
        None,
        Some(maximized),
      );
    }
    WindowEvent::Moved(position) => {
      let scale = window_for_events.scale_factor().unwrap_or(1.0);
      record_geometry(
        &app_for_events,
        None,
        Some((position.x as f64 / scale, position.y as f64 / scale)),
        None,
      );
    }
    WindowEvent::Destroyed => {
      // 正常退出时也会触发；记录日志便于区分「WebView2 初始化失败导致窗口被销毁」
      logging::warn("主窗口收到 Destroyed 事件（若出现在启动早期，通常表示 WebView2 初始化失败）");
      record_action("主窗口已销毁（Destroyed）".to_string());
    }
    _ => {}
  });
  Ok(webview_window)
}

/// 窗口关闭请求的统一处理（WM_CLOSE 与冒烟命令 window:close 共用）：
/// - 托盘可用：隐藏窗口，程序继续在托盘运行；
/// - 托盘不可用：直接优雅退出程序（清理 Node/托盘），避免留下无法唤出的后台进程。
pub fn handle_close_request(app: &AppHandle, source: &str) {
  let tray_available = app.state::<AppState>().tray_available();
  logging::info(format!(
    "窗口关闭请求（{source}）：托盘可用={tray_available}"
  ));
  if tray_available {
    hide(app);
    record_action(format!("关闭请求（{source}）：已隐藏到托盘（托盘可用）"));
  } else {
    record_action(format!(
      "关闭请求（{source}）：托盘不可用，直接退出程序"
    ));
    logging::warn("托盘不可用：关闭窗口将退出程序（不驻留后台）");
    node_proc::shutdown_and_exit(app, 0);
  }
}

pub fn show(app: &AppHandle) {
  match window_of(app) {
    Some(webview_window) => {
      let show_result = webview_window.show().map_err(|err| err.to_string());
      let unminimize_result = webview_window.unminimize().map_err(|err| err.to_string());
      let focus_result = webview_window.set_focus().map_err(|err| err.to_string());
      let visible_after = webview_window
        .is_visible()
        .map_err(|err| err.to_string());
      let hwnd = webview_window.hwnd().ok().map(|handle| handle.0 as isize);
      record_action(format!(
        "显示主窗口：hwnd={hwnd:?} show={show_result:?} unminimize={unminimize_result:?} focus={focus_result:?} visibleAfter={visible_after:?}"
      ));
    }
    None => {
      logging::warn("显示主窗口失败：窗口对象不存在");
      record_action("显示主窗口失败：窗口对象不存在".to_string());
    }
  }
  app.state::<AppState>().window_visible.store(true, Ordering::SeqCst);
}

pub fn hide(app: &AppHandle) {
  match window_of(app) {
    Some(webview_window) => {
      let hide_result = webview_window.hide().map_err(|err| err.to_string());
      let visible_after = webview_window
        .is_visible()
        .map_err(|err| err.to_string());
      record_action(format!(
        "隐藏主窗口：hide={hide_result:?} visibleAfter={visible_after:?}"
      ));
    }
    None => {
      logging::warn("隐藏主窗口失败：窗口对象不存在");
      record_action("隐藏主窗口失败：窗口对象不存在".to_string());
    }
  }
  app.state::<AppState>().window_visible.store(false, Ordering::SeqCst);
  save_prefs(app);
}

/// 日志/诊断里隐藏内部管理 URL 的访问令牌（日志禁止出现带 token 的完整 URL）。
fn sanitize_url(url: &str) -> String {
  match url.find("__mirror_token=") {
    Some(index) => format!("{}__mirror_token=***", &url[..index]),
    None => url.to_string(),
  }
}

pub fn navigate(app: &AppHandle, url: &str) {
  let safe_url = sanitize_url(url);
  let parsed = match url.parse() {
    Ok(parsed) => parsed,
    Err(err) => {
      logging::warn(format!("导航 URL 无效：{safe_url}（{err}）"));
      record_action(format!("导航失败（URL 无效）：{safe_url}（{err}）"));
      return;
    }
  };
  match window_of(app) {
    Some(webview_window) => {
      match webview_window.url() {
        Ok(current) => {
          if current.as_str() == url {
            record_action(format!("导航跳过：已是目标地址 {safe_url}"));
            return;
          }
        }
        Err(err) => {
          logging::warn(format!("读取当前窗口地址失败：{err}（继续尝试导航）"));
        }
      }
      match webview_window.navigate(parsed) {
        Ok(()) => {
          record_action(format!("主窗口导航到：{safe_url}"));
        }
        Err(err) => {
          logging::warn(format!("导航到 {safe_url} 失败：{err}"));
          record_action(format!("导航到 {safe_url} 失败：{err}"));
        }
      }
    }
    None => {
      logging::warn(format!("导航失败：窗口对象不存在（目标 {safe_url}）"));
      record_action(format!("导航失败：窗口对象不存在（目标 {safe_url}）"));
    }
  }
}

pub fn apply_title(app: &AppHandle) {
  if let Some(webview_window) = window_of(app) {
    let title = app.state::<AppState>().window_title();
    match webview_window.set_title(&title) {
      Ok(()) => record_action(format!("更新窗口标题：{title}")),
      Err(err) => {
        logging::warn(format!("更新窗口标题失败：{err}"));
        record_action(format!("更新窗口标题失败：{err}"));
      }
    }
  }
}

pub fn is_visible(app: &AppHandle) -> bool {
  window_of(app)
    .and_then(|webview_window| webview_window.is_visible().ok())
    .unwrap_or(false)
}

pub fn current_url(app: &AppHandle) -> Option<String> {
  window_of(app)
    .and_then(|webview_window| webview_window.url().ok())
    .map(|url| url.to_string())
}

fn record_geometry(
  app: &AppHandle,
  size: Option<(f64, f64)>,
  position: Option<(f64, f64)>,
  maximized: Option<bool>,
) {
  let state = app.state::<AppState>();
  let mut prefs = state::lock(&state.prefs);
  if let Some((width, height)) = size {
    if width >= 1024.0 && height >= 700.0 {
      prefs.width = Some(width);
      prefs.height = Some(height);
    }
  }
  if let Some((x, y)) = position {
    prefs.x = Some(x);
    prefs.y = Some(y);
  }
  if let Some(maximized) = maximized {
    prefs.maximized = maximized;
  }
}

pub fn save_prefs(app: &AppHandle) {
  let state = app.state::<AppState>();
  let prefs = state::lock(&state.prefs).clone();
  if let Err(err) = paths::write_desktop_prefs(&state.home_dir, &prefs) {
    crate::logging::warn(format!("保存窗口位置失败：{err}"));
  }
}
