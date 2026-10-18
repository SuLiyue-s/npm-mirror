'use strict';
/* 从本机已有的 npm 缓存（_cacache）导入包 —— 无需联网即可把平时装过的包灌进镜像 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const {
  integrityToCachePath, ensureDir, readJson, writeJsonAtomic, rootPath, compareVersions,
  isSafePkgName, isSafeVersion, mapLimit, createByteBudget,
} = require('./util');

let scanState = null;                   // { cacheDir, registry, scannedAt, packages:[{...,__contentPath}] }
// 2: 扫描阶段会校验每个可导入 tarball 的 integrity，旧扫描结果需要重扫才能得到准确计数
const SCAN_STATE_VERSION = 2;

function stateFile() { return rootPath('data', 'npmcache-scan.json'); }

/** 用户主目录：环境变量缺失时回退 os.homedir()；都取不到返回 ''。
 *  绝不能让空字符串参与 path.join，否则会变成相对路径、误读「当前目录下的 .npmrc」。 */
function homeDir() {
  const fromEnv = process.env.USERPROFILE || process.env.HOME || '';
  if (fromEnv) return fromEnv;
  try { return os.homedir() || ''; } catch { return ''; }
}

/** 展开以 ~ 开头的路径：npm 的 .npmrc 里 `cache=~/...` 实际指向用户主目录 */
function expandHome(p) {
  const s = String(p == null ? '' : p).trim();
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    const home = homeDir();
    if (!home) return s;   // 取不到主目录时保持原样，交给后续 resolve 去报错/兜底
    return s === '~' ? home : path.join(home, s.slice(2));
  }
  return s;
}

/** 缓存目录比较键：绝对路径 + Windows 下大小写不敏感，避免同一目录因写法不同触发全量重扫 */
function cacheDirKey(dir) {
  let p;
  try { p = path.resolve(expandHome(dir)); } catch { p = String(dir); }
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
function sameCacheDir(a, b) {
  if (!a || !b) return false;
  return cacheDirKey(a) === cacheDirKey(b);
}

/** 校验 cacache 内容与索引记录中的 integrity 是否一致（sha512-<base64> 等），防止被篡改的缓存直接写入镜像 */
function verifyIntegrity(buf, integrity) {
  const m = /^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(String(integrity || ''));
  if (!m) return false;
  let expected;
  try { expected = Buffer.from(m[2], 'base64'); } catch { return false; }
  if (!expected.length) return false;
  const actual = crypto.createHash(m[1]).update(buf).digest();
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * 流式校验磁盘文件的 integrity：不把整个 tarball 读进内存（扫描阶段只关心「是否被篡改」，
 * 大 tarball 在 64 路并发下若各自 readFile 会成倍放大内存峰值，极端情况直接 OOM）。
 * 返回 { ok, sizeBytes }；文件读不了时 ok=false、sizeBytes=0。
 */
async function verifyFileIntegrity(file, integrity) {
  const m = /^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(String(integrity || ''));
  if (!m) {
    // 没有可用 integrity 时退化为「读得到就算通过」，但仍用流扫描统计大小，避免整文件进内存
    let sizeBytes = 0;
    try {
      for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) sizeBytes += chunk.length;
      return { ok: true, sizeBytes };
    } catch { return { ok: false, sizeBytes: 0 }; }
  }
  let expected;
  try { expected = Buffer.from(m[2], 'base64'); } catch { return { ok: false, sizeBytes: 0 }; }
  if (!expected.length) return { ok: false, sizeBytes: 0 };
  const hash = crypto.createHash(m[1]);
  let sizeBytes = 0;
  try {
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) { hash.update(chunk); sizeBytes += chunk.length; }
  } catch { return { ok: false, sizeBytes: 0 }; }
  const actual = hash.digest();
  const ok = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  return { ok, sizeBytes };
}

/** 判定 p 是否在 base 目录内（用于校验扫描结果里记录的缓存内容路径没被篡改/串目录） */
function isInside(base, p) {
  try {
    const rel = path.relative(path.resolve(base), path.resolve(p));
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  } catch { return false; }
}

/**
 * 元数据整体读入内存的字节预算：导入时每个包都会把 packument（可达数 MB）整块读入校验/解析，
 * 64 路并发时峰值可能到几百 MB，用预算把并发读总量压住。
 */
const META_BYTE_BUDGET = createByteBudget(128 * 1024 * 1024);

