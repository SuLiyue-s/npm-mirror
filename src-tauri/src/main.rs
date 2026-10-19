// 桌面程序入口：
// 单实例 -> 解析配置目录/主数据目录 -> 解压内嵌运行时 -> 创建隐藏主窗口/托盘（并校验 WebView2 可用性）
// -> 启动 Node 子进程 -> 收到 Node ready 后导航到内部管理界面并显示窗口；
// 关闭窗口只隐藏，退出时优雅关闭 Node。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod autostart;
mod bridge;
mod config_watch;
mod dialog;
mod embed;
mod integrity;
mod logging;
mod node_proc;
mod paths;
mod single_instance;
mod smoke;
mod state;
mod tray;
mod window;
mod winutil;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent};

use crate::state::AppState;

/// 启动失败分类：窗口/WebView2 校验失败给出可操作提示；其余错误给出通用提示。
#[derive(Clone)]
enum StartupError {
  Window(window::WindowFailure),
  Other(String),
}

impl StartupError {
  fn kind(&self) -> &'static str {
    match self {
      StartupError::Window(failure) => failure.kind,
      StartupError::Other(_) => "other",
    }
  }

  fn message(&self) -> String {
    match self {
      StartupError::Window(failure) => format!(
        "主窗口/WebView2 校验失败：{}（{}）",
        failure.reason, failure.detail
      ),
      StartupError::Other(message) => message.clone(),
    }
  }
}

impl std::fmt::Display for StartupError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter.write_str(&self.message())
  }
}

impl From<String> for StartupError {
  fn from(message: String) -> Self {
    StartupError::Other(message)
  }
}

// 启动阶段已收集的环境摘要（写失败报告用；setup 闭包出错后 AppState 不可访问，故提前缓存）
static STARTUP_SUMMARY: Mutex<Option<serde_json::Value>> = Mutex::new(None);
// setup 闭包中的启动失败信息：build() 返回 Err 后由 main 统一写报告/弹提示框
static STARTUP_FAILURE: Mutex<Option<StartupError>> = Mutex::new(None);

fn set_startup_failure(error: StartupError) {
  if let Ok(mut guard) = STARTUP_FAILURE.lock() {
    *guard = Some(error);
  }
}

fn take_startup_failure() -> Option<StartupError> {
  STARTUP_FAILURE.lock().ok().and_then(|mut guard| guard.take())
}

fn main() {
  let args = parse_args();
  // --repair-integrity：提权修复实例入口（由程序内修复提示或手动以管理员身份启动）。
  // 注意：Low 标签的 exe 即使「以管理员身份运行」，进程仍会被系统降为 Low；
  // 因此这里在已提权时改为提权调用系统 icacls.exe（Medium 文件）执行 /setintegritylevel Medium。
  if args.repair_integrity {
    let code = integrity::run_repair_mode(&args);
    std::process::exit(code);
  }
  let smoke_mode = smoke::enabled();
  // 启动自检：程序文件是否带低完整性（Low）标签（从受限环境（浏览器下载/聊天窗口/沙盒）启动常见）。
  // 检测到且可交互时弹「是/否」询问框，选择「是」会在当前进程内通过 UAC 提权系统 icacls 修复，
  // 成功后自动以普通权限重启并退出当前实例。
  let integrity_status = integrity::startup_check(&args, smoke_mode);
  integrity::set_status(integrity_status.clone());
  if integrity_status.repair_launched {
    eprintln!("低完整性标签修复成功，已请求以普通权限重启，当前实例退出");
    return;
  }
  let error_report_path = args.smoke_report.clone();
  let result = run(args, integrity_status);
  // setup 闭包里的失败信息优先（包含窗口/WebView2 失败细节）
  let setup_failure = take_startup_failure();
  if let Err(err) = result {
    let error = setup_failure.unwrap_or(err);
    let message = error.message();
    eprintln!("桌面程序启动失败：{message}");
    logging::error(format!("启动失败：{message}"));
    // smoke 模式统一由主程序写一份失败报告后退出（不弹框），便于受限环境 e2e 断言
    if let Some(path) = &error_report_path {
      let payload = build_failure_report(&message, error.kind(), None);
      let _ = std::fs::write(path, format!("{payload}\n"));
    }
    if !smoke_mode {
      match &error {
        StartupError::Window(failure) => show_window_failure_box(failure),
        StartupError::Other(_) => winutil::message_box(
          format!(
            "{} 启动失败：\n\n{message}\n\n请查看日志：{}",
            paths::PRODUCT_NAME,
            logging::log_path()
              .map(|path| path.display().to_string())
              .unwrap_or_else(|| "desktop.log".to_string())
          ),
          paths::PRODUCT_NAME,
          true,
        ),
      }
    }
    std::process::exit(1);
  }
}

