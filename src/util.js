'use strict';
/* 通用工具：路径、原子读写、格式化、包名解析、版本比较 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

// ---------------- 程序目录 / 数据目录（桌面版支持） ----------------
// 程序自身根目录：开发 / CLI 模式 = __dirname/.. ；桌面版解压后 = MIRROR_APP_ROOT（Rust 设置）或 __dirname/..
// 注意：只有「程序文件」（public/、cli.js、node.exe 旁的东西）在程序目录；运行数据（config/storage/logs）在主数据目录。
const APP_ROOT = (() => {
  const env = String(process.env.MIRROR_APP_ROOT || '').trim();
  if (env) {
    try { if (path.isAbsolute(env)) return path.resolve(env); } catch { /* 忽略非法值，回退 __dirname/.. */ }
  }
  return path.resolve(__dirname, '..');
})();

// 兼容旧导出：ROOT 仍然表示「程序根目录」
const ROOT = APP_ROOT;

/** 读取命令行参数值：支持 --name=value 与 --name value 两种写法；没出现该参数返回 undefined */
function argvValue(name) {
  const argv = process.argv.slice(2);
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith(prefix)) return a.slice(prefix.length);
    if (a === `--${name}`) {
      const next = argv[i + 1];
      // --name 后面紧跟另一个开关时按「空值」处理（例如 --data-dir --desktop）
      return next !== undefined && !next.startsWith('-') ? next : '';
    }
  }
  return undefined;
}

function hasArgvFlag(name) { return process.argv.slice(2).includes(`--${name}`); }

// 桌面模式：Rust 会设置 MIRROR_DESKTOP=1；开发/自测时直接 `node src/server.js --desktop` 也视为桌面模式。
// 这里顺手把 env 补齐，保证桌面进程拉起的子进程（一键脚本）能继承到同一语义。
const DESKTOP = process.env.MIRROR_DESKTOP === '1' || process.env.MIRROR_DESKTOP === 'true' || hasArgvFlag('desktop');
if (DESKTOP && !process.env.MIRROR_DESKTOP) process.env.MIRROR_DESKTOP = '1';

/**
 * 主数据目录解析（必须在 require 阶段完成：config.js 加载期就要用 dataPath('config.json') 算 CONFIG_FILE）：
 * 优先级 --data-dir 参数 > MIRROR_DATA_DIR 环境变量 > <程序目录>/data。
 * 数据目录不由 config.json 决定（配置本身就在数据目录里，鸡生蛋）。
 */
function computeDataRoot() {
  const fromArg = argvValue('data-dir');
  const raw = String((fromArg !== undefined ? fromArg : process.env.MIRROR_DATA_DIR) || '').trim();
  if (!raw || raw.includes('\0')) return path.join(APP_ROOT, 'data');
  try { return path.resolve(raw); } catch { return path.join(APP_ROOT, 'data'); }
}

let dataRootCache = computeDataRoot();

function appRoot() { return APP_ROOT; }
function dataRoot() { return dataRootCache; }
/** 设置主数据目录（仅内部/测试用）：必须是绝对路径、存在、且是目录，否则抛错 */
function setDataRoot(dir) {
  const raw = String(dir == null ? '' : dir).trim();
  const bad = (msg) => { const e = new Error(msg); e.code = 'EBADDATADIR'; return e; };
  if (!raw) throw bad('数据目录不能为空');
  if (raw.includes('\0')) throw bad('数据目录不能包含空字节');
  if (!path.isAbsolute(raw)) throw bad(`数据目录必须是绝对路径：${raw}`);
  const abs = path.resolve(raw);
  let st = null;
  try { st = fs.statSync(abs); } catch { st = null; }
  if (!st) throw bad(`数据目录不存在：${abs}`);
  if (!st.isDirectory()) throw bad(`数据目录不是文件夹：${abs}`);
  dataRootCache = abs;
  return dataRootCache;
}

function isDesktop() { return DESKTOP; }

function epathError(msg) { const e = new Error(msg); e.code = 'EPATH'; return e; }

/** 校验一段相对路径：非空字符串、不含 NUL、不是绝对路径/盘符相对路径、不含 .. 段 */
function checkRelSegment(part) {
  if (typeof part !== 'string') throw epathError('路径必须是字符串');
  const text = part.trim();
  if (!text) throw epathError('路径不能为空');
  if (text.includes('\0')) throw epathError('路径不能包含空字节');
  const s = text.replace(/\\/g, '/');
  if (path.isAbsolute(s) || /^[A-Za-z]:/.test(s) || s.startsWith('//')) {
    throw epathError(`数据目录内只能使用相对路径：${text}`);
  }
  const segs = s.split('/').filter(seg => seg && seg !== '.');
  if (segs.includes('..')) throw epathError('路径不能包含 .. 段');
  return segs;
}

/**
 * 数据目录内的相对路径安全解析（storage.dir 等统一走这里）：
 *  - 兼容旧配置：以 `data/` 或 `data\` 开头时先去掉该前缀（旧默认值 data/storage 在数据根=<程序目录>/data
 *    时解析为 <程序目录>/data/storage，与旧布局一致）；
 *  - 解析结果必须落在数据目录内部（用 path.relative 校验，不靠字符串前缀）；
 *  - 非法时抛 {code:'EPATH'}。
 */
