// 低完整性（Low）标签自检与一键修复：
// 用户从受限环境（聊天窗口/沙箱/预览面板）运行 exe 后，程序文件可能被系统继承 Low 完整性标签，
// 导致程序自身无法写入用户配置目录、托盘注册失败等问题。本模块在启动最早期检测并给出修复入口。
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use serde_json::Value;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED, HANDLE};
use windows::Win32::Security::{
  GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenElevation,
  TokenIntegrityLevel, TOKEN_ELEVATION, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::UI::Shell::{
  ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

use crate::paths;
use crate::state::StartupArgs;
use crate::winutil;

/// 低完整性级别 RID（S-1-16-4096）
pub const RID_LOW: u32 = 0x1000;
/// 中完整性级别 RID（S-1-16-8192）
pub const RID_MEDIUM: u32 = 0x2000;
/// 高完整性级别 RID（S-1-16-12288）
pub const RID_HIGH: u32 = 0x3000;

/// 当前进程 token 完整性级别（取 SID 末级 RID：Low=0x1000 / Medium=0x2000）。
pub fn token_integrity_rid() -> Option<u32> {
  unsafe {
    let mut token = HANDLE(std::ptr::null_mut());
    if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
      return None;
    }
    let mut buffer = [0u8; 256];
    let mut needed = 0u32;
    let result = GetTokenInformation(
      token,
      TokenIntegrityLevel,
      Some(buffer.as_mut_ptr() as *mut core::ffi::c_void),
      buffer.len() as u32,
      &mut needed,
    );
    let _ = CloseHandle(token);
    if result.is_err() {
      return None;
    }
    // TOKEN_MANDATORY_LABEL { Label: SID_AND_ATTRIBUTES { Sid, Attributes } }
    let label = buffer.as_ptr() as *const TOKEN_MANDATORY_LABEL;
    let sid = (*label).Label.Sid;
    if sid.0.is_null() {
      return None;
    }
    let count_ptr = GetSidSubAuthorityCount(sid);
    if count_ptr.is_null() {
      return None;
    }
    let count = *count_ptr;
    if count == 0 {
      return None;
    }
    let rid_ptr = GetSidSubAuthority(sid, u32::from(count) - 1);
    if rid_ptr.is_null() {
      return None;
    }
    Some(*rid_ptr)
  }
}

/// 当前进程是否以管理员权限运行（TokenElevation）。
pub fn is_elevated() -> bool {
  unsafe {
    let mut token = HANDLE(std::ptr::null_mut());
    if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
      return false;
    }
    let mut elevation = TOKEN_ELEVATION::default();
    let mut needed = 0u32;
    let result = GetTokenInformation(
      token,
      TokenElevation,
      Some(&mut elevation as *mut TOKEN_ELEVATION as *mut core::ffi::c_void),
      std::mem::size_of::<TOKEN_ELEVATION>() as u32,
      &mut needed,
    );
    let _ = CloseHandle(token);
    result.is_ok() && elevation.TokenIsElevated != 0
  }
}

/// 把完整性 RID 转成可读级别名（用于日志/冒烟报告）。
pub fn level_name(rid: u32) -> String {
  match rid {
    0x0000 => "Untrusted".to_string(),
    RID_LOW => "Low".to_string(),
    RID_MEDIUM => "Medium".to_string(),
    RID_HIGH => "High".to_string(),
    0x4000 => "System".to_string(),
    0x5000 => "Protected".to_string(),
    other => format!("Other({other})"),
  }
}

/// 读取文件完整性标签的结果（file 标签用 icacls 读取，受限进程也可用）。
#[derive(Clone, Debug, Default)]
pub struct FileIntegrity {
  /// "Low" / "Medium" / "High" / "System" / "Unknown"
  pub label: String,
  /// icacls 输出中包含“Mandatory Label”的原始行（便于诊断）
  pub raw: Option<String>,
  /// icacls 执行失败原因（成功则为 None）
  pub error: Option<String>,
}

