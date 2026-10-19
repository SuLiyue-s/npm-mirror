// Node 子进程管理：启动、stdout/stderr 分流（桥消息 vs 普通日志）、stdin 写命令、
// 崩溃自动重启（最多 3 次，间隔 1s/3s/5s）、优雅退出（shutdown -> 4s 超时 taskkill）。
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdout, Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::logging;
use crate::state::{self, AppState, NodeRuntime};
use crate::{bridge, paths, winutil};

pub const BRIDGE_PREFIX: &str = "@@BRIDGE@@";
/// 崩溃自动重启间隔（毫秒），最多重试 3 次
const RESTART_DELAYS_MS: [u64; 3] = [1_000, 3_000, 5_000];
const MAX_RESTARTS: u32 = 3;
const SHUTDOWN_CMD_TIMEOUT: Duration = Duration::from_secs(2);
const SHUTDOWN_WAIT: Duration = Duration::from_secs(4);

/// 启动 Node 子进程（正式行为 node.exe <appRoot>\src\server.js --desktop --data-dir <dir>）。
/// 测试挂钩：环境变量 MIRROR_DESKTOP_FAKE_NODE 指向一个 js 文件时，用内嵌 node.exe 运行它，
/// 不污染正式启动行为（仅联调/冒烟使用）。
pub fn spawn(app: &AppHandle, exit_tx: mpsc::Sender<i32>) -> Result<(), String> {
  let state = app.state::<AppState>();
  let runtime_dir = state.runtime_dir.clone();
  let app_root = state.app_root.clone();
  let data_dir = state.data_dir_snapshot();
  let node_exe = runtime_dir.join("node.exe");
  if !node_exe.is_file() {
    return Err(format!("运行时缺少 node.exe：{}", node_exe.display()));
  }

  let fake_node: Option<PathBuf> = std::env::var_os("MIRROR_DESKTOP_FAKE_NODE")
    .filter(|value| !value.is_empty())
    .map(PathBuf::from);

  let mut command = Command::new(&node_exe);
  match &fake_node {
    Some(fake_path) => {
      logging::warn(format!(
        "使用测试用假 Node 进程：{}（环境变量 MIRROR_DESKTOP_FAKE_NODE）",
        fake_path.display()
      ));
      command.arg(fake_path);
    }
    None => {
      let server_js = app_root.join("src").join("server.js");
      if !server_js.is_file() {
        return Err(format!("运行时缺少 src/server.js：{}", server_js.display()));
      }
      command.arg(&server_js);
    }
  }
  command
    .arg("--desktop")
    .arg("--data-dir")
    .arg(&data_dir)
    .current_dir(&app_root)
    .env("MIRROR_DESKTOP", "1")
    .env("MIRROR_DATA_DIR", &data_dir)
    .env("MIRROR_APP_ROOT", &app_root)
    .env("MIRROR_PRODUCT_NAME", &state.product_name)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  {
    use std::os::windows::process::CommandExt;
    command.creation_flags(winutil::CREATE_NO_WINDOW);
  }

  let mut child = command
    .spawn()
    .map_err(|e| format!("启动 Node 子进程失败：{e}"))?;
  let pid = child.id();
  let stdin = child.stdin.take().ok_or_else(|| "无法获取 Node stdin".to_string())?;
  let stdout = child.stdout.take().ok_or_else(|| "无法获取 Node stdout".to_string())?;
  let stderr = child.stderr.take().ok_or_else(|| "无法获取 Node stderr".to_string())?;
  let stdin_shared = Arc::new(Mutex::new(Some(stdin)));
  state.set_node(NodeRuntime {
    pid,
    stdin: stdin_shared,
    ready: false,
    internal_port: None,
    url: None,
    data_dir: None,
    version: None,
  });
  logging::info(format!(
    "Node 子进程已启动：pid={pid} node={} appRoot={} dataDir={}",
    node_exe.display(),
    app_root.display(),
    data_dir.display()
  ));

  // stdout 读线程：桥消息交给 bridge，其余按行写 desktop.log
  let app_out = app.clone();
  thread::spawn(move || read_stdout(app_out, stdout));
  // stderr 读线程：统一写 desktop.log
  let app_err = app.clone();
  thread::spawn(move || read_stderr(app_err, stderr));
  // 退出等待线程：把退出码发给监控线程（避免监控线程阻塞在 child.wait 上无法接收新子进程）
  let app_wait = app.clone();
  thread::spawn(move || {
    let code = match child.wait() {
      Ok(status) => status.code().unwrap_or(-1),
      Err(err) => {
        logging::warn(format!("等待 Node 子进程退出失败：{err}"));
        -1
      }
    };
    let _ = app_wait;
    let _ = exit_tx.send(code);
  });
  Ok(())
}

