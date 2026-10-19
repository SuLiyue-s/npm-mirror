#!/usr/bin/env node
'use strict';

/**
 * 版本号统一维护工具（零依赖）
 *
 * 用法：
 *   node tools/version.js                 # 打印各文件当前版本，并检查是否一致
 *   node tools/version.js --check         # 检查一致性，不一致退出码 1
 *   node tools/version.js 0.0.2           # 设置指定版本
 *   node tools/version.js --bump patch    # 第三位 +1（默认发版方式）
 *   node tools/version.js --bump minor    # 第二位 +1，第三位归零
 *   node tools/version.js --bump major    # 第一位 +1，后两位归零
 *
 * 维护文件：
 *   package.json                （package.version）
 *   src-tauri/Cargo.toml        （[package].version）
 *   src-tauri/Cargo.lock        （[[package]] name = "npm-mirror-desktop" 的 version，如存在）
 *   src-tauri/tauri.conf.json   （version）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG_FILE = path.join(ROOT, 'package.json');
const CARGO_FILE = path.join(ROOT, 'src-tauri', 'Cargo.toml');
const LOCK_FILE = path.join(ROOT, 'src-tauri', 'Cargo.lock');
const TAURI_CONF_FILE = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
const CARGO_PKG_NAME = 'npm-mirror-desktop';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function fail(msg) {
  console.error('[version] ' + msg);
  process.exit(1);
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    fail('读取失败 ' + file + '：' + e.message);
  }
}

function write(file, text) {
  fs.writeFileSync(file, text, 'utf8');
}

function readPkgVersion() {
  const raw = read(PKG_FILE);
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    fail('package.json 不是合法 JSON：' + e.message);
  }
  return json.version;
}

function readCargoVersion() {
  const raw = read(CARGO_FILE);
  // 只匹配 [package] 段内的第一个 version 行
  const pkgSection = raw.split(/^\[/m);
  for (const sec of pkgSection) {
    if (/^package\]\s*\n/.test(sec) || /^package\]\r?\n/.test(sec)) {
      const m = sec.match(/version\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    }
  }
  fail('src-tauri/Cargo.toml 中未找到 [package].version');
}

function readLockVersion() {
  if (!fs.existsSync(LOCK_FILE)) return null;
  const raw = read(LOCK_FILE);
  const re = new RegExp('\\[\\[package\\]\\]\\r?\\nname = "' + CARGO_PKG_NAME + '"\\r?\\nversion = "([^"]+)"');
  const m = raw.match(re);
  return m ? m[1] : null;
}

function readTauriVersion() {
  const raw = read(TAURI_CONF_FILE);
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    fail('src-tauri/tauri.conf.json 不是合法 JSON：' + e.message);
  }
  return json.version;
}

function check() {
  const versions = {
    'package.json': readPkgVersion(),
    'src-tauri/Cargo.toml': readCargoVersion(),
    'src-tauri/tauri.conf.json': readTauriVersion()
  };
  const lock = readLockVersion();
  if (lock) versions['src-tauri/Cargo.lock'] = lock;
  const uniq = Array.from(new Set(Object.values(versions)));
  console.log('[version] 当前版本：');
  for (const [file, ver] of Object.entries(versions)) {
    console.log('  ' + file.padEnd(28) + ver);
  }
  if (uniq.length > 1) {
    console.error('[version] 版本号不一致：' + uniq.join(' / '));
    return false;
  }
  console.log('[version] 一致：' + uniq[0]);
  return true;
}

function bumpVersion(current, kind) {
  const parts = current.split('.').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
    fail('当前版本不是合法 semver：' + current);
  }
  if (kind === 'patch') parts[2] += 1;
  else if (kind === 'minor') {
    parts[1] += 1;
    parts[2] = 0;
  } else if (kind === 'major') {
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
  } else {
    fail('未知的 bump 类型：' + kind + '（可选 patch/minor/major）');
  }
  return parts.join('.');
}

function setVersion(next) {
  if (!SEMVER_RE.test(next)) fail('版本号格式必须是 x.y.z：' + next);

  // package.json：只替换第一个 "version" 字段
  const pkgRaw = read(PKG_FILE);
  if (!/"version"\s*:\s*"[^"]+"/.test(pkgRaw)) fail('package.json 中未找到 version 字段');
  const pkgNext = pkgRaw.replace(/("version"\s*:\s*")[^"]+(")/, '$1' + next + '$2');
  write(PKG_FILE, pkgNext);

  // src-tauri/Cargo.toml：只替换 [package] 段内的第一个 version
  const cargoRaw = read(CARGO_FILE);
  const cargoLines = cargoRaw.split(/\r?\n/);
  let inPkg = false;
  let cargoDone = false;
  for (let i = 0; i < cargoLines.length; i++) {
    const line = cargoLines[i];
    if (/^\s*\[package\]\s*$/.test(line)) {
      inPkg = true;
      continue;
    }
    if (inPkg && /^\s*\[/.test(line)) inPkg = false;
    if (inPkg && !cargoDone && /^\s*version\s*=\s*"/.test(line)) {
      cargoLines[i] = line.replace(/version\s*=\s*"[^"]+"/, 'version = "' + next + '"');
      cargoDone = true;
    }
  }
  if (!cargoDone) fail('src-tauri/Cargo.toml 中未找到 [package].version');
  write(CARGO_FILE, cargoLines.join('\n'));

  // src-tauri/Cargo.lock（如存在）
  if (fs.existsSync(LOCK_FILE)) {
    const lockRaw = read(LOCK_FILE);
    const re = new RegExp('(\\[\\[package\\]\\]\\r?\\nname = "' + CARGO_PKG_NAME + '"\\r?\\nversion = ")[^"]+(")');
    if (re.test(lockRaw)) write(LOCK_FILE, lockRaw.replace(re, '$1' + next + '$2'));
  }

  // src-tauri/tauri.conf.json
  const confRaw = read(TAURI_CONF_FILE);
  if (!/"version"\s*:\s*"[^"]+"/.test(confRaw)) fail('src-tauri/tauri.conf.json 中未找到 version 字段');
  write(TAURI_CONF_FILE, confRaw.replace(/("version"\s*:\s*")[^"]+(")/, '$1' + next + '$2'));

  console.log('[version] 已把版本统一设置为 ' + next);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--show') {
    check();
    return;
  }
  if (args[0] === '--check') {
    process.exit(check() ? 0 : 1);
  }
  if (args[0] === '--bump') {
    const kind = args[1] || 'patch';
    const current = readPkgVersion();
    setVersion(bumpVersion(current, kind));
    check();
    return;
  }
  if (args[0].startsWith('-')) fail('未知参数：' + args.join(' '));
  setVersion(args[0]);
  check();
}

main();
