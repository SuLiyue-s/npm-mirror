// 内嵌资源解压：把 build.rs 生成的 app 资产（package.json/cli.js/src/**/public/**）
// 与 node.exe 释放到 %LOCALAPPDATA%\LiYueNpmMirror\runtime\v<version>\：
//   <runtime>\node.exe
//   <runtime>\app\...（app 根）
//   <runtime>\.complete（完整性标记：版本、文件数、字节数）
// 先用临时目录写入再整体 rename，避免中断后留下半成品。
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::logging;

// ASSETS / ASSET_COUNT / ASSET_BYTES 由 build.rs 生成到 OUT_DIR
include!(concat!(env!("OUT_DIR"), "/assets.rs"));

/// 内嵌 node.exe（91MB 左右，勿改勿删）
pub const NODE_EXE: &[u8] = include_bytes!("../embed/node.exe");

pub fn runtime_root(home: &Path) -> PathBuf {
  home.join("runtime")
}

pub fn runtime_dir(home: &Path) -> PathBuf {
  runtime_root(home).join(format!("v{}", env!("CARGO_PKG_VERSION")))
}

pub fn app_root(home: &Path) -> PathBuf {
  runtime_dir(home).join("app")
}

fn total_expected_bytes() -> u64 {
  NODE_EXE.len() as u64 + ASSET_BYTES
}

fn marker_body(files: u64, bytes: u64) -> String {
  format!(
    "{{\"version\":\"{}\",\"files\":{},\"bytes\":{}}}\n",
    env!("CARGO_PKG_VERSION"),
    files,
    bytes
  )
}

fn marker_valid(path: &Path, files: u64, bytes: u64) -> bool {
  let Ok(text) = fs::read_to_string(path) else {
    return false;
  };
  let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
    return false;
  };
  value.get("version").and_then(|v| v.as_str()) == Some(env!("CARGO_PKG_VERSION"))
    && value.get("files").and_then(|v| v.as_u64()) == Some(files)
    && value.get("bytes").and_then(|v| v.as_u64()) == Some(bytes)
}

fn now_nanos() -> u128 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or(0)
}

/// 确保 runtime 已就绪，返回 runtime 根目录。
pub fn ensure_runtime(home: &Path) -> Result<PathBuf, String> {
  let dir = runtime_dir(home);
  let node_exe = dir.join("node.exe");
  let marker = dir.join(".complete");
  let files = ASSET_COUNT as u64 + 1;
  let bytes = total_expected_bytes();

  if node_exe.is_file() && marker_valid(&marker, files, bytes) {
    logging::info(format!("复用已解压的运行时：{}", dir.display()));
    return Ok(dir);
  }

  logging::info(format!(
    "解压运行时到 {}（node.exe {} 字节 + {} 个应用文件，共 {} 字节）",
    dir.display(),
    NODE_EXE.len(),
    ASSET_COUNT,
    bytes
  ));

  let root = runtime_root(home);
  fs::create_dir_all(&root).map_err(|e| format!("创建运行时目录失败 {}：{e}", root.display()))?;
  // 清理上次中断遗留的临时目录
  if let Ok(entries) = fs::read_dir(&root) {
    for entry in entries.flatten() {
      let name = entry.file_name().to_string_lossy().to_string();
      if name.starts_with(".tmp-") {
        let _ = fs::remove_dir_all(entry.path());
      }
    }
  }

  let temp = root.join(format!(".tmp-{}-{}", std::process::id(), now_nanos()));
  fs::create_dir_all(&temp).map_err(|e| format!("创建临时运行时目录失败：{e}"))?;

  let write_all = |path: &Path, data: &[u8]| -> Result<(), String> {
    if let Some(parent) = path.parent() {
      fs::create_dir_all(parent).map_err(|e| format!("创建目录失败 {}：{e}", parent.display()))?;
    }
    let mut file =
      fs::File::create(path).map_err(|e| format!("创建文件失败 {}：{e}", path.display()))?;
    file
      .write_all(data)
      .map_err(|e| format!("写入文件失败 {}：{e}", path.display()))?;
    file
      .sync_all()
      .map_err(|e| format!("同步文件失败 {}：{e}", path.display()))?;
    Ok(())
  };

  write_all(&temp.join("node.exe"), NODE_EXE)?;
  for (rel, data) in ASSETS {
    let path = temp.join("app").join(rel);
    write_all(&path, data)?;
  }
  let marker_path = temp.join(".complete");
  write_all(&marker_path, marker_body(files, bytes).as_bytes())?;

  if dir.exists() {
    fs::remove_dir_all(&dir).map_err(|e| format!("替换旧运行时失败（删除 {}）：{e}", dir.display()))?;
  }
  fs::rename(&temp, &dir).map_err(|e| format!("提交运行时目录失败：{e}"))?;
  logging::info(format!("运行时解压完成：{}", dir.display()));
  Ok(dir)
}