fn read_stdout(app: AppHandle, stdout: ChildStdout) {
  let reader = BufReader::new(stdout);
  for line in reader.lines() {
    match line {
      Ok(line) => {
        if let Some(payload) = line.strip_prefix(BRIDGE_PREFIX) {
          match serde_json::from_str::<Value>(payload) {
            Ok(message) => bridge::handle_message(&app, message),
            Err(err) => {
              let preview: String = payload.chars().take(300).collect();
              logging::warn(format!("桥消息 JSON 解析失败：{err}；内容：{preview}"));
            }
          }
        } else if !line.trim().is_empty() {
          logging::log("node", &line);
        }
      }
      Err(err) => {
        logging::warn(format!("读取 Node stdout 失败：{err}"));
        break;
      }
    }
  }
}

fn read_stderr(app: AppHandle, stderr: std::process::ChildStderr) {
  let reader = BufReader::new(stderr);
  for line in reader.lines() {
    match line {
      Ok(line) => {
        if !line.trim().is_empty() {
          logging::log("node:stderr", &line);
        }
      }
      Err(err) => {
        logging::warn(format!("读取 Node stderr 失败：{err}"));
        break;
      }
    }
  }
  let _ = app;
}

/// 向 Node 发送桥命令并等待响应（带超时）。
pub fn send_cmd(
  app: &AppHandle,
  method: &str,
  params: Value,
  timeout: Duration,
) -> Result<Value, String> {
  let state = app.state::<AppState>();
  let stdin = state
    .stdin_handle()
    .ok_or_else(|| "Node 进程未运行".to_string())?;
  let id = state.next_cmd_id.fetch_add(1, Ordering::SeqCst);
  let (tx, rx) = mpsc::channel::<Result<Value, String>>();
  state::lock(&state.pending).insert(id, tx);

  let message = json!({
    "type": "cmd",
    "id": id,
    "method": method,
    "params": params,
  });
  let line = format!("{BRIDGE_PREFIX}{message}\n");
  {
    let mut guard = state::lock(&stdin);
    let written = match guard.as_mut() {
      Some(pipe) => pipe
        .write_all(line.as_bytes())
        .and_then(|_| pipe.flush())
        .is_ok(),
      None => false,
    };
    if !written {
      drop(guard);
      state::lock(&state.pending).remove(&id);
      return Err("写入 Node stdin 失败（进程可能已退出）".into());
    }
  }
  logging::log("bridge", format!("-> {method} id={id}"));

  match rx.recv_timeout(timeout) {
    Ok(result) => result,
    Err(mpsc::RecvTimeoutError::Timeout) => {
      state::lock(&state.pending).remove(&id);
      Err(format!(
        "桥命令 {method} 超时（{} 秒）",
        timeout.as_secs()
      ))
    }
    Err(mpsc::RecvTimeoutError::Disconnected) => {
      state::lock(&state.pending).remove(&id);
      Err("Node 桥已断开".into())
    }
  }
}

