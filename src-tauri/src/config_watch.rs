// 配置监听：每秒轮询 <数据目录>\config.json 的 admin.enabled 与 ui.title，
// 变化时立即刷新托盘菜单与窗口标题（另配合 Node 的 webAdminChanged 事件即时刷新）。
use std::path::Path;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::state::{self, AppState, UiConfig};
use crate::{logging, tray, window};

/// 读取并解析 config.json 中桌面壳关心的字段。
pub fn read_ui_config(data_dir: &Path) -> UiConfig {
  let path = data_dir.join("config.json");
  let Ok(text) = std::fs::read_to_string(&path) else {
    return UiConfig {
      source_path: Some(path),
      ..Default::default()
    };
  };
  match serde_json::from_str::<serde_json::Value>(&text) {
    Ok(value) => {
      let admin_enabled = value
        .pointer("/admin/enabled")
        .and_then(|item| item.as_bool())
        .unwrap_or(false);
      let ui_title = value
        .pointer("/ui/title")
        .and_then(|item| item.as_str())
        .map(|title| title.trim().to_string())
        .filter(|title| !title.is_empty());
      UiConfig {
        loaded: true,
        admin_enabled,
        ui_title,
        source_path: Some(path),
      }
    }
    Err(err) => {
      logging::warn(format!("解析 config.json 失败（{}）：{err}", path.display()));
      UiConfig {
        source_path: Some(path),
        ..Default::default()
      }
    }
  }
}

/// 立即读取一次配置；返回是否有变化。供单测/冒烟直接调用。
pub fn poll_with_state(state: &AppState) -> bool {
  let dir = state.data_dir_snapshot();
  let next = read_ui_config(&dir);
  let mut changed = false;
  {
    let mut current = state::lock(&state.config);
    if !current.loaded
      || current.admin_enabled != next.admin_enabled
      || current.ui_title != next.ui_title
      || current.source_path != next.source_path
    {
      *current = next.clone();
      changed = true;
    }
  }
  if changed {
    logging::info(format!(
      "config.json 变化：admin.enabled={} ui.title={:?}",
      next.admin_enabled, next.ui_title
    ));
  }
  changed
}

/// 轮询一次并应用副作用（窗口标题/托盘菜单）。
pub fn poll_once(app: &AppHandle) -> bool {
  let state = app.state::<AppState>();
  let changed = poll_with_state(&state);
  if changed {
    window::apply_title(app);
    // 「重启管理界面」菜单项依据「配置开启 或 管理界面监听已开启」显示：
    // 配置文件是用户预期，webAdminChanged 事件反映实际监听状态，两者取或更稳健。
    let config = state.config_snapshot();
    let web_admin_enabled = state.web_admin_snapshot().enabled;
    let menu_enabled = config.admin_enabled || web_admin_enabled;
    if let Err(err) = tray::rebuild(app, menu_enabled) {
      logging::warn(format!("刷新托盘菜单失败：{err}"));
    }
  }
  changed
}

/// 启动后台 1 秒轮询线程（应用退出时自动结束）。
pub fn start(app: AppHandle) {
  std::thread::spawn(move || loop {
    std::thread::sleep(Duration::from_secs(1));
    let state = app.state::<AppState>();
    if state.allow_exit.load(std::sync::atomic::Ordering::SeqCst) {
      break;
    }
    poll_once(&app);
  });
}
