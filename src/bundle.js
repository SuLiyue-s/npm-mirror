'use strict';
/* 离线迁移包：整库/按范围导出为单个 .tgz，或从 .tgz 导入（合并式，可重复导入） */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  ensureDir, readJson, rootPath, stamp, safePkgDir, pkgBaseName, sha1hex, integrityOf, nowIso, compareVersions,
  isSafePkgName, isSafeVersion, mapLimit, clamp,
} = require('./util');
const tar = require('./tar');
const deps = require('./deps');
const pull = require('./pull');

const FORMAT = 'npm-private-mirror-bundle';
const FORMAT_VERSION = 1;

/** 连带导出依赖时最多纳入多少个包（防止误点「全部包」把整个镜像拖进来） */
const DEPS_MAX_PACKAGES = 3000;

/**
 * 解析「按添加时间导出」的时间边界。
 * 接受 ISO 字符串（2026-10-01T12:30、2026-10-01）或毫秒数；空值返回 null。
 * 时间边界是闭区间（含端点），与前端 datetime-local 的直觉一致。
 */
function parseTimeBound(v, label) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) {
    const err = new Error(`${label}格式不正确：${s}（例：2026-10-01T00:00 或 2026-10-01T23:59）`);
    err.code = 'EBADTIME';
    err.status = 400;
    throw err;
  }
  return t;
}

/**
 * 规范化「按添加时间」导出区间：{ from, to }（毫秒，null 表示不设边界）。
 * - 至少给一个边界；
 * - from 不能晚于 to；
 * - 额外回传 fromIso/toIso 供 manifest 记录。
 */
function normalizeAddedRange({ addedFrom, addedTo } = {}) {
  const from = parseTimeBound(addedFrom, '起始时间');
  const to = parseTimeBound(addedTo, '结束时间');
  if (from === null && to === null) {
    const err = new Error('按添加时间导出需要至少给出起始时间或结束时间');
    err.code = 'EBADTIME';
    err.status = 400;
    throw err;
  }
  if (from !== null && to !== null && from > to) {
    const err = new Error('起始时间不能晚于结束时间');
    err.code = 'EBADTIME';
    err.status = 400;
    throw err;
  }
  return {
    from, to,
    fromIso: from === null ? null : new Date(from).toISOString(),
    toIso: to === null ? null : new Date(to).toISOString(),
  };
}

/** 包是否在区间内：用本地镜像记录的「首次添加时间」meta.createdAt（闭区间） */
function pkgAddedInRange(meta, from, to) {
  const t = Date.parse((meta && meta.createdAt) || '');
  if (!Number.isFinite(t)) return false;
  if (from !== null && t < from) return false;
  if (to !== null && t > to) return false;
  return true;
}


function bundleDir() { return rootPath('data', 'bundles'); }
function tmpRoot() { return rootPath('data', 'tmp'); }

function safeFileName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '-').slice(0, 80);
}

/** 包名/版本号来自 tarball 或 bundle 内的 JSON，属于不可信输入；会参与磁盘路径拼接，必须严格校验 */
function badNameError(name) {
  const err = new Error(`不合法的包名：${String(name)}`);
  err.code = 'EBADNAME';
  return err;
}
function badVersionError(name, version) {
  const err = new Error(`不合法的版本号：${String(name)}@${String(version)}`);
  err.code = 'EBADVERSION';
  return err;
}

/** bundle 结构/格式错误：统一标记 400（上层 import 路由已按 400 返回，/upload 等也据此归类） */
function bundleFormatError(message, code = 'EBADFORMAT') {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
}

