// 冒烟测试挂钩（仅环境变量 MIRROR_DESKTOP_SMOKE=1 时启用）：
// 1) 周期性把运行状态写成 JSON 报告文件（--smoke-report）；
// 2) 轮询命令文件（--smoke-cmd），执行 show/hide/quit/menu:* 等测试动作，
//    用于在无头/自动化环境里验证窗口、托盘、退出等行为。
// 正式运行（未设置 MIRROR_DESKTOP_SMOKE）时本模块不产生任何行为。
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::state::{self, AppState};
use crate::{autostart, config_watch, logging, node_proc, paths, tray, window};

pub fn enabled() -> bool {
  matches!(std::env::var("MIRROR_DESKTOP_SMOKE").ok().as_deref(), Some("1"))
}

pub fn start(app: AppHandle) {
  if !enabled() {
    return;
  }
  let state = app.state::<AppState>();
  let report_path = state.args.smoke_report.clone();
  let command_path = state.args.smoke_cmd.clone();
  logging::info(format!(
    "冒烟测试模式已启用：report={report_path:?} cmd={command_path:?}"
  ));
  let started = Instant::now();
  thread::spawn(move || {
    let mut last_report = String::new();
    let mut last_command_text = String::new();
    loop {
      {
        let state = app.state::<AppState>();
        if state.allow_exit.load(Ordering::SeqCst) {
          break;
        }
      }
      if let Some(path) = &command_path {
        run_commands(&app, path, &mut last_command_text);
      }
      if let Some(path) = &report_path {
        let report = build_report(&app, started.elapsed());
        let text = format!(
          "{}\n",
          serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".to_string())
        );
        if text != last_report {
          if let Err(err) = std::fs::write(path, &text) {
            logging::warn(format!("写入冒烟报告失败：{err}"));
          } else {
            last_report = text;
          }
        }
      }
      thread::sleep(Duration::from_millis(400));
    }
    logging::info("冒烟测试线程结束（allow_exit=true）");
  });
}

fn run_commands(app: &AppHandle, path: &PathBuf, last_text: &mut String) {
  // 只执行「追加的新行」：命令文件由测试脚本逐行 append，避免每次文件变化都重复执行旧命令。
  let Ok(raw) = std::fs::read_to_string(path) else {
    return;
  };
  let text = raw.trim_start_matches('\u{feff}').to_string();
  if text == *last_text {
    return;
  }
  let segment = if text.starts_with(last_text.as_str()) {
    &text[last_text.len()..]
  } else {
    // 文件被重写/清空：内容全部视为新命令
    text.as_str()
  };
  for line in segment.lines() {
    let command = line.trim();
    if command.is_empty() || command.starts_with('#') {
      continue;
    }
    let (ok, detail) = execute_command(app, command);
    logging::info(format!("冒烟命令：{command} -> ok={ok} {detail}"));
    let state = app.state::<AppState>();
    state::lock(&state.smoke_commands).push(json!({
      "command": command,
      "ok": ok,
      "detail": detail,
      "atSecs": state.started_at.elapsed().as_secs_f64(),
    }));
  }
  *last_text = text;
}

