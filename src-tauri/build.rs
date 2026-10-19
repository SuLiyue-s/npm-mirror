// 构建脚本：
// 1) 把仓库根下的程序文件（package.json、cli.js、src/**、public/**）生成到 OUT_DIR/assets.rs，
//    由 src/embed.rs 用 include_bytes! 编进 exe（桌面版单文件分发所需）；
// 2) 调用 tauri_build::build() 完成 Tauri 的 Windows 资源/上下文生成。
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// 递归收集目录下的所有文件（相对仓库根的路径统一用 / 分隔，作为解压时的 app/ 内相对路径）
fn collect_dir(dir: &Path, repo_root: &Path, out: &mut BTreeMap<String, PathBuf>) {
  if !dir.is_dir() {
    return;
  }
  let mut stack = vec![dir.to_path_buf()];
  while let Some(current) = stack.pop() {
    let entries = match fs::read_dir(&current) {
      Ok(e) => e,
      Err(_) => continue,
    };
    for entry in entries.flatten() {
      let path = entry.path();
      // 跳过隐藏文件/目录与编辑器的临时目录（如 .app.js.1234.xxxx.tmpdir），
      // 避免把别人原子写入过程中的临时文件打进去导致构建随机失败。
      let name = entry.file_name().to_string_lossy().to_string();
      if name.starts_with('.') {
        continue;
      }
      if path.is_dir() {
        stack.push(path);
      } else if path.is_file() {
        if name.ends_with(".tmp") || name.ends_with(".swp") {
          continue;
        }
        if let Ok(rel) = path.strip_prefix(repo_root) {
          let rel_text = rel.to_string_lossy().replace('\\', "/");
          out.insert(rel_text, path);
        }
      }
    }
  }
}

fn main() {
  let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
  let repo_root = manifest_dir
    .parent()
    .expect("src-tauri 应该位于仓库根目录下")
    .to_path_buf();

  let mut assets: BTreeMap<String, PathBuf> = BTreeMap::new();
  for rel in ["package.json", "cli.js"] {
    let path = repo_root.join(rel);
    if path.is_file() {
      assets.insert(rel.to_string(), path.clone());
    }
    println!("cargo:rerun-if-changed={}", path.display());
  }
  for dir in ["src", "public"] {
    let path = repo_root.join(dir);
    collect_dir(&path, &repo_root, &mut assets);
    println!("cargo:rerun-if-changed={}", path.display());
  }
  // 目录内文件增删时目录 mtime 会变；单个文件内容变化也要重新编译
  for path in assets.values() {
    println!("cargo:rerun-if-changed={}", path.display());
  }

  let mut code = String::new();
  code.push_str("// 本文件由 build.rs 自动生成，请勿手改。\n");
  code.push_str("pub const ASSETS: &[(&str, &[u8])] = &[\n");
  for (rel, path) in &assets {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
    let literal = canonical.to_string_lossy().replace('\\', "/");
    code.push_str(&format!(
      "  ({:?}, include_bytes!(r#\"{}\"#)),\n",
      rel, literal
    ));
  }
  code.push_str("];\n");
  code.push_str("pub const ASSET_COUNT: usize = ");
  code.push_str(&assets.len().to_string());
  code.push_str(";\n");
  code.push_str("pub const ASSET_BYTES: u64 = ");
  code.push_str(&assets_bytes(&assets).to_string());
  code.push_str(";\n");

  let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
  let out_file = out_dir.join("assets.rs");
  let old = fs::read_to_string(&out_file).unwrap_or_default();
  if old != code {
    fs::write(&out_file, &code).expect("写入 assets.rs 失败");
  }

  tauri_build::build();
}

fn assets_bytes(assets: &BTreeMap<String, PathBuf>) -> u64 {
  let mut total = 0u64;
  for path in assets.values() {
    if let Ok(meta) = fs::metadata(path) {
      total += meta.len();
    }
  }
  total
}