/// 窗口/WebView2 不可用时给用户的可操作提示（区分「WebView2 缺失」与「受限环境」）。
fn show_window_failure_box(failure: &window::WindowFailure) {
  let webview2 = winutil::webview2_version();
  let (hint, need_webview2) = match webview2 {
    Some(version) => (
      format!(
        "已检测到 WebView2 Runtime（{version}）。\n\n若主窗口一直无法显示，通常是因为从受限/沙盒环境（预览面板、受限 token）启动，\
无法完成 WebView2 渲染进程通信。请从资源管理器直接双击本程序重试。"
      ),
      false,
    ),
    None => (
      "未检测到 Microsoft Edge WebView2 Runtime。Windows 10 1803 及以上通常已自带；\
若缺失请安装 WebView2 Runtime 后重试。".to_string(),
      true,
    ),
  };
  let title = if need_webview2 {
    format!("{} 无法显示主窗口", paths::PRODUCT_NAME)
  } else {
    format!("{} 无法显示主窗口（环境受限）", paths::PRODUCT_NAME)
  };
  winutil::message_box(
    format!(
      "主窗口/WebView2 校验失败：\n\n{}\n\n{hint}\n\n详细信息：{}\n\n日志：{}",
      failure.reason,
      failure.detail,
      logging::log_path()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "desktop.log".to_string())
    ),
    title,
    true,
  );
}

/// 非 smoke 模式下 setup 阶段失败：尽量写一份失败报告（若指定 --smoke-report）、
/// 弹可操作说明框，然后退出。此时尚未启动 Node，不会残留子进程/托盘图标。
fn handle_startup_failure(app: &AppHandle, error: &StartupError) {
  if let Some(path) = app.state::<AppState>().args.smoke_report.clone() {
    let payload = build_failure_report(&error.message(), error.kind(), Some(app));
    let _ = std::fs::write(path, format!("{payload}\n"));
  }
  match error {
    StartupError::Window(failure) => show_window_failure_box(failure),
    StartupError::Other(message) => winutil::message_box(
      format!(
        "{} 启动失败：\n\n{message}\n\n若本程序是从聊天窗口/预览面板/受限终端启动的，\
请改为从 Windows 资源管理器直接双击程序重试。\n\n日志：{}",
        paths::PRODUCT_NAME,
        logging::log_path()
          .map(|path| path.display().to_string())
          .unwrap_or_else(|| "desktop.log".to_string())
      ),
      paths::PRODUCT_NAME,
      true,
    ),
  }
  logging::error("桌面壳初始化失败，进程退出");
  std::process::exit(1);
}

