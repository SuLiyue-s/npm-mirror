// 桌面壳全局状态：数据目录、配置快照、Node 进程句柄、桥请求等待表、冒烟测试状态等。
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::ChildStdin;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use serde_json::Value;

use crate::integrity::IntegrityStatus;
use crate::paths::DesktopPrefs;

/// 加锁辅助：互斥体中毒时取回内部数据，避免一次 panic 让整个桌面壳不可用。
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Debug, Default)]
pub struct StartupArgs {
  /// --data-dir 指定主数据目录
  pub data_dir: Option<PathBuf>,
  /// --autostart 开机自启启动：窗口默认隐藏
  pub autostart: bool,
  /// --repair-integrity：提权修复实例入口（移除 exe 的低完整性标签后重启）
  pub repair_integrity: bool,
  /// --skip-integrity-prompt：测试/自动化用，跳过低完整性标签修复询问框
  pub skip_integrity_prompt: bool,
  /// 冒烟测试：状态报告输出文件（测试专用，正式环境为空）
  pub smoke_report: Option<PathBuf>,
  /// 冒烟测试：命令文件，每行一个命令（show/hide/quit/restart-registry...）
  pub smoke_cmd: Option<PathBuf>,
}

#[derive(Clone, Debug, Default)]
pub struct UiConfig {
  /// 是否已成功读取过 config.json
  pub loaded: bool,
  /// config.json 的 admin.enabled
  pub admin_enabled: bool,
  /// config.json 的 ui.title（为空则回退产品名）
  pub ui_title: Option<String>,
  /// config.json 路径
  pub source_path: Option<PathBuf>,
}

#[derive(Clone, Debug, Default)]
pub struct WebAdminState {
  pub enabled: bool,
  pub url: Option<String>,
}

/// Node 子进程运行信息
pub struct NodeRuntime {
  pub pid: u32,
  pub stdin: Arc<Mutex<Option<ChildStdin>>>,
  /// 是否已经收到 ready 消息
  pub ready: bool,
  /// 内部管理端口（127.0.0.1:0 随机）
  pub internal_port: Option<u16>,
  /// GUI 加载地址 http://127.0.0.1:<port>/
  pub url: Option<String>,
  /// Node 报告的 dataDir
  pub data_dir: Option<String>,
  /// Node 报告的版本号
  pub version: Option<String>,
}

pub struct AppState {
  /// 桌面配置目录（正常情况下 %LOCALAPPDATA%\LiYueNpmMirror，受限环境自动回退）
  pub home_dir: PathBuf,
  /// 配置目录是否发生回退（未使用首选用户配置目录）
  pub home_fallback: bool,
  /// 配置目录回退过程中的探测告警（供日志/冒烟报告）
  pub home_warnings: Vec<String>,
  /// 当前主数据目录
  pub data_dir: Mutex<PathBuf>,
  /// 主数据目录来源（cli/env/pointer/default）
  pub data_dir_source: Mutex<String>,
  /// runtime 根目录（含 node.exe 与 app/）
  pub runtime_dir: PathBuf,
  /// app 根目录（src/server.js 所在层级）
  pub app_root: PathBuf,
  pub product_name: String,
  pub version: String,
  pub args: StartupArgs,
  pub config: Mutex<UiConfig>,
  pub web_admin: Mutex<WebAdminState>,
  pub node: Mutex<Option<NodeRuntime>>,
  /// 桥命令 id 生成器（单调递增）
  pub next_cmd_id: AtomicU64,
  /// 等待 Node 响应的桥请求：id -> 结果通道
  pub pending: Mutex<HashMap<u64, Sender<Result<Value, String>>>>,
  /// 窗口当前是否可见
  pub window_visible: AtomicBool,
  /// 是否正在退出（退出流程开始后不再自动重启 Node）
  pub quitting: AtomicBool,
  /// 是否允许 Tauri 真正退出（RunEvent 中用于拦截 Alt+F4/任务栏关闭）
  pub allow_exit: AtomicBool,
  /// Node 崩溃自动重启次数
  pub node_restarts: AtomicU32,
  /// 托盘菜单项文本（冒烟证据用）
  pub tray_labels: Mutex<Vec<String>>,
  /// 托盘图标当前是否确认注册成功（Shell_NotifyIconW NIM_ADD 返回 TRUE）
  pub tray_available: AtomicBool,
  /// 是否已尝试过托盘注册（无论成败；冒烟报告的 tray.created）
  pub tray_created: AtomicBool,
  /// 托盘注册失败原因（成功时为空字符串）
  pub tray_error: Mutex<String>,
  /// 冒烟命令 window:close 触发的退出（由退出流程判定是否清空托盘）
  pub smoke_intent_close: AtomicBool,
  /// 冒烟测试命令执行记录
  pub smoke_commands: Mutex<Vec<Value>>,
  /// 窗口位置/大小（退出时写 desktop.json）
  pub prefs: Mutex<DesktopPrefs>,
  /// 桌面日志路径
  pub log_path: Option<PathBuf>,
  /// 启动时的完整性标签检测结果（低完整性/提权/修复提示状态）
  pub integrity: IntegrityStatus,
  pub started_at: Instant,
}

