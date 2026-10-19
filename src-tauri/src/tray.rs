// 系统托盘：合成图标、动态右键菜单、左键单击显示窗口
// 菜单项：打开窗口 / 关闭窗口 / [打开管理界面 / 重启管理界面（仅网页版管理开启时显示）] /
//         重启镜像源服务 / 退出程序
use std::thread;
use std::time::Duration;

use serde_json::json;
use tauri::image::Image;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::state::{self, AppState};
use crate::{logging, node_proc, window, winutil};

pub const TRAY_ID: &str = "main-tray";
pub const MENU_OPEN: &str = "tray-open";
pub const MENU_HIDE: &str = "tray-hide";
pub const MENU_OPEN_WEBADMIN: &str = "tray-open-webadmin";
pub const MENU_RESTART_WEBADMIN: &str = "tray-restart-webadmin";
pub const MENU_RESTART_REGISTRY: &str = "tray-restart-registry";
pub const MENU_QUIT: &str = "tray-quit";

// 由 tools/compose-desktop-icon.ps1 生成，纯 RGBA 字节（32x32）
static TRAY_ICON: &[u8] = include_bytes!("../icons/tray-32.rgba");

pub fn init(app: &AppHandle) -> Result<(), String> {
  let state = app.state::<AppState>();
  let web_admin_enabled = state.web_admin_snapshot().enabled;
  let menu = build_menu(app, web_admin_enabled)?;
  let tooltip = format!("{}（单击打开窗口）", state.product_name);
  TrayIconBuilder::with_id(TRAY_ID)
    .icon(Image::new(TRAY_ICON, 32, 32))
    .tooltip(tooltip)
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
    .on_tray_icon_event(|tray, event| handle_tray_event(tray, &event))
    .build(app)
    .map_err(|err| format!("创建托盘图标失败：{err}"))?;
  logging::info(format!(
    "托盘图标已创建：{}",
    state::lock(&state.tray_labels).join(" / ")
  ));
  Ok(())
}

fn build_menu(app: &AppHandle, web_admin_enabled: bool) -> Result<Menu<Wry>, String> {
  let create = |id: &str, text: &str| -> Result<MenuItem<Wry>, String> {
    MenuItem::with_id(app, id, text, true, None::<&str>)
      .map_err(|err| format!("创建托盘菜单项 {id} 失败：{err}"))
  };
  let open = create(MENU_OPEN, "打开窗口")?;
  let hide = create(MENU_HIDE, "关闭窗口")?;
  let separator_top = PredefinedMenuItem::separator(app)
    .map_err(|err| format!("创建托盘菜单分隔线失败：{err}"))?;
  let open_web_admin = if web_admin_enabled {
    Some(create(MENU_OPEN_WEBADMIN, "打开管理界面")?)
  } else {
    None
  };
  let restart_web_admin = if web_admin_enabled {
    Some(create(MENU_RESTART_WEBADMIN, "重启管理界面")?)
  } else {
    None
  };
  let restart_registry = create(MENU_RESTART_REGISTRY, "重启镜像源服务")?;
  let separator_bottom = PredefinedMenuItem::separator(app)
    .map_err(|err| format!("创建托盘菜单分隔线失败：{err}"))?;
  let quit = create(MENU_QUIT, "退出程序")?;

  let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![&open, &hide, &separator_top];
  if let Some(item) = &open_web_admin {
    items.push(item);
  }
  if let Some(item) = &restart_web_admin {
    items.push(item);
  }
  items.push(&restart_registry);
  items.push(&separator_bottom);
  items.push(&quit);
  let menu = Menu::with_items(app, &items)
    .map_err(|err| format!("创建托盘菜单失败：{err}"))?;

  // 记录实际菜单项文本，供冒烟测试/日志核对
  let mut labels = vec!["打开窗口".to_string(), "关闭窗口".to_string()];
  if web_admin_enabled {
    labels.push("打开管理界面".to_string());
    labels.push("重启管理界面".to_string());
  }
  labels.push("重启镜像源服务".to_string());
  labels.push("退出程序".to_string());
  let state = app.state::<AppState>();
  *state::lock(&state.tray_labels) = labels;
  Ok(menu)
}

/// 网页版管理开/关变化时重建托盘菜单（目标 <1 秒内出现/消失）。
pub fn rebuild(app: &AppHandle, web_admin_enabled: bool) -> Result<(), String> {
  let menu = build_menu(app, web_admin_enabled)?;
  match app.tray_by_id(TRAY_ID) {
    Some(tray) => {
      tray
        .set_menu(Some(menu))
        .map_err(|err| format!("更新托盘菜单失败：{err}"))?;
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
    None => Err("更新托盘菜单失败：托盘图标不存在".to_string()),
  }
}

fn handle_tray_event(tray: &TrayIcon<Wry>, event: &TrayIconEvent) {
  if let TrayIconEvent::Click {
    button: MouseButton::Left,
    button_state: MouseButtonState::Up,
    ..
  } = event
  {
    let app = tray.app_handle();
    logging::info("托盘左键单击：显示主窗口");
    window::show(app);
  }
}

/// 供冒烟测试模拟点击托盘菜单项。
pub fn activate_menu(app: &AppHandle, id: &str) {
  handle_menu_event(app, id);
}

fn handle_menu_event(app: &AppHandle, id: &str) {
  logging::info(format!("托盘菜单点击：{id}"));
  match id {
    MENU_OPEN => {
      node_proc::log_to_gui(app, "info", "托盘操作：打开窗口");
      window::show(app);
    }
    MENU_HIDE => {
      node_proc::log_to_gui(app, "info", "托盘操作：关闭窗口");
      window::hide(app);
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