fn run(
  args: state::StartupArgs,
  integrity_status: integrity::IntegrityStatus,
) -> Result<(), StartupError> {
  // 单实例「等待-接管」：重启时旧实例正在退出，若立即退出会导致新旧都退、窗口/托盘丢失；
  // 旧实例健康时则唤醒其窗口后退出。等待期间每 250ms 重试互斥体，最长 15 秒。
  if let single_instance::InstanceCheck::AlreadyRunning = single_instance::acquire() {
    let takeover = single_instance::wait_and_take_over();
    let mode = takeover.mode.unwrap_or("takeover");
    if takeover.acquired {
      logging::info(format!(
        "单实例：{}（等待 {}ms，唤醒尝试 {} 次，takeoverMode={}）",
        if takeover.activated {
          "旧实例正在退出，宽限期内拿到互斥体，本实例接管启动"
        } else {
          "旧实例已退出，接管互斥体继续启动"
        },
        takeover.waited_ms,
        takeover.activation_attempts,
        mode
      ));
    } else {
      logging::info(format!(
        "已有实例在运行：唤醒已有窗口={}，等待 {}ms，唤醒尝试 {} 次，超时={}，takeoverMode={}",
        takeover.activated,
        takeover.waited_ms,
        takeover.activation_attempts,
        takeover.timed_out,
        mode
      ));
      if let Some(path) = &args.smoke_report {
        let payload = serde_json::json!({
          "alreadyRunning": true,
          "activated": takeover.activated,
          "waitedMs": takeover.waited_ms,
          "activationAttempts": takeover.activation_attempts,
          "timedOut": takeover.timed_out,
          "takeoverMode": mode,
        });
        let _ = std::fs::write(path, format!("{payload}\n"));
      }
      eprintln!(
        "已有实例在运行，已尝试唤醒其窗口（activated={}，waitedMs={}，takeoverMode={}）",
        takeover.activated, takeover.waited_ms, mode
      );
      return Ok(());
    }
  }

  // 桌面配置目录：MIRROR_DESKTOP_HOME > %LOCALAPPDATA%\LiYueNpmMirror > 程序目录 > %TEMP% > 程序目录备用。
  // 受限环境（沙箱/预览面板继承受限 token）写不了 %LOCALAPPDATA% 时自动回退，不再启动即失败。
  // 提示框统一在主窗口校验之后给出（见 setup_app），避免同一问题弹两次。
  let home_resolution = paths::effective_home()?;
  let home = home_resolution.path.clone();
  // 日志初始化失败不阻断启动（配置目录可用但日志文件被占用等极端情况）
  if let Err(err) = logging::init(&home) {
    eprintln!("初始化桌面日志失败（继续运行）：{err}");
  }
  logging::info(format!(
    "==== 桌面程序启动：{} v{} pid={} ====",
    paths::PRODUCT_NAME,
    env!("CARGO_PKG_VERSION"),
    std::process::id()
  ));
  logging::info(format!(
    "exe={} home={} homeFallback={} args={args:?}",
    paths::exe_path().display(),
    home.display(),
    home_resolution.fallback
  ));
  for warning in &home_resolution.warnings {
    logging::warn(warning);
  }
  // 完整性标签自检结果（WebView2/托盘/脚本执行等异常的首要排查项）
  logging::info(format!(
    "完整性标签检测：{}",
    integrity_status.summary()
  ));
  logging::info(format!(
    "完整性标签详情：{}",
    serde_json::to_string(&integrity_status.to_json()).unwrap_or_else(|_| "{}".to_string())
  ));
  if integrity_status.low_detected {
    logging::warn(
      "程序文件带低完整性（Low）标签：从受限环境启动时 WebView2/托盘/界面可能异常。可右键以管理员身份运行「修复-桌面版启动限制.cmd」修复。",
    );
  }
  if integrity_status.prompt_suppressed {
    let reason = if args.autostart {
      "开机自启模式"
    } else if smoke::enabled() {
      "smoke 测试模式"
    } else if args.skip_integrity_prompt {
      "--skip-integrity-prompt"
    } else {
      "当前环境不可交互"
    };
    logging::info(format!("低完整性标签修复询问框已跳过（原因：{reason}）"));
  }
  if let Some(result) = &integrity_status.repair_result {
    logging::info(format!("完整性标签修复结果：{result}"));
  }
  if let Some(error) = &integrity_status.repair_error {
    logging::warn(format!("完整性标签修复失败：{error}"));
  }
  if integrity_status.repair_launched {
    logging::info("低完整性标签修复成功，已请求以普通权限重启（当前实例即将退出）");
  }
  if home_resolution.fallback {
    logging::warn(format!(
      "用户配置目录不可写，已改用备用配置目录：{}（原因：{}）",
      home.display(),
      home_resolution
        .warnings
        .first()
        .cloned()
        .unwrap_or_else(|| "用户配置目录不可写".to_string())
    ));
    // 受限 shell 提前给出可操作提示（不影响 smoke 模式；正式桌面且窗口正常时用户可忽略）
    logging::warn(
      "运行环境似乎是受限 shell（用户配置目录回退）。若界面显示/操作异常，请从资源管理器直接双击本程序。",
    );
  }

  // WebView2 Runtime 版本仅用于日志/报告（缺失会导致窗口创建失败，提示框会说明）
  let webview2_version = winutil::webview2_version();
  logging::info(format!(
    "WebView2 Runtime 版本：{}",
    webview2_version.clone().unwrap_or_else(|| "未检测到".to_string())
  ));

  // 主数据目录：--data-dir > MIRROR_DATA_DIR > 指针文件 > 自动发现/默认
  let resolution = paths::resolve_data_dir(&args, &home)?;
  for warning in &resolution.warnings {
    logging::warn(warning);
  }
  let data_dir_default = paths::exe_dir().join("data");
  logging::info(format!(
    "主数据目录：{}（来源：{}，默认值：{}）",
    resolution.path.display(),
    resolution.source.as_str(),
    data_dir_default.display()
  ));

  // 缓存启动环境摘要供失败报告使用
  *STARTUP_SUMMARY.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(serde_json::json!({
    "home": {
      "path": home.display().to_string(),
      "fallback": home_resolution.fallback,
      "warnings": &home_resolution.warnings,
    },
    "dataDir": resolution.path.display().to_string(),
    "dataDirSource": resolution.source.as_str(),
    "dataDirDefault": data_dir_default.display().to_string(),
    "webview2Version": webview2_version,
    "integrity": integrity_status.to_json(),
    "exePath": paths::exe_path().display().to_string(),
    "exeDir": paths::exe_dir().display().to_string(),
    "logPath": logging::log_path().map(|path| path.display().to_string()),
  }));

  // 解压内嵌运行时（node.exe + app 资产）
  let runtime_dir = embed::ensure_runtime(&home)?;
  let app_root = embed::app_root(&home);
  let log_path = logging::log_path();
  let app_state = AppState::new(
    home.clone(),
    home_resolution.fallback,
    home_resolution.warnings.clone(),
    resolution.path,
    resolution.source.as_str().to_string(),
    runtime_dir,
    app_root,
    args,
    log_path,
    integrity_status,
  );
  *state::lock(&app_state.prefs) = paths::read_desktop_prefs(&home);

  let app = tauri::Builder::default()
    .manage(app_state)
    .setup(|app| {
      let handle = app.handle().clone();
      if let Err(err) = setup_app(&handle) {
        logging::error(format!("桌面程序初始化失败：{err}"));
        set_startup_failure(err.clone());
        if smoke::enabled() {
          // smoke 模式：窗口/托盘校验失败仍继续运行（受限环境 e2e 依赖 Node 服务/托盘挂钩），
          // 失败原因写入 --smoke-report 的 window 字段，由测试断言。
          logging::warn(format!(
            "smoke 模式：桌面壳初始化失败仍继续运行（窗口/托盘能力可能不可用）：{err}"
          ));
          return Ok(());
        }
        // 非 smoke：交给事件循环启动后的后台线程弹说明框再退出。
        // （setup 钩子运行在事件循环初始化阶段，部分受限环境下消息框无法正常显示）
        let handle_failure = handle.clone();
        thread::spawn(move || {
          thread::sleep(Duration::from_millis(120));
          handle_startup_failure(&handle_failure, &err);
        });
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .map_err(|err| StartupError::Other(format!("创建桌面应用失败：{err}")))?;

  app.run(|app_handle, event| match event {
    RunEvent::ExitRequested { code: _, api, .. } => {
      // 未走退出流程时拦截退出（Alt+F4/任务栏关闭等应由托盘「退出程序」或 Node 请求触发）
      let state = app_handle.state::<AppState>();
      if !state.allow_exit.load(Ordering::SeqCst) {
        api.prevent_exit();
      }
    }
    RunEvent::Exit => {
      node_proc::kill_node(app_handle);
      // 清理托盘图标（NIM_DELETE）与 HICON，避免任务栏残留幽灵图标
      tray::shutdown();
      window::save_prefs(app_handle);
      logging::info("桌面程序进程退出");
    }
    _ => {}
  });
  Ok(())
}

fn setup_app(app: &AppHandle) -> Result<(), StartupError> {
  let state = app.state::<AppState>();
  let data_dir = state.data_dir_snapshot();
  // 初始读取配置（admin.enabled / ui.title），后续由 config_watch 每秒轮询
  let config = config_watch::read_ui_config(&data_dir);
  logging::info(format!(
    "config.json：loaded={} admin.enabled={} ui.title={:?}",
    config.loaded, config.admin_enabled, config.ui_title
  ));
  *state::lock(&state.config) = config;

  let smoke_mode = smoke::enabled();
  let mut window_failure: Option<window::WindowFailure> = None;
  // 1) 主窗口先隐藏创建，并校验 WebView2 是否真的可用（受限环境会在此失败）
  match window::create(app) {
    Ok(_) => logging::info("主窗口创建并通过 WebView2 校验"),
    Err(failure) if smoke_mode => {
      logging::warn(format!(
        "主窗口校验失败（smoke 模式继续启动 Node/托盘，供受限环境 e2e 使用）：{}（{}）",
        failure.reason, failure.detail
      ));
      window_failure = Some(failure);
    }
    Err(failure) => return Err(StartupError::Window(failure)),
  }

  // 2) 托盘（图标 + 右键菜单 + 左键单击）
  match tray::init(app) {
    Ok(()) => {}
    Err(err) if smoke_mode => {
      logging::warn(format!("托盘创建失败（smoke 模式继续启动 Node）：{err}"));
    }
    Err(err) => return Err(StartupError::Other(format!("创建托盘失败：{err}"))),
  }

  // 3) 窗口/托盘校验通过后再启动 Node（受限环境 smoke 模式允许窗口校验失败但仍启动，便于 e2e）
  if window_failure.is_none() {
    logging::info("窗口/托盘校验通过，开始启动 Node");
  } else {
    logging::warn("窗口校验未通过（受限环境），继续启动 Node 子进程");
  }
  // 配置文件轮询：admin.enabled -> 托盘菜单；ui.title -> 窗口标题
  config_watch::start(app.clone());
  // 启动 Node 子进程
  start_initial_node(app);
  // 冒烟测试挂钩（未设置 MIRROR_DESKTOP_SMOKE 时空转）
  smoke::start(app.clone());
  logging::info("桌面壳初始化完成");
  Ok(())
}

fn start_initial_node(app: &AppHandle) {
  let (exit_tx, exit_rx) = mpsc::channel::<i32>();
  match node_proc::spawn(app, exit_tx) {
    Ok(()) => node_proc::start_monitor(app.clone(), exit_rx),
    Err(err) => {
      logging::error(format!("首次启动 Node 失败：{err}"));
      if !smoke::enabled() {
        let log_hint = app
          .state::<AppState>()
          .log_path
          .as_ref()
          .map(|path| path.display().to_string())
          .unwrap_or_else(|| "desktop.log".to_string());
        winutil::message_box(
          format!("镜像源服务启动失败，将自动重试。\n\n{err}\n\n日志：{log_hint}"),
          paths::PRODUCT_NAME,
          true,
        );
      }
      // 启动失败也按崩溃处理：1s/3s/5s 重试，成功后交给监控线程
      let app_retry = app.clone();
      thread::spawn(move || {
        for delay_ms in [1_000u64, 3_000, 5_000] {
          thread::sleep(Duration::from_millis(delay_ms));
          let (tx, rx) = mpsc::channel::<i32>();
          match node_proc::spawn(&app_retry, tx) {
            Ok(()) => {
              node_proc::start_monitor(app_retry.clone(), rx);
              logging::info("Node 重试启动成功");
              return;
            }
            Err(err) => logging::error(format!("Node 重试启动失败：{err}")),
          }
        }
        logging::error("Node 自动重试结束，仍未启动成功（可通过托盘「重启镜像源服务」再试）");
      });
    }
  }
}

/// 构造启动失败报告：smoke 模式下写 --smoke-report（fields 与成功报告尽量兼容）。
fn build_failure_report(
  message: &str,
  kind: &str,
  app: Option<&AppHandle>,
) -> serde_json::Value {
  let summary = STARTUP_SUMMARY
    .lock()
    .ok()
    .and_then(|guard| guard.clone())
    .unwrap_or_else(|| serde_json::json!({}));
  let window_failure = window::startup_failure();
  let window_status = window::failure_snapshot();
  let tray_labels = tray::labels_snapshot();
  let mut report = serde_json::json!({
    "smoke": true,
    "startupOk": false,
    "error": message,
    "errorKind": kind,
    "startupFailure": window_failure.as_ref().map(|failure| serde_json::json!({
      "kind": failure.kind,
      "reason": failure.reason,
      "detail": failure.detail,
    })),
    "window": window_status,
    "tray": { "labels": tray_labels },
    "pid": std::process::id(),
    "version": env!("CARGO_PKG_VERSION"),
    "logPath": logging::log_path().map(|path| path.display().to_string()),
  });
  // setup 阶段的失败可从 AppState 补充与冒烟报告一致的字段（home/dataDir/tray 状态）
  if let Some(app) = app {
    let state = app.state::<AppState>();
    if let Some(object) = report.as_object_mut() {
      object.insert(
        "home".to_string(),
        serde_json::json!({
          "path": state.home_dir.to_string_lossy(),
          "fallback": state.home_fallback,
          "warnings": state.home_warnings,
        }),
      );
      object.insert(
        "homeDir".to_string(),
        serde_json::json!(state.home_dir.to_string_lossy()),
      );
      object.insert(
        "dataDir".to_string(),
        serde_json::json!(state.data_dir_snapshot().to_string_lossy()),
      );
      object.insert(
        "dataDirSource".to_string(),
        serde_json::json!(state.data_dir_source_snapshot()),
      );
      object.insert(
        "restricted".to_string(),
        serde_json::json!(state.restricted()),
      );
      object.insert(
        "integrity".to_string(),
        state.integrity.to_json(),
      );
      object.insert(
        "tray".to_string(),
        serde_json::json!({
          "created": state.tray_created(),
          "available": state.tray_available(),
          "error": state.tray_error_snapshot(),
          "labels": tray_labels,
        }),
      );
    }
  }
  // 合并启动阶段环境摘要（home/dataDir/dataDirSource/webview2Version 等）
  if let (Some(object), Some(extra)) = (report.as_object_mut(), summary.as_object()) {
    for (key, value) in extra {
      object.entry(key.clone()).or_insert_with(|| value.clone());
    }
  }
  report
}

fn parse_args() -> state::StartupArgs {
  let mut args = state::StartupArgs::default();
  let mut iter = std::env::args_os().skip(1);
  while let Some(raw) = iter.next() {
    let text = raw.to_string_lossy().to_string();
    let (name, inline_value) = match text.split_once('=') {
      Some((name, value)) => (name.to_string(), Some(value.to_string())),
      None => (text, None),
    };
    let mut next_path = |label: &str| -> Option<PathBuf> {
      if let Some(value) = inline_value.clone() {
        return Some(PathBuf::from(value));
      }
      match iter.next() {
        Some(value) => Some(PathBuf::from(value)),
        None => {
          eprintln!("启动参数 {label} 缺少取值");
          None
        }
      }
    };
    match name.as_str() {
      "--data-dir" => args.data_dir = next_path("--data-dir"),
      "--smoke-report" => args.smoke_report = next_path("--smoke-report"),
      "--smoke-cmd" => args.smoke_cmd = next_path("--smoke-cmd"),
      "--autostart" => args.autostart = true,
      "--repair-integrity" => args.repair_integrity = true,
      "--skip-integrity-prompt" => args.skip_integrity_prompt = true,
      "-h" | "--help" => {
        print_help();
        std::process::exit(0);
      }
      other => eprintln!("忽略未知启动参数：{other}"),
    }
  }
  args
}

fn print_help() {
  println!("{} v{}（桌面版）", paths::PRODUCT_NAME, env!("CARGO_PKG_VERSION"));
  println!();
  println!("用法：npm-mirror-desktop.exe [选项]");
  println!();
  println!("选项：");
  println!("  --data-dir <目录>     指定主数据目录（绝对路径）");
  println!("  --autostart           开机自启启动：不自动显示主窗口");
  println!("  -h, --help            显示本帮助");
  println!();
  println!("排错参数：");
  println!("  --repair-integrity    修复实例：用提权系统 icacls 移除程序文件的低完整性（Low）标签后重启（需管理员权限；由程序内提示自动调用，勿手动使用）");
  println!("  --skip-integrity-prompt  跳过低完整性标签修复询问框（自动化测试用）");
  println!("  --smoke-report <文件> 冒烟测试：持续写入状态 JSON（自动化测试用）");
  println!("  --smoke-cmd <文件>    冒烟测试：读取命令文件执行窗口/托盘/退出等动作（自动化测试用）");
}
