// 桌面程序入口：
// 单实例 -> 解析主数据目录 -> 解压内嵌运行时 -> 创建隐藏主窗口/托盘 -> 启动 Node 子进程 ->
// 收到 Node ready 后导航到内部管理界面并显示窗口；关闭窗口只隐藏，退出时优雅关闭 Node。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod autostart;
mod bridge;
mod config_watch;
mod dialog;
mod embed;
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
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent};

use crate::state::AppState;

fn main() {
  let args = parse_args();
  let smoke_mode = smoke::enabled();
  let error_report_path = args.smoke_report.clone();
  if let Err(err) = run(args) {
    eprintln!("桌面程序启动失败：{err}");
    logging::error(format!("启动失败：{err}"));
    if let Some(path) = &error_report_path {
      let payload = serde_json::json!({ "error": err, "smoke": smoke_mode });
      let _ = std::fs::write(path, format!("{payload}\n"));
    }
    if !smoke_mode {
      winutil::message_box(
        format!("{} 启动失败：\n\n{err}", paths::PRODUCT_NAME),
        paths::PRODUCT_NAME,
        true,
      );
    }
    std::process::exit(1);
  }
}

fn run(args: state::StartupArgs) -> Result<(), String> {
  // 单实例：已有实例在运行时，尝试唤醒它的窗口后退出
  if let single_instance::InstanceCheck::AlreadyRunning = single_instance::acquire() {
    let activated = single_instance::activate_existing();
    logging::info(format!("已有实例在运行：唤醒已有窗口={activated}"));
    if let Some(path) = &args.smoke_report {
      let payload = serde_json::json!({ "alreadyRunning": true, "activated": activated });
      let _ = std::fs::write(path, format!("{payload}\n"));
    }
    eprintln!("已有实例在运行，已尝试唤醒其窗口（activated={activated}）");
    return Ok(());
  }

  // 桌面配置目录（%LOCALAPPDATA%\LiYueNpmMirror，测试可用 MIRROR_DESKTOP_HOME 覆盖）
  let home = paths::home_dir();
  std::fs::create_dir_all(&home)
    .map_err(|err| format!("创建桌面配置目录 {} 失败：{err}", home.display()))?;
  logging::init(&home)?;
  logging::info(format!(
    "==== 桌面程序启动：{} v{} pid={} ====",
    paths::PRODUCT_NAME,
    env!("CARGO_PKG_VERSION"),
    std::process::id()
  ));
  logging::info(format!(
    "exe={} home={} args={args:?}",
    paths::exe_path().display(),
    home.display()
  ));

  // 主数据目录：--data-dir > MIRROR_DATA_DIR > 指针文件 > <exe 目录>/data
  let resolution = paths::resolve_data_dir(&args, &home)?;
  for warning in &resolution.warnings {
    logging::warn(warning);
  }
  logging::info(format!(
    "主数据目录：{}（来源：{}）",
    resolution.path.display(),
    resolution.source.as_str()
  ));

  // 解压内嵌运行时（node.exe + app 资产）
  let runtime_dir = embed::ensure_runtime(&home)?;
  let app_root = embed::app_root(&home);
  let log_path = logging::log_path();
  let app_state = AppState::new(
    home.clone(),
    resolution.path,
    resolution.source.as_str().to_string(),
    runtime_dir,
    app_root,
    args,
    log_path,
  );
  *state::lock(&app_state.prefs) = paths::read_desktop_prefs(&home);

  let app = tauri::Builder::default()
    .manage(app_state)
    .setup(|app| {
      let handle = app.handle().clone();
      if let Err(err) = setup_app(&handle) {
        logging::error(format!("桌面程序初始化失败：{err}"));
        if !smoke::enabled() {
          winutil::message_box(
            format!("{} 初始化失败：\n\n{err}", paths::PRODUCT_NAME),
            paths::PRODUCT_NAME,
            true,
          );
        }
        return Err(std::io::Error::new(std::io::ErrorKind::Other, err).into());
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .map_err(|err| format!("创建桌面应用失败：{err}"))?;

  app.run(|app_handle, event| match event {
    RunEvent::ExitRequested { api, .. } => {
      // 未走退出流程时拦截退出（Alt+F4/任务栏关闭等应由托盘「退出程序」或 Node 请求触发）
      let state = app_handle.state::<AppState>();
      if !state.allow_exit.load(Ordering::SeqCst) {
        api.prevent_exit();
      }
    }
    RunEvent::Exit => {
      node_proc::kill_node(app_handle);
      window::save_prefs(app_handle);
      logging::info("桌面程序进程退出");
    }
    _ => {}
  });
  Ok(())
}

fn setup_app(app: &AppHandle) -> Result<(), String> {
  let state = app.state::<AppState>();
  let data_dir = state.data_dir_snapshot();
  // 初始读取配置（admin.enabled / ui.title），后续由 config_watch 每秒轮询
  let config = config_watch::read_ui_config(&data_dir);
  logging::info(format!(
    "config.json：loaded={} admin.enabled={} ui.title={:?}",
    config.loaded, config.admin_enabled, config.ui_title
  ));
  *state::lock(&state.config) = config;

  // 主窗口先隐藏创建，等 Node ready 后再导航并显示
  window::create(app)?;
  // 托盘（图标 + 右键菜单 + 左键单击）
  tray::init(app)?;
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
}
