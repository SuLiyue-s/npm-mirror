// 路径与数据目录解析：主数据目录解析顺序、校验、指针文件、窗口状态文件的读写。
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use crate::logging;
use crate::state::StartupArgs;

/// 产品名（与 node 端 MIRROR_PRODUCT_NAME 默认值保持一致）
pub const PRODUCT_NAME: &str = "离月私人 npm 镜像源";
/// 数据目录指针文件名（位于桌面配置目录）
pub const POINTER_FILE: &str = "data-location.json";
/// 桌面窗口状态文件（位于桌面配置目录）
pub const DESKTOP_PREFS_FILE: &str = "desktop.json";
/// 数据目录路径长度上限（给数据库/缓存子目录留余量）
pub const MAX_DATA_DIR_LEN: usize = 180;

pub fn exe_path() -> PathBuf {
  std::env::current_exe().unwrap_or_else(|_| PathBuf::from("npm-mirror-desktop.exe"))
}

pub fn exe_dir() -> PathBuf {
  exe_path()
    .parent()
    .map(|p| p.to_path_buf())
    .unwrap_or_else(|| PathBuf::from("."))
}

/// 桌面配置目录候选（带说明，用于回退告警与引导提示）。
struct HomeCandidate {
  /// 人类可读的目录用途说明
  label: &'static str,
  path: PathBuf,
  /// 是否为首选目录（%LOCALAPPDATA%\LiYueNpmMirror）
  preferred: bool,
}

/// 桌面配置目录解析结果。
pub struct HomeResolution {
  /// 实际使用的配置目录
  pub path: PathBuf,
  /// 是否发生了回退（未使用首选用户配置目录）
  pub fallback: bool,
  /// 逐个候选探测失败的说明（含系统错误），供日志/冒烟报告/引导提示使用
  pub warnings: Vec<String>,
}

/// 探测目录是否可写：创建目录 + 写/删报告探针文件。
fn probe_writable(dir: &Path) -> Result<(), String> {
  fs::create_dir_all(dir).map_err(|err| format!("创建目录失败：{err}"))?;
  let probe = dir.join(format!(".write-probe-{}", std::process::id()));
  let write_result = (|| -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new()
      .write(true)
      .create(true)
      .truncate(true)
      .open(&probe)?;
    file.write_all(b"ok")?;
    file.flush()
  })();
  let _ = fs::remove_file(&probe);
  write_result.map_err(|err| format!("写入探针失败：{err}"))
}

/// 解析桌面配置目录。顺序：
/// ① MIRROR_DESKTOP_HOME（设置则权威，不可用直接报清晰错误）
/// ② %LOCALAPPDATA%\LiYueNpmMirror（首选）
/// ③ <exe 目录>\LiYueNpmMirror
/// ④ %TEMP%\LiYueNpmMirror
/// ⑤ <exe 目录>\.LiYueNpmMirror
///
/// 例外环境（DSH 沙箱、预览面板等受限 token）写不了 %LOCALAPPDATA% 时自动回退，
/// 不再让程序在启动阶段直接失败；回退情况通过 fallback/warnings 暴露给日志与提示框。
pub fn effective_home() -> Result<HomeResolution, String> {
  // 环境变量显式指定时视为权威：不可写则明确报错，不静默改用其它目录
  if let Some(value) = std::env::var_os("MIRROR_DESKTOP_HOME") {
    if !value.is_empty() {
      let dir = PathBuf::from(value);
      return match probe_writable(&dir) {
        Ok(()) => Ok(HomeResolution {
          path: dir,
          fallback: false,
          warnings: Vec::new(),
        }),
        Err(err) => Err(format!(
          "环境变量 MIRROR_DESKTOP_HOME 指定的配置目录不可用 {}：{err}",
          dir.display()
        )),
      };
    }
  }

  let mut candidates: Vec<HomeCandidate> = Vec::new();
  if let Some(base) = std::env::var_os("LOCALAPPDATA") {
    if !base.is_empty() {
      candidates.push(HomeCandidate {
        label: "用户配置目录",
        path: PathBuf::from(base).join("LiYueNpmMirror"),
        preferred: true,
      });
    }
  }
  candidates.push(HomeCandidate {
    label: "程序目录配置目录",
    path: exe_dir().join("LiYueNpmMirror"),
    preferred: false,
  });
  if let Some(temp) = std::env::var_os("TEMP") {
    if !temp.is_empty() {
      candidates.push(HomeCandidate {
        label: "临时目录配置目录",
        path: PathBuf::from(temp).join("LiYueNpmMirror"),
        preferred: false,
      });
    }
  }
  candidates.push(HomeCandidate {
    label: "程序目录备用配置目录",
    path: exe_dir().join(".LiYueNpmMirror"),
    preferred: false,
  });

  let mut warnings: Vec<String> = Vec::new();
  for candidate in &candidates {
    match probe_writable(&candidate.path) {
      Ok(()) => {
        return Ok(HomeResolution {
          path: candidate.path.clone(),
          fallback: !candidate.preferred,
          warnings,
        })
      }
      Err(err) => warnings.push(format!(
        "{} {} 不可用：{err}",
        candidate.label,
        candidate.path.display()
      )),
    }
  }
  Err(format!(
    "没有可写入的桌面配置目录：\n{}",
    warnings.join("\n")
  ))
}

