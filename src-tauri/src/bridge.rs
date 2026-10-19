// 桥协议处理（DESIGN 第 6 节）：
//   Node -> Rust：ready / req / event / bye
//   Rust -> Node：res / cmd
// 这里只处理 Node 主动发来的消息；Rust 发命令的等待逻辑在 node_proc::send_cmd。
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::state::AppState;
use crate::{autostart, dialog, logging, node_proc, paths, tray, window, winutil};
use crate::dialog::DialogOutcome;
use crate::winutil::HWND;

struct BridgeError {
  code: &'static str,
  message: String,
}

impl BridgeError {
  fn new(code: &'static str, message: impl Into<String>) -> Self {
    Self {
      code,
      message: message.into(),
    }
  }
}

pub fn handle_message(app: &AppHandle, message: Value) {
  let kind = message
    .get("type")
    .and_then(|value| value.as_str())
    .unwrap_or("");
  match kind {
    "ready" => handle_ready(app, &message),
    "res" => handle_response(app, &message),
    "req" => {
      // 对话框等操作可能阻塞数分钟，必须放到独立线程处理，不能卡住 stdout 读线程。
      let app = app.clone();
      thread::spawn(move || handle_request(&app, message));
    }
    "event" => handle_event(app, &message),
    "bye" => logging::info(format!("收到 Node 的 bye 消息：{message}")),
    other => logging::warn(format!("收到未知类型的桥消息：{other}（{message}）")),
  }
}

fn handle_response(app: &AppHandle, message: &Value) {
  let id = message.get("id").and_then(|value| value.as_u64()).unwrap_or(0);
  let ok = message.get("ok").and_then(|value| value.as_bool()).unwrap_or(false);
  let result = if ok {
    Ok(message
      .get("data")
      .cloned()
      .unwrap_or_else(|| json!({})))
  } else {
    Err(error_message(message))
  };
  node_proc::resolve_pending(app, id, result);
}

fn error_message(message: &Value) -> String {
  let error = message.get("error");
  let code = error
    .and_then(|value| value.get("code"))
    .and_then(|value| value.as_str())
    .unwrap_or("");
  let text = error
    .and_then(|value| value.get("message"))
    .and_then(|value| value.as_str())
    .unwrap_or("Node 返回未知错误");
  if code.is_empty() {
    text.to_string()
  } else {
    format!("[{code}] {text}")
  }
}

fn handle_ready(app: &AppHandle, message: &Value) {
  let state = app.state::<AppState>();
  let port = message
    .get("internalAdminPort")
    .and_then(|value| value.as_u64())
    .unwrap_or(0);
  if port == 0 || port > u16::MAX as u64 {
    logging::error(format!("ready 消息缺少有效的 internalAdminPort：{message}"));
    return;
  }
  let port = port as u16;
  let url = format!("http://127.0.0.1:{port}/");
  let version = message
    .get("version")
    .and_then(|value| value.as_str())
    .map(str::to_string);
  let node_data_dir = message
    .get("dataDir")
    .and_then(|value| value.as_str())
    .map(str::to_string);
  let was_restart = state.node_restarts.load(Ordering::SeqCst) > 0;

  state.mark_node_ready(port, url.clone(), node_data_dir, version);
  if let Some(web_admin) = message.get("webAdmin") {
    let enabled = web_admin
      .get("enabled")
      .and_then(|value| value.as_bool())
      .unwrap_or(false);
    let web_url = web_admin
      .get("url")
      .and_then(|value| value.as_str())
      .map(str::to_string);
    state.update_web_admin(enabled, web_url);
  }
  state.node_restarts.store(0, Ordering::SeqCst);
  logging::info(format!(
    "Node ready：internalAdminPort={port} url={url} webAdmin={:?}",
    state.web_admin_snapshot()
  ));

  window::navigate(app, &url);
  window::apply_title(app);
  // 菜单项显示条件：Node 报告的网页版管理监听状态 或 配置里 admin.enabled=true（取或）
  let menu_enabled = state.web_admin_snapshot().enabled || state.config_snapshot().admin_enabled;
  if let Err(err) = tray::rebuild(app, menu_enabled) {
    logging::warn(format!("Node ready 后刷新托盘菜单失败：{err}"));
  }

  if was_restart {
    if state.window_visible.load(Ordering::SeqCst) {
      window::show(app);
    }
  } else if state.args.autostart {
    logging::info("--autostart 启动：主窗口保持隐藏，可通过托盘打开");
  } else {
    window::show(app);
  }
}