/// 把 Node 发来的响应交给等待中的发送方。
pub fn resolve_pending(app: &AppHandle, id: u64, result: Result<Value, String>) {
  let state = app.state::<AppState>();
  let mut guard = state::lock(&state.pending);
  if let Some(tx) = guard.remove(&id) {
    let _ = tx.send(result);
  }
}

/// 向 Node 写一条桥消息（响应/事件等）。
pub fn write_message(app: &AppHandle, message: &Value) -> Result<(), String> {
  let state = app.state::<AppState>();
  let stdin = state
    .stdin_handle()
    .ok_or_else(|| "Node 进程未运行".to_string())?;
  let line = format!("{BRIDGE_PREFIX}{message}\n");
  let mut guard = state::lock(&stdin);
  match guard.as_mut() {
    Some(pipe) => pipe
      .write_all(line.as_bytes())
      .and_then(|_| pipe.flush())
      .map_err(|e| format!("写入 Node stdin 失败：{e}")),
    None => Err("Node stdin 已关闭".into()),
  }
}

/// 把托盘操作等桌面侧日志写入 GUI 控制台（桥 cmd console.log，失败只记文件日志）。
pub fn log_to_gui(app: &AppHandle, level: &str, text: impl Into<String>) {
  let app = app.clone();
  let level = level.to_string();
  let text = text.into();
  thread::spawn(move || {
    if let Err(err) = send_cmd(
      &app,
      "console.log",
      json!({ "level": level, "text": text }),
      Duration::from_secs(5),
    ) {
      logging::warn(format!("写入 GUI 控制台失败：{err}"));
    }
  });
}

pub fn node_alive(app: &AppHandle) -> bool {
  let state = app.state::<AppState>();
  match state.node_pid() {
    Some(pid) => winutil::process_alive(pid),
    None => false,
  }
}

pub fn kill_node(app: &AppHandle) {
  let state = app.state::<AppState>();
  if let Some(pid) = state.node_pid() {
    logging::warn(format!("强制结束 Node 进程树：pid={pid}"));
    winutil::kill_process_tree(pid);
  }
}

/// 等待 Node 退出，超时返回 false。
pub fn wait_node_exit(app: &AppHandle, timeout: Duration) -> bool {
  let started = Instant::now();
  while started.elapsed() < timeout {
    if !node_alive(app) {
      return true;
    }
    thread::sleep(Duration::from_millis(80));
  }
  !node_alive(app)
}

fn fail_pending(state: &AppState, message: &str) {
  let mut guard = state::lock(&state.pending);
  for (_, tx) in guard.drain() {
    let _ = tx.send(Err(message.to_string()));
  }
}

/// 保存窗口状态到 desktop.json（退出/重启前调用）。
pub fn save_prefs(app: &AppHandle) {
  let state = app.state::<AppState>();
  let prefs = state::lock(&state.prefs).clone();
  if prefs.width.is_none()
    && prefs.height.is_none()
    && prefs.x.is_none()
    && prefs.y.is_none()
  {
    return;
  }
  if let Err(err) = paths::write_desktop_prefs(&state.home_dir, &prefs) {
    logging::warn(format!("保存窗口状态失败：{err}"));
  }
}