pub fn data_pointer_path(home: &Path) -> PathBuf {
  home.join(POINTER_FILE)
}

fn now_nanos() -> u128 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or(0)
}

/// 读取数据目录指针文件；文件不存在/损坏时返回 None（由调用方回退默认目录）。
pub fn read_pointer(home: &Path) -> Option<PathBuf> {
  let text = fs::read_to_string(data_pointer_path(home)).ok()?;
  let value: serde_json::Value = serde_json::from_str(&text).ok()?;
  let dir = value.get("dataDir").and_then(|v| v.as_str())?;
  let dir = dir.trim();
  if dir.is_empty() {
    return None;
  }
  Some(PathBuf::from(dir))
}

/// 原子写入数据目录指针文件（先写临时文件再替换）。
pub fn write_pointer(home: &Path, data_dir: &Path) -> Result<(), String> {
  fs::create_dir_all(home).map_err(|e| format!("创建桌面配置目录失败 {}：{e}", home.display()))?;
  let json = serde_json::json!({ "dataDir": data_dir.to_string_lossy() });
  let body = serde_json::to_vec_pretty(&json).map_err(|e| format!("序列化数据目录指针失败：{e}"))?;
  let tmp = home.join(format!("{POINTER_FILE}.tmp"));
  fs::write(&tmp, &body).map_err(|e| format!("写入数据目录指针临时文件失败：{e}"))?;
  let target = data_pointer_path(home);
  if target.exists() {
    let _ = fs::remove_file(&target);
  }
  fs::rename(&tmp, &target).map_err(|e| format!("替换数据目录指针文件失败：{e}"))?;
  Ok(())
}

/// 数据目录来源，用于启动日志和冒烟报告。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DataDirSource {
  CliArg,
  Env,
  Pointer,
  Default,
}

impl DataDirSource {
  pub fn as_str(&self) -> &'static str {
    match self {
      DataDirSource::CliArg => "cli",
      DataDirSource::Env => "env",
      DataDirSource::Pointer => "pointer",
      DataDirSource::Default => "default",
    }
  }
}

pub struct DataDirResolution {
  pub path: PathBuf,
  pub source: DataDirSource,
  /// 解析过程中的非致命问题（例如指针文件损坏后回退默认目录）
  pub warnings: Vec<String>,
}

/// 解析主数据目录：--data-dir > MIRROR_DATA_DIR > 指针文件 > <exe 目录>/data。
pub fn resolve_data_dir(args: &StartupArgs, home: &Path) -> Result<DataDirResolution, String> {
  let mut warnings: Vec<String> = Vec::new();

  if let Some(dir) = &args.data_dir {
    validate_data_dir(dir).map_err(|e| format!("--data-dir 指定的数据目录无效：{e}"))?;
    return Ok(DataDirResolution {
      path: dir.clone(),
      source: DataDirSource::CliArg,
      warnings,
    });
  }

  if let Some(value) = std::env::var_os("MIRROR_DATA_DIR") {
    if !value.is_empty() {
      let dir = PathBuf::from(&value);
      validate_data_dir(&dir).map_err(|e| format!("环境变量 MIRROR_DATA_DIR 指定的数据目录无效：{e}"))?;
      return Ok(DataDirResolution {
        path: dir,
        source: DataDirSource::Env,
        warnings,
      });
    }
  }

  if let Some(dir) = read_pointer(home) {
    match validate_data_dir(&dir) {
      Ok(()) => {
        return Ok(DataDirResolution {
          path: dir,
          source: DataDirSource::Pointer,
          warnings,
        });
      }
      Err(err) => {
        let message = format!(
          "数据目录指针 {} 指向的目录无效（{err}），已回退到默认目录",
          dir.display()
        );
        logging::warn(&message);
        warnings.push(message);
      }
    }
  }

  let default_dir = exe_dir().join("data");
  fs::create_dir_all(&default_dir)
    .map_err(|e| format!("创建默认数据目录失败 {}：{e}", default_dir.display()))?;
  validate_data_dir(&default_dir)?;
  Ok(DataDirResolution {
    path: default_dir,
    source: DataDirSource::Default,
    warnings,
  })
}