fn handle_event(app: &AppHandle, message: &Value) {
  let method = message
    .get("method")
    .and_then(|value| value.as_str())
    .unwrap_or("");
  let params = message
    .get("params")
    .cloned()
    .unwrap_or_else(|| json!({}));
  match method {
    "webAdminChanged" => {
      let state = app.state::<AppState>();
      let enabled = params
        .get("enabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
      let url = params
        .get("url")
        .and_then(|value| value.as_str())
        .map(str::to_string);
      state.update_web_admin(enabled, url.clone());
      logging::info(format!(
        "网页版管理状态变化：enabled={enabled} url={url:?}"
      ));
      if let Err(err) = tray::rebuild(app, enabled) {
        logging::warn(format!("刷新托盘菜单失败：{err}"));
      }
    }
    "console" => {
      let level = params
        .get("level")
        .and_then(|value| value.as_str())
        .unwrap_or("info");
      let text = params
        .get("text")
        .and_then(|value| value.as_str())
        .unwrap_or("");
      logging::log("node:console", format!("[{level}] {text}"));
    }
    other => logging::warn(format!("收到未知的桥事件：{other}（{params}）")),
  }
}

fn main_window_hwnd(app: &AppHandle) -> Option<HWND> {
  app
    .get_webview_window("main")
    .and_then(|window| window.hwnd().ok())
}

fn handle_request(app: &AppHandle, message: Value) {
  let id = message.get("id").and_then(|value| value.as_u64()).unwrap_or(0);
  let method = message
    .get("method")
    .and_then(|value| value.as_str())
    .unwrap_or("")
    .to_string();
  let params = message
    .get("params")
    .cloned()
    .unwrap_or_else(|| json!({}));
  logging::log("bridge", format!("<- Node 请求 {method} id={id}"));
  let result = dispatch(app, &method, &params);
  let response = match &result {
    Ok(data) => json!({ "type": "res", "id": id, "ok": true, "data": data }),
    Err(err) => json!({
      "type": "res",
      "id": id,
      "ok": false,
      "error": { "code": err.code, "message": err.message },
    }),
  };
  if let Err(write_err) = node_proc::write_message(app, &response) {
    logging::warn(format!("写回 Node 响应失败（{method} id={id}）：{write_err}"));
  }
  if let Ok(data) = &result {
    logging::log("bridge", format!("-> Node 响应 {method} id={id} data={data}"));
  }
}

fn dispatch(app: &AppHandle, method: &str, params: &Value) -> Result<Value, BridgeError> {
  let state = app.state::<AppState>();
  match method {
    "pickFolder" => {
      let title = params
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("选择主数据目录");
      let initial_dir = params
        .get("initialDir")
        .and_then(|value| value.as_str())
        .map(str::to_string);
      let outcome = dialog::pick_folder(main_window_hwnd(app), title, initial_dir.as_deref());
      dialog_result(outcome)
    }
    "pickFile" => {
      let title = params
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("选择离线包文件");
      let initial_dir = params
        .get("initialDir")
        .and_then(|value| value.as_str())
        .map(str::to_string);
      let extensions: Vec<String> = params
        .get("filters")
        .and_then(|value| value.as_array())
        .map(|items| {
          items
            .iter()
            .filter_map(|item| item.as_str())
            .map(|ext| format!("*.{}", ext.trim_start_matches('.').trim()))
            .filter(|spec| spec.len() > 2)
            .collect()
        })
        .unwrap_or_default();
      let patterns = if extensions.is_empty() {
        "*.tgz;*.gz".to_string()
      } else {
        extensions.join(";")
      };
      let outcome = dialog::pick_file(
        main_window_hwnd(app),
        title,
        initial_dir.as_deref(),
        vec![("离线包文件".to_string(), patterns)],
      );
      dialog_result(outcome)
    }
    "setDataDir" => {
      let raw = params
        .get("dir")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
      if raw.is_empty() {
        return Err(BridgeError::new("EINVAL", "数据目录不能为空"));
      }
      let dir = std::path::PathBuf::from(&raw);
      paths::validate_data_dir(&dir)
        .map_err(|err| BridgeError::new("EINVALID", format!("数据目录校验失败：{err}")))?;
      // 指针文件写入失败不致命：本次运行仍切换成功，只是下次启动可能回退（受限环境常见）
      match paths::write_pointer(&state.home_dir, &dir) {
        Ok(()) => {}
        Err(err) => {
          logging::warn(format!(
            "写入数据目录指针失败（本次切换仍生效，重启后可能回退）：{err}"
          ));
          node_proc::log_to_gui(
            app,
            "warn",
            format!("写入数据目录指针失败（重启后可能回退）：{err}"),
          );
        }
      }
      state.set_data_dir(dir.clone(), "pointer");
      logging::info(format!("主数据目录已切换为：{}（即将重启程序）", dir.display()));
      node_proc::log_to_gui(app, "info", format!("主数据目录已切换为：{}，程序即将重启", dir.display()));
      // 先返回响应，再延迟重启，避免 Node 侧请求超时
      let app_clone = app.clone();
      thread::spawn(move || {
        thread::sleep(Duration::from_millis(300));
        node_proc::restart_app(&app_clone);
      });
      Ok(json!({ "ok": true, "restarting": true }))
    }
    "autostart.get" => Ok(json!({
      "enabled": autostart::is_enabled(),
      "exe": paths::exe_path().to_string_lossy(),
      "matchesExe": autostart::matches_current_exe(),
    })),
    "autostart.set" => {
      let enabled = params
        .get("enabled")
        .and_then(|value| value.as_bool())
        .ok_or_else(|| BridgeError::new("EINVAL", "缺少 enabled 参数"))?;
      let actual = autostart::set_enabled(enabled)
        .map_err(|err| BridgeError::new("EREG", err))?;
      logging::info(format!("开机自启已{}", if actual { "开启" } else { "关闭" }));
      node_proc::log_to_gui(
        app,
        "info",
        format!("开机自启已{}", if actual { "开启" } else { "关闭" }),
      );
      Ok(json!({ "enabled": actual }))
    }
    "openPath" => {
      let target = params
        .get("target")
        .and_then(|value| value.as_str())
        .unwrap_or("data");
      let url_param = params
        .get("url")
        .and_then(|value| value.as_str())
        .map(str::to_string);
      let path = match target {
        "data" => state.data_dir_snapshot(),
        "logs" => state.home_dir.clone(),
        "config" => state.data_dir_snapshot().join("config.json"),
        "exeDir" => paths::exe_dir(),
        "webAdmin" => {
          let url = url_param
            .or_else(|| state.web_admin_snapshot().url)
            .ok_or_else(|| BridgeError::new("EWEBADMIN", "网页版管理未开启"))?;
          return open_target(&url);
        }
        "url" => {
          let url = url_param
            .ok_or_else(|| BridgeError::new("EINVAL", "openPath(url) 缺少 url 参数"))?;
          return open_target(&url);
        }
        other => {
          return Err(BridgeError::new(
            "EINVAL",
            format!("未知的 openPath target：{other}"),
          ))
        }
      };
      open_target(&path.to_string_lossy())
    }
    "app.info" => Ok(json!({
      "desktop": true,
      "productName": state.product_name,
      "version": state.version,
      "platform": "windows",
      "pid": std::process::id(),
      "exePath": paths::exe_path().to_string_lossy(),
      "exeDir": paths::exe_dir().to_string_lossy(),
      "appRoot": state.app_root.to_string_lossy(),
      "runtimeDir": state.runtime_dir.to_string_lossy(),
      "dataDir": state.data_dir_snapshot().to_string_lossy(),
      "dataDirSource": state.data_dir_source_snapshot(),
      "dataDirDefault": paths::exe_dir().join("data").to_string_lossy(),
      "homeDir": state.home_dir.to_string_lossy(),
      "homeFallback": state.home_fallback,
      "homeWarnings": state.home_warnings,
      // restricted = 配置目录回退或托盘不可用；tray.created=已尝试注册，tray.available=确认成功
      "restricted": state.restricted(),
      "tray": {
        "created": state.tray_created(),
        "available": state.tray_available(),
        "error": state.tray_error_snapshot(),
        "labels": tray::labels_snapshot(),
      },
      "webview2Version": winutil::webview2_version(),
      // 完整性标签自检：token/file 级别、是否提权、修复提示状态（排错用）
      "integrity": state.integrity.to_json(),
      "logPath": state.log_path.as_ref().map(|path| path.to_string_lossy().to_string()),
      "autostart": autostart::is_enabled(),
    })),
    "app.restart" => {
      logging::info("收到 app.restart 请求，准备重启程序");
      let app_clone = app.clone();
      thread::spawn(move || {
        thread::sleep(Duration::from_millis(300));
        node_proc::restart_app(&app_clone);
      });
      Ok(json!({ "restarting": true }))
    }
    "app.quit" => {
      logging::info("收到 app.quit 请求，准备退出程序");
      let app_clone = app.clone();
      thread::spawn(move || {
        thread::sleep(Duration::from_millis(300));
        node_proc::shutdown_and_exit(&app_clone, 0);
      });
      Ok(json!({ "quitting": true }))
    }
    "window.show" => {
      window::show(app);
      Ok(json!({ "ok": true }))
    }
    "window.hide" => {
      window::hide(app);
      Ok(json!({ "ok": true }))
    }
    other => Err(BridgeError::new(
      "EMETHOD",
      format!("桌面桥不支持的方法：{other}"),
    )),
  }
}

fn dialog_result(outcome: DialogOutcome) -> Result<Value, BridgeError> {
  match outcome {
    DialogOutcome::Picked(path) => Ok(json!({ "path": path.to_string_lossy() })),
    DialogOutcome::Canceled => Ok(json!({ "canceled": true })),
    DialogOutcome::Failed(message) => Err(BridgeError::new("EDIALOG", message)),
  }
}

fn open_target(path: &str) -> Result<Value, BridgeError> {
  if winutil::open_path(path) {
    Ok(json!({ "opened": true }))
  } else {
    Err(BridgeError::new("EOPEN", format!("无法打开：{path}")))
  }
}
