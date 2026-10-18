'use strict';
/* 通用工具：路径、原子读写、格式化、包名解析、版本比较 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

function rootPath(...p) { return path.join(ROOT, ...p); }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

/** 同步睡眠（不忙等 CPU）：用于极小范围的同步重试 */
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { try { Atomics.wait(SLEEP_BUF, 0, 0, ms); } catch { /* 忽略 */ } }

function fsyncPath(p, flags) {
  let fd;
  try { fd = fs.openSync(p, flags || 'r+'); fs.fsyncSync(fd); }
  catch { /* 平台不支持时忽略 */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 忽略 */ } } }
}

function writeFileAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  // Windows 下目标文件被杀软/其它进程短暂占用时 rename 可能 EPERM/EBUSY：短暂重试几次再放弃
  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, file); fsyncPath(path.dirname(file), 'r'); return; }
    catch (e) {
      lastErr = e;
      if (!['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(e.code)) break;
      sleepSync(20 + i * 40);
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  throw lastErr;
}

function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2));
}

function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

function nowIso() { return new Date().toISOString(); }

function pad2(n) { return String(n).padStart(2, '0'); }

/** 文件时间戳 YYYYMMDD-HHmmss */
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function dateOnly(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function randomToken(bytes = 24) { return crypto.randomBytes(bytes).toString('hex'); }

function sha1hex(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }
function sha512base64(buf) { return crypto.createHash('sha512').update(buf).digest('base64'); }
function integrityOf(buf) { return `sha512-${sha512base64(buf)}`; }

/** 严格包名校验：允许历史大写的旧包名；禁止反斜杠、空字节、超长与非法字符。
 *  反斜杠在 Windows 上会被 path.join 当分隔符，是路径穿越的根源，必须拒绝。 */
const PKG_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function isSafePkgName(name) {
  if (typeof name !== 'string' || !name || name.length > 214) return false;
  if (name.includes('\\') || name.includes('\0')) return false;
  if (!PKG_NAME_RE.test(name)) return false;
  // Windows 目录限制：结尾的点/空格会被系统静默去掉，保留设备名无法作为目录名
  if (/[. ]$/.test(name)) return false;
  const last = name.split('/').pop();
  if (WIN_RESERVED.test(last)) return false;
  return true;
}

/** 版本号只允许安全字符（用于拼文件名）；拒绝路径分隔符、'..' 与超长 */
function isSafeVersion(v) {
  if (typeof v !== 'string' || !v || v.length > 128) return false;
  if (v.includes('\\') || v.includes('/') || v.includes('\0') || v.includes('..')) return false;
  return /^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(v);
}

/** 包名 -> 磁盘目录名（scoped 包的 / 换成 __）；非法包名直接抛错，杜绝路径穿越 */
function safePkgDir(name) {
  if (!isSafePkgName(name)) {
    const err = new Error(`不合法的包名：${String(name)}`);
    err.code = 'EBADNAME';
    throw err;
  }
  return String(name).replace(/\//g, '__');
}
/** 磁盘目录名 -> 包名 */
function dirToPkg(dir) { return String(dir).replace(/__/g, '/'); }

/** 包名末段，用于 tarball 文件名，例如 @scope/pkg -> pkg */
function pkgBaseName(name) { return String(name).split('/').pop(); }

/** integrity(sha512-base64) -> npm 缓存 content-v2 路径 */
function integrityToCachePath(cacheDir, integrity) {
  const m = /^(sha512|sha256|sha1)-(.+)$/.exec(String(integrity || ''));
  if (!m) return null;
  const algo = m[1];
  const hex = Buffer.from(m[2], 'base64').toString('hex');
  if (hex.length < 4 || !/^[0-9a-f]+$/i.test(hex)) return null;
  return path.join(cacheDir, '_cacache', 'content-v2', algo, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 判断是否为回环地址：整个 IPv4 127.0.0.0/8 网段（不只 127.0.0.1）、IPv6 ::1、
 * 以及 IPv4-mapped 形式（::ffff:127.x.x.x）都算本机回环。
 * 只接受 IP 字面量（主机名 localhost 不等于回环，避免 127.0.0.1.evil.com 之类绕过）。
 */
function isLoopback(addr) {
  if (!addr) return false;
  const a = String(addr).replace(/^::ffff:/, '');
  if (a === '::1') return true;
  if (net.isIPv4(a)) return a.startsWith('127.');
  return false;
}

/** 解析 "name@1.2.3" / "@scope/name@^1.0.0" / "name" */
function parsePkgSpec(spec) {
  const s = String(spec || '').trim();
  if (!s) return null;
  const at = s.lastIndexOf('@');
  if (at <= 0) return { name: s, version: null };
  const name = s.slice(0, at);
  const version = s.slice(at + 1);
  if (!name || name.endsWith('/')) return { name: s, version: null };
  if (!version || version.includes('/')) return { name: s, version: null };
  return { name, version };
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

function parseVersion(v) {
  const m = SEMVER_RE.exec(String(v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '', build: m[5] || '' };
}

/** 预发布段比较（semver 规则：数字段按数值比、数字段小于字母段、段数多的大） */
function comparePre(a, b) {
  const as = String(a).split('.');
  const bs = String(b).split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i]; const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x); const ny = /^\d+$/.test(y);
    if (nx && ny) { const d = +x - +y; if (d) return d < 0 ? -1 : 1; continue; }
    if (nx) return -1;
    if (ny) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa && !pb) return String(a).localeCompare(String(b));
  if (!pa) return -1;
  if (!pb) return 1;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;   // 正式版 > 预发布版
  if (!pb.pre) return -1;
  return comparePre(pa.pre, pb.pre);
}

/** 极简 semver 范围判断，支持 ^ ~ >= > <= < = * x || 空格(AND) 与连字符范围
 *  语义对齐 npm 的 node-semver（含省略小版本号的 ~ / ^ / 比较操作符、预发布版本匹配规则） */
function satisfies(version, range) {
  range = String(range == null ? '' : range).trim();
  const v = parseVersion(version);
  if (!v) return false;
  // 与 npm 一致：通配范围不匹配任何预发布版本（除非范围里有同 x.y.z 的预发布比较器）
  if (!range || range === '*' || range === 'x') return !v.pre;
  if (range === 'latest') return true;
  // 「>= 2.1.2 < 3」这种操作符与版本号之间带空格的写法必须先粘回去：
  // 否则按空格切成 ['>=','2.1.2','<','3']，裸 '3' 会被当成「精确版本 3」而判成不满足。
  const norm = range.replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1');
  const parts = norm.split('||').map(s => s.trim()).filter(Boolean);
  return parts.some(part => {
    // 连字符范围「1.2.3 - 2.3.4」= >=1.2.3 且 <=2.3.4
    const hy = /^(\S+)\s+-\s+(\S+)$/.exec(part);
    const conds = hy ? ['>=' + hy[1], '<=' + hy[2]] : part.split(/\s+/).filter(Boolean);
    if (!conds.every(c => satisfyOne(version, c))) return false;
    if (v.pre) {
      // 与 npm 一致：候选是预发布版时，只有「同一 x.y.z 的某个比较器也带预发布段」才允许匹配
      return conds.some((c) => {
        const sp = parseSpecVersion(c.replace(/^(\^|~|>=|<=|>|<|=)/, ''));
        return sp && sp.pre && sp.major === v.major && sp.minor === v.minor && sp.patch === v.patch;
      });
    }
    return true;
  });
}

/** 解析范围里的单段版本；x/* / 省略段返回 null 表示「未指定」 */
const SPEC_VER_RE = /^([0-9]+|[xX*])(?:\.([0-9]+|[xX*]))?(?:\.([0-9]+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
function parseSpecVersion(s) {
  const m = SPEC_VER_RE.exec(String(s || '').trim().replace(/^v/, ''));
  if (!m || !m[1] || /^[xX*]$/.test(m[1])) return null;
  const num = (x) => (x === undefined || /^[xX*]$/.test(x) ? null : +x);
  return {
    major: +m[1], minor: num(m[2]), patch: num(m[3]),
    pre: m[4] || '',
  };
}

function satisfyOne(version, cond) {
  const v = parseVersion(version);
  if (!v) return false;
  const m = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(cond);
  let op = (m && m[1]) || '=';
  let rest = ((m && m[2]) || '').trim();
  if (!rest || rest === '*' || rest === 'x' || rest === 'latest') return true;
  const sp = parseSpecVersion(rest);
  if (!sp) return false;
  const minor = sp.minor === null ? 0 : sp.minor;
  const patch = sp.patch === null ? 0 : sp.patch;
  const baseCore = `${sp.major}.${minor}.${patch}`;
  const lower = sp.pre ? `${baseCore}-${sp.pre}` : baseCore;
  const majorBump = `${sp.major + 1}.0.0`;
  const minorBump = `${sp.major}.${minor + 1}.0`;
  const cmp = (x) => compareVersions(version, x);
  switch (op) {
    case '=':
      if (sp.minor === null) return v.major === sp.major;
      if (sp.patch === null) return v.major === sp.major && v.minor === sp.minor;
      return cmp(lower) === 0;
    case '>=': return cmp(lower) >= 0;
    case '>':
      if (sp.minor === null) return cmp(majorBump) >= 0;   // >1 → >=2.0.0
      if (sp.patch === null) return cmp(minorBump) >= 0;   // >1.2 → >=1.3.0
      return cmp(lower) > 0;
    case '<': return cmp(lower) < 0;
    case '<=':
      if (sp.minor === null) return cmp(majorBump) < 0;    // <=1 → <2.0.0
      if (sp.patch === null) return cmp(minorBump) < 0;    // <=1.2 → <1.3.0
      return cmp(lower) <= 0;
    case '~':
      // ~1 → >=1.0.0 <2.0.0；~1.2 → >=1.2.0 <1.3.0；~1.2.3 → >=1.2.3 <1.3.0
      return cmp(lower) >= 0 && cmp(sp.minor === null ? majorBump : minorBump) < 0;
    case '^': {
      // ^1 → <2.0.0；^0.2 → <0.3.0；^0.0 → <0.1.0；^0.0.3 → <0.0.4
      let upper;
      if (sp.minor === null) upper = majorBump;
      else if (sp.major > 0) upper = majorBump;
      else if (sp.patch === null) upper = minorBump;
      else if (sp.minor > 0) upper = minorBump;
      else upper = `${sp.major}.${minor}.${patch + 1}`;
      return cmp(lower) >= 0 && cmp(upper) < 0;
    }
    default: return false;
  }
}

/** 从版本号列表中挑出满足 range 的最高版本 */
function maxSatisfying(versions, range) {
  const ok = versions.filter(v => satisfies(v, range));
  if (!ok.length) return null;
  return ok.sort(compareVersions).pop();
}

function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

function toPosix(p) { return String(p).replace(/\\/g, '/'); }

/** 简单并发上限映射 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { out[idx] = await fn(items[idx], idx); }
      catch (e) { out[idx] = { __error: e && e.message ? e.message : String(e) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

function httpDate(d = new Date()) { return d.toUTCString(); }

module.exports = {
  ROOT, rootPath, ensureDir, readJson, writeFileAtomic, writeJsonAtomic,
  formatBytes, nowIso, stamp, dateOnly, pad2, randomToken,
  sha1hex, sha512base64, integrityOf, integrityToCachePath,
  safePkgDir, dirToPkg, pkgBaseName, sleep, isLoopback,
  isSafePkgName, isSafeVersion,
  parsePkgSpec, parseVersion, compareVersions, satisfies, maxSatisfying,
  escapeRegExp, clamp, toPosix, mapLimit, httpDate,
};