fn execute_command(app: &AppHandle, command: &str) -> (bool, String) {
  if let Some(menu_id) = command.strip_prefix("menu:") {
    tray::activate_menu(app, menu_id.trim());
    return (true, format!("托盘菜单 {menu_id}"));
  }
  match command {
    "show" => {
      window::show(app);
      (true, "已显示窗口".to_string())
    }
    "hide" => {
      window::hide(app);
      (true, "已隐藏窗口".to_string())
    }
    "quit" => {
      node_proc::shutdown_and_exit(app, 0);
      (true, "已发起退出流程".to_string())
    }
    "restart-node" => {
      node_proc::kill_node(app);
      (true, "已结束 Node 进程（等待自动重启）".to_string())
    }
    "restart-registry" => {
      let result = node_proc::send_cmd(
        app,
        "restartRegistry",
        json!({}),
        Duration::from_secs(20),
      );
      match result {
        Ok(value) => (true, format!("restartRegistry={value}")),
        Err(err) => (false, err),
      }
    }
    "restart-webadmin" => {
      let result = node_proc::send_cmd(
        app,
        "restartWebAdmin",
        json!({}),
        Duration::from_secs(20),
      );
      match result {
        Ok(value) => {
          let enabled = value
            .get("enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
          let url = value
            .get("url")
            .and_then(|value| value.as_str())
            .map(str::to_string);
          app.state::<AppState>().update_web_admin(enabled, url);
          (true, format!("restartWebAdmin={value}"))
        }
        Err(err) => (false, err),
      }
    }
    "show-webadmin" => {
      let result = node_proc::send_cmd(
        app,
        "showWebAdmin",
        json!({}),
        Duration::from_secs(20),
      );
      match result {
        Ok(value) => (true, format!("showWebAdmin={value}")),
        Err(err) => (false, err),
      }
    }
    "autostart-on" => match autostart::set_enabled(true) {
      Ok(enabled) => (true, format!("开机自启 enabled={enabled}")),
      Err(err) => (false, err),
    },
    "autostart-off" => match autostart::set_enabled(false) {
      Ok(enabled) => (true, format!("开机自启 enabled={enabled}")),
      Err(err) => (false, err),
    },
    "reload-config" => {
      config_watch::poll_once(app);
      (true, "已重新读取 config.json".to_string())
    }
    "renderer-info" => (true, format!("window={:?}", window::current_url(app))),
    other => (false, format!("未知冒烟命令：{other}")),
  }
}

fn build_report(app: &AppHandle, elapsed: Duration) -> Value {
  let state = app.state::<AppState>();
  let config = state.config_snapshot();
  let web_admin = state.web_admin_snapshot();
  let tray_labels = {
    let guard = state::lock(&state.tray_labels);
    guard.clone()
  };
  let commands = {
    let guard = state::lock(&state.smoke_commands);
    guard.clone()
  };
  // 窗口诊断：created/hwnd/visible/url/错误详情/lastAction（用于区分沙箱限制与产品缺陷）
  let mut window_info = window::diagnostics(app);
  if let Some(object) = window_info.as_object_mut() {
    object.insert("title".to_string(), json!(state.window_title()));
    object.insert("stateVisible".to_string(), json!(window::is_visible(app)));
  }
  let (node_pid, node_ready, internal_port, node_url, node_data_dir) = {
    let guard = state::lock(&state.node);
    match guard.as_ref() {
      Some(node) => (
        Some(node.pid),
        node.ready,
        node.internal_port,
        node.url.clone(),
        node.data_dir.clone(),
      ),
      None => (None, false, None, None, None),
    }
  };
  json!({
    "smoke": true,
    "productName": state.product_name,
    "version": state.version,
    "pid": std::process::id(),
    "exePath": paths::exe_path().to_string_lossy(),
    "exeDir": paths::exe_dir().to_string_lossy(),
    "homeDir": state.home_dir.to_string_lossy(),
    "runtimeDir": state.runtime_dir.to_string_lossy(),
    "appRoot": state.app_root.to_string_lossy(),
    "dataDir": state.data_dir_snapshot().to_string_lossy(),
    "dataDirSource": state.data_dir_source_snapshot(),
    "logPath": state.log_path.as_ref().map(|path| path.to_string_lossy().to_string()),
    "uptimeSecs": elapsed.as_secs_f64(),
    "autostart": {
      "enabled": autostart::is_enabled(),
      "matchesExe": autostart::matches_current_exe(),
      "command": autostart::current_command(),
    },
    "node": {
      "pid": node_pid,
      "ready": node_ready,
      "internalAdminPort": internal_port,
      "url": node_url,
      "dataDir": node_data_dir,
      "restarts": state.node_restarts.load(Ordering::SeqCst),
    },
    "window": window_info,
    "webview2Dir": state.home_dir.join("webview2").to_string_lossy(),
    "tray": {
      "id": tray::TRAY_ID,
      "labels": tray_labels,
    },
    "smokeCommandHelp": [
      "show", "hide", "quit", "restart-node", "restart-registry", "restart-webadmin",
      "show-webadmin", "autostart-on", "autostart-off", "reload-config", "renderer-info",
      "menu:tray-open", "menu:tray-hide", "menu:tray-restart-webadmin", "menu:tray-restart-registry"
    ],
    "webAdmin": {
      "enabled": web_admin.enabled,
      "url": web_admin.url,
    },
    "config": {
      "loaded": config.loaded,
      "adminEnabled": config.admin_enabled,
      "uiTitle": config.ui_title,
      "path": config.source_path.as_ref().map(|path| path.to_string_lossy().to_string()),
    },
    "quitting": state.quitting.load(Ordering::SeqCst),
    "allowExit": state.allow_exit.load(Ordering::SeqCst),
    "commands": commands,
  })
}