/** 解析用户级 .npmrc 里的 cache 配置 */
function readNpmrcCacheDir() {
  const home = homeDir();
  const candidates = [];
  // home 为空时 path.join('', '.npmrc') 会变成当前目录下的相对路径，必须跳过
  if (home) candidates.push(path.join(home, '.npmrc'));
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'etc', 'npmrc'));
  for (const f of candidates) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const m = /^cache\s*=\s*(.+)$/i.exec(line);
      if (m) {
        let v = m[1].trim().replace(/^["']|["']$/g, '');
        v = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => process.env[n] || '');
        v = expandHome(v);
        if (v) return v;
      }
    }
  }
  return '';
}

function defaultCacheDir() {
  const fromNpmrc = readNpmrcCacheDir();
  if (fromNpmrc) return fromNpmrc;
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'npm-cache');
  const home = homeDir();
  // 取不到主目录时返回空串，由调用方给出明确错误，避免用相对路径瞎猜
  return home ? path.join(home, '.npm') : '';
}

function resolveCacheDir(cfgOverride) {
  const raw = (cfgOverride && String(cfgOverride).trim()) ? String(cfgOverride).trim() : defaultCacheDir();
  if (!raw) return '';
  // 统一成绝对路径（展开 ~ 并归一化分隔符），后续比较才不会被 `C:/x` 与 `c:\x` 这类写法差异干扰
  try { return path.resolve(expandHome(raw)); } catch { return raw; }
}

function walkFiles(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out, depth + 1);
    else out.push(full);
  }
  return out;
}

async function walkFilesAsync(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkFilesAsync(full, out, depth + 1);
    else out.push(full);
  }
  return out;
}

function safeUrl(u) { try { return new URL(u); } catch { return null; } }
function hostOf(registry) { const u = safeUrl(registry); return u ? u.host : ''; }

/** 对外（界面）用的结果：剥掉内部字段 */
function publicScan(state) {
  if (!state) return null;
  return {
    cacheDir: state.cacheDir,
    registry: state.registry,
    scannedAt: state.scannedAt,
    durationMs: state.durationMs,
    scannedFiles: state.scannedFiles,
    packages: state.packages.map(({ __contentPath, __integrity, ...rest }) => rest),
    total: state.packages.length,
    withTarball: state.packages.filter(p => p.hasTarball).length,
    bytes: state.packages.reduce((a, p) => a + (p.sizeBytes || 0), 0),
    tampered: state.tampered || 0,
    tamperedTarballs: state.tamperedTarballs || 0,
  };
}

function loadScanState() {
  if (scanState) return scanState;
  const saved = readJson(stateFile(), null);
  if (saved && Array.isArray(saved.packages)) scanState = saved;
  return scanState;
}

function lastScan() { return publicScan(loadScanState()); }

/**
 * 扫描本机 npm 缓存，列出可以离线导入的包。
 * 使用异步读取 + 定期让出事件循环，扫描期间镜像服务仍然可用。
 */