/// 用 `icacls "<path>"` 读取文件完整性标签（包含 "Low Mandatory" 即低完整性）。
pub fn read_file_integrity(path: &Path) -> FileIntegrity {
  let output = Command::new("icacls")
    .arg(path)
    .creation_flags(winutil::CREATE_NO_WINDOW)
    .output();
  let output = match output {
    Ok(output) => output,
    Err(err) => {
      return FileIntegrity {
        label: "Unknown".to_string(),
        raw: None,
        error: Some(format!("执行 icacls 失败：{err}")),
      };
    }
  };
  let stdout = String::from_utf8_lossy(&output.stdout).to_string();
  let label_line = stdout
    .lines()
    .find(|line| line.contains("Mandatory Label") || line.contains("强制标签"))
    .map(|line| line.trim().to_string());
  let label = match &label_line {
    Some(line) => {
      if line.contains("Low Mandatory") || line.contains("低强制性级别") || line.contains("低完整性") {
        "Low"
      } else if line.contains("Medium Mandatory")
        || line.contains("中强制性级别")
        || line.contains("中等完整性")
      {
        "Medium"
      } else if line.contains("High Mandatory") || line.contains("高强制性级别") || line.contains("高完整性") {
        "High"
      } else if line.contains("System Mandatory") || line.contains("系统强制性级别") {
        "System"
      } else {
        "Unknown"
      }
    }
    None => "Unknown",
  };
  // icacls 成功时 stdout 会包含 “Successfully processed”；失败时收集 stderr 便于诊断
  let error = if label_line.is_none() {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = if stderr.is_empty() {
      stdout.lines().next().unwrap_or("").trim().to_string()
    } else {
      stderr
    };
    Some(format!("icacls 未返回完整性标签（{detail}）"))
  } else {
    None
  };
  FileIntegrity {
    label: label.to_string(),
    raw: label_line,
    error,
  }
}

/// 提权助手脚本 + marker 轮询的最长等待时间（毫秒）。覆盖 UAC 授权、icacls 执行与助手内 ~2 秒延迟。
const REPAIR_HELPER_TIMEOUT_MS: u64 = 180_000;
/// 轮询 marker 的间隔（毫秒）。
const REPAIR_HELPER_POLL_MS: u64 = 100;

/// 系统目录（%SystemRoot%\System32）。
fn system32_dir() -> PathBuf {
  let root = std::env::var_os("SystemRoot")
    .map(PathBuf::from)
    .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
  root.join("System32")
}

/// 一次「提权 cmd 助手」修复尝试的结果。
pub enum RepairAttempt {
  /// 修复成功：助手已把文件标签改为 Medium/High，并安排 ~2 秒后以普通权限重启。
  Repaired { detail: String, helper_path: PathBuf },
  /// 用户在 UAC 授权框点了取消：继续以受限方式运行，不重启。
  Cancelled { detail: String },
  /// 修复失败（icacls 失败 / marker 超时 / 复查标签仍为 Low）。
  Failed { detail: String },
}

/// 提权 cmd 助手脚本与 marker 的临时文件路径（纯 ASCII 文件名，避免中文路径编码问题）。
///
/// exe 路径与 marker 路径都通过**命令行参数**传给脚本，脚本自身只含 ASCII 字符。
fn repair_helper_paths() -> (PathBuf, PathBuf) {
  let temp = std::env::var_os("TEMP")
    .map(PathBuf::from)
    .or_else(|| std::env::var_os("TMP").map(PathBuf::from))
    .unwrap_or_else(std::env::temp_dir);
  let pid = std::process::id();
  (
    temp.join(format!("liyue-mirror-repair-{pid}.cmd")),
    temp.join(format!("liyue-mirror-repair-{pid}.marker")),
  )
}