/// 校验一个路径能否作为主数据目录。
pub fn validate_data_dir(path: &Path) -> Result<(), String> {
  let text = path.to_string_lossy();
  if text.trim().is_empty() {
    return Err("路径为空".into());
  }
  if !path.is_absolute() {
    return Err("必须是绝对路径".into());
  }
  if text.len() > MAX_DATA_DIR_LEN {
    return Err(format!("路径过长（{} 字符，上限 {MAX_DATA_DIR_LEN}）", text.len()));
  }
  // 非法字符：Windows 保留字符与控制字符；盘符后的冒号是唯一允许的冒号。
  for (index, ch) in text.chars().enumerate() {
    if ch.is_control() {
      return Err(format!("包含非法字符（控制字符 U+{:04X}）", ch as u32));
    }
    if matches!(ch, '<' | '>' | '"' | '|' | '?' | '*') {
      return Err(format!("包含非法字符：{ch}"));
    }
    if ch == ':' && index != 1 {
      return Err("包含非法字符：:".into());
    }
  }
  // 目录名不能以空格或点结尾（Windows 资源管理器会静默截断）
  for component in path.components() {
    if let Component::Normal(part) = component {
      let part = part.to_string_lossy();
      if part.ends_with(' ') || part.ends_with('.') {
        return Err(format!("目录名不能以空格或点结尾：{part}"));
      }
    }
  }
  // 不能是磁盘根目录或卷根
  if path.file_name().is_none() || path.parent().is_none() {
    return Err("不能直接使用磁盘根目录".into());
  }
  if !path.exists() {
    return Err(format!("目录不存在：{}", path.display()));
  }
  if !path.is_dir() {
    return Err(format!("不是目录：{}", path.display()));
  }
  // 可写性探测：创建并删除一个探针文件
  let probe = path.join(format!(
    ".npm-mirror-write-test-{}-{}",
    std::process::id(),
    now_nanos()
  ));
  match fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
    Ok(mut file) => {
      let write_ok = file.write_all(b"ok").is_ok();
      drop(file);
      let _ = fs::remove_file(&probe);
      if !write_ok {
        return Err(format!("目录不可写：{}", path.display()));
      }
    }
    Err(err) => return Err(format!("目录不可写：{err}")),
  }
  Ok(())
}

/// 桌面窗口状态（可选持久化到 %LOCALAPPDATA%\LiYueNpmMirror\desktop.json）
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DesktopPrefs {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub width: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub height: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub x: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub y: Option<f64>,
  #[serde(default)]
  pub maximized: bool,
}

pub fn read_desktop_prefs(home: &Path) -> DesktopPrefs {
  fs::read_to_string(home.join(DESKTOP_PREFS_FILE))
    .ok()
    .and_then(|text| serde_json::from_str(&text).ok())
    .unwrap_or_default()
}

pub fn write_desktop_prefs(home: &Path, prefs: &DesktopPrefs) -> Result<(), String> {
  fs::create_dir_all(home).map_err(|e| format!("创建桌面配置目录失败：{e}"))?;
  let body = serde_json::to_vec_pretty(prefs).map_err(|e| format!("序列化窗口状态失败：{e}"))?;
  let tmp = home.join(format!("{DESKTOP_PREFS_FILE}.tmp"));
  fs::write(&tmp, &body).map_err(|e| format!("写入窗口状态临时文件失败：{e}"))?;
  let target = home.join(DESKTOP_PREFS_FILE);
  if target.exists() {
    let _ = fs::remove_file(&target);
  }
  fs::rename(&tmp, &target).map_err(|e| format!("替换窗口状态文件失败：{e}"))
}