async function scanCache({ cacheDir, registry, logger, anyRegistry = false, onProgress, concurrency = 8 } = {}) {
  const dir = resolveCacheDir(cacheDir);
  if (!dir) {
    const err = new Error('无法确定 npm 缓存目录：HOME/USERPROFILE 环境变量缺失且系统主目录不可用，请在「配置」页手动指定缓存目录');
    err.code = 'NO_CACHE';
    throw err;
  }
  const indexDir = path.join(dir, '_cacache', 'index-v5');
  const started = Date.now();
  if (!fs.existsSync(indexDir)) {
    const err = new Error(`未找到 npm 缓存索引目录：${indexDir}（可先用 npm 安装一些包，或在「配置」页里指定缓存目录）`);
    err.code = 'NO_CACHE';
    throw err;
  }
  const wantHost = anyRegistry ? '' : hostOf(registry);
  const files = await walkFilesAsync(indexDir);
  const conc = Math.max(1, Math.min(64, Math.floor(Number(concurrency)) || 8));
  let scanned = 0;
  let tampered = 0;
  const foundNow = new Set();

  /* 第一阶段（并发读索引）：原来是一个文件一个文件串行 await，npm 缓存大时（几万个索引文件）
   * 扫描要等很久。现在按 concurrency 路并发读索引文件并校验元数据内容，镜像服务在扫描期间仍可用。
   * 并发下同一个包可能被多个索引条目指向，所以先按文件顺序收候选、最后顺序去重，
   * 保证「先扫到的为准」，扫描结果与串行版本一致、不会时快时慢。
   * 注意：这一步每个任务会把 packument（最大约 10MB）整块读入校验，所以把并发压到 8 路，
   * 避免 64 路 × 大元数据把内存打爆；真正慢的 tarball 校验在第二阶段（流式，可高并发）。 */
  const hits = await mapLimit(files, Math.min(conc, 8), async (f) => {
    let text = '';
    try { text = await fsp.readFile(f, 'utf8'); } catch { return null; }
    scanned++;
    const out = [];
    const seenInFile = new Set();
    for (const line of text.split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      let entry = null;
      try { entry = JSON.parse(line.slice(tab + 1)); } catch { continue; }
      const key = String(entry.key || '');
      const at = key.indexOf('request-cache:');
      if (at < 0) continue;
      const rawUrl = key.slice(at + 'request-cache:'.length).split('?')[0];
      const u = safeUrl(rawUrl);
      if (!u) continue;
      // 只接受 registry 的 packument 端点：/name 或 /@scope/name（scoped 在 URL 里可能编码成 %2f）。
      // 不能按 .json/.har/.tgz 后缀过滤——包名本身可能以这些后缀结尾，会漏扫；tarball 端点含 /-/ 已排除。
      if (u.pathname.includes('/-/')) continue;
      if (wantHost && u.host !== wantHost) continue;
      let pkgName = '';
      try { pkgName = decodeURIComponent(u.pathname.replace(/^\/+/, '')); } catch { continue; }
      if (!isSafePkgName(pkgName) || seenInFile.has(pkgName)) continue;
      seenInFile.add(pkgName);
      const contentPath = integrityToCachePath(dir, entry.integrity);
      if (!contentPath) continue;
      let raw = null;
      try { raw = await fsp.readFile(contentPath); } catch { continue; }
      // 缓存内容可能被篡改：必须与索引记录里的 integrity 一致才认可
      if (!verifyIntegrity(raw, entry.integrity)) {
        tampered++;
        foundNow.add(pkgName);
        if (logger) logger.warn(`跳过完整性校验失败的 npm 缓存条目：${pkgName}`);
        continue;
      }
      let data = null;
      try { data = JSON.parse(raw.toString('utf8')); } catch { continue; }
      if (!data || !data.versions || !data.name) continue;
      if (!isSafePkgName(data.name)) continue;
      foundNow.add(data.name);
      out.push({ name: data.name, packument: data, contentPath, integrity: entry.integrity });
    }
    // 进度回调异常不能打断扫描：以前在并发任务里直接调用，回调一抛错该文件结果
    // 就变成 mapLimit 的 {__error} 行，后面合并时 for...of 直接 TypeError 整次扫描失败。
    if (onProgress && scanned % 2000 === 0) { try { onProgress({ scanned, total: files.length, found: foundNow.size }); } catch { /* 忽略 */ } }
    return out;
  });
  const found = new Map();
  let failedFiles = 0;
  for (const list of hits) {
    // 并发阶段个别文件抛错时 mapLimit 会给出 {__error} 对象，这里必须跳过而不是当数组迭代
    if (!Array.isArray(list)) { failedFiles++; continue; }
    for (const it of list) {
      if (!it || !it.name) continue;
      if (found.has(it.name)) continue;
      found.set(it.name, it);
    }
  }
  if (failedFiles && logger) logger.warn(`扫描 npm 缓存：${failedFiles} 个索引文件读取/解析失败，已跳过`);
  if (onProgress) { try { onProgress({ scanned, total: files.length, found: found.size }); } catch { /* 忽略 */ } }

  /* 第二阶段（并发校验 tarball）：逐包读取本地缓存里的每个版本 tarball 并校验 integrity，
   * 包与包之间并发执行（原来逐包逐版本全串行）。
   * 这里改成「流式」校验：只算哈希、不把 tarball 读进内存。以前 64 路并发时
   * 同时最多有 64 个整包 Buffer 在内存里，遇到大 tarball 会直接把进程内存打满。 */
  const rows = await mapLimit(Array.from(found.entries()), conc, async ([name, rec]) => {
    const versions = Object.keys(rec.packument.versions || {});
    let avail = 0, size = 0, badTarballs = 0;
    for (const v of versions) {
      const dist = rec.packument.versions[v].dist || {};
      const p = integrityToCachePath(dir, dist.integrity);
      if (!p) continue;
      // 扫描阶段就校验 tarball 的 integrity：否则「扫描说有 N 个可导入」与「导入只成功 M 个」口径不一致
      const checked = await verifyFileIntegrity(p, dist.integrity);
      if (!checked.ok) {
        badTarballs++;
        if (logger) logger.warn(`跳过完整性校验失败的 npm 缓存 tarball：${name}@${v}`);
        continue;
      }
      size += checked.sizeBytes;
      avail++;
    }
    const latest = (rec.packument['dist-tags'] && rec.packument['dist-tags'].latest) || versions.sort(compareVersions).pop();
    return {
      name,
      version: latest || '',
      versionCount: versions.length,
      tarballCount: avail,
      // 校验失败、不可导入的 tarball 数量；hasTarball 只按通过校验的 tarball 计算
      tamperedTarballs: badTarballs,
      sizeBytes: size,
      hasTarball: avail > 0,
      __contentPath: rec.contentPath,
      // 导入时要用它重新校验元数据完整性（publicScan 会剥掉）
      __integrity: rec.integrity,
    };
  });
  // 并发阶段个别包抛异常时 mapLimit 会给出 {__error} 行：必须滤掉，否则下面排序
  // 访问 a.name / a.sizeBytes 会 TypeError 整个扫描失败。
  const packages = rows.filter((row) => row && !row.__error && row.name && Number.isFinite(row.sizeBytes));
  if (packages.length < rows.length && logger) {
    logger.warn(`扫描 npm 缓存：${rows.length - packages.length} 个包在校验阶段失败，已跳过`);
  }
  packages.sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name));
  scanState = {
    version: SCAN_STATE_VERSION,
    cacheDir: dir,
    registry: registry || '',
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    scannedFiles: scanned,
    tampered,
    tamperedTarballs: packages.reduce((a, p) => a + (p.tamperedTarballs || 0), 0),
    packages,
  };
  try { ensureDir(path.dirname(stateFile())); writeJsonAtomic(stateFile(), scanState); } catch { /* 忽略 */ }
  if (logger) {
    const nTamperedTarballs = scanState.tamperedTarballs;
    logger.info(`扫描 npm 缓存完成：${packages.length} 个包（其中 ${packages.filter(p => p.hasTarball).length} 个含 tarball${tampered ? `，跳过 ${tampered} 个完整性校验失败条目` : ''}${nTamperedTarballs ? `，跳过 ${nTamperedTarballs} 个完整性校验失败的 tarball` : ''}），耗时 ${scanState.durationMs}ms`);
  }
  return publicScan(scanState);
}