/// 生成提权 cmd 助手脚本内容（纯 ASCII + CRLF 换行）。
///
/// 为什么不能直接提权启动自身 exe：Windows 规则「进程完整性 = min(用户令牌完整性, 文件完整性)」，
/// 带 Low 标签的 exe 即使用户选择「以管理员身份运行」，新进程仍被降为 Low，它再去调 icacls 也失败
/// （v0.0.5 用户实测现象）。cmd.exe / icacls.exe 是系统 Medium 文件，提权后进程为 Medium + 管理员
/// 令牌，可以成功执行 `icacls /setintegritylevel Medium`。
/// 助手成功后用 explorer.exe 把路径转发给已运行的 Explorer，实现非提权重启；并先 ping 约 2 秒，
/// 等旧实例退出、释放单实例互斥体后新实例才能正常启动。
fn repair_helper_script() -> String {
  let lines = [
    "@echo off",
    "setlocal",
    "\"%SystemRoot%\\System32\\icacls.exe\" \"%~1\" /setintegritylevel Medium >nul 2>&1",
    "if errorlevel 1 (",
    "  >\"%~2\" echo fail",
    "  del \"%~f0\" >nul 2>&1",
    "  exit /b 1",
    ")",
    ">\"%~2\" echo ok",
    "ping -n 3 127.0.0.1 >nul",
    "explorer.exe \"%~1\"",
    "del \"%~f0\" >nul 2>&1",
    "exit /b 0",
  ];
  format!("{}\r\n", lines.join("\r\n"))
}

/// 通过 UAC 启动提权 cmd 助手，由助手完成 icacls 修复，再轮询 marker 获取结果。
///
/// 成功时调用方应记录状态并**立即退出当前实例**（先释放单实例互斥体），助手会在约 2 秒后
/// 以普通权限拉起新实例。不要等待/杀死助手进程。
pub fn repair_label_via_cmd_helper(exe: &Path) -> RepairAttempt {
  let (script_path, marker_path) = repair_helper_paths();
  let _ = std::fs::remove_file(&marker_path);
  let script = repair_helper_script();
  if let Err(err) = std::fs::write(&script_path, script.as_bytes()) {
    return RepairAttempt::Failed {
      detail: format!("写入提权助手脚本失败（{}）：{err}", script_path.display()),
    };
  }
  let cmd = system32_dir().join("cmd.exe");
  if !cmd.is_file() {
    let _ = std::fs::remove_file(&script_path);
    return RepairAttempt::Failed {
      detail: format!("未找到系统 cmd.exe：{}", cmd.display()),
    };
  }
  let verb = HSTRING::from("runas");
  let file = HSTRING::from(cmd.to_string_lossy().to_string());
  let params = HSTRING::from(format!(
    "/c \"{}\" \"{}\" \"{}\"",
    script_path.display(),
    exe.display(),
    marker_path.display()
  ));
  let mut info = SHELLEXECUTEINFOW::default();
  info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
  info.fMask = SEE_MASK_NOCLOSEPROCESS;
  info.lpVerb = PCWSTR(verb.as_ptr());
  info.lpFile = PCWSTR(file.as_ptr());
  info.lpParameters = PCWSTR(params.as_ptr());
  info.nShow = SW_HIDE.0;
  if let Err(err) = unsafe { ShellExecuteExW(&mut info) } {
    let last = unsafe { GetLastError() };
    let _ = std::fs::remove_file(&script_path);
    let canceled =
      last.0 == ERROR_CANCELLED.0 || err.code().0 == 0x8007_04C7u32 as i32;
    if canceled {
      return RepairAttempt::Cancelled {
        detail: "已取消管理员授权（UAC），未做任何修改".to_string(),
      };
    }
    return RepairAttempt::Failed {
      detail: format!(
        "提权启动 cmd 助手失败：{err}（GetLastError={}）",
        last.0
      ),
    };
  }
  // 不等待助手进程：成功后它会延迟约 2 秒再拉起新实例，这里只轮询 marker。
  if !info.hProcess.0.is_null() {
    let _ = unsafe { CloseHandle(info.hProcess) };
  }

  let deadline = std::time::Instant::now() + std::time::Duration::from_millis(REPAIR_HELPER_TIMEOUT_MS);
  loop {
    if std::time::Instant::now() >= deadline {
      let _ = std::fs::remove_file(&script_path);
      return RepairAttempt::Failed {
        detail: format!(
          "等待提权助手结果超时（{} 秒）：未得到 ok/fail 标记（可能 UAC 未响应或助手被安全软件拦截）",
          REPAIR_HELPER_TIMEOUT_MS / 1000
        ),
      };
    }
    if let Ok(text) = std::fs::read_to_string(&marker_path) {
      let marker = text.trim();
      if marker == "fail" {
        let _ = std::fs::remove_file(&marker_path);
        let _ = std::fs::remove_file(&script_path);
        return RepairAttempt::Failed {
          detail:
            "提权 cmd 助手执行 icacls /setintegritylevel Medium 失败（请检查管理员授权与文件是否被占用）"
              .to_string(),
        };
      }
      if marker == "ok" {
        // 必须自行复查：助手报告成功 ≠ 标签真的改成功
        let after = read_file_integrity(exe);
        let _ = std::fs::remove_file(&marker_path);
        let _ = std::fs::remove_file(&script_path);
        if after.label == "Medium" || after.label == "High" {
          return RepairAttempt::Repaired {
            detail: format!(
              "已通过提权 cmd 助手调用系统 icacls 重置完整性标签，当前文件标签：{}",
              after.label
            ),
            helper_path: script_path,
          };
        }
        return RepairAttempt::Failed {
          detail: format!(
            "助手报告已执行修复，但复查文件完整性标签仍为 {}（可能 icacls 未生效或被安全软件拦截）",
            after.label
          ),
        };
      }
    }
    std::thread::sleep(std::time::Duration::from_millis(REPAIR_HELPER_POLL_MS));
  }
}