impl AppState {
  #[allow(clippy::too_many_arguments)]
  pub fn new(
    home_dir: PathBuf,
    home_fallback: bool,
    home_warnings: Vec<String>,
    data_dir: PathBuf,
    data_dir_source: String,
    runtime_dir: PathBuf,
    app_root: PathBuf,
    args: StartupArgs,
    log_path: Option<PathBuf>,
    integrity: IntegrityStatus,
  ) -> Self {
    Self {
      home_dir,
      home_fallback,
      home_warnings,
      data_dir: Mutex::new(data_dir),
      data_dir_source: Mutex::new(data_dir_source),
      runtime_dir,
      app_root,
      product_name: crate::paths::PRODUCT_NAME.to_string(),
      version: env!("CARGO_PKG_VERSION").to_string(),
      args,
      config: Mutex::new(UiConfig::default()),
      web_admin: Mutex::new(WebAdminState::default()),
      node: Mutex::new(None),
      next_cmd_id: AtomicU64::new(1),
      pending: Mutex::new(HashMap::new()),
      window_visible: AtomicBool::new(false),
      quitting: AtomicBool::new(false),
      allow_exit: AtomicBool::new(false),
      node_restarts: AtomicU32::new(0),
      tray_labels: Mutex::new(Vec::new()),
      tray_available: AtomicBool::new(false),
      tray_created: AtomicBool::new(false),
      tray_error: Mutex::new(String::new()),
      smoke_intent_close: AtomicBool::new(false),
      smoke_commands: Mutex::new(Vec::new()),
      prefs: Mutex::new(DesktopPrefs::default()),
      log_path,
      integrity,
      started_at: Instant::now(),
    }
  }

  pub fn data_dir_snapshot(&self) -> PathBuf {
    lock(&self.data_dir).clone()
  }

  pub fn set_data_dir(&self, dir: PathBuf, source: &str) {
    *lock(&self.data_dir) = dir;
    *lock(&self.data_dir_source) = source.to_string();
  }

  pub fn data_dir_source_snapshot(&self) -> String {
    lock(&self.data_dir_source).clone()
  }

  pub fn node_pid(&self) -> Option<u32> {
    lock(&self.node).as_ref().map(|node| node.pid)
  }

  pub fn stdin_handle(&self) -> Option<Arc<Mutex<Option<ChildStdin>>>> {
    lock(&self.node).as_ref().map(|node| node.stdin.clone())
  }

  pub fn set_node(&self, runtime: NodeRuntime) {
    *lock(&self.node) = Some(runtime);
  }

  pub fn take_node(&self) -> Option<NodeRuntime> {
    lock(&self.node).take()
  }

  pub fn mark_node_ready(&self, port: u16, url: String, shared_dir: Option<String>, version: Option<String>) {
    if let Some(node) = lock(&self.node).as_mut() {
      node.ready = true;
      node.internal_port = Some(port);
      node.url = Some(url);
      node.data_dir = shared_dir;
      node.version = version;
    }
  }

  /// 当前内部管理地址（端口 + 含令牌的完整 URL），供托盘重启后校验/冒烟报告读取。
  pub fn internal_admin_snapshot(&self) -> Option<(u16, String)> {
    lock(&self.node).as_ref().and_then(|node| {
      match (node.internal_port, node.url.clone()) {
        (Some(port), Some(url)) => Some((port, url)),
        _ => None,
      }
    })
  }

  /// 托盘「重启窗口的管理界面」成功后更新内部管理端口/URL，使 smoke 报告与 app.info 读到最新值。
  pub fn update_internal_admin(&self, port: u16, url: String) {
    if let Some(node) = lock(&self.node).as_mut() {
      node.internal_port = Some(port);
      node.url = Some(url);
    }
  }

  pub fn update_web_admin(&self, enabled: bool, url: Option<String>) {
    let mut guard = lock(&self.web_admin);
    guard.enabled = enabled;
    guard.url = url;
  }

  pub fn web_admin_snapshot(&self) -> WebAdminState {
    lock(&self.web_admin).clone()
  }

  /// 托盘图标是否已成功注册。
  pub fn tray_available(&self) -> bool {
    self.tray_available.load(Ordering::SeqCst)
  }

  /// 标记已尝试过托盘注册（用于冒烟报告 tray.created）。
  pub fn mark_tray_attempted(&self) {
    self.tray_created.store(true, Ordering::SeqCst);
  }

  pub fn tray_created(&self) -> bool {
    self.tray_created.load(Ordering::SeqCst)
  }

  /// 更新托盘注册状态与失败原因。
  pub fn set_tray_available(&self, available: bool, error: String) {
    self.tray_available.store(available, Ordering::SeqCst);
    *lock(&self.tray_error) = error;
  }

  pub fn tray_error_snapshot(&self) -> String {
    lock(&self.tray_error).clone()
  }

  /// 受限启动环境：配置目录回退或托盘不可用。
  pub fn restricted(&self) -> bool {
    self.home_fallback || !self.tray_available()
  }

  /// 标记冒烟命令 window:close 触发的关闭（退出流程据此清空托盘图标）。
  pub fn mark_smoke_intent_close(&self) {
    self.smoke_intent_close.store(true, Ordering::SeqCst);
  }

  pub fn config_snapshot(&self) -> UiConfig {
    lock(&self.config).clone()
  }

  /// 窗口标题：config.json 的 ui.title 优先，否则产品名。
  pub fn window_title(&self) -> String {
    lock(&self.config)
      .ui_title
      .clone()
      .filter(|title| !title.trim().is_empty())
      .unwrap_or_else(|| self.product_name.clone())
  }
}