/**
 * 从缓存导入指定包；默认只导入本地确实有 tarball 的版本。
 *
 * 进度回调 onProgress（可选）会收到三类事件，界面据此展示「正在导入的包」和逐包导入详情：
 *   { phase:'start',   name, versionTotal, done, total }      开始处理某个包
 *   { phase:'version', name, versionDone, versionTotal }      包内版本进度（约 120ms 节流一次）
 *   { phase:'done',    name, status:'imported'|'skipped'|'failed',
 *                      versions, tarballs, sizeBytes, reason, error, done, total }
 * 传 isCanceled 后，每处理一个包前都会检查一次；返回 true 则停下，并把 result.canceled 置为 true。
 */
async function importFromCache({ store, cacheDir, names = [], all = false, overwrite = false, onlyWithTarball = true, logger, onProgress, isCanceled, concurrency = 8 }) {
  const dir = resolveCacheDir(cacheDir);
  let state = loadScanState();
  // 旧版本扫描结果没有 __integrity / 未做 tarball 校验，或缓存目录只是写法不同，都需要重新扫描
  if (!state || !sameCacheDir(state.cacheDir, dir) || state.version !== SCAN_STATE_VERSION || state.packages.some(p => !p.__integrity)) {
    await scanCache({ cacheDir: dir, registry: '', logger, anyRegistry: true, concurrency });
    state = scanState;
  }
  const wanted = all ? state.packages.map(p => p.name) : names;
  const result = {
    imported: [], failed: [], skipped: [], tarballs: 0, total: wanted.length, canceled: false,
    invalidVersions: 0, invalidTarballs: 0,
  };
  const emit = (e) => {
    if (!onProgress) return;
    try { onProgress(e); } catch { /* 进度回调异常不能打断导入 */ }
  };
  const conc = Math.max(1, Math.min(64, Math.floor(Number(concurrency)) || 8));
  const infoByName = new Map();
  for (const p of state.packages) if (!infoByName.has(p.name)) infoByName.set(p.name, p);
  let done = 0;

  /* 包级并发：每个包只锁自己（store.withLock），跨包互不阻塞；包内仍按版本顺序读盘。
   * 原来逐包串行、包内又用同步 readFileSync，一次只能用一个核读一个文件；
   * 现在并发读盘 + 同步写入，等待磁盘的时间被多路复用。结果先按输入下标收集，
   * 最后按原顺序汇总，保证 imported/failed/skipped 顺序稳定。 */
  const settled = await mapLimit(Array.from(wanted), conc, async (rawName, index) => {
    const name = String(rawName);
    const base = { index, name };
    if (isCanceled && isCanceled()) { result.canceled = true; return { ...base, canceled: true }; }
    if (!isSafePkgName(name)) {
      done++;
      const bad = { status: 'skipped', versions: 0, tarballs: 0, sizeBytes: 0, reason: '非法包名，已拒绝导入' };
      if (logger) logger.warn(`从 npm 缓存导入时拒绝非法包名：${name}`);
      emit(Object.assign({ phase: 'done', name, done, total: wanted.length }, bad));
      return Object.assign(base, bad);
    }
    const info = infoByName.get(name);
    if (!info) {
      done++;
      const skipped = { status: 'skipped', versions: 0, tarballs: 0, sizeBytes: 0, reason: '缓存中未找到该包的元数据' };
      emit(Object.assign({ phase: 'done', name, done, total: wanted.length }, skipped));
      return Object.assign(base, skipped);
    }
    emit({ phase: 'start', name, versionTotal: Number(info.versionCount) || 0, done, total: wanted.length });
    let invalidVersions = 0;
    let invalidTarballs = 0;
    let outcome = null;
    try {
      outcome = await store.withLock(name, async () => {
        let packument = null;
        // 扫描结果文件（data/npmcache-scan.json）是本地数据，也可能被手工改动/串目录：
        // 只允许读取「当前缓存目录内」的内容文件，避免把任意路径当缓存内容读进来。
        if (info.__contentPath && isInside(dir, info.__contentPath)) {
          // 元数据同样按扫描时记录的 integrity 校验，防止被篡改的缓存直接写进镜像
          let raw = null;
          let cred = 0;
          try {
            const st = await fsp.stat(info.__contentPath);
            cred = await META_BYTE_BUDGET.acquire((st && st.size) || 1);
            raw = await fsp.readFile(info.__contentPath);
          } catch { raw = null; }
          try {
            if (raw && verifyIntegrity(raw, info.__integrity)) {
              try { packument = JSON.parse(raw.toString('utf8')); } catch { packument = null; }
            } else if (logger) {
              logger.warn(`跳过完整性校验失败的缓存元数据：${name}`);
            }
          } finally {
            if (cred) META_BYTE_BUDGET.release(cred);
          }
        } else if (logger) {
          logger.warn(`缓存元数据路径不在缓存目录内，已拒绝读取：${name}`);
        }
        if (!packument) throw new Error('缓存中的元数据已失效或完整性校验失败，请重新扫描');
        const local = await store.getAsync(name);
        // 新建 packument 时清空 dist-tags，下面只写入指向真实存在版本号的 tag
        const target = local ? local.packument : { ...packument, versions: {}, 'dist-tags': {} };
        const files = {}; const sizes = {}; const origins = {};
        const versionTotal = Object.keys(packument.versions || {}).length;
        let added = 0, got = 0, seen = 0, lastEmit = 0;
        let canceledMid = false;
        for (const [v, manifest] of Object.entries(packument.versions)) {
          // 取消响应：包内版本可能很多（几千个），每 32 个检查一次，别让用户等整个包做完
          if ((seen & 31) === 0 && isCanceled && isCanceled()) { canceledMid = true; break; }
          // 版本号会参与 tarball 文件名拼接，非法版本号直接跳过（不写盘）
          if (!isSafeVersion(v)) { invalidVersions++; continue; }
          const dist = manifest.dist || {};
          const p = integrityToCachePath(dir, dist.integrity);
          /* 先流式校验 integrity，再用流式拷贝写入镜像：
           * 不再 fsp.readFile 整块读进内存 —— 原来每路并发都 hold 一个完整 tarball Buffer，
           * 64 路 × 大 tarball 时会直接把内存打爆。 */
          let tarballOk = false;
          if (p) {
            const checked = await verifyFileIntegrity(p, dist.integrity);
            if (!checked.ok) {
              invalidTarballs++;
              if (logger) logger.warn(`跳过完整性校验失败的缓存 tarball：${name}@${v}`);
            } else tarballOk = true;
          }
          const hasFile = tarballOk;
          seen++;
          if (onlyWithTarball && !hasFile) continue;
          if (target.versions[v] && !overwrite && store.hasTarball(name, v)) continue;
          target.versions[v] = manifest;
          if (hasFile) {
            const info2 = await store.putTarballFromFileAsync(name, v, p);
            files[v] = info2.file; sizes[v] = info2.sizeBytes; origins[v] = 'npm-cache';
            got++;
          }
          added++;
          const now = Date.now();
          if (now - lastEmit >= 120) { lastEmit = now; emit({ phase: 'version', name, versionDone: seen, versionTotal }); }
        }
        if (canceledMid) result.canceled = true;
        if (added === 0) {
          // 跳过原因要明确：是本地已全有、缓存里没 tarball，还是 tarball 校验失败（疑似被篡改）
          let reason;
          if (invalidTarballs > 0) reason = `没有可导入的版本（${invalidTarballs} 个 tarball 完整性校验失败，疑似被篡改）`;
          else if (onlyWithTarball && !got) reason = local ? '本地已有全部版本' : '缓存中没有通过完整性校验的 tarball';
          else reason = local ? '本地已有全部版本' : '没有可导入的版本';
          return { status: 'skipped', versions: 0, tarballs: 0, sizeBytes: 0, reason };
        }
        for (const [tag, v] of Object.entries(packument['dist-tags'] || {})) {
          if (!target.versions[v]) continue; // 悬空 dist-tag 丢弃
          target['dist-tags'] = target['dist-tags'] || {};
          if (!target['dist-tags'][tag] || overwrite) target['dist-tags'][tag] = v;
        }
        store.save(name, target, {
          source: (local && local.meta && local.meta.source) || 'cache',
          description: target.description || packument.description || '',
          files, sizes, origins,
        });
        return { status: 'imported', versions: added, tarballs: got, sizeBytes: Object.values(sizes).reduce((a, b) => a + b, 0) };
      });
    } catch (e) {
      outcome = { status: 'failed', versions: 0, tarballs: 0, sizeBytes: 0, error: e.message };
    }
    done++;
    emit(Object.assign({ phase: 'done', name, done, total: wanted.length }, outcome));
    return Object.assign(base, { invalidVersions, invalidTarballs }, outcome);
  });

  // mapLimit 对「整包任务抛异常」会给 {__error} 行：按输入下标兜底包名，不能静默丢结果
  for (let i = 0; i < settled.length; i++) {
    const it = settled[i];
    if (!it) continue;
    if (it.__error) {
      result.failed.push({ name: String(wanted[i]), error: it.__error });
      continue;
    }
    if (it.canceled) continue;
    result.invalidVersions += it.invalidVersions || 0;
    result.invalidTarballs += it.invalidTarballs || 0;
    if (it.status === 'imported') result.imported.push({ name: it.name, versions: it.versions, tarballs: it.tarballs, sizeBytes: it.sizeBytes });
    else if (it.status === 'failed') result.failed.push({ name: it.name, error: it.error });
    else if (it.status === 'skipped') result.skipped.push({ name: it.name, reason: it.reason });
    result.tarballs += it.tarballs || 0;
  }
  if (logger) {
    const extra = [
      result.invalidVersions ? `跳过 ${result.invalidVersions} 个非法版本号` : '',
      result.invalidTarballs ? `跳过 ${result.invalidTarballs} 个完整性校验失败的 tarball` : '',
    ].filter(Boolean).join('，');
    logger.info(`从 npm 缓存导入完成：成功 ${result.imported.length} 个包 / ${result.tarballs} 个 tarball，失败 ${result.failed.length}${extra ? `，${extra}` : ''}${result.canceled ? '（已取消）' : ''}`);
  }
  return result;
}

module.exports = {
  defaultCacheDir, resolveCacheDir, readNpmrcCacheDir, stateFile,
  scanCache, importFromCache, lastScan, walkFiles,
};