function sameDigest(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * 版本比较用的归一化键：npm 会把 tarball 里的版本写法规范化（express@1.0.0-beta 的 tarball 内
 * package.json 里写的是 `1.0.0beta`），所以「tarball 内版本 vs packument 版本」不能直接字符串比。
 * 这里把分隔符（- . _ +）统一去掉再比，只用于「是否同一个版本」的兼容判断，不影响存储键。
 */
function versionKey(v) {
  return String(v == null ? '' : v).trim().toLowerCase().replace(/^v/, '').replace(/[^0-9a-z]/g, '');
}

/** 按 packument 里 dist.integrity（缺失时用 dist.shasum）校验 tarball 实际字节；返回 null 表示通过 */
function verifyTarballBytes(buf, dist) {
  const d = dist && typeof dist === 'object' ? dist : {};
  const integrity = typeof d.integrity === 'string' ? d.integrity.trim() : '';
  if (integrity) {
    const m = /^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(integrity);
    if (!m) return `dist.integrity 格式非法：${integrity.slice(0, 40)}`;
    const actual = crypto.createHash(m[1]).update(buf).digest('base64');
    if (!sameDigest(actual, m[2])) return 'integrity 与 tarball 实际字节不一致（可能被篡改）';
    return null;
  }
  const shasum = typeof d.shasum === 'string' ? d.shasum.trim().toLowerCase() : '';
  if (shasum) {
    const actual = crypto.createHash('sha1').update(buf).digest('hex');
    if (!sameDigest(actual, shasum)) return 'shasum 与 tarball 实际字节不一致（可能被篡改）';
    return null;
  }
  // 两者都没有时无法证明字节未被替换，按不可信处理，避免被篡改的 bundle 静默导入
  return '缺少 dist.integrity / dist.shasum，无法校验 tarball';
}

/**
 * 把一个依赖声明解析成「真正需要导出的包名」。
 * - `npm:` 别名（`alias: npm:real@^1.0.0`）→ 真实包名 real
 * - file:/link:/git/http 等镜像拿不到的依赖 → null（跳过）
 */
function depTargetName(alias, range) {
  const r = String(range == null ? '' : range).trim();
  if (/^npm:/i.test(r)) {
    const a = deps.parseNpmAlias(r);
    return a ? a.name : null;
  }
  return deps.isRegistryRange(r) ? alias : null;
}

/**
 * 求「这批包 + 它们（递归）依赖的包」的闭包。
 * 只纳入镜像里真实存在的包；镜像里没有的放进 missing，回报给前端提示用户先补。
 * 每条依赖都从 packument 的每个版本里收集（导出本来就是整包全部版本，依赖也按全部版本取并集）。
 * 分层 BFS：同一层的包并发读 packument（mapLimit），依赖图通常只有几层，
 * 并发读盘把「逐个 store.get」的串行等待摊开；并发数取 storage.localScanConcurrency。
 */
async function collectDepClosure(store, roots, { max = DEPS_MAX_PACKAGES, concurrency = 8, isCanceled } = {}) {
  const conc = Math.max(1, Math.min(64, Math.floor(Number(concurrency)) || 8));
  const cancelErr = () => { const e = new Error('已取消'); e.code = 'ECANCELED'; return e; };
  const visited = new Set(roots);
  let queue = roots.map(n => n);
  const missing = new Map();
  let added = 0;
  while (queue.length) {
    if (isCanceled && isCanceled()) throw cancelErr();
    const level = queue;
    queue = [];
    const rows = await mapLimit(level, conc, async (cur) => {
      const rec = await store.getAsync(cur);
      const versions = (rec && rec.packument && rec.packument.versions) || {};
      const found = [];
      for (const v of Object.keys(versions)) {
        const map = versions[v] && versions[v].dependencies;
        if (!map || typeof map !== 'object') continue;
        for (const alias of Object.keys(map)) {
          const real = depTargetName(alias, map[alias]);
          if (real) found.push({ real, range: String(map[alias]), parent: cur });
        }
      }
      return found;
    });
    for (const found of rows) {
      if (!Array.isArray(found)) continue;       // 读包失败（mapLimit 收成 {__error}）按没有依赖处理
      for (const { real, range, parent } of found) {
        if (visited.has(real)) continue;
        if (store.index.has(real)) {
          if (visited.size >= max) {
            if (!missing.has(real)) missing.set(real, { name: real, range, parent, reason: `超过连带导出上限（${max} 个包），未纳入` });
            continue;
          }
          visited.add(real);
          added++;
          queue.push(real);
        } else if (!missing.has(real)) {
          missing.set(real, { name: real, range, parent });
        }
      }
    }
  }
  if (isCanceled && isCanceled()) throw cancelErr();
  const out = Array.from(visited).filter(n => !roots.includes(n));
  return { names: out, added, missing: Array.from(missing.values()) };
}

/** 导出时自动补依赖的默认预算（可在请求里用 autoDeps 覆盖；limit 同时受 DEPS_MAX_PACKAGES 约束） */
const AUTO_DEPS = { limit: 300, concurrency: 6, maxRounds: 3 };

/** 把 missing 里的「包 + 版本范围」还原成 resolveClosure 认得的 spec；没有范围就取 latest */
function depSpecOf(m) {
  const range = String(m.range || '').trim();
  if (!range || range === '*' || range === 'latest') return m.name;
  return `${m.name}@${range}`;
}

/**
 * 导出 scope=selected + withDeps 时，把「镜像里还没有的依赖」自动从上游补齐（元数据 + tarball）。
 * 逐轮：求依赖闭包 → 解析还缺的包的版本（落 packument）→ 下载 tarball → 再求闭包，直到补齐或达上限。
 * 原则：导出本体优先 —— 任何下载/解析失败都只记进返回值，不向外抛（导出照常继续，失败项在 missingDeps.reason 里说明）。
 */
async function autoFillDeps({ ctx, store, roots, logger, emit = () => {}, isCanceled, opts = {} }) {
  const stop = () => !!(isCanceled && isCanceled());
  const mode = (ctx && typeof ctx.cfg === 'function' && (ctx.cfg() || {}).mode) || 'cache';
  const limit = Math.max(1, Math.min(DEPS_MAX_PACKAGES, Math.round(Number(opts.limit) || AUTO_DEPS.limit)));
  const concurrency = Math.max(1, Math.min(32, Math.round(Number(opts.concurrency) || AUTO_DEPS.concurrency)));
  const maxRounds = Math.max(1, Math.min(10, Math.round(Number(opts.maxRounds) || AUTO_DEPS.maxRounds)));
  const res = { enabled: true, mode, limit, attempted: 0, downloaded: [], failed: [], canceled: false, skippedReason: '' };
  if (!ctx || !ctx.registry || !ctx.upstream) {
    res.skippedReason = '当前调用没有联网上下文，未自动下载缺失依赖';
    emit({ phase: 'deps-fetch', status: 'skipped', total: 0, downloaded: 0, failed: 0, message: res.skippedReason });
    return res;
  }
  if (mode === 'offline') {
    res.skippedReason = '当前是纯离线模式（offline），不会自动下载缺失依赖';
    emit({ phase: 'deps-fetch', status: 'skipped', total: 0, downloaded: 0, failed: 0, message: res.skippedReason });
    return res;
  }
  const tried = new Set();     // 已经尝试过的包名：每轮只处理新出现的缺失包，避免重复撞同一个失败
  const seen = new Set();      // 已下载成功的 name@version
  let remaining = limit;
  for (let round = 0; round < maxRounds; round++) {
    if (stop()) { res.canceled = true; break; }
    const scanConc = Math.max(1, Math.min(64, Math.floor(Number(opts.localScanConcurrency)) || Number(opts.concurrency) || AUTO_DEPS.concurrency));
    const missing = (await collectDepClosure(store, roots, { concurrency: scanConc, isCanceled }))
      .missing.filter(m => !m.reason && !tried.has(m.name));
    const todo = [];
    for (const m of missing) {
      if (remaining <= 0) break;
      tried.add(m.name);
      remaining--;
      res.attempted++;
      todo.push(m);
    }
    if (!todo.length) break;
    emit({
      phase: 'deps-fetch', status: 'resolve', total: todo.length, done: 0,
      downloaded: res.downloaded.length, failed: res.failed.length,
      message: `正在解析缺失依赖（${todo.length} 个，第 ${round + 1} 轮）…`,
    });
    const parentOf = (name) => { const t = todo.find(x => x.name === name); return t ? t.parent : ''; };
    let resolved = null;
    try {
      resolved = await deps.resolveClosure(ctx, todo.map(depSpecOf), {
        depth: 0, limit: Math.max(1, todo.length), persist: true, publishTime: false, shouldStop: stop,
      });
    } catch (e) {
      for (const m of todo) res.failed.push({ name: m.name, range: m.range, parent: m.parent, error: `解析依赖失败：${(e && e.message) || e}` });
      if (stop()) res.canceled = true;
      break;
    }
    if (stop()) res.canceled = true;
    for (const u of (resolved && resolved.unresolved) || []) {
      if (res.failed.length >= 200) break;
      res.failed.push({ name: u.name, range: u.range || '', parent: u.parent || '', error: u.error || '无法解析出版本' });
    }
    for (const e of (resolved && resolved.errors) || []) {
      if (res.failed.length >= 200) break;
      res.failed.push({ name: e.name, range: e.range || '', parent: e.parent || '', error: e.error || '获取包元数据失败' });
    }
    const picks = ((resolved && resolved.picks) || []).filter(p => p && p.name && p.version);
    if (!picks.length) { if (res.canceled) break; continue; }
    emit({
      phase: 'deps-fetch', status: 'download', total: picks.length, done: 0,
      downloaded: res.downloaded.length, failed: res.failed.length,
      message: `正在下载缺失依赖 0 / ${picks.length} 个…`,
    });
    let dl = null;
    try {
      dl = await pull.pullTarballs(ctx, {
        names: Array.from(new Set(picks.map(p => p.name))),
        mode: 'selected',
        selected: picks.map(p => ({ name: p.name, version: p.version })),
        concurrency,
        shouldStop: stop,
        onProgress: (info) => {
          const doneN = (info && info.done) || 0;
          emit({
            phase: 'deps-fetch', status: 'download', total: picks.length, done: doneN,
            bytes: (info && info.bytes) || 0,
            downloaded: res.downloaded.length, failed: res.failed.length,
            message: `正在下载缺失依赖 ${doneN} / ${picks.length} 个…`,
          });
        },
      });
    } catch (e) {
      for (const p of picks) {
        if (res.failed.length >= 200) break;
        res.failed.push({ name: p.name, range: p.range || '', parent: parentOf(p.name), error: `下载依赖失败：${(e && e.message) || e}` });
      }
      if (stop()) res.canceled = true;
      if (res.canceled) break;
      continue;
    }
    const dlErr = (name, version) => {
      const hit = ((dl && dl.errors) || []).find(x => x.name === name && x.version === version);
      return hit ? hit.error : '';
    };
    for (const p of picks) {
      const key = `${p.name}@${p.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (store.hasTarball(p.name, p.version)) {
        res.downloaded.push({ name: p.name, version: p.version, range: p.range || '', parent: parentOf(p.name) });
        if (logger && logger.info) logger.info(`导出时自动下载依赖 ${key}`);
      } else if (res.failed.length < 200) {
        res.failed.push({
          name: p.name, version: p.version, range: p.range || '', parent: parentOf(p.name),
          error: dlErr(p.name, p.version) || '未能下载 tarball（上游可能没有这个版本的包文件）',
        });
      }
    }
    if (dl && dl.canceled) { res.canceled = true; break; }
    if (stop()) { res.canceled = true; break; }
  }
  return res;
}

/**
 * 导出 bundle
 * @param {object} o
 * @param {object} [o.ctx] 服务上下文（需要 { cfg, store, registry, upstream, log }）；
 *   给了 ctx 且当前不是纯离线模式时，withDeps 缺的依赖会被自动下载并写进镜像，再一起导出
 * @param {boolean} [o.withDeps] scope='selected' 时把被选包的（递归）依赖也一起导出
 * @param {boolean} [o.autoFetchDeps=true] 是否自动下载镜像里缺失的依赖（仅 withDeps 生效）
 * @param {object} [o.autoDeps] 自动补依赖的预算 { limit=300, concurrency=6, maxRounds=3 }
 * @param {string} [o.scope='all'] 'all' | 'private' | 'upstream' | 'selected' | 'added'
 * @param {string|number} [o.addedFrom] scope='added' 的起始时间（ISO 字符串或毫秒，闭区间）
 * @param {string|number} [o.addedTo] scope='added' 的结束时间（ISO 字符串或毫秒，闭区间）
 * @param {function} [o.onProgress] 进度回调：
 *   { phase:'collect-start', total }                      开始统计要导出的包
 *   { phase:'deps-fetch', status, total, done, message }   正在自动补齐缺失依赖（status=resolve/download/skipped）
 *   { phase:'collect-done', packages, entries, totalBytes } 统计/文件清单准备完成
 *   { phase:'pack', entriesDone, entriesTotal, bytes, totalBytes, pkg, pkgDone, pkgTotal,
 *     inFlight:[{name,file,size}] }  打包进度；inFlight 是并行时正在压缩的条目（并行文件，一行一个）
 *   { phase:'package', name, status:'packed', tarballs, versions, sizeBytes }  某个包的全部条目已写入
 * @param {function} [o.isCanceled] 返回 true 时尽快中止（抛 code=ECANCELED）
 * @param {number} [o.concurrency=1] 打包并发：>1 时起多段 gzip 流共享条目游标并行压缩（产物仍是标准 tar.gz）
 */
async function exportBundle({
  store, ctx = null, scope = 'all', names = [], fileName, withDeps = false,
  autoFetchDeps = true, autoDeps = null, logger, onProgress, isCanceled, concurrency = 1,
  localScanConcurrency = 8,
  addedFrom = null, addedTo = null,
}) {
  const emit = (ev) => {
    if (!onProgress) return;
    // 进度回调只是旁路信息：它抛错不能把已经打了半天的包搞失败
    try { onProgress(ev); } catch { /* 忽略 */ }
  };
  const canceledError = () => {
    const e = new Error('导出已取消');
    e.code = 'ECANCELED';
    return e;
  };
  const checkCancel = () => { if (isCanceled && isCanceled()) throw canceledError(); };
  /* 本地扫描/统计类批处理的读盘并发（依赖闭包与打包前的逐包 stats 共用）：默认 8，1-64 */
  const localScanConc = Math.max(1, Math.min(64, Math.floor(Number(localScanConcurrency)) || 8));
  const all = Array.from(store.index.keys());
  let addedRange = null;
  let targets = all;
  if (scope === 'private') targets = all.filter(n => { const m = store.index.get(n); return m.source === 'private' || m.private; });
  else if (scope === 'upstream') targets = all.filter(n => { const m = store.index.get(n); return m.source !== 'private' && !m.private; });
  else if (scope === 'selected') targets = names.filter(n => store.index.has(n));
  else if (scope === 'added') {
    /* 「按添加时间」导出：只挑首次进本地镜像的时间（meta.createdAt）落在区间内的包。
     * 时间边界按闭区间处理；起始/结束可以只给一个。 */
    addedRange = normalizeAddedRange({ addedFrom, addedTo });
    targets = all.filter(n => pkgAddedInRange(store.index.get(n), addedRange.from, addedRange.to));
  }
  targets = Array.from(new Set(targets)).sort();

  const roots = targets.slice();
  let depsAdded = 0;
  let missingDeps = [];
  let autoFetch = null;
  if (withDeps && scope === 'selected' && roots.length) {
    let closure = await collectDepClosure(store, roots, { concurrency: localScanConc, isCanceled });
    // 镜像里没有的依赖：cache/proxy 模式自动从上游下载并入库；离线模式只提示、不下载
    if (autoFetchDeps && closure.missing.length) {
      autoFetch = await autoFillDeps({
        ctx, store, roots, logger, emit, isCanceled,
        opts: { ...(autoDeps || {}), localScanConcurrency: localScanConc },
      });
      if (!autoFetch.skippedReason) closure = await collectDepClosure(store, roots, { concurrency: localScanConc, isCanceled });
    }
    depsAdded = closure.added;
    // 给仍然缺的依赖补一句人话原因，前端/CLI/告警文案直接展示
    missingDeps = closure.missing.map((m) => {
      if (m.reason) return m;
      if (autoFetch) {
        const f = autoFetch.failed.find(x => x.name === m.name);
        if (f) return { ...m, reason: `自动下载失败：${f.error}` };
        if (autoFetch.canceled) return { ...m, reason: '导出被取消，依赖没有下载完' };
        if (autoFetch.skippedReason) return { ...m, reason: autoFetch.skippedReason };
        if (autoFetch.attempted >= autoFetch.limit) return { ...m, reason: `超过自动下载上限（${autoFetch.limit} 个包），未自动下载` };
      }
      return m;
    });
    targets = Array.from(new Set([...roots, ...closure.names])).sort();
  }

  if (!targets.length) {
    const err = new Error(scope === 'added'
      ? '所选时间段内没有添加进本地镜像的包（时间按本机时区、含起止；可放宽范围或留空一端再试）'
      : '没有符合条件的包可以导出');
    err.code = 'EMPTY';
    throw err;
  }

  emit({ phase: 'collect-start', total: targets.length });
  /* 先把每个包的条目收进各自的列表，最后再「跨包轮流交织」展开成 entries。
   * 原因：并行打包是共享一个条目游标领取任务，如果同一包的条目连在一起，几路压缩会同时落在
   * 同一个包上，进度弹窗右栏就只剩 1~2 个包（用户反馈收尾只剩 1 个）。交织后并发的几路分属
   * 不同包，右栏才有多行；条目在归档里的顺序对导入无影响（按路径解包），但 manifest 必须排第一。 */
  const pkgEntryLists = [];   // 与 pkgPlan 一一对应，每个包自己的条目列表
  const manifestPackages = [];
  /* 逐包统计：每个包在 entries 里占几条、几个 tarball、多少字节，
   * 供打包阶段的「逐包打包详情」与「当前包」进度条使用。 */
  const pkgPlan = [];
  let versions = 0, tarballs = 0, bytes = 0;
  /* 统计阶段改成并发读盘：此前是同步 for 循环（1520 个包 × 几万个 tarball 逐个 statSync），
   * 大镜像能卡住事件循环好几秒，页面轮询和托盘健康检查都跟着卡。
   * 并发数取 storage.localScanConcurrency；结果仍按 targets 顺序合并，manifest/进度顺序不变。 */
  let collectedN = 0;
  const collected = await mapLimit(targets, localScanConc, async (name) => {
    if (isCanceled && isCanceled()) return null;
    const rec = await store.getAsync(name);
    if (!rec) return null;
    let dir;
    try { dir = safePkgDir(name); }
    catch (e) {
      // 历史遗留的非法包名（例如早期被写入的可疑目录）不参与导出，跳过并提示，避免整个导出失败
      if (logger) logger.warn(`导出跳过非法包名：${String(name)}（${e.message}）`);
      return null;
    }
    const meta = rec.meta || {};
    const list = [];
    const pkgVersions = [];
    let pkgBytes = 0, pkgTarballs = 0, pkgVersionsN = 0;
    for (const v of Object.keys(rec.packument.versions || {})) {
      const file = store.tarballFileName(name, v);
      const abs = store.tarballPath(name, v);
      const entryName = `storage/${dir}/tarballs/${file}`;
      if (abs) {
        let st = null;
        try { st = await fsp.stat(abs); } catch { st = null; }
        if (st && st.isFile()) {
          list.push({ name: entryName, source: abs, size: st.size, mtime: st.mtimeMs / 1000 });
          pkgBytes += st.size;
          pkgTarballs++;
          pkgVersions.push({ version: v, file, sizeBytes: st.size, cached: true });
        } else {
          pkgVersions.push({ version: v, file: null, sizeBytes: 0, cached: false });
        }
      } else {
        pkgVersions.push({ version: v, file: null, sizeBytes: 0, cached: false });
      }
      pkgVersionsN++;
    }
    list.push({ name: `storage/${dir}/packument.json`, source: store.packumentPath(name) });
    if (fs.existsSync(store.metaPath(name))) list.push({ name: `storage/${dir}/meta.json`, source: store.metaPath(name) });
    collectedN++;
    // 统计阶段对大镜像也要有反馈（每个包都要 stat 一遍 tarball）
    if (collectedN % 100 === 0) emit({ phase: 'collect', packages: collectedN, total: targets.length });
    return {
      list,
      planRow: {
        name,
        entries: list.length,
        tarballs: pkgTarballs,
        versions: pkgVersionsN,
        sizeBytes: pkgBytes,
      },
      manifestPkg: {
        name,
        source: meta.source || 'upstream',
        latest: meta.latest || null,
        versionCount: pkgVersionsN,
        private: !!meta.private,
        versions: pkgVersions,
      },
      versions: pkgVersionsN,
      tarballs: pkgTarballs,
      bytes: pkgBytes,
    };
  });
  checkCancel();   // 统计期间按过取消：一个包都不打包，直接结束
  for (const row of collected) {
    if (!row) continue;
    pkgEntryLists.push(row.list);
    pkgPlan.push(row.planRow);
    manifestPackages.push(row.manifestPkg);
    versions += row.versions;
    tarballs += row.tarballs;
    bytes += row.bytes;
  }
  emit({ phase: 'collect', packages: manifestPackages.length, total: targets.length });

  /* 跨包轮流交织展开（round-robin）：第 1 轮每个包的 1 条，第 2 轮每个包的第 2 条……
   * 这样并行压缩的 N 路分别落在不同包上，进度弹窗右栏才能同时显示多个包（而不是几路挤在一个包）。 */
  const entries = [];
  const entryPkgInfo = [];
  for (let round = 0; ; round++) {
    let any = false;
    for (let pi = 0; pi < pkgEntryLists.length; pi++) {
      const list = pkgEntryLists[pi];
      if (round < list.length) { entries.push(list[round]); entryPkgInfo.push(pkgPlan[pi]); any = true; }
    }
    if (!any) break;
  }

  const manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    createdAt: nowIso(),
    host: process.env.COMPUTERNAME || 'unknown',
    scope,
    withDeps: !!withDeps,
    roots,
    addedTimeRange: addedRange ? { from: addedRange.fromIso, to: addedRange.toIso } : null,
    stats: { packages: manifestPackages.length, versions, tarballs, tarballBytes: bytes, depsAdded, depsFetched: autoFetch ? autoFetch.downloaded.length : 0, depsMissing: missingDeps.length },
    // 自动补依赖的结果摘要（失败明细放顶层，限制条数，避免 manifest 过大）
    autoFetch: autoFetch ? {
      mode: autoFetch.mode, attempted: autoFetch.attempted, downloaded: autoFetch.downloaded.length,
      failed: autoFetch.failed.length, canceled: autoFetch.canceled, skippedReason: autoFetch.skippedReason,
      downloadedPackages: autoFetch.downloaded.slice(0, 200).map(d => `${d.name}@${d.version}`),
      failedPackages: autoFetch.failed.slice(0, 200),
    } : null,
    missingDeps: missingDeps.slice(0, 200),
    packages: manifestPackages,
  };
  // 先把每个条目的大小补齐（下面要拿它算「预计总字节」，好让进度条有百分比，而不是只有已写入字节）
  // packument/meta 条目没有 size，这里并发 stat 补齐（tarball 条目的 size 已在统计阶段拿到）
  await mapLimit(entries, Math.max(1, Math.min(32, localScanConc * 2)), async (e) => {
    if (e.size === undefined && e.source) {
      try { e.size = (await fsp.stat(e.source)).size; } catch { e.size = 0; }
    }
    return e;
  });
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });
  const expectedBytes = entries.reduce((a, e) => a + (e.size || (e.data ? e.data.length : 0)), 0);
  emit({ phase: 'collect-done', packages: manifestPackages.length, entries: entries.length, totalBytes: expectedBytes });

  ensureDir(bundleDir());
  const base = safeFileName(fileName) || `npm-mirror-${scope}-${stamp()}`;
  let finalName = base.endsWith('.tgz') ? base : `${base}.tgz`;
  let finalPath = path.join(bundleDir(), finalName);
  if (fs.existsSync(finalPath)) {
    // 同名离线包已存在时不覆盖：追加时间戳（必要时再加序号），避免误删用户上次导出的文件
    const stem = finalName.slice(0, -4);
    const suffix = stamp();
    let n = 0;
    do {
      finalName = `${stem}-${suffix}${n ? `-${n}` : ''}.tgz`;
      finalPath = path.join(bundleDir(), finalName);
      n++;
    } while (fs.existsSync(finalPath));
    if (logger) logger.warn(`离线包同名已存在，改名保存为 ${finalName}`);
  }
  const tmpPath = path.join(bundleDir(), `.${finalName}.part`);
  /* 条目下标 → 所属包的映射：entries 已按包轮流交织，下标不再按连续区间对应包，
   * 映射在展开时逐条记进 entryPkgInfo；entries[0] 是 manifest.json，所以包从下标 1 开始。 */
  const entryPkg = [null].concat(entryPkgInfo);
  const pkgSeen = new Map();   // 包名 -> 已写完的条目数（并行模式下条目完成顺序不固定）
  const res = await tar.packTarGz(tmpPath, entries, {
    gzip: true,
    shouldAbort: isCanceled,
    concurrency,
    onEntryDone: ({ index }) => {
      const p = entryPkg[index];
      if (!p) return;
      const seen = (pkgSeen.get(p.name) || 0) + 1;
      pkgSeen.set(p.name, seen);
      // 这个包的全部条目（tarball + packument/meta）都写完了：补一条「逐包打包详情」
      if (seen >= p.entries) {
        emit({ phase: 'package', name: p.name, status: 'packed', tarballs: p.tarballs, versions: p.versions, sizeBytes: p.sizeBytes });
      }
    },
    onProgress: (info) => {
      const cur = info.entry > 0 ? entryPkg[info.entry - 1] : null;
      /* 并行打包时同时有多个条目在写：右栏按「正在压缩的文件」一行一个（条目级），
       * 行数就是真正在干活的路数，收尾时也不会因为只剩一个包而塌成 1 行。
       * 条目名形如 storage/<包目录>/tarballs/<文件> 或 storage/<包目录>/packument.json，
       * 展示时去掉 storage/<包目录>/ 前缀，只留 tarballs/xxx.tgz 这样的短名。 */
      const inFlight = [];
      for (const idx of Array.isArray(info.active) ? info.active : []) {
        const e = entries[idx];
        if (!e) continue;
        const p = entryPkg[idx];
        inFlight.push({
          name: p ? p.name : '',
          file: String(e.name || '').replace(/^storage\/[^/]+\//, ''),
          size: Number(e.size) || (e.data ? e.data.length : 0),
        });
        if (inFlight.length >= 64) break;   // 快照不做无限长（并发本来也有上限）
      }
      emit({
        phase: 'pack',
        entriesDone: info.count,
        entriesTotal: info.entriesTotal,
        bytes: info.total,
        totalBytes: expectedBytes,
        pkg: cur ? cur.name : '',
        pkgDone: cur ? Math.min(pkgSeen.get(cur.name) || 0, cur.entries) : 0,
        pkgTotal: cur ? cur.entries : 0,
        inFlight,
      });
    },
    onStage: (s) => {
      /* 并行压缩写完后还有一步「把 N 个分片按序拼成最终 .tgz」：几十 GB 的镜像要读写十几秒到几分钟，
       * 没有这个阶段上报，界面会停在「100% 却不结束」，看起来像卡死。 */
      if (!s || s.stage !== 'concat') return;
      emit({
        phase: 'concat',
        concatDone: Number(s.copied) || 0,
        concatTotal: Number(s.total) || 0,
        concatParts: Number(s.parts) || 0,
      });
    },
  });
  emit({ phase: 'finalize', sizeBytes: Number(res.sizeBytes) || 0 });
  fs.renameSync(tmpPath, finalPath);
  const fetchedN = autoFetch ? autoFetch.downloaded.length : 0;
  if (logger) {
    logger.info(`导出离线包完成: ${finalName} (${manifestPackages.length} 个包 / ${tarballs} 个 tarball${depsAdded ? ` / 含依赖 ${depsAdded} 个` : ''}${fetchedN ? ` / 自动下载依赖 ${fetchedN} 个` : ''})`);
    if (autoFetch && autoFetch.failed.length) logger.warn(`导出时有 ${autoFetch.failed.length} 个依赖没能自动下载：${autoFetch.failed.slice(0, 8).map(f => `${f.name}${f.version ? `@${f.version}` : ''}（${f.error}）`).join('、')}${autoFetch.failed.length > 8 ? ' …' : ''}`);
    if (autoFetch && autoFetch.skippedReason) logger.warn(`导出时未自动下载缺失依赖：${autoFetch.skippedReason}`);
  }
  return {
    file: finalName,
    path: finalPath,
    sizeBytes: res.sizeBytes,
    packages: manifestPackages.length,
    versions,
    tarballs,
    scope,
    withDeps: !!withDeps,
    roots: roots.length,
    depsAdded,
    depsFetched: fetchedN,
    missingDeps,
    autoFetch,
  };
}

/** 读取 bundle 的 manifest（不完整解包） */
async function readBundleManifest(file) {
  const buf = await tar.readTarEntry(file, 'manifest.json');
  if (!buf) throw bundleFormatError('不是有效的镜像离线包：缺少 manifest.json', 'EMANIFEST');
  let manifest;
  try {
    manifest = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    // 损坏的 manifest 属于用户输入错误（400），不是服务端 500
    throw bundleFormatError(`离线包 manifest.json 不是合法 JSON：${e.message}`, 'EBADMANIFEST');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw bundleFormatError('离线包 manifest.json 结构非法（应为对象）', 'EBADMANIFEST');
  }
  if (manifest.format !== FORMAT) throw bundleFormatError('不是本工具导出的离线包（format 不匹配）');
  if (manifest.formatVersion !== FORMAT_VERSION) {
    throw bundleFormatError(`离线包格式版本不受支持：${String(manifest.formatVersion)}（当前支持 ${FORMAT_VERSION}）`, 'EBADFORMAT');
  }
  return manifest;
}

/**
 * 从 bundle 导入（合并式）
 * @param {object} o
 * @param {function} [o.onProgress] 进度回调：
 *   { phase:'extract', bytes, totalBytes, current }            正在解包到临时目录（bytes=已解出数据字节）
 *   { phase:'extract-done', bytes, packages }                  解包完成
 *   { phase:'package-start', index, total, name, versionTotal, running, inFlight } 开始导入某个包（并行时会有多个包同时开始）
 *   { phase:'version', name, versionDone, versionTotal, inFlight } 该包内正在处理第 k/N 个版本
 *   { phase:'package', name, status:'imported'|'skipped'|'failed', versions, tarballs, skipped, failed, reason, inFlight }
 *     inFlight 是并行导入时「同时在处理的包」列表（{name,done,total}，done/total = 版本数），界面右栏按它显示多行
 *     status='skipped' 时 reason 会说明原因（版本已存在 / bundle 内缺少 tarball 等）
 * @param {function} [o.isCanceled] 返回 true 时在包之间/版本之间尽快停下来（结果带 canceled=true 的部分数据）
 * @param {number} [o.concurrency=1] 并行路数（不同包/同一包的版本级任务一起抢，包级不再被 min(并发,包数) 卡死）
 * @param {number} [o.extractConcurrency=4] 解包时并发写盘的文件数（单流读 tar，多路写盘收尾）
 * @param {number} [o.scanConcurrency=8] 解包后扫描各包目录（stat + 读 packument.json）的读盘并发
 */
async function importBundle({
  store, file, overwrite = false, metadataOnly = false, onProgress, isCanceled, logger,
  concurrency = 1, extractConcurrency = 4, scanConcurrency = 8,
}) {
  const manifest = await readBundleManifest(file); // 先校验格式与 manifest 是否可读
  const mstats = (manifest && manifest.stats) || {};
  /* 并行导入时同时有多个包在处理：维护「正在导入的包」集合，随每个事件带给界面，
   * 右栏才能一条包一行。同一个包的版本可能被多个并行路一起导入，
   * 所以每行额外带 lanes（当前分配给该包的并行路数），右侧进度详情会显示「N 路」。 */
  const running = new Map();          // name -> packageState
  const flight = () => Array.from(running.values()).map((st) => ({
    name: st.name,
    done: Number(st.versionDone) || 0,
    total: Number(st.versionTotal) || 0,
    lanes: Number(st.lanes) || 0,
  }));
  const emit = (ev) => {
    if (!onProgress) return;
    try { onProgress({ ...ev, inFlight: flight() }); } catch { /* 进度回调不影响导入结果 */ }
  };
  const canceled = () => !!(isCanceled && isCanceled());
  const tmp = path.join(tmpRoot(), `import-${stamp()}-${Math.random().toString(36).slice(2, 8)}`);
  ensureDir(tmp);
  const result = {
    file: path.basename(file), packages: 0, versions: 0, tarballs: 0, skipped: 0, overwritten: 0,
    metadataOnly: 0, failed: [],
  };
  try {
    // 完整镜像包（scope=all）解压后可能有数 GB，默认 2GB 上限会误伤；按包体积放宽，同时仍防解压炸弹
    let bundleSize = 0;
    try { bundleSize = fs.statSync(file).size; } catch { bundleSize = 0; }
    // 解包进度的分母：优先用 manifest 记录的 tarball 总字节，再兜底用包体积（tgz 里 tarball 已压缩，两者量级接近）
    const totalBytes = Math.max(1, Number(mstats.tarballBytes) || 0, bundleSize);
    let extracted = 0;
    const expectedPkgs = Number(mstats.packages) || 0;
    emit({ phase: 'extract', bytes: 0, totalBytes, packages: expectedPkgs });
    await tar.extractTarGz(file, tmp, {
      filter: rel => rel === 'manifest.json' || rel.startsWith('storage/'),
      onEntry: (rel, written) => {
        extracted += Number(written) || 0;
        emit({ phase: 'extract', bytes: extracted, totalBytes, current: rel });
      },
      // 解包不再逐文件串行：读 tar 是单流，但写盘/建目录可以多路并行收尾
      concurrency: Math.max(1, Math.min(64, Math.floor(Number(extractConcurrency)) || 1)),
      maxTotalBytes: Math.max(2 * 1024 * 1024 * 1024, bundleSize * 4),
      maxEntries: 2000000,
    });
    const storageDir = path.join(tmp, 'storage');
    let dirs = [];
    try {
      const ents = await fsp.readdir(storageDir, { withFileTypes: true });
      dirs = ents.filter(d => d.isDirectory()).map(d => d.name).sort();
    } catch { dirs = []; }
    emit({ phase: 'extract-done', bytes: extracted, packages: dirs.length });

    /* 先并发扫描出真正要处理的包目录（按目录名排序，日志/结果可复现）。
     * 此前是同步逐包 statSync + readJson：1521 个包目录会让事件循环停顿 1~2 秒，
     * 这里改用 fsp 异步读盘 + mapLimit 并发（并发数取 storage.localScanConcurrency）。
     * 不同包之间本来就可以并行导入：每个包只锁自己（store.withLock(name)），包内版本按版本级调度，
     * 所以并发不会改变任何单个包的最终内容，只是把磁盘读写/校验摊开。 */
    const scanConc = Math.max(1, Math.min(64, Math.floor(Number(scanConcurrency)) || 8));
    const scanned = await mapLimit(dirs, scanConc, async (dir) => {
      const pkgDir = path.join(storageDir, dir);
      let st = null;
      try { st = await fsp.stat(pkgDir); } catch { st = null; }
      if (!st || !st.isDirectory()) return null;
      let incomingPackument = null;
      try {
        incomingPackument = JSON.parse(await fsp.readFile(path.join(pkgDir, 'packument.json'), 'utf8'));
      } catch { incomingPackument = null; }
      if (!incomingPackument || !incomingPackument.versions) return null;
      return { dir, pkgDir, incomingPackument, name: incomingPackument.name || dir.replace(/__/g, '/') };
    });
    const pkgDirs = scanned.filter(Boolean);
    const totalPkgs = pkgDirs.length;

    /* 并行路数：配置多少就用多少，不再被「包数」min 掉（原来 workerCount=min(并发,包数)，
     * 包数少于并发时多余的并行路直接不存在）。包数少于路数时，多出来的 lane 会去抢
     * 同一个包里剩余的版本任务一起做，让空闲路一起导入剩余的包。 */
    const laneCount = Math.max(1, Math.min(64, Math.floor(Number(concurrency)) || 1));
    let nextPkg = 0;
    let startedPkgs = 0;
    const states = [];                 // 本次导入打开过的包状态（顺序 = 包顺序）
    const idleWaiters = new Set();     // 空闲 lane 的唤醒回调（多个 lane 同时空闲时必须全部唤醒）
    function notify() {
      if (!idleWaiters.size) return;
      const list = Array.from(idleWaiters);
      idleWaiters.clear();
      for (const it of list) { try { clearTimeout(it.timer); } catch { /* 忽略 */ } it.resolve(); }
    }
    function waitForWork() {
      return new Promise((res) => {
        const it = { resolve: res, timer: null };
        // 兜底：即使某次唤醒漏掉，也会在 250ms 内重新检查，保证不会永久卡住
        it.timer = setTimeout(() => { if (idleWaiters.delete(it)) res(); }, 250);
        if (it.timer.unref) it.timer.unref();
        idleWaiters.add(it);
      });
    }
    /** 某个包的并发任务全部结束（或取消）时唤醒正在等它收尾的 lane */
    function settleState(st) {
      if (st.outstanding === 0 && st.failWaiter) {
        const w = st.failWaiter; st.failWaiter = null; w();
      }
    }

    /** 单个包的运行时状态（prepare → 版本任务被任意 lane 抢着做 → finalize 落盘） */
    function makeState(item) {
      const ip = item.incomingPackument || {};
      const versionEntries = Object.entries(ip.versions || {});
      return {
        item, name: item.name, versionEntries, versionTotal: versionEntries.length,
        incomingTags: ip['dist-tags'] || {},
        index: 0, tasks: [], nextTask: 0, outstanding: 0,
        versionDone: 0, ps: 0, pf: 0, pt: 0, added: 0, metadataOnlySkipped: 0, invalidVersions: 0,
        lanes: 0, prepared: false, finalizing: false, finalized: false, badName: false,
        local: null, packument: null, incomingMeta: {},
        files: {}, sizes: {}, origins: {}, deprecated: {}, writtenVersions: new Set(),
        failedReason: '', lastError: '', failWaiter: null,
      };
    }

    function openState(item) {
      const st = makeState(item);
      st.index = ++startedPkgs;
      running.set(st.name, st);
      states.push(st);
      emit({
        phase: 'package-start', index: st.index, total: totalPkgs, name: st.name,
        versionTotal: st.versionTotal, running: laneCount,
      });
      return st;
    }

    /** prepare：包锁内读本地现状，把「真正要写盘的版本」列成可被任意 lane 抢的任务。
     *  已存在（且未覆盖）/非法版本/缺 tarball 的版本在这里一次性统计，不再占用并行路数。 */
    async function prepareState(st) {
      const name = st.name;
      if (!isSafePkgName(name)) {
        const error = `非法包名，已跳过导入：${String(name)}`;
        st.badName = true; st.pf = 1; st.failedReason = error;
        result.failed.push({ name: String(name), error });
        if (logger) logger.warn(`导入离线包跳过：${error}`);
        st.prepared = true;
        return;
      }
      st.incomingMeta = readJson(path.join(st.item.pkgDir, 'meta.json'), {}) || {};
      const incomingMeta = st.incomingMeta;
      await store.withLock(name, async () => {
        const local = await store.getAsync(name);
        st.local = local;
        // 新建 packument 时清空 dist-tags，避免把包内可能悬空的 tag 原样带进来
        st.packument = local ? local.packument : { ...st.item.incomingPackument, versions: {}, 'dist-tags': {} };
        const packument = st.packument;
        const tasks = [];
        for (const [v, manifestV] of st.versionEntries) {
          if (!isSafeVersion(v)) { st.invalidVersions++; st.versionDone++; continue; }
          if (packument.versions[v] && !overwrite) { st.ps++; st.versionDone++; continue; }
          const srcFile = path.join(st.item.pkgDir, 'tarballs', `${pkgBaseName(name)}-${v}.tgz`);
          const altName = incomingMeta.files && typeof incomingMeta.files[v] === 'string' ? incomingMeta.files[v] : '';
          // files 映射来自包内 meta.json，可能被构造成 ../ 路径；只接受纯文件名
          const altFile = altName && altName === path.basename(altName) ? path.join(st.item.pkgDir, 'tarballs', altName) : null;
          const useFile = fs.existsSync(srcFile) ? srcFile : (altFile && fs.existsSync(altFile) ? altFile : null);
          if (!useFile) {
            // 默认只导入带 tarball 的版本，否则会写出「元数据有、下载 tarball 404」的幻影版本。
            // metadataOnly=true 时保留旧行为（仍写入元数据），并在结果里单独计数。
            if (!metadataOnly) { st.metadataOnlySkipped++; st.versionDone++; continue; }
            if (packument.versions[v] && overwrite) result.overwritten++;
            packument.versions[v] = manifestV;
            st.writtenVersions.add(v);
            if (incomingMeta.sizes && Number.isFinite(incomingMeta.sizes[v])) st.sizes[v] = incomingMeta.sizes[v];
            if (incomingMeta.deprecated && incomingMeta.deprecated[v]) st.deprecated[v] = incomingMeta.deprecated[v];
            st.added++; st.versionDone++;
            continue;
          }
          tasks.push({ pkg: st, version: v, manifestV, useFile });
        }
        st.tasks = tasks;
        // packument 里的版本已经展开成任务，包目录里的 packument 不再需要，尽早释放（整包导出时内存可观）
        if (st.item) st.item.incomingPackument = null;
      });
      st.prepared = true;
      // 把「准备阶段已处理（跳过/非法/仅元数据）」的进度一次性同步给界面
      if (st.versionDone > 0) emit({ phase: 'version', name, versionDone: st.versionDone, versionTotal: st.versionTotal });
      notify();
    }

    /** 执行一个版本任务（多个 lane 可以同时执行同一个包的不同版本） */
    async function runVersionTask(task) {
      const st = task.pkg;
      const name = st.name;
      const v = task.version;
      const manifestV = task.manifestV;
      try {
        // 篡改校验 1：tarball 实际字节必须与 packument 的 dist.integrity（缺失则 shasum）一致
        const buf = fs.readFileSync(task.useFile);
        const badBytes = verifyTarballBytes(buf, manifestV && manifestV.dist);
        if (badBytes) {
          st.pf++;
          st.lastError = `${name}@${v}：${badBytes}`;
          result.failed.push({ name, version: v, error: st.lastError });
          if (logger) logger.warn(`导入离线包跳过 ${name}@${v}：${badBytes}`);
          return;
        }
        // 篡改校验 2：tarball 内「根级 package.json」的 name/version 必须与 packument 的键一致。
        // 注意根目录名不一定叫 package：既有 types-registry/ 这种包名目录，也有 DefinitelyTyped 的
        // 「node v22.20/」、git 导出风格「mscdex-cpu-features-c6f574c/」，所以按「一层目录 + package.json」匹配。
        let innerPkg = null;
        try { innerPkg = await tar.readRootPackageJson(task.useFile); } catch { innerPkg = null; }
        if (innerPkg && innerPkg.name !== name) {
          st.pf++;
          st.lastError = `${name}@${v}：tarball 内 package.json 的包名与 packument 不一致（实际 ${String(innerPkg.name)}）`;
          result.failed.push({ name, version: v, error: st.lastError });
          if (logger) logger.warn(`导入离线包跳过：${st.lastError}`);
          return;
        }
        if (innerPkg && versionKey(innerPkg.version) !== versionKey(v)) {
          // tarball 字节本身已通过 integrity 校验，只是里面写的版本与 packument 键不同。
          // 这是上游镜像自身的元数据问题（例：npmmirror 上 npm@6.8.0 的 dist 指向 npm-6.7.0.tgz，
          // 下载到的 tarball 内版本就是 6.7.0），不是包被篡改；按 packument 版本导入并留告警。
          if (logger) logger.warn(`导入 ${name}@${v}：tarball 内 package.json 版本是 ${String(innerPkg.version)}（integrity 已校验通过，按 packument 版本导入）`);
        }
        if (!innerPkg) {
          // integrity 已经校验过字节与 packument 一致；极少数历史 tarball 没有可解析的根级 package.json，
          // 不能因此丢弃（否则「导出的包再导入」会平白失败），按兼容方式导入并留一条告警。
          if (logger) logger.warn(`导入 ${name}@${v}：tarball 内找不到可解析的根级 package.json（integrity 已校验通过），按兼容方式导入`);
        }
        if (st.packument.versions[v] && overwrite) result.overwritten++;
        // 用刚校验过的字节直接写入，避免校验后再按路径读一次造成 TOCTOU；dist 以实际写入结果为准
        const saved = store.putTarball(name, v, buf);
        st.packument.versions[v] = {
          ...manifestV,
          name,
          version: v,
          _id: `${name}@${v}`,
          dist: {
            ...(manifestV && manifestV.dist),
            integrity: saved.integrity,
            shasum: saved.shasum,
            tarball: `${name}/-/${saved.file}`,
          },
        };
        st.files[v] = saved.file; st.sizes[v] = saved.sizeBytes; st.origins[v] = 'bundle';
        st.writtenVersions.add(v);
        st.pt++;
        if (st.incomingMeta.deprecated && st.incomingMeta.deprecated[v]) st.deprecated[v] = st.incomingMeta.deprecated[v];
        st.added++;
      } catch (e) {
        st.pf++;
        st.lastError = e.message;
        result.failed.push({ name, version: v, error: `${name}@${v}：${e.message}` });
        if (logger) logger.warn(`导入 ${name}@${v} 失败：${e.message}`);
      }
    }

    /** 一个 lane 在某个包上循环抢本包的版本任务，直到本包任务被（自己或别的 lane）抢完（或取消） */
    async function consumeState(st) {
      for (;;) {
        if (canceled()) { result.canceled = true; break; }
        if (st.nextTask >= st.tasks.length) break;
        const task = st.tasks[st.nextTask++];
        st.outstanding++;
        st.lanes++;
        try {
          await runVersionTask(task);
        } finally {
          st.lanes--;
          st.outstanding--;
          st.versionDone++;
          emit({ phase: 'version', name: st.name, versionDone: st.versionDone, versionTotal: st.versionTotal });
          settleState(st);
          notify();
        }
      }
    }

    /** 收尾：等本包被其它 lane 抢走的任务全部结束，再在包锁内合并落盘并发出 package 事件 */
    async function finalizeState(st) {
      if (st.finalized || st.finalizing) return;
      st.finalizing = true;
      try {
        if (st.outstanding > 0) await new Promise((res) => { st.failWaiter = res; });
        result.metadataOnly += st.metadataOnlySkipped;
        if (st.metadataOnlySkipped > 0 && logger) {
          logger.warn(`导入 ${st.name}：跳过 ${st.metadataOnlySkipped} 个 bundle 内没有 tarball 的版本`);
        }
        if (st.invalidVersions > 0) {
          result.failed.push({ name: st.name, error: `跳过 ${st.invalidVersions} 个非法版本号` });
          if (logger) logger.warn(`导入 ${st.name} 时跳过 ${st.invalidVersions} 个非法版本号`);
        }
        if (!st.badName) {
          try {
            await store.withLock(st.name, async () => {
              const fresh = await store.getAsync(st.name);
              const packument = fresh ? fresh.packument : st.packument;
              // 本次导入写出的版本合并进「磁盘最新」的 packument（prepare 期间可能有其它写入）
              if (fresh) {
                for (const v of st.writtenVersions) packument.versions[v] = st.packument.versions[v];
              }
              for (const [tag, v] of Object.entries(st.incomingTags)) {
                if (!packument.versions[v]) {
                  if (logger) logger.warn(`导入 ${st.name}：丢弃悬空 dist-tag ${tag} -> ${String(v)}`);
                  continue;
                }
                packument['dist-tags'] = packument['dist-tags'] || {};
                if (!packument['dist-tags'][tag] || overwrite) packument['dist-tags'][tag] = v;
              }
              const latest = packument['dist-tags'] && packument['dist-tags'].latest;
              if (!latest) {
                const vs = Object.keys(packument.versions);
                if (vs.length) { packument['dist-tags'] = packument['dist-tags'] || {}; packument['dist-tags'].latest = vs.sort(compareVersions).pop(); }
              }
              // 一个版本都没导入时不要新建空 packument（否则会留下没有任何版本的包条目）
              if (st.added > 0 || fresh) {
                store.save(st.name, packument, {
                  source: (fresh && fresh.meta && fresh.meta.source) || st.incomingMeta.source || 'cache',
                  description: packument.description || st.incomingMeta.description || '',
                  private: (fresh && fresh.meta && fresh.meta.private) || !!st.incomingMeta.private,
                  files: st.files, sizes: st.sizes, origins: st.origins, deprecated: st.deprecated,
                });
              }
            });
          } catch (e) {
            st.pf++;
            st.lastError = e.message;
            result.failed.push({ name: st.name, error: e.message });
            if (logger) logger.warn(`导入 ${st.name} 失败：${e.message}`);
          }
        }
        result.versions += st.added;
        result.tarballs += st.pt;
        result.skipped += st.ps;
        // 「导入成功的包数」按确实往存储里写了东西算：覆盖导入（版本已存在但 overwrite）时
        // added 为 0 而 pt>0，不能因此把包数报成 0（界面上会显示「0 包」但明明导入了 tarball）。
        if (st.added > 0 || st.pt > 0) result.packages++;
        // 逐包结果（左栏一行）：这个包最终是「导入成功 / 全部已存在跳过 / 失败」，并尽量给出人话原因
        if (!st.failedReason) {
          if (st.metadataOnlySkipped > 0) st.failedReason = `bundle 内缺少 ${st.metadataOnlySkipped} 个版本的 tarball（导出时本地就没有缓存）`;
          else if (st.pf > 0) st.failedReason = st.lastError || '导入失败';
          else if (st.ps > 0) st.failedReason = '版本已存在';
        }
        emit({
          phase: 'package', index: st.index, name: st.name,
          status: st.added > 0 ? 'imported' : (st.pf > 0 ? 'failed' : 'skipped'),
          versions: st.added, tarballs: st.pt, skipped: st.ps, failed: st.pf,
          reason: st.failedReason || '',
        });
      } finally {
        running.delete(st.name);
        st.finalized = true;
        // 释放大对象，避免整包导入时把几千个包的 packument 全留在内存里
        st.packument = null; st.local = null; st.tasks = null; st.versionEntries = null;
        st.files = null; st.sizes = null; st.origins = null; st.deprecated = null;
        st.item = null;
        notify();
      }
    }

    /** 从别的包里抢一个还没做的版本任务（剩余包少于并行路数时，空闲 lane 一起分担剩余版本） */
    function stealTask() {
      if (canceled()) return null;
      for (const st of states) {
        if (!st.prepared || st.finalizing || st.finalized || st.badName) continue;
        if (st.nextTask >= st.tasks.length) continue;
        return st.tasks[st.nextTask++];
      }
      return null;
    }

    /** 抢到的任务执行完统一记账（与 consumeState 里的记账一致） */
    async function runStolenTask(task) {
      const st = task.pkg;
      st.outstanding++;
      st.lanes++;
      try {
        await runVersionTask(task);
      } finally {
        st.lanes--;
        st.outstanding--;
        st.versionDone++;
        emit({ phase: 'version', name: st.name, versionDone: st.versionDone, versionTotal: st.versionTotal });
        settleState(st);
        notify();
      }
    }

    /** 每个 lane 的主循环：有没打开过的包就先开新包，没有就抢其它包的版本任务，直到全部完成 */
    async function laneLoop() {
      for (;;) {
        // 1) 还有没打开过的包：优先开新包，保持包级并行
        if (!canceled() && nextPkg < pkgDirs.length) {
          const st = openState(pkgDirs[nextPkg++]);
          try {
            await prepareState(st);
            // 版本任务已就绪：立刻唤醒空闲 lane 一起抢，而不是等第一个版本结束才醒
            notify();
            await consumeState(st);
          } catch (e) {
            st.pf++;
            st.lastError = e.message;
            result.failed.push({ name: st.name, error: e.message });
            if (logger) logger.warn(`导入 ${st.name} 失败：${e.message}`);
          }
          await finalizeState(st);
          continue;
        }
        // 2) 没有新包了：抢其它包里剩余的版本任务一起导入（需求：剩余包少时让空闲路也参与）
        const task = stealTask();
        if (task) { await runStolenTask(task); continue; }
        // 3) 所有包都已收尾 → 结束
        if (nextPkg >= pkgDirs.length && states.every((s) => s.finalized)) return;
        // 4) 等有进展（版本任务完成 / 包收尾 / 取消）
        await waitForWork();
        if (canceled()) result.canceled = true;
      }
    }

    await Promise.all(Array.from({ length: laneCount }, () => laneLoop()));

    if (logger) {
      const tail = result.canceled ? '（已取消，保留已导入的部分）' : '';
      logger.info(`导入离线包完成: ${result.file} → ${result.packages} 个包 / ${result.versions} 个版本 / ${result.tarballs} 个 tarball${tail}`);
    }
    return result;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/** 导入单个 npm tarball（.tgz）：解析 package.json 后登记为一个版本 */
async function importTarballFile({ store, file, overwrite = false, source = 'upload' }) {
  // tarball 根目录名不一定是 package（历史包可能是包名目录 / DefinitelyTyped 风格），按根级 package.json 读
  const pkg = await tar.readRootPackageJson(file);
  if (!pkg) throw new Error('不是有效的 npm 包 tarball（找不到可解析的根级 package.json）');
  const name = pkg.name;
  const version = pkg.version;
  if (!name || !version) throw new Error('tarball 里的 package.json 缺少 name 或 version');
  // 包内 package.json 不可信：name/version 会参与磁盘路径拼接，必须先做严格校验再写盘
  if (!isSafePkgName(name)) throw badNameError(name);
  if (!isSafeVersion(version)) throw badVersionError(name, version);
  const buf = fs.readFileSync(file);
  const info = { file: path.basename(file), sizeBytes: buf.length, shasum: sha1hex(buf), integrity: integrityOf(buf) };
  await store.withLock(name, async () => {
    const local = store.get(name);
    const packument = local
      ? local.packument
      : { _id: name, name, description: pkg.description || '', 'dist-tags': {}, versions: {}, readme: '' };
    if (packument.versions[version] && !overwrite) {
      const err = new Error(`版本 ${name}@${version} 已存在（未覆盖）`);
      err.code = 'EEXIST';
      throw err;
    }
    const saved = store.putTarball(name, version, buf);
    packument.versions[version] = {
      ...pkg,
      name,
      version,
      _id: `${name}@${version}`,
      dist: {
        ...(packument.versions[version] && packument.versions[version].dist),
        integrity: saved.integrity,
        shasum: saved.shasum,
        tarball: `${name}/-/${saved.file}`,
      },
    };
    const isLatest = !packument['dist-tags'].latest || compareVersions(version, packument['dist-tags'].latest) > 0;
    if (isLatest) packument['dist-tags'].latest = version;
    store.save(name, packument, {
      source,
      private: true,
      description: packument.description || pkg.description || '',
      files: { [version]: saved.file },
      sizes: { [version]: saved.sizeBytes },
      origins: { [version]: 'upload' },
    });
  });
  return { name, version, sizeBytes: info.sizeBytes, shasum: info.shasum, integrity: info.integrity };
}

/** 导入 packument JSON（只有元数据，没有 tarball） */
async function importPackumentJson({ store, json, overwrite = false, source = 'upload' }) {
  const name = json.name;
  if (!name || !json.versions) throw new Error('不是有效的 packument JSON（缺少 name/versions）');
  if (!isSafePkgName(name)) throw badNameError(name);
  let invalidVersions = 0;
  const versions = {};
  for (const [v, m] of Object.entries(json.versions)) {
    // 版本号后续会被用于 tarball 文件名拼接，非法版本号直接丢弃
    if (!isSafeVersion(v)) { invalidVersions++; continue; }
    versions[v] = m;
  }
  await store.withLock(name, async () => {
    const local = store.get(name);
    // 新建 packument 时清空 dist-tags，下面只写入指向真实存在版本号的 tag
    const packument = local ? local.packument : { ...json, versions: {}, 'dist-tags': {} };
    let added = 0;
    for (const [v, m] of Object.entries(versions)) {
      if (packument.versions[v] && !overwrite) continue;
      packument.versions[v] = m;
      added++;
    }
    for (const [tag, v] of Object.entries(json['dist-tags'] || {})) {
      if (!packument.versions[v]) continue; // 悬空 dist-tag 直接丢弃
      packument['dist-tags'] = packument['dist-tags'] || {};
      if (!packument['dist-tags'][tag] || overwrite) packument['dist-tags'][tag] = v;
    }
    store.save(name, packument, { source, description: json.description || '' });
    return added;
  });
  return { name, versions: Object.keys(versions).length, skippedInvalidVersions: invalidVersions };
}

function listBundles() {
  const dir = bundleDir();
  ensureDir(dir);
  const items = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.toLowerCase().endsWith('.tgz') || f.startsWith('.')) continue;
    const full = path.join(dir, f);
    let st = null;
    try { st = fs.statSync(full); } catch { continue; }
    items.push({ file: f, path: full, sizeBytes: st.size, createdAt: st.mtime.toISOString(), packages: null, scope: null });
  }
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { items };
}

module.exports = {
  FORMAT, FORMAT_VERSION, bundleDir, exportBundle, importBundle, importTarballFile,
  importPackumentJson, readBundleManifest, listBundles, safeFileName,
  depTargetName, collectDepClosure, autoFillDeps, AUTO_DEPS, DEPS_MAX_PACKAGES,
  parseTimeBound, normalizeAddedRange, pkgAddedInRange,
};