/// 修复模式进程退出码：0=修复成功并已请求重启；2=修复失败；3=未以管理员权限运行；4=环境异常。
pub const REPAIR_EXIT_OK: i32 = 0;
pub const REPAIR_EXIT_FAILED: i32 = 2;
pub const REPAIR_EXIT_NOT_ELEVATED: i32 = 3;

/// 启动自检结果（写入 AppState 与冒烟报告）。
#[derive(Clone, Debug, Default)]
pub struct IntegrityStatus {
  /// 进程 token 完整性级别："Low" / "Medium" / "High" / "Other(rid)" / "Unknown"
  pub token: String,
  /// 进程 token 完整性 RID（Unknown 时为 None）
  pub token_rid: Option<u32>,
  /// 进程 token 完整性 SID（例如 S-1-16-4096）
  pub token_sid: Option<String>,
  /// exe 文件完整性标签："Low" / "Medium" / "High" / "System" / "Unknown"
  pub file: String,
  /// icacls 中完整性标签原始行
  pub file_raw: Option<String>,
  /// 自检读取失败原因
  pub error: Option<String>,
  /// 当前进程是否管理员权限
  pub elevated: bool,
  /// 是否本次真的弹出了修复提示（非 smoke / 非 autostart 且文件为 Low）
  pub repair_prompted: bool,
  /// 是否成功启动了 UAC 提权修复实例
  pub repair_launched: bool,
  /// 是否因为 smoke/autostart/已提权而抑制了提示
  pub prompt_suppressed: bool,
  /// 文件是否为低完整性（需要修复的情形）
  pub low_detected: bool,
  /// 修复模式结果说明（仅 --repair-integrity 实例或成功修复时填写）
  pub repair_result: Option<String>,
  /// 修复失败原因（仅 --repair-integrity 实例或修复失败时填写）
  pub repair_error: Option<String>,
  /// 修复方式：本版本固定为 "icacls-elevated"（提权调用系统 icacls.exe）
  pub repair_via: Option<String>,
  /// 修复阶段：running / verified / cancelled / failed（未触及时为 None）
  pub repair_stage: Option<String>,
  /// 修复后重启方式（v0.0.7 起为 "elevated-cmd-helper"=提权 cmd 助手延迟拉起普通权限实例）
  pub relaunch_method: Option<String>,
  /// 是否已安排自动重启（助手会在约 2 秒后拉起新实例；当前实例应立即退出释放互斥体）
  pub relaunch_scheduled: bool,
  /// 提权 cmd 助手脚本路径（诊断用）
  pub helper_path: Option<String>,
  /// 被检测的 exe 路径
  pub exe_path: String,
}

impl IntegrityStatus {
  /// 用于冒烟报告 / app.info 的 JSON。
  pub fn to_json(&self) -> Value {
    serde_json::json!({
      "token": self.token,
      "tokenRid": self.token_rid,
      "tokenSid": self.token_sid,
      "file": self.file,
      "fileRaw": self.file_raw,
      "lowDetected": self.low_detected,
      "elevated": self.elevated,
      "repairPrompted": self.repair_prompted,
      "repairLaunched": self.repair_launched,
      "promptSuppressed": self.prompt_suppressed,
      "repairResult": self.repair_result,
      "repairError": self.repair_error,
      "repairVia": self.repair_via,
      "repairStage": self.repair_stage,
      "relaunchMethod": self.relaunch_method,
      "relaunchScheduled": self.relaunch_scheduled,
      "helperPath": self.helper_path,
      "error": self.error,
      "exePath": self.exe_path,
    })
  }