/// 启动崩溃监控线程：Node 退出后自动重启（最多 3 次），3 次仍失败弹原生错误框。
pub fn start_monitor(app: AppHandle, mut exit_rx: mpsc::Receiver<i32>) {
  thread::spawn(move || loop {
    let code = match exit_rx.recv() {
      Ok(code) => code,
      Err(_) => break,
    };
    let state = app.state::<AppState>();
    let exited_pid = state.take_node().map(|node| node.pid).unwrap_or(0);
    logging::warn(format!("Node 子进程退出：pid={exited_pid} code={code}"));
    fail_pending(&state, "Node 进程已退出");
    if state.quitting.load(Ordering::SeqCst) || state.allow_exit.load(Ordering::SeqCst) {
      continue;
    }

    let attempt = state.node_restarts.fetch_add(1, Ordering::SeqCst) + 1;
    if attempt > MAX_RESTARTS {
      logging::error(format!(
        "Node 已连续崩溃 {MAX_RESTARTS} 次，停止自动重启（可通过托盘「重启镜像源服务」或重新打开程序重试）"
      ));
      if state.args.smoke_report.is_none() {
        winutil::message_box(
          format!(
            "镜像源服务启动失败，已连续崩溃 {MAX_RESTARTS} 次。\n\n请查看日志：{}\n\n可稍后右键托盘图标选择「重启镜像源服务」重试。",
            state
              .log_path
              .as_ref()
              .map(|path| path.display().to_string())
              .unwrap_or_else(|| "desktop.log".into())
          ),
          &state.product_name,
          true,
        );
      }
      continue;
    }

    let delay = RESTART_DELAYS_MS[(attempt - 1) as usize];
    logging::info(format!(
      "Node 崩溃，{delay}ms 后自动重启（第 {attempt}/{MAX_RESTARTS} 次）"
    ));
    thread::sleep(Duration::from_millis(delay));
    if state.quitting.load(Ordering::SeqCst) || state.allow_exit.load(Ordering::SeqCst) {
      continue;
    }
    let (tx, new_rx) = mpsc::channel::<i32>();
    match spawn(&app, tx) {
      Ok(()) => {
        exit_rx = new_rx;
      }
      Err(err) => {
        logging::error(format!("自动重启 Node 失败：{err}"));
        if state.args.smoke_report.is_none() {
          winutil::message_box(
            format!("重启镜像源服务失败：{err}"),
            &state.product_name,
            true,
          );
        }
      }
    }
  });
}

/// 优雅退出：shutdown 命令 -> 最多等 4 秒 -> taskkill -> 保存窗口状态 -> 退出。
pub fn shutdown_and_exit(app: &AppHandle, exit_code: i32) {
  let state = app.state::<AppState>();
  if state.quitting.swap(true, Ordering::SeqCst) {
    return;
  }
  let app = app.clone();
  thread::spawn(move || {
    logging::info(format!("开始退出程序（code={exit_code}）"));
    if node_alive(&app) {
      match send_cmd(&app, "shutdown", json!({}), SHUTDOWN_CMD_TIMEOUT) {
        Ok(value) => logging::info(format!("Node 已确认 shutdown：{value}")),
        Err(err) => logging::warn(format!("向 Node 发送 shutdown 失败或超时：{err}")),
      }
      if !wait_node_exit(&app, SHUTDOWN_WAIT) {
        logging::warn("Node 未在 4 秒内退出，执行 taskkill 兜底");
        kill_node(&app);
        let _ = wait_node_exit(&app, Duration::from_secs(2));
      }
    }
    kill_node(&app);
    save_prefs(&app);
    let state = app.state::<AppState>();
    state.allow_exit.store(true, Ordering::SeqCst);
    logging::info("桌面程序退出");
    app.exit(exit_code);
  });
}

/// 重启程序（代码更新/切换数据目录后使用）：先优雅关 Node，再 app.restart()。
pub fn restart_app(app: &AppHandle) {
  let state = app.state::<AppState>();
  if state.quitting.swap(true, Ordering::SeqCst) {
    return;
  }
  let app = app.clone();
  thread::spawn(move || {
    logging::info("开始重启桌面程序");
    if node_alive(&app) {
      let _ = send_cmd(&app, "shutdown", json!({}), SHUTDOWN_CMD_TIMEOUT);
      if !wait_node_exit(&app, SHUTDOWN_WAIT) {
        kill_node(&app);
      }
    }
    kill_node(&app);
    save_prefs(&app);
    app
      .state::<AppState>()
      .allow_exit
      .store(true, Ordering::SeqCst);
    logging::info("退出旧进程并重启");
    app.restart();
  });
}
