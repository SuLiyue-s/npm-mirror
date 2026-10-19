// 简单文件日志：%LOCALAPPDATA%\LiYueNpmMirror\desktop.log（可用 MIRROR_DESKTOP_HOME 覆盖目录）。
// 不引入第三方日志库，时间戳手算 UTC，保证离线构建零额外依赖。
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_FILE: OnceLock<Mutex<Option<File>>> = OnceLock::new();
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn init(home: &Path) -> Result<(), String> {
  fs::create_dir_all(home).map_err(|e| format!("创建日志目录失败 {}：{e}", home.display()))?;
  let path = home.join("desktop.log");
  let file = OpenOptions::new()
    .create(true)
    .append(true)
    .open(&path)
    .map_err(|e| format!("打开日志文件失败 {}：{e}", path.display()))?;
  let _ = LOG_PATH.set(path.clone());
  let _ = LOG_FILE.set(Mutex::new(Some(file)));
  info(format!(
    "======== 桌面程序启动 pid={} exe={} ========",
    std::process::id(),
    crate::paths::exe_path().display()
  ));
  Ok(())
}

pub fn log_path() -> Option<PathBuf> {
  LOG_PATH.get().cloned()
}

pub fn log(level: &str, message: impl AsRef<str>) {
  let line = format!("[{}] [{}] {}", utc_now(), level, message.as_ref());
  if let Some(store) = LOG_FILE.get() {
    if let Ok(mut guard) = store.lock() {
      if let Some(file) = guard.as_mut() {
        let _ = writeln!(file, "{line}");
        let _ = file.flush();
      }
    }
  }
  #[cfg(debug_assertions)]
  {
    eprintln!("{line}");
  }
}

pub fn info(message: impl AsRef<str>) {
  log("info", message);
}

pub fn warn(message: impl AsRef<str>) {
  log("warn", message);
}

pub fn error(message: impl AsRef<str>) {
  log("error", message);
}

/// 手工换算 UTC 时间戳：YYYY-MM-DDTHH:MM:SSZ
pub fn utc_now() -> String {
  let secs = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs() as i64)
    .unwrap_or(0);
  format_utc(secs)
}

pub fn format_utc(secs: i64) -> String {
  let days = secs.div_euclid(86_400);
  let rem = secs.rem_euclid(86_400);
  let (year, month, day) = civil_from_days(days);
  format!(
    "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
    rem / 3600,
    (rem % 3600) / 60,
    rem % 60
  )
}

/// Howard Hinnant 的 days -> civil date 算法（公历，含闰年）
fn civil_from_days(days: i64) -> (i64, u32, u32) {
  let z = days + 719_468;
  let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
  let doe = z - era * 146_097;
  let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
  let year = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
  let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
  (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
  use super::format_utc;

  #[test]
  fn utc_epoch_format() {
    assert_eq!(format_utc(0), "1970-01-01T00:00:00Z");
    assert_eq!(format_utc(1_700_000_000), "2023-11-14T22:13:20Z");
  }
}