  /// 一行日志摘要。
  pub fn summary(&self) -> String {
    format!(
      "token={} file={} elevated={} lowDetected={} repairPrompted={} repairLaunched={} error={:?}",
      self.token,
      self.file,
      self.elevated,
      self.low_detected,
      self.repair_prompted,
      self.repair_launched,
      self.error
    )
  }
}

/// 全局最近一次自检结果（main 启动早期写入，AppState/冒烟报告读取）。
static STATUS: Mutex<Option<IntegrityStatus>> = Mutex::new(None);

pub fn set_status(status: IntegrityStatus) {
  if let Ok(mut guard) = STATUS.lock() {
    *guard = Some(status);
  }
}

/// 采集一次完整性自检（不弹框、不修复）。
pub fn collect_status() -> IntegrityStatus {
  let exe = paths::exe_path();
  let token_rid = token_integrity_rid();
  let file = read_file_integrity(&exe);
  let token = match token_rid {
    Some(rid) => level_name(rid),
    None => "Unknown".to_string(),
  };
  IntegrityStatus {
    token,
    token_rid,
    token_sid: token_rid.map(|rid| format!("S-1-16-{rid}")),
    file: file.label,
    file_raw: file.raw,
    error: file.error,
    elevated: is_elevated(),
    repair_prompted: false,
    repair_launched: false,
    prompt_suppressed: false,
    low_detected: false,
    repair_result: None,
    repair_error: None,
    repair_via: Some("icacls-elevated".to_string()),
    repair_stage: None,
    relaunch_method: None,
    relaunch_scheduled: false,
    helper_path: None,
    exe_path: exe.to_string_lossy().to_string(),
  }
}

/// 修复失败时给用户的可操作说明（含两条退路 + 手动命令）。
fn repair_failure_text(err: &str, exe: &Path) -> String {
  format!(
    "自动修复低完整性标签失败：\n\n{err}\n\n\
     可以这样处理：\n\
     1. 把程序文件复制到其他文件夹（例如桌面）后再运行——复制出的文件会继承目标目录的正常完整性标签，通常即可正常使用；\n\
     2. 右键以管理员身份打开「命令提示符」，执行：\n   icacls \"{}\" /setintegritylevel Medium\n\
     3. 或者右键以管理员身份运行程序目录下的「修复-桌面版启动限制.cmd」。\n\n\
     注意：直接对带 Low 标签的程序「以管理员身份运行」仍会被系统降为低完整性，无法完成修复。",
    exe.display()
  )
}