function resolveWithinDataRoot(rel) {
  if (typeof rel !== 'string') throw epathError('路径必须是字符串');
  let s = rel.trim();
  if (!s) throw epathError('路径不能为空');
  if (s.includes('\0')) throw epathError('路径不能包含空字节');
  s = s.replace(/\\/g, '/');
  // 本接口只接受数据目录内的相对路径：绝对路径（含盘符相对 / UNC）一律拒绝
  if (path.isAbsolute(s) || /^[A-Za-z]:/.test(s) || s.startsWith('//')) {
    throw epathError(`数据目录内只能使用相对路径：${rel.trim()}`);
  }
  if (s === 'data' || s.startsWith('data/')) s = s.slice(s === 'data' ? 4 : 5);
  if (!s) throw epathError('路径不能指向数据目录本身');
  const abs = path.resolve(dataRootCache, s);
  const relOut = path.relative(dataRootCache, abs);
  if (!relOut) throw epathError('路径不能指向数据目录本身');
  if (path.isAbsolute(relOut) || relOut.split(path.sep).includes('..')) {
    throw epathError(`路径不能跳出数据目录：${rel}`);
  }
  return abs;
}

/** 拼数据目录内的绝对路径；对每段做基本校验（禁止绝对路径 / .. / 空字节），防止意外穿越 */
function dataPath(...parts) {
  if (!parts.length) return dataRootCache;
  const segs = [];
  for (const p of parts) segs.push(...checkRelSegment(p));
  if (!segs.length) throw epathError('路径不能为空');
  return path.join(dataRootCache, ...segs);
}

function rootPath(...p) { return path.join(APP_ROOT, ...p); }
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

/** 日志时间戳：本机时区的 ISO 时间，带 +08:00 这类偏移（日期/时区与电脑本机一致；UTC 的 Z 会和本机差几小时） */
function nowLocalIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    + `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
    + `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
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

/** 简单并发上限映射。
 *  注意：单个任务抛错不会中断整批，而是把该下标收成 {__error}；调用方合并结果时
 *  必须显式跳过这种行（本轮审计发现多处 mapLimit 结果直接 for...of / .length 会崩）。 */
async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  const n = Math.floor(Number(limit));
  // limit 非法（NaN/Infinity/0/负数）时兜底成 1：`new Array(NaN)` 会抛 RangeError
  const workerCount = Math.max(1, Math.min(Number.isFinite(n) && n > 0 ? n : 1, list.length || 1));
  let i = 0;
  const workers = new Array(workerCount).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= list.length) return;
      try { out[idx] = await fn(list[idx], idx); }
      catch (e) { out[idx] = { __error: e && e.message ? e.message : String(e) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 「同时在内存里的 Buffer 总量」预算闸门。
 *
 * 并发导入 / 校验 tarball 时，如果只看任务条数（比如 64 路），每路都可能把一整个
 * tarball 读进内存（最大允许 512MB），峰值内存能到几十 GB 直接 OOM。这里按字节数
 * 限流：每路先申请「这个文件有多大」的额度，额度不够就排队等待，用完释放。
 * 单个文件大于总预算时允许独占运行（避免死等）。
 */
function createByteBudget(limitBytes) {
  const cap = Math.max(1, Number(limitBytes) || 256 * 1024 * 1024);
  let used = 0;
  const waiters = [];   // { need, resolve }：按剩余额度唤醒，而不是「等全部归零」才唤醒

  function tryWake() {
    if (!waiters.length) return;
    for (let i = 0; i < waiters.length;) {
      const w = waiters[i];
      // 单个超大文件（need 已按 cap 截断）必须等内存完全空出才放行；普通文件按剩余额度判断
      const ok = w.need >= cap ? used === 0 : used + w.need <= cap;
      if (ok) { waiters.splice(i, 1); try { w.resolve(); } catch { /* 忽略 */ } } else { i++; }
    }
  }

  return {
    /** 申请 n 字节额度，返回实际占用的额度（单文件超过上限时按上限算） */
    async acquire(n) {
      const need = Math.max(1, Math.min(Math.floor(Number(n) || 1), cap));
      // 额度不够就排队；被唤醒后重新判断（别的等待者可能先占用了刚释放的额度）
      while (!(need >= cap ? used === 0 : used + need <= cap)) {
        await new Promise((resolve) => waiters.push({ need, resolve }));
      }
      used += need;
      return need;
    },
    release(need) {
      used = Math.max(0, used - Math.max(0, Math.floor(Number(need) || 0)));
      tryWake();
    },
  };
}

function httpDate(d = new Date()) { return d.toUTCString(); }

module.exports = {
  ROOT, rootPath, ensureDir, readJson, writeFileAtomic, writeJsonAtomic,
  formatBytes, nowIso, nowLocalIso, stamp, dateOnly, pad2, randomToken,
  sha1hex, sha512base64, integrityOf, integrityToCachePath,
  safePkgDir, dirToPkg, pkgBaseName, sleep, isLoopback,
  isSafePkgName, isSafeVersion,
  parsePkgSpec, parseVersion, compareVersions, satisfies, maxSatisfying,
  escapeRegExp, clamp, toPosix, mapLimit, createByteBudget, httpDate,
  // 桌面版：程序目录 / 主数据目录 / 路径穿越防护
  appRoot, dataRoot, setDataRoot, dataPath, resolveWithinDataRoot, isDesktop, argvValue, hasArgvFlag,
};
