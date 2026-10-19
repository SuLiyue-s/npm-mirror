// 低完整性（Low）标签自检与一键修复：
// 用户从受限环境（聊天窗口/沙箱/预览面板）运行 exe 后，程序文件可能被系统继承 Low 完整性标签，
// 导致程序自身无法写入用户配置目录、托盘注册失败等问题。本模块在启动最早期检测并给出修复入口。
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use serde_json::Value;
use windows::core::HSTRING;
use windows::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows::Win32::Security::{
  GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenElevation,
  TokenIntegrityLevel, TOKEN_ELEVATION, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

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

/// 提权实例内执行：去掉文件低完整性标签（icacls /setintegritylevel Medium），并复查。
///
/// 注意：Windows 规则「进程完整性 = min(用户令牌完整性, 文件完整性)」，即使通过 runas 提权，
/// 执行 Low 标签文件得到的进程仍可能是 Low 完整性（但持有完整管理员令牌 + SeSecurityPrivilege）。
/// 因此这里必须用管理员令牌执行 icacls，并捕获 stdout/stderr 与退出码用于诊断。
pub fn repair_label(exe: &Path) -> Result<String, String> {
  let output = Command::new("icacls")
    .arg(exe)
    .args(["/setintegritylevel", "Medium"])
    .creation_flags(winutil::CREATE_NO_WINDOW)
    .output()
    .map_err(|err| format!("执行 icacls /setintegritylevel 失败：{err}"))?;
  let code = output.status.code().unwrap_or(-1);
  let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
  let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
  let after = read_file_integrity(exe);
  if after.label == "Medium" || after.label == "High" {
    return Ok(format!(
      "已移除低完整性标签（icacls 退出码 {code}，输出：{}）",
      first_line(&stdout)
    ));
  }
  let detail = if stderr.is_empty() { stdout } else { stderr };
  Err(format!(
    "icacls 退出码 {code}；修复后复查文件完整性标签仍为 {}（输出：{}）",
    after.label,
    first_line(&detail)
  ))
}

fn first_line(text: &str) -> String {
  text.lines()
    .map(str::trim)
    .find(|line| !line.is_empty())
    .unwrap_or("")
    .to_string()
}

/// 通过 UAC 提权启动 `"<exe>" --repair-integrity`（修复完成后由提权实例负责重启）。
pub fn launch_repair_elevated(exe: &Path) -> Result<(), String> {
  let verb = HSTRING::from("runas");
  let file = HSTRING::from(exe.to_string_lossy().to_string());
  let params = HSTRING::from("--repair-integrity");
  let dir = input_directory(exe);
  let result = unsafe { ShellExecuteW(None, &verb, &file, &params, &dir, SW_SHOWNORMAL) };
  let code = result.0 as isize;
  if code > 32 {
    return Ok(());
  }
  let last_error = unsafe { GetLastError() };
  Err(format!(
    "ShellExecuteW(runas) 失败：返回 {code}，GetLastError={}，{}",
    last_error.0,
    std::io::Error::last_os_error()
  ))
}

/// 以普通（非提权）方式重新启动程序：优先经 explorer.exe 转发，失败回退 ShellExecuteW "open"。
pub fn relaunch_unelevated() {
  let exe = paths::exe_path();
  let exe_text = exe.to_string_lossy().to_string();
  let spawned = Command::new("explorer.exe").arg(&exe_text).spawn();
  if spawned.is_ok() {
    return;
  }
  let _ = winutil::open_path(&exe_text);
}

fn input_directory(exe: &Path) -> HSTRING {
  let dir = exe.parent().map(PathBuf::from).unwrap_or_default();
  HSTRING::from(dir.to_string_lossy().to_string())
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
  /// 修复模式结果说明（仅 --repair-integrity 实例填写）
  pub repair_result: Option<String>,
  /// 修复失败原因（仅 --repair-integrity 实例填写）
  pub repair_error: Option<String>,
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
    exe_path: exe.to_string_lossy().to_string(),
  }
}

/// 正式启动路径的完整性自检：
/// - 文件带 Low 标签且未提权、非 smoke、非 autostart 时，弹「是否现在修复？」；
///   选「是」→ 通过 UAC 启动 --repair-integrity 实例（成功后本实例退出）；
///   选「否」→ 记录日志后继续以受限方式运行。
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
       选择「否」将继续以受限方式运行，之后可在资源管理器双击本程序时再次修复。",
      status.exe_path
    );
    let title = format!("{} 检测到低完整性标签", paths::PRODUCT_NAME);
    let accepted = winutil::message_box_yes_no(text, title);
    status.repair_prompted = true;
    if accepted {
      match launch_repair_elevated(Path::new(&status.exe_path)) {
        Ok(()) => {
          status.repair_launched = true;
          eprintln!("已请求管理员修复低完整性标签，等待修复实例完成并重启");
        }
        Err(err) => {
          status.repair_error = Some(err.clone());
          eprintln!("启动管理员修复实例失败：{err}");
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
pub fn run_repair_mode(args: &StartupArgs) -> i32 {
  let smoke_mode = std::env::var("MIRROR_DESKTOP_SMOKE").map(|value| value == "1").unwrap_or(false);
  let mut status = collect_status();
  status.low_detected = status.file == "Low";
  let report_path = args.smoke_report.clone();

  if !status.elevated {
    status.repair_error = Some("--repair-integrity 需要管理员权限".to_string());
    eprintln!("修复低完整性标签失败：需要管理员权限（请通过程序内的修复提示启动）");
    if !smoke_mode {
      winutil::message_box(
        "自动修复失败：获取管理员权限失败。\n\n请右键以管理员身份运行「修复-桌面版启动限制.cmd」（或「启动桌面版.cmd」）完成修复。",
        format!("{} 修复低完整性标签", paths::PRODUCT_NAME),
        true,
      );
    }
    write_repair_report(report_path.as_ref(), &status);
    return REPAIR_EXIT_NOT_ELEVATED;
  }

  let exe = paths::exe_path();
  match repair_label(&exe) {
    Ok(detail) => {
      status.repair_result = Some(detail.clone());
      let after = read_file_integrity(&exe);
      status.file = after.label;
      status.file_raw = after.raw;
      eprintln!("低完整性标签修复成功：{detail}");
      if !smoke_mode {
        winutil::message_box(
          format!("修复成功，正在重启程序…\n\n{detail}"),
          format!("{} 修复完成", paths::PRODUCT_NAME),
          false,
        );
        relaunch_unelevated();
      }
      write_repair_report(report_path.as_ref(), &status);
      REPAIR_EXIT_OK
    }
    Err(err) => {
      status.repair_error = Some(err.clone());
      eprintln!("低完整性标签修复失败：{err}");
      if !smoke_mode {
        winutil::message_box(
          format!(
            "自动修复失败，请右键以管理员身份运行「修复-桌面版启动限制.cmd」（或「启动桌面版.cmd」）。\n\n失败原因：\n{err}\n\n也可手动修复：\n1. 右键以管理员身份打开命令提示符；\n2. 执行 icacls \"{}\" /setintegritylevel Medium",
            exe.display()
          ),
          format!("{} 修复失败", paths::PRODUCT_NAME),
          true,
        );
      }
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