/// 正式启动路径的完整性自检：
/// - 文件带 Low 标签且未提权、非 smoke、非 autostart 时，弹「是否现在修复？」；
///   选「是」→ 在 %TEMP% 生成纯 ASCII 助手脚本，用 `ShellExecuteExW(runas, cmd.exe)` 提权执行
///   `icacls /setintegritylevel Medium`，轮询 marker 拿到 ok 后复查标签；成功则提示
///   「修复成功，正在以普通权限重启」并立即退出（助手约 2 秒后拉起非提权新实例），
///   失败则弹可操作说明框（含“复制到其他文件夹运行”退路），继续以受限方式运行。
/// - UAC 取消 → 提示已取消，继续受限运行。
/// - smoke / autostart / 已提权时不弹框，只记录状态。
pub fn startup_check(args: &StartupArgs, smoke_mode: bool) -> IntegrityStatus {
  let mut status = collect_status();
  status.low_detected = status.file == "Low";
  let can_prompt = status.low_detected
    && !status.elevated
    && !smoke_mode
    && !args.autostart
    && !args.skip_integrity_prompt;
  if status.low_detected && !status.elevated && !can_prompt {
    status.prompt_suppressed = true;
    if args.autostart {
      eprintln!("检测到程序文件带低完整性（Low）标签（autostart 模式不弹修复提示）");
    } else if smoke_mode {
      eprintln!("检测到程序文件带低完整性（Low）标签（smoke 模式不弹修复提示）");
    } else if args.skip_integrity_prompt {
      eprintln!("检测到程序文件带低完整性（Low）标签（--skip-integrity-prompt 跳过修复提示）");
    }
  }
  if can_prompt {
    let text = format!(
      "检测到程序文件带有 Windows「低完整性（Low）」标签：\n\n{}\n\n\
       这通常是因为本程序曾从受限环境（聊天窗口、沙箱、预览面板等）启动，文件被系统自动打上了低完整性标签。\n\
       带该标签运行时会无法正常写入用户配置目录、托盘图标可能不显示。\n\n\
       是否现在修复？（需要一次管理员授权，修复成功后程序会自动重启）\n\n\
       若不想授权，也可以把程序文件复制到其他文件夹（如桌面）再运行，或点「否」先继续以受限方式运行。",
      status.exe_path
    );
    let title = format!("{} 检测到低完整性标签", paths::PRODUCT_NAME);
    let accepted = winutil::message_box_yes_no(text, title);
    status.repair_prompted = true;
    if accepted {
      status.repair_stage = Some("running".to_string());
      eprintln!("开始通过提权 cmd 助手修复低完整性标签：{}", status.exe_path);
      match repair_label_via_cmd_helper(Path::new(&status.exe_path)) {
        RepairAttempt::Repaired { detail, helper_path } => {
          let after = read_file_integrity(Path::new(&status.exe_path));
          status.file = after.label;
          status.file_raw = after.raw;
          status.repair_result = Some(detail.clone());
          status.repair_launched = true;
          status.repair_stage = Some("verified".to_string());
          status.relaunch_method = Some("elevated-cmd-helper".to_string());
          status.relaunch_scheduled = true;
          status.helper_path = Some(helper_path.to_string_lossy().to_string());
          eprintln!("低完整性标签修复成功：{detail}");
          winutil::message_box(
            format!(
              "修复成功，正在以普通权限重启…\n\n{detail}\n\n\
               程序会自动重新启动；若几秒后没有出现窗口，请从资源管理器双击程序。"
            ),
            format!("{} 修复完成", paths::PRODUCT_NAME),
            false,
          );
          // 不在这里启动新进程：助手脚本会在约 2 秒后经 explorer 拉起新实例。
          // 当前实例（main）返回后立即退出，先释放单实例互斥体。
        }
        RepairAttempt::Cancelled { detail } => {
          status.repair_stage = Some("cancelled".to_string());
          eprintln!("已取消低完整性标签修复：{detail}");
          winutil::message_box(
            format!(
              "已取消管理员授权，未做任何修改。\n\n{detail}\n\n程序将继续以受限方式运行；\
               如需修复，可重新启动程序并在提示时允许管理员授权，或把程序复制到其他文件夹运行。"
            ),
            format!("{} 修复已取消", paths::PRODUCT_NAME),
            false,
          );
        }
        RepairAttempt::Failed { detail } => {
          status.repair_error = Some(detail.clone());
          status.repair_stage = Some("failed".to_string());
          eprintln!("低完整性标签修复失败：{detail}");
          winutil::message_box(
            repair_failure_text(&detail, Path::new(&status.exe_path)),
            format!("{} 修复失败", paths::PRODUCT_NAME),
            true,
          );
        }
      }
    } else {
      eprintln!("用户选择暂不修复低完整性标签，继续受限运行");
    }
  }
  set_status(status.clone());
  status
}

/// `--repair-integrity` 提权实例入口（不抢单实例互斥体、不初始化桌面壳）。
///
/// 注意：Low 标签的 exe 即使用户选择「以管理员身份运行」，进程仍会因
/// 「进程完整性 = min(用户令牌完整性, 文件完整性)」规则被降为 Low，直接 spawn icacls 会失败。
/// 真正的修复由主程序启动「提权 cmd 助手」（cmd.exe/icacls.exe 是系统 Medium 文件）完成；
/// 本模式在已提权时复用同一助手，随后立即退出由助手拉起普通权限实例。
/// 非提权时保持 exit 3 + repairError「需要管理员权限」（自动化测试依赖此行为，不要改）。
pub fn run_repair_mode(args: &StartupArgs) -> i32 {
  let smoke_mode = std::env::var("MIRROR_DESKTOP_SMOKE")
    .map(|value| value == "1")
    .unwrap_or(false);
  let mut status = collect_status();
  status.low_detected = status.file == "Low";
  let report_path = args.smoke_report.clone();

  if !status.elevated {
    status.repair_error = Some("--repair-integrity 需要管理员权限".to_string());
    status.repair_stage = Some("failed".to_string());
    eprintln!("修复低完整性标签失败：需要管理员权限（请通过程序内的修复提示启动）");
    if !smoke_mode {
      winutil::message_box(
        "自动修复失败：获取管理员权限失败。\n\n请右键以管理员身份运行「修复-桌面版启动限制.cmd」（或「启动桌面版.cmd」）完成修复。\n\n注意：直接对带 Low 标签的程序「以管理员身份运行」仍会被系统降为低完整性；真正的修复由主程序/脚本调用系统 icacls 完成。",
        format!("{} 修复低完整性标签", paths::PRODUCT_NAME),
        true,
      );
    }
    write_repair_report(report_path.as_ref(), &status);
    return REPAIR_EXIT_NOT_ELEVATED;
  }

  // smoke 模式不执行实际修复、不弹框、不重启（避免自动化环境触发 UAC/修改标签）
  if smoke_mode {
    status.repair_result = Some("smoke 模式跳过实际修复（避免触发 UAC/重启）".to_string());
    status.repair_stage = Some("skipped".to_string());
    eprintln!("smoke 模式：跳过实际低完整性标签修复");
    write_repair_report(report_path.as_ref(), &status);
    return REPAIR_EXIT_OK;
  }

  let exe = paths::exe_path();
  status.repair_stage = Some("running".to_string());
  match repair_label_via_cmd_helper(&exe) {
    RepairAttempt::Repaired { detail, helper_path } => {
      let after = read_file_integrity(&exe);
      status.file = after.label;
      status.file_raw = after.raw;
      status.repair_result = Some(detail.clone());
      status.repair_stage = Some("verified".to_string());
      status.repair_launched = true;
      status.relaunch_method = Some("elevated-cmd-helper".to_string());
      status.relaunch_scheduled = true;
      status.helper_path = Some(helper_path.to_string_lossy().to_string());
      eprintln!("低完整性标签修复成功：{detail}");
      winutil::message_box(
        format!(
          "修复成功，正在以普通权限重启…\n\n{detail}\n\n\
           程序会自动重新启动；若几秒后没有出现窗口，请从资源管理器双击程序。"
        ),
        format!("{} 修复完成", paths::PRODUCT_NAME),
        false,
      );
      write_repair_report(report_path.as_ref(), &status);
      REPAIR_EXIT_OK
    }
    RepairAttempt::Cancelled { detail } => {
      status.repair_stage = Some("cancelled".to_string());
      eprintln!("已取消低完整性标签修复：{detail}");
      winutil::message_box(
        format!("已取消管理员授权，未做任何修改。\n\n{detail}"),
        format!("{} 修复已取消", paths::PRODUCT_NAME),
        false,
      );
      write_repair_report(report_path.as_ref(), &status);
      REPAIR_EXIT_FAILED
    }
    RepairAttempt::Failed { detail } => {
      status.repair_error = Some(detail.clone());
      status.repair_stage = Some("failed".to_string());
      eprintln!("低完整性标签修复失败：{detail}");
      winutil::message_box(
        repair_failure_text(&detail, &exe),
        format!("{} 修复失败", paths::PRODUCT_NAME),
        true,
      );
      write_repair_report(report_path.as_ref(), &status);
      REPAIR_EXIT_FAILED
    }
  }
}

fn write_repair_report(path: Option<&PathBuf>, status: &IntegrityStatus) {
  let Some(path) = path else {
    return;
  };
  let payload = serde_json::json!({
    "smoke": true,
    "repairMode": true,
    "integrity": status.to_json(),
  });
  let _ = std::fs::write(path, format!("{payload}\n"));
}
