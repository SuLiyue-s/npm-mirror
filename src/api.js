'use strict';
/* 可视化管理端 API：/__admin/api/*（统一 {ok,data} 响应） */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const authLib = require('./auth');

// 常量时间令牌比较（src/auth.js 的 tokenMatches）：不能用 === 明文比较，
// 逐字节短路会泄露令牌前缀，也让响应时间可被观测。
const tokenMatches = authLib.tokenMatches;

const {
  ok, fail, readJson, readBody, readBodyToFile, sendJson, streamFile, bodyToTempFile, tempFilePath,
  baseFor, lanUrls, registryUrl,
} = require('./http-util');
const { parseLevelLine, validName } = require('./registry');
const tasks = require('./tasks');
const pull = require('./pull');
const deps = require('./deps');
const {
  nowIso, parsePkgSpec, satisfies, compareVersions, maxSatisfying,
  rootPath, stamp, formatBytes, clamp, randomToken, mapLimit,
} = require('./util');

const API = '/__admin/api';

function bundlesStat() {
  const dir = rootPath('data', 'bundles');
  let count = 0, bytes = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.tgz') || f.startsWith('.')) continue;
      try { bytes += fs.statSync(path.join(dir, f)).size; count++; } catch { /* 忽略 */ }
    }
  } catch { /* 目录不存在 */ }
  return { count, bytes };
}

/** 安全解码 URL 片段 */
function decodeStr(s) { try { return decodeURIComponent(s); } catch { return s; } }

/** 「本地扫描 / 统计」类批处理的读盘并发：取 storage.localScanConcurrency（1-64，默认 8） */
function localScanConcurrency(cfg) {
  return Math.max(1, Math.min(64, Math.floor(Number((cfg && cfg.storage && cfg.storage.localScanConcurrency)) || 8)));
}

/* 「全部包补 tarball」的名单：上传包（只有 packument、没有 tarball 下载地址）与私有包（tarball 只在本机）
 * 本来就不可能从上游补下来，全部包模式下直接跳过，免得每次跑完都报一堆无意义的失败。
 * 返回 { names, skipped }；如果整个镜像都是本地包，就不跳过（保持行为可解释）。 */
function allPackageNames(store) {
  const all = store.names();
  const kept = all.filter((n) => {
    // 只取内存索引里的 meta：原来为拿 source 把整份 packument 读一遍，
    // 「全部包补 tarball」规划 1520 个包时光这一步就要卡几秒。
    const meta = typeof store.metaOf === 'function' ? store.metaOf(n) : (store.index.get(n) || null);
    const src = meta && meta.source;
    return src !== 'upload' && src !== 'private';
  });
  return kept.length ? { names: kept, skipped: all.length - kept.length } : { names: all, skipped: 0 };
}

/** 路由：把 /__admin/api/packages/... 拆成 { name, tail } */
function parsePackageRoute(pathname) {
  const raw = pathname.slice(`${API}/packages`.length).replace(/^\/+/, '');
  if (!raw) return null;
  const segs = raw.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } });
  if (!segs.length) return null;
  // 情况一：整个包名在一个段里（@scope%2Fname 解码后含 /）
  if (segs[0].includes('/')) return { name: segs[0], tail: segs.slice(1) };
  // 情况二：scoped 包固定占两段（@scope/name），不再猜「下一段是不是动作名」——
  // 否则 @scope/deprecate 这类真实包名会被拆成 { name:'@scope', tail:['deprecate',...] } 而查错包。
  if (segs[0].startsWith('@')) {
    return segs.length >= 2 ? { name: `${segs[0]}/${segs[1]}`, tail: segs.slice(2) } : null;
  }
  return { name: segs[0], tail: segs.slice(1) };
}

/* 离线包「导出 / 导入」的长任务封装：建任务 → 后台跑 → 进度写进 tasks → 收敛成终态。
 * progress:true 的请求立刻拿到 { taskId, async:true }，界面轮询 /tasks/<id> 显示详细进度；
 * 不带该参数的旧调用仍走同步路径（命令行、脚本不受影响）。 */
function startBundleTask({ type, title, phase = '', total = 0, concurrency = 1, run, log }) {
  const task = tasks.create({ type, title, phase, total, concurrency });
  const isCanceled = () => {
    const t = tasks.get(task.id);
    return !!(t && t.cancelRequested);
  };
  const update = (patch) => tasks.update(task.id, patch);
  (async () => {
    try {
      const r = await run({ taskId: task.id, update, isCanceled });
      const canceled = !!(r && r.canceled) || isCanceled();
      tasks.finish(task.id, { status: canceled ? 'canceled' : 'done', result: r || null });
      if (log) log.info(`${title} 任务结束${canceled ? '（已取消）' : ''}`);
    } catch (e) {
      // 取消时底层抛 ECANCELED 也收敛成「已取消」，不要让界面看到一条红色失败
      const canceled = isCanceled() || (e && e.code === 'ECANCELED');
      tasks.finish(task.id, { status: canceled ? 'canceled' : 'error', message: (e && e.message) || String(e) });
      if (!canceled && log) log.warn(`${title} 任务失败：${(e && e.message) || e}`);
    }
  })();
  return task.id;
}

/* ---------------- 离线包导入：进度映射与任务封装 ----------------
 * 导入离线包有三个入口：本机 data/bundles 里的文件、旧版整包单请求上传、新的分片并发上传。
 * 这里把「进度事件 → 任务快照字段」和「真正执行导入」抽成公共函数，
 * 三个入口共用同一套统计口径，界面左右栏才不会出现两套逻辑。 */

/** 把 bundle.importBundle 的进度事件映射成任务快照字段，返回 onProgress 回调 */
function makeImportProgressHandler(update) {
  const pkgs = [];
  let curTotal = 0;
  let pkgTotal = 0;
  return (ev) => {
    if (ev.phase === 'extract') {
      update({
        phase: 'extract',
        bytes: Number(ev.bytes) || 0,
        bytesTotal: Number(ev.totalBytes) || 0,
        total: Number(ev.packages) || 0,
        current: ev.current || '',
      });
      return;
    }
    if (ev.phase === 'extract-done') {
      update({
        phase: 'import',
        total: Number(ev.packages) || 0,
        done: 0,
        bytes: Number(ev.bytes) || 0,
        bytesTotal: Number(ev.bytes) || 0,
        current: '', currentDone: 0, currentTotal: 0,
        inFlight: [],
        message: '',
      });
      return;
    }
    if (ev.phase === 'package-start') {
      pkgTotal = Number(ev.total) || pkgTotal;
      curTotal = Number(ev.versionTotal) || 0;
      update({
        phase: 'import',
        total: pkgTotal,
        // 并行导入时包是同时开始的，进度按「已完成的包数」算（pkgs.length），不能用包的起始序号
        done: pkgs.length,
        current: ev.name,
        currentDone: 0,
        currentTotal: curTotal,
        inFlight: Array.isArray(ev.inFlight) ? ev.inFlight.slice(0, 64) : [],
      });
      return;
    }
    if (ev.phase === 'version') {
      curTotal = Number(ev.versionTotal) || curTotal;
      update({
        current: ev.name, currentDone: Number(ev.versionDone) || 0, currentTotal: curTotal,
        inFlight: Array.isArray(ev.inFlight) ? ev.inFlight.slice(0, 64) : [],
      });
      return;
    }
    if (ev.phase === 'package') {
      pkgs.push({
        name: ev.name,
        status: ev.status,
        versions: Number(ev.versions) || 0,
        tarballs: Number(ev.tarballs) || 0,
        skipped: Number(ev.skipped) || 0,
        failed: Number(ev.failed) || 0,
        reason: ev.reason || '',
      });
      update({
        done: pkgs.length,
        total: Math.max(pkgTotal, pkgs.length),
        ok: pkgs.filter(p => p.status === 'imported').length,
        failed: pkgs.filter(p => p.status === 'failed').length,
        skipped: pkgs.filter(p => p.status === 'skipped').length,
        packages: pkgs.slice(-2000),
        versions: pkgs.reduce((a, p) => a + p.versions, 0),
        tarballs: pkgs.reduce((a, p) => a + p.tarballs, 0),
        current: ev.name,
        currentDone: curTotal,
        currentTotal: curTotal,
        inFlight: Array.isArray(ev.inFlight) ? ev.inFlight.slice(0, 64) : [],
        errors: pkgs.filter(p => p.status === 'failed').slice(-50).map(p => ({ name: p.name, error: p.reason })),
      });
    }
  };
}

/** 真正执行一次离线包导入（调用方负责任务生命周期、临时文件清理与错误收敛） */
async function runBundleImportJob(ctx, { file, overwrite, update, isCanceled }) {
  const cfg = ctx.cfg();
  const r = await ctx.bundle.importBundle({
    store: ctx.store,
    file,
    overwrite,
    logger: ctx.log,
    isCanceled,
    concurrency: Math.max(1, Number(cfg.storage.bundleImportConcurrency) || 4),
    // 解包（解压+写盘）的并发路数：与「导入包」的并发分开，机械硬盘和小宝塔盘都能调
    extractConcurrency: Math.max(1, Number(cfg.storage.bundleImportExtractConcurrency) || 8),
    // 解包后扫描各包目录的读盘并发（store.getAsync / stat 并发数）
    scanConcurrency: localScanConcurrency(cfg),
    onProgress: makeImportProgressHandler(update),
  });
  return { ...r, total: r.packages, failedCount: r.failed.length };
}

/** 按 progress 参数决定：后台任务（立即返回 taskId）或同步执行，统一收敛错误与临时文件清理 */
async function startOrRunBundleImport(ctx, { res, file, overwrite, tempFile, wantProgress, title }) {
  const cfg = ctx.cfg();
  const conc = Math.max(1, Number(cfg.storage.bundleImportConcurrency) || 4);
  const doImport = async ({ update, isCanceled }) => {
    try {
      return await runBundleImportJob(ctx, { file, overwrite, update, isCanceled });
    } finally {
      // 临时文件的生命周期交给实际执行导入的那段代码：progress 模式下响应已先返回，
      // 绝不能提前删掉还在读的文件；同步模式下导入结束才删。
      if (tempFile) { try { fs.unlinkSync(tempFile); } catch { /* 忽略 */ } }
    }
  };
  if (wantProgress) {
    const taskId = startBundleTask({
      type: 'bundle-import',
      title: title || `导入离线包 · ${path.basename(file)}`,
      phase: 'extract',
      total: 0,
      concurrency: conc,
      log: ctx.log,
      run: async (o) => {
        try {
          return await doImport(o);
        } finally {
          // 收尾（成功/取消/失败）都清空「并行导入的包」，右栏不留残行
          o.update({ inFlight: [] });
        }
      },
    });
    return ok(res, { taskId, async: true });
  }
  try {
    const r = await doImport({ update: () => {}, isCanceled: () => false });
    return ok(res, r);
  } catch (e) {
    return fail(res, 400, `导入失败：${e.message}`, e.code || 'EIMPORT');
  }
}

/* ---------------- 大离线包分片并发上传 ----------------
 * 一个请求上传几个 GB 只能占用一条连接、串行推进，浏览器一断就前功尽弃。
 * 这里拆成固定大小的分片：网页端多路并发 POST 分片，服务端逐片落盘（data/tmp/upload-<id>/），
 * 收齐后在后台任务里按顺序拼成一个临时 .tgz 再交给导入流程，导入结束删临时文件。
 * 会话只存在内存里（进程重启即中断，前端会重新上传）；超过 2 小时的残留会被清理。 */
const BUNDLE_UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const BUNDLE_UPLOAD_MAX_SESSIONS = 8;
const bundleUploads = new Map(); // uploadId -> { id, name, size, overwrite, dir, chunkSize, chunkCount, parts, bytes, createdAt, assembling }

/** 进程重启后内存会话表是空的，但 data/tmp 里的 upload-* 残留目录还在。
 *  每次 init 都顺手扫一遍（开销只是一次 readdir），超过 2×TTL 的删掉，避免长期占盘。 */
function cleanupStaleBundleUploadDirs() {
  try {
    const tmpDir = rootPath('data', 'tmp');
    const now = Date.now();
    for (const name of fs.readdirSync(tmpDir)) {
      if (!name.startsWith('upload-')) continue;
      const dir = path.join(tmpDir, name);
      try {
        const st = fs.statSync(dir);
        if (st.isDirectory() && now - st.mtimeMs > BUNDLE_UPLOAD_TTL_MS * 2) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch { /* 忽略单个目录 */ }
    }
  } catch { /* data/tmp 不存在等情况直接忽略 */ }
}

function cleanupBundleUploads() {
  cleanupStaleBundleUploadDirs();
  const now = Date.now();
  for (const [id, up] of bundleUploads) {
    if (now - up.createdAt <= BUNDLE_UPLOAD_TTL_MS) continue;
    bundleUploads.delete(id);
    try { fs.rmSync(up.dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  // 会话数超上限时踢掉最老的，防止反复 init 把磁盘占满；
  // 正在合并（assembling）的会话不能踢，否则正在拼的文件会被删掉。
  while (bundleUploads.size >= BUNDLE_UPLOAD_MAX_SESSIONS) {
    let victim = null;
    for (const [id, up] of bundleUploads) {
      if (!up.assembling) { victim = id; break; }
    }
    // 全都在合并：宁可暂时超出上限，也不破坏正在进行的上传
    if (!victim) break;
    const up = bundleUploads.get(victim);
    bundleUploads.delete(victim);
    if (up) { try { fs.rmSync(up.dir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  }
}

function bundleUploadPartPath(up, index) {
  return path.join(up.dir, `part-${String(index).padStart(6, '0')}.bin`);
}

function bundleUploadPartSize(up, index) {
  if (index < up.chunkCount - 1) return up.chunkSize;
  return up.size - up.chunkSize * (up.chunkCount - 1);
}

/** 返回第一个缺失/大小不对的分片序号；全部分片完整时返回 -1 */
function bundleUploadFirstMissing(up) {
  for (let i = 0; i < up.chunkCount; i++) {
    try {
      if (fs.statSync(bundleUploadPartPath(up, i)).size !== bundleUploadPartSize(up, i)) return i;
    } catch {
      return i;
    }
  }
  return -1;
}

/** 把分片按顺序拼成 targetFile；onProgress(copied) 约每 16MB 回调一次；isCanceled() 为真时中止 */
async function assembleBundleUpload(up, targetFile, onProgress, isCanceled) {
  const ws = fs.createWriteStream(targetFile, { highWaterMark: 1024 * 1024 });
  const finished = new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('finish', resolve);
  });
  finished.catch(() => { /* 由下面的 await 统一处理 */ });
  let copied = 0;
  let lastReport = 0;
  const abortError = () => {
    const e = new Error('已取消');
    e.code = 'ECANCELED';
    return e;
  };
  try {
    for (let i = 0; i < up.chunkCount; i++) {
      // 几十 GB 的包合并要几分钟，取消要能立刻生效
      if (typeof isCanceled === 'function' && isCanceled()) throw abortError();
      const buf = await fsp.readFile(bundleUploadPartPath(up, i));
      copied += buf.length;
      if (!ws.write(buf)) {
        await new Promise((resolve, reject) => { ws.once('drain', resolve); ws.once('error', reject); });
      }
      if (onProgress && copied - lastReport >= 16 * 1024 * 1024) {
        lastReport = copied;
        try { onProgress(copied); } catch { /* 忽略 */ }
      }
    }
    if (typeof isCanceled === 'function' && isCanceled()) throw abortError();
    ws.end();
    await finished;
    if (onProgress) { try { onProgress(copied); } catch { /* 忽略 */ } }
    return copied;
  } catch (e) {
    try { ws.destroy(); } catch { /* 忽略 */ }
    throw e;
  }
}

function dropBundleUpload(up) {
  if (!up) return;
  bundleUploads.delete(up.id);
  try { fs.rmSync(up.dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

async function handleAdmin(ctx) {
  const { req, res, url, method, store, log } = ctx;
  const cfg = ctx.cfg();
  const pathname = url.pathname.replace(/\/+$/, '') || API;
  const rel = pathname.startsWith(API) ? pathname.slice(API.length) : '';
  const q = url.searchParams;

  // ---------------- 会话 ----------------
  if (rel === '/session' && method === 'GET') {
    const r = ctx.auth.check(req, url);
    const authed = !!r.ok && !r.anonymous;
    // 未通过鉴权（既无有效令牌，也不是受信任的本机回环）时只返回渲染顶栏所需的最小信息，
    // 不暴露 pid / configPath / listen 等可被用来推断本机环境与路径的字段。
    const base = {
      authenticated: authed,
      viaLocalhost: !!r.viaLocalhost,
      trustLocalhost: cfg.security.trustLocalhost !== false,
      authRequired: { read: cfg.security.requireRead === true, publish: cfg.security.requirePublish !== false },
      // 上传体积上限：界面据此在上传前做预检，避免「拖进去几个 GB、等到服务端拒收才看到网络错误」
      limits: { uploadMB: cfg.storage.maxUploadMB, bundleUploadMB: cfg.storage.maxBundleUploadMB },
      version: ctx.state.version,
      mode: cfg.mode,
      title: cfg.ui.title || '私人 npm 镜像源',
    };
    if (!authed) return ok(res, base);
    return ok(res, {
      ...base,
      pid: process.pid,
      startedAt: new Date(ctx.state.startedAt).toISOString(),
      registryUrl: ctx.registryUrl,
      listen: { ip: ctx.listenIp || cfg.server.ip, port: ctx.listenPort || cfg.server.port },
      configPath: require('./config').CONFIG_FILE,
      clientIp: ctx.clientIp(req),
    });
  }
  if (rel === '/session' && method === 'POST') {
    const body = await readJson(req);
    const token = String(body.token || '').trim();
    if (!token) return fail(res, 400, '缺少令牌', 'EBADTOKEN');
    if (!tokenMatches(token, cfg.security.token)) return fail(res, 401, '令牌不正确', 'EAUTH');
    // 不回显令牌：前端只判断 ok，回显只会让令牌多经过一次响应体
    return ok(res, { authenticated: true });
  }

  // ---------------- 概览 ----------------
  if (rel === '/overview' && method === 'GET') {
    const stats = store.stats();
    const bs = bundlesStat();
    // 上游连通性：首次同步探测，之后后台刷新，避免拖慢页面
    if (!ctx.state.upstreamCheck) {
      try { ctx.state.upstreamCheck = { ...(await ctx.upstream.ping()), at: Date.now() }; }
      catch (e) { ctx.state.upstreamCheck = { reachable: false, reason: e.message, at: Date.now() }; }
    } else if (Date.now() - (ctx.state.upstreamCheck.at || 0) > 60000) {
      ctx.upstream.ping().then(r => { ctx.state.upstreamCheck = { ...r, at: Date.now() }; }).catch(() => { /* 忽略 */ });
    }
    const uc = ctx.state.upstreamCheck || {};
    return ok(res, {
      version: ctx.state.version,
      mode: cfg.mode,
      pid: process.pid,
      configPath: require('./config').CONFIG_FILE,
      title: cfg.ui && cfg.ui.title,
      uptimeSec: Math.floor((Date.now() - ctx.state.startedAt) / 1000),
      startedAt: new Date(ctx.state.startedAt).toISOString(),
      listen: { ip: ctx.listenIp || cfg.server.ip, port: ctx.listenPort || cfg.server.port },
      registryUrl: ctx.registryUrl,
      lanUrls: cfg.server.ip === '0.0.0.0' || cfg.server.ip === '::' ? lanUrls(cfg.server.port) : [],
      upstream: { registry: cfg.upstream.registry, reachable: !!uc.reachable, reason: uc.reason || '', checkedAt: uc.at ? new Date(uc.at).toISOString() : null },
      stats: { ...stats, bundles: bs, storageBytesText: formatBytes(stats.storageBytes) },
      recent: (log ? log.recent(12) : []).map(parseLevelLine),
      node: { version: process.version, platform: `${os.platform()} ${os.arch()}`, pid: process.pid },
      cacheDir: ctx.npmcache.defaultCacheDir(),
    });
  }

  // ---------------- 包列表 ----------------
  if (rel === '/packages' && method === 'GET') {
    const data = store.list({
      q: q.get('q') || '',
      source: q.get('source') || 'all',
      tarballs: q.get('tarballs') || 'all',
      sort: q.get('sort') || '-updated',
      page: q.get('page') || 1,
      size: q.get('size') || 20,
    });
    const stats = store.stats();
    return ok(res, { ...data, bySource: stats.bySource, storageBytes: stats.storageBytes });
  }

  // ---------------- 添加公共包（回源并缓存） ----------------
  if (rel === '/packages' && method === 'POST') {
    const body = await readJson(req);
    let specs = [];
    if (Array.isArray(body.names)) specs = body.names;
    else if (Array.isArray(body.packages)) specs = body.packages.map(p => (typeof p === 'string' ? p : (p.version ? `${p.name}@${p.version}` : p.name)));
    else if (body.name) specs = [body.version ? `${body.name}@${body.version}` : body.name];
    specs = specs.map(s => String(s || '').trim()).filter(Boolean);
    if (!specs.length) return fail(res, 400, '请提供要添加的包名，例如 {"names":["lodash","axios@1.6.0"]}', 'EBADREQ');
    if ((cfg.mode || 'cache') === 'offline') return fail(res, 409, '当前是纯离线模式，无法从公共源添加包（可改用「导入」或「npm 缓存」方式）', 'EOFFLINE');

    const prefetch = body.prefetch !== false;   // 默认把 tarball 一起下载好，方便以后离线用
    const result = { added: [], updated: [], skipped: [], failed: [], tarballs: 0, requested: specs.length };
    for (const spec of specs) {
      const parsed = parsePkgSpec(spec);
      if (!parsed || !parsed.name) { result.failed.push({ name: spec, error: '包名格式不正确' }); continue; }
      let { name, version } = parsed;
      // `别名@npm:真实包名@范围` / `npm:真实包名@范围`：直接按真实包名抓（别名只是安装到本地时的名字）
      if (/npm:/i.test(name) || /^npm:/i.test(version || '')) {
        const root = deps.splitRootSpec(spec);
        const alias = root && /^npm:/i.test(root.range) ? deps.parseNpmAlias(root.range) : null;
        if (!alias) { result.failed.push({ name: spec, error: 'npm: 别名写法不正确，应为「别名@npm:真实包名@范围」' }); continue; }
        name = alias.name;
        version = alias.range || null;
        if (log) log.info(`添加公共包：识别到 npm: 别名 ${spec} → ${name}${version ? '@' + version : ''}`);
      }
      const existed = store.has(name);
      if (!validName(name)) { result.failed.push({ name, error: '包名不合法' }); continue; }
      try {
        const before = store.get(name);
        const beforeVersions = before ? Object.keys(before.packument.versions).length : 0;
        // full:true —— 添加公共包是用户主动操作，顺手把完整元数据里的「真实发布时间」也存下来
        const rec = await ctx.registry.ensurePackument(ctx, name, { force: true, full: true });
        if (!rec) { result.failed.push({ name, error: '上游没有找到该包' }); continue; }
        const all = Object.keys(rec.packument.versions);
        let targets = [];
        if (!version) {
          const latest = rec.packument['dist-tags'] && rec.packument['dist-tags'].latest;
          targets = latest ? [latest] : all.slice(-1);
        } else if (Object.prototype.hasOwnProperty.call(rec.packument.versions, version)) {
          targets = [version];
        } else {
          // 版本位置也可能写 dist-tag（如 beta），优先按标签解析，再退回 semver 范围
          const tagged = (rec.packument['dist-tags'] || {})[version];
          if (tagged && Object.prototype.hasOwnProperty.call(rec.packument.versions, tagged)) {
            targets = [tagged];
          } else {
            const best = maxSatisfying(all, version);
            targets = best ? [best] : [];
          }
        }
        if (!targets.length) { result.failed.push({ name: `${name}@${version}`, error: '找不到匹配的版本' }); continue; }
        let got = 0;
        if (prefetch) {
          for (const v of targets) {
            try {
              const r = await ctx.registry.ensureTarballEx(ctx, name, v);
              if (r && r.path) got++;
              else result.failed.push({ name: `${name}@${v}`, error: (ctx.registry.TARBALL_REASON_TEXT || {})[r && r.reason] || '未能获取 tarball' });
            } catch (e) { result.failed.push({ name: `${name}@${v}`, error: `tarball 下载失败：${e.message}` }); }
          }
        }
        result.tarballs += got;
        const after = store.get(name);
        const afterVersions = after ? Object.keys(after.packument.versions).length : 0;
        const entry = { name, versions: afterVersions, newVersions: Math.max(0, afterVersions - beforeVersions), tarballs: got, latest: after && after.meta.latest };
        if (!existed) result.added.push(entry);
        else if (afterVersions > beforeVersions) result.updated.push(entry);
        else result.skipped.push({ name, reason: prefetch && got ? '仅补齐了 tarball' : '已是最新，无新版本' });
        if (log) log.info(`添加公共包 ${name}${version ? `@${version}` : ''}：新增 ${entry.newVersions} 个版本，缓存 ${got} 个 tarball`);
      } catch (e) {
        result.failed.push({ name, error: e.message });
      }
    }
    return ok(res, result);
  }

  // ---------------- 一键补 tarball（包管理页勾选后批量补全） ----------------
  if (rel === '/packages/prefetch' && method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    // 同 /packages/pull：支持「全部包」（body.all=true），只是这条是同步版、适合包不多时用
    const scopeAll = body.all === true || body.scope === 'all';
    let skippedLocal = 0;
    let names;
    if (scopeAll) {
      const pick = allPackageNames(store);            // 跳过上传/私有这类不可能从上游补的包
      names = pick.names;
      skippedLocal = pick.skipped;
    } else {
      names = (Array.isArray(body.names) ? body.names : []).map(s => String(s || '').trim()).filter(Boolean);
    }
    if (!names.length) {
      return fail(res, 400, scopeAll ? '镜像里还没有任何包，先添加包再补 tarball' : '请提供要补 tarball 的包名，例如 {"names":["lodash"],"mode":"tags"}', 'EBADREQ');
    }
    const mode = body.mode === 'all' ? 'all' : (body.mode === 'latest' ? 'latest' : 'tags');   // tags=dist-tag 指向的版本（默认）；latest=只补 latest 那一个；all=补全部缺失版本
    if ((cfg.mode || 'cache') === 'offline') {
      return fail(res, 409, '当前是纯离线模式：本地没有的 tarball 补不下来（请在联网时补，或改用「导入」离线包）', 'EOFFLINE');
    }
    const unknown = names.filter(n => !store.has(n));
    if (unknown.length === names.length) return fail(res, 404, `本地没有这些包：${unknown.join('、')}`, 'ENOTFOUND');

    const out = { mode, scope: scopeAll ? 'all' : 'picked', skippedLocal, requested: names.length, tarballs: 0, packages: [], skipped: [], failed: [] };
    /* 两个阶段都并发：
     * 1) 逐个包并发读 packument、算缺哪些版本（每个包只读一次，不再 get 两遍）；
     * 2) 把「包@版本」摊平成任务后按上游并发数一起下载（原来是逐包逐版本串行 await）。 */
    const scanConc = localScanConcurrency(cfg);
    const plans = await mapLimit(names, scanConc, async (name) => {
      const rec = await store.getAsync(name);
      if (!rec) return { name, error: '本地没有这个包' };
      const missing = pull.missingTarballsFrom(store, name, rec);
      const missingSet = new Set(missing);
      let targets;
      if (mode === 'all') {
        targets = missing.slice();
      } else if (mode === 'latest') {
        const v = String((rec.packument['dist-tags'] || {}).latest || '');
        targets = (v && missingSet.has(v)) ? [v] : [];
      } else {
        const tags = rec.packument['dist-tags'] || {};
        const set = new Set();
        for (const v of Object.values(tags)) if (missingSet.has(v)) set.add(v);
        targets = Array.from(set);
      }
      return { name, missing, targets, got: [], bad: [] };
    });
    const jobs = [];
    for (const plan of plans) {
      if (plan.error) { out.failed.push({ name: plan.name, error: plan.error }); continue; }
      if (!plan.targets.length) {
        out.skipped.push({
          name: plan.name,
          reason: plan.missing.length
            ? (mode === 'latest'
              ? `latest 版本已缓存（该包另有 ${plan.missing.length} 个版本没缓存，可用「全部版本」模式补）`
              : `dist-tag 指向的版本都已缓存（该包另有 ${plan.missing.length} 个版本没缓存，可用「全部版本」模式补）`)
            : '所有版本都已缓存',
          missing: plan.missing.length,
        });
        out.packages.push({ name: plan.name, target: 0, downloaded: 0, failed: 0, missing: plan.missing.length });
        continue;
      }
      for (const v of plan.targets) jobs.push({ plan, version: v });
    }
    const dlConc = clamp(Number(cfg.upstream.concurrency) || 6, 1, 32);
    await mapLimit(jobs, dlConc, async (job) => {
      try {
        const r = await ctx.registry.ensureTarballEx(ctx, job.plan.name, job.version);
        if (r && r.path) job.plan.got.push(job.version);
        else job.plan.bad.push({ version: job.version, error: (ctx.registry.TARBALL_REASON_TEXT || {})[r && r.reason] || '无法获取（上游未提供或离线）' });
      } catch (e) { job.plan.bad.push({ version: job.version, error: e.message }); }
    });
    for (const plan of plans) {
      if (plan.error || !plan.targets || !plan.targets.length) continue;
      for (const b of plan.bad) out.failed.push({ name: `${plan.name}@${b.version}`, error: b.error });
      out.tarballs += plan.got.length;
      const recNow = await store.getAsync(plan.name);
      const left = recNow ? pull.missingTarballsFrom(store, plan.name, recNow).length : 0;
      out.packages.push({ name: plan.name, target: plan.targets.length, downloaded: plan.got.length, failed: plan.bad.length, versions: plan.got, missing: left });
      if (log) log.info(`补 tarball ${plan.name}（${mode}）：目标 ${plan.targets.length} 个，成功 ${plan.got.length} 个，剩余缺失 ${left} 个`);
    }
    return ok(res, out);
  }

  // ---------------- 补 tarball（异步任务版：真实进度 + 并发下载 + 可取消） ----------------
  if (rel === '/packages/pull' && method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    // 包管理页的「全部包补 dist-tag 版本 / 全部包补最新版本」：不对名单，直接对镜像里所有包
    const scopeAll = body.all === true || body.scope === 'all';
    let skippedLocal = 0;
    let names = (Array.isArray(body.names) ? body.names : [])
      .map(s => String(s || '').trim()).filter(Boolean);
    // 详情页可以点名补「选中版本」：targets=[{name,version}]
    const targets = (Array.isArray(body.targets) ? body.targets : [])
      .map(t => ({ name: String((t && t.name) || '').trim(), version: String((t && t.version) || '').trim() }))
      .filter(t => t.name && t.version);
    if (scopeAll) {
      // 全部包：名单由服务端给（前端不用传），并跳过上传/私有这类不可能从上游补的包
      const pick = allPackageNames(store);
      names = pick.names;
      skippedLocal = pick.skipped;
      if (!names.length) return fail(res, 400, '镜像里还没有任何包，先添加包再补 tarball', 'EBADREQ');
    }
    const mode = scopeAll
      ? (body.mode === 'all' ? 'all' : (body.mode === 'latest' ? 'latest' : 'tags'))
      : ((body.mode === 'all') ? 'all'
        : (body.mode === 'latest') ? 'latest'
          : ((body.mode === 'selected' || targets.length) ? 'selected' : 'tags'));
    if (mode === 'selected') {
      if (!targets.length) return fail(res, 400, 'selected 模式需要提供 targets，例如 {"targets":[{"name":"lodash","version":"4.17.21"}]}', 'EBADREQ');
      if (!names.length) names = Array.from(new Set(targets.map(t => t.name)));
    }
    if (!names.length) return fail(res, 400, '请提供要补 tarball 的包名，例如 {"names":["lodash"],"mode":"tags"}', 'EBADREQ');
    if ((cfg.mode || 'cache') === 'offline') {
      return fail(res, 409, '当前是纯离线模式：本地没有的 tarball 补不下来（请在联网时补，或改用「导入」离线包）', 'EOFFLINE');
    }
    const unknown = names.filter(n => !store.has(n));
    if (unknown.length === names.length) return fail(res, 404, `本地没有这些包：${unknown.join('、')}`, 'ENOTFOUND');

    const concurrency = clamp(Number(body.concurrency) || Number(cfg.upstream.concurrency) || 6, 1, 32);
    // 规划阶段同样并发读盘（并发数取 storage.localScanConcurrency），不再逐个包串行 get
    const plan = await pull.planTargets(store, names, mode, targets, { concurrency: localScanConcurrency(cfg) });
    const total = plan.reduce((a, p) => a + p.target.length, 0);
    const modeLabel = mode === 'all' ? '全部版本'
      : (mode === 'latest' ? '最新版本' : (mode === 'selected' ? '选中版本' : 'dist-tag 版本'));
    const title = scopeAll
      ? `全部包补 ${modeLabel} · ${names.length} 个包`
      : (mode === 'all' ? `全部版本补 tarball · ${names.length} 个包`
        : (mode === 'selected' ? `选中版本补 tarball · ${names.length} 个包 / ${targets.length} 个点名版本`
          : (mode === 'latest' ? `只补最新版本 · ${names.length} 个包`
            : `dist-tag 版本补 tarball · ${names.length} 个包`)));
    const task = tasks.create({
      type: 'pull',
      title,
      total,
      concurrency,
      packages: plan.map(p => ({
        name: p.name, target: p.target.length, done: 0, ok: 0, failed: 0, bytes: 0,
        missing: p.missingCount, totalVersions: p.totalVersions || 0, latest: p.latest || '',
        error: p.error || '', status: p.error ? 'error' : 'pending',
      })),
    });

    setImmediate(() => {
      Promise.resolve()
        .then(() => pull.pullTarballs(ctx, {
          names, mode, selected: targets, concurrency, task, plan,
          onProgress: (info) => tasks.update(task.id, {
            done: info.done, ok: info.ok, failed: info.failed, bytes: info.bytes, packages: info.packages,
            errors: (info.errors || []).slice(0, 50),
            /* 正在并发下载的「版本」实时字节进度（name/version/received/total），前端右栏逐条显示 */
            downloads: (info.downloads || []).slice(0, 64),
          }),
          shouldStop: () => task.cancelRequested,
        }))
        .then((r) => {
          const status = r.canceled ? 'canceled' : (r.failed > 0 && r.ok === 0 ? 'error' : 'done');
          const parts = [`成功 ${r.ok} 个`];
          if (r.failed) parts.push(`失败 ${r.failed} 个`);
          if (r.canceled) parts.push('已取消');
          tasks.finish(task.id, {
            status,
            message: `${parts.join('、')}，共 ${r.done}/${r.total} 个，下载 ${formatBytes(r.bytes)}`,
            result: {
              mode, scope: scopeAll ? 'all' : 'picked', skippedLocal, concurrency, total: r.total, ok: r.ok, failed: r.failed,
              bytes: r.bytes, canceled: !!r.canceled, errors: r.errors.slice(0, 50),
              packages: r.packages.map(p => ({ name: p.name, target: p.target, done: p.done, ok: p.ok, failed: p.failed, bytes: p.bytes, error: p.error || '' })),
            },
          });
          if (log) log.info(`补 tarball 任务 ${task.id} 结束：模式 ${mode}，并发 ${concurrency}，成功 ${r.ok}，失败 ${r.failed}${r.canceled ? '，已取消' : ''}`);
        })
        .catch((e) => {
          tasks.finish(task.id, { status: 'error', message: (e && e.message) || String(e) });
          if (log) log.error(`补 tarball 任务 ${task.id} 异常：${(e && e.message) || e}`);
        });
    });

    return ok(res, {
      taskId: task.id, mode, concurrency, total,
      scope: scopeAll ? 'all' : 'picked',
      skippedLocal,
      packages: plan.map(p => ({ name: p.name, target: p.target.length, missing: p.missingCount, error: p.error || '' })),
    });
  }

  // ---------------- 递归添加依赖（输一个包名，把它的依赖、依赖的依赖一起加进来） ----------------
  if (rel === '/packages/deps-add' && method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    let specs = [];
    if (Array.isArray(body.names)) specs = body.names;
    else if (Array.isArray(body.packages)) specs = body.packages.map(p => (typeof p === 'string' ? p : (p.version ? `${p.name}@${p.version}` : p.name)));
    else if (body.name) specs = [body.version ? `${body.name}@${body.version}` : body.name];
    specs = specs.map(s => String(s || '').trim()).filter(Boolean);
    if (!specs.length) return fail(res, 400, '请提供要添加的包名，例如 {"names":["chalk@4.1.2"],"depth":5}', 'EBADREQ');
    if ((cfg.mode || 'cache') === 'offline') return fail(res, 409, '当前是纯离线模式，无法从公共源添加包（可改用「导入」或「npm 缓存」方式）', 'EOFFLINE');

    const depth = clamp(Math.round(Number(body.depth) || deps.DEFAULT_DEPTH), 0, deps.HARD_DEPTH);
    const limit = clamp(Math.round(Number(body.limit) || deps.DEFAULT_LIMIT), 1, deps.HARD_LIMIT);
    const prefetch = body.prefetch !== false;         // 默认连 tarball 一起下，方便以后离线装
    const concurrency = clamp(Number(body.concurrency) || Number(cfg.upstream.concurrency) || 6, 1, 32);

    const task = tasks.create({
      type: 'add-deps',
      title: `递归添加依赖 · ${specs.length} 个包（最多 ${depth} 层）`,
      phase: 'resolve',
      total: 0,
      concurrency,
      packages: specs.map(s => ({
        name: s, version: '', depth: 0, kind: 'root',
        target: 0, done: 0, ok: 0, failed: 0, bytes: 0, status: 'running',
      })),
    });

    setImmediate(() => {
      Promise.resolve()
        .then(async () => {
          const rowsOf = (info) => info.picks.map(p => ({
            name: p.name, version: p.version, depth: p.depth, kind: p.kind, deps: p.deps || 0,
            newPackage: !!p.newPackage, newVersion: !!p.newVersion, tarball: !!p.tarball,
            alias: p.alias ? { name: p.alias.name, spec: p.alias.spec } : null,
            target: 0, done: 0, ok: 0, failed: 0, bytes: 0, status: 'pending',
          }));
          let lastEmit = 0;
          const resolved = await deps.resolveClosure(ctx, specs, {
            depth, limit, persist: true,
            optional: body.optional === true, peer: body.peer === true,
            shouldStop: () => task.cancelRequested,
            onProgress: (info) => {
              // 前端 700ms 轮询一次，这里跟着节流；队列清空时一定补发最后一帧
              const now = Date.now();
              if (info.stats.queued && now - lastEmit < 400) return;
              lastEmit = now;
              const rows = rowsOf(info);
              tasks.update(task.id, {
                phase: 'resolve',
                total: rows.length, done: rows.length,
                packages: rows,
                message: `正在解析依赖：已找到 ${rows.length} 个版本 / ${info.stats.packages} 个包`
                  + (info.stats.aliases ? `（其中 ${info.stats.aliases} 个是 npm: 别名）` : ''),
                result: {
                  phase: 'resolve', stats: info.stats, picks: rows,
                  unresolved: info.unresolved.slice(0, 50), errors: info.errors.slice(0, 50), bad: info.bad,
                },
              });
            },
          });

          const picks = resolved.picks;
          const targets = picks.map(p => ({ name: p.name, version: p.version }));
          const names = Array.from(new Set(picks.map(p => p.name)));
          let dl = null;

          if (prefetch && targets.length && !task.cancelRequested) {
            const plan = await pull.planTargets(store, names, 'selected', targets, { concurrency: localScanConcurrency(cfg) });
            const planTotal = plan.reduce((a, p) => a + p.target.length, 0);
            tasks.update(task.id, {
              phase: 'download',
              packages: plan.map(p => ({
                name: p.name, target: p.target.length, done: 0, ok: 0, failed: 0, bytes: 0,
                missing: p.missingCount, totalVersions: p.totalVersions || 0, latest: p.latest || '',
                error: p.error || '', status: p.error ? 'error' : 'pending',
              })),
              total: planTotal, done: 0, ok: 0, failed: 0, bytes: 0,
              message: `依赖已解析，开始下载 tarball（${planTotal} 个）`,
            });
            dl = await pull.pullTarballs(ctx, {
              names, mode: 'selected', selected: targets, concurrency, task, plan,
              onProgress: (info) => tasks.update(task.id, {
                done: info.done, ok: info.ok, failed: info.failed, bytes: info.bytes,
                packages: info.packages, errors: (info.errors || []).slice(0, 50),
                /* 每个正在下载版本的实时字节进度（递归添加依赖弹窗右栏也按版本显示） */
                downloads: (info.downloads || []).slice(0, 64),
              }),
              shouldStop: () => task.cancelRequested,
            });
          }

          const s = resolved.stats;
          const parts = [`解析出 ${s.versions} 个版本 / ${s.packages} 个包`];
          if (s.aliases) parts.push(`其中 ${s.aliases} 个是 npm: 别名`);
          if (s.newPackages) parts.push(`新增 ${s.newPackages} 个包`);
          if (dl) parts.push(`tarball 成功 ${dl.ok} 个${dl.failed ? `、失败 ${dl.failed} 个` : ''}`);
          else if (prefetch) parts.push('没有需要下载的 tarball');
          if (s.unresolved) parts.push(`${s.unresolved} 个依赖需要手工处理`);
          if (s.truncated) parts.push('已达到上限，未继续展开');
          const canceled = !!(s.canceled || (dl && dl.canceled));
          const status = canceled ? 'canceled' : ((dl && dl.failed > 0 && dl.ok === 0) ? 'error' : 'done');
          tasks.finish(task.id, {
            status,
            message: parts.join('，'),
            result: {
              phase: 'done', depth, limit, prefetch, canceled,
              stats: s,
              packages: picks.map(p => ({
                name: p.name, version: p.version, depth: p.depth, kind: p.kind,
                deps: p.deps || 0, newPackage: !!p.newPackage, newVersion: !!p.newVersion,
                alias: p.alias ? { name: p.alias.name, spec: p.alias.spec } : null,
              })),
              unresolved: resolved.unresolved.slice(0, 50),
              errors: resolved.errors.slice(0, 50),
              bad: resolved.bad,
              tarballs: dl ? { total: dl.total, ok: dl.ok, failed: dl.failed, bytes: dl.bytes, canceled: !!dl.canceled } : null,
            },
          });
          if (log) log.info(`递归添加依赖任务 ${task.id} 结束：根 ${specs.length} 个，解析 ${s.packages} 包 / ${s.versions} 版本，新增 ${s.newPackages} 包${dl ? `，tarball 成功 ${dl.ok} 失败 ${dl.failed}` : ''}`);
        })
        .catch((e) => {
          tasks.finish(task.id, { status: 'error', message: (e && e.message) || String(e) });
          if (log) log.error(`递归添加依赖任务 ${task.id} 异常：${(e && e.message) || e}`);
        });
    });

    return ok(res, { taskId: task.id, depth, limit, prefetch, requested: specs.length });
  }

  // ---------------- 后台任务查询 / 取消 ----------------
  if (rel === '/tasks' && method === 'GET') {
    return ok(res, { items: tasks.list() });
  }
  if (rel.startsWith('/tasks/') && rel.endsWith('/cancel') && method === 'POST') {
    const id = decodeStr(rel.slice('/tasks/'.length, -'/cancel'.length));
    const t = tasks.get(id);
    if (!t) return fail(res, 404, '任务不存在（可能已随服务重启清空）', 'ENOTFOUND');
    const r = tasks.cancel(id);
    if (log) log.info(`请求取消任务 ${id}`);
    return ok(res, { canceling: true, task: r });
  }
  if (rel.startsWith('/tasks/') && method === 'GET') {
    const id = decodeStr(rel.slice('/tasks/'.length));
    const snap = tasks.snapshot(id);
    if (!snap) return fail(res, 404, '任务不存在（可能已随服务重启清空）', 'ENOTFOUND');
    return ok(res, snap);
  }

  // ---------------- 单个包 ----------------
  const pkgRoute = parsePackageRoute(pathname);
  if (pkgRoute && (pathname.startsWith(`${API}/packages/`))) {
    const { name, tail } = pkgRoute;
    // 包名先校验再进 store：store 内部还有一层路径校验兜底，这里提前给出清晰的 400
    if (!validName(name)) return fail(res, 400, `不合法的包名：${name}`, 'EBADNAME');
    const base = baseFor(req, ctx.registryUrl);

    if (!tail.length && method === 'GET') {
      const rec = store.get(name);
      if (!rec) return fail(res, 404, `本地没有包 ${name}`, 'ENOTFOUND');
      const meta = rec.meta || {};
      const pk = rec.packument;
      const versions = Object.keys(pk.versions || {}).sort(compareVersions).map(v => {
        const m = pk.versions[v];
        const dist = m.dist || {};
        // 用内存索引里的 meta.files 判断是否已缓存（O(1)）：typescript 这类 3900 个版本的包
        // 原来每个版本 existsSync 一遍，详情页要白等；索引里没有 files 的历史数据再回退真实检查。
        const cached = meta.files
          ? Object.prototype.hasOwnProperty.call(meta.files, v)
          : store.hasTarball(name, v);
        let size = (meta.sizes && meta.sizes[v]) || 0;
        if (!size && cached) { try { size = fs.statSync(store.tarballPath(name, v)).size; } catch { size = 0; } }
        return {
          version: v,
          sizeBytes: size,
          // 源服务器上的信息（来自上游元数据，未缓存的版本也有；本地缓存后两者应基本一致）
          sourceSizeBytes: Number(dist.size) || 0,
          unpackedSizeBytes: Number(dist.unpackedSize) || 0,
          fileCount: Number(dist.fileCount) || 0,
          downloads: (meta.byVersion && meta.byVersion[v]) || 0,
          // 真实发布时间：只认真实上游 time 字段；上游没给就是 null（界面显示 —），
          // 绝不用「本地收录时间」冒充，否则所有老版本看着都像今天发布的。
          publishedAt: (pk.time && pk.time[v]) || null,
          cached,
          deprecated: (meta.deprecated && meta.deprecated[v]) || m.deprecated || null,
          tarballUrl: `${base}/${name}/-/${store.tarballFileName(name, v)}`,
          integrity: (m.dist && m.dist.integrity) || null,
          shasum: (m.dist && m.dist.shasum) || null,
          dependencies: m.dependencies || null,
          engines: m.engines || null,
          origin: (meta.origins && meta.origins[v]) || null,
        };
      });
      return ok(res, {
        name,
        description: pk.description || meta.description || '',
        source: meta.source || 'upstream',
        latest: meta.latest || null,
        distTags: pk['dist-tags'] || {},
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        lastFetchAt: meta.lastFetchAt || null,
        // 上游元数据里的时间（只有拉过完整元数据的包才有）：created/modified + 已收录多少个版本的发布时间
        upstreamCreated: meta.upstreamCreated || (pk.time && pk.time.created) || null,
        upstreamModified: meta.upstreamModified || (pk.time && pk.time.modified) || null,
        publishTimeCount: (meta.publishTimeCount !== undefined
          ? meta.publishTimeCount
          : Object.keys(pk.time || {}).length),
        downloads: meta.downloads || 0,
        private: !!meta.private,
        homepage: pk.homepage || null,
        license: pk.license || null,
        keywords: pk.keywords || null,
        tarballBytes: meta.sizeBytes || 0,
        missingTarballs: versions.filter(v => !v.cached).map(v => v.version),
        versions,
      });
    }

    if (tail.length === 1 && tail[0] === 'refresh' && method === 'POST') {
      if ((cfg.mode || 'cache') === 'offline') return fail(res, 409, '当前是纯离线模式，无法回源刷新', 'EOFFLINE');
      try {
        const rec = await ctx.registry.ensurePackument(ctx, name, { force: true, full: true });
        if (!rec) return fail(res, 404, `上游没有找到 ${name}`, 'ENOTFOUND');
        return ok(res, {
          name,
          versions: Object.keys(rec.packument.versions).length,
          latest: rec.meta.latest,
          publishTimeCount: (rec.meta && rec.meta.publishTimeCount) || 0,
        });
      } catch (e) { return fail(res, 502, `刷新失败：${e.message}`, 'EUPSTREAM'); }
    }

    if (tail.length === 1 && tail[0] === 'prefetch' && method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const rec = await store.getAsync(name);
      if (!rec) return fail(res, 404, `本地没有包 ${name}`, 'ENOTFOUND');
      let list = Array.isArray(body.versions) ? body.versions.filter(v => rec.packument.versions[v]) : [];
      if (!list.length) list = pull.missingTarballsFrom(store, name, rec);
      const out = { name, requested: list.length, downloaded: [], failed: [] };
      // 多版本一起并发下载（原来是一个版本一个 await，选一大串版本时要等很久）
      const dlConc = clamp(Number(cfg.upstream.concurrency) || 6, 1, 32);
      await mapLimit(list, dlConc, async (v) => {
        try {
          const r = await ctx.registry.ensureTarballEx(ctx, name, v);
          if (r && r.path) out.downloaded.push(v);
          else out.failed.push({ version: v, error: (ctx.registry.TARBALL_REASON_TEXT || {})[r && r.reason] || '未能获取 tarball' });
        } catch (e) { out.failed.push({ version: v, error: e.message }); }
      });
      return ok(res, out);
    }

    if (tail.length === 1 && tail[0] === 'deprecate' && method === 'POST') {
      const body = await readJson(req);
      const rec = store.get(name);
      if (!rec) return fail(res, 404, `本地没有包 ${name}`, 'ENOTFOUND');
      const version = body.version || rec.meta.latest;
      if (!Object.prototype.hasOwnProperty.call(rec.packument.versions || {}, version)) return fail(res, 404, `版本 ${name}@${version} 不存在`, 'ENOTFOUND');
      const message = String(body.message || '').trim();
      const deprecated = { ...(rec.meta.deprecated || {}) };
      if (message) {
        rec.packument.versions[version].deprecated = message;
        deprecated[version] = message;
      } else {
        delete rec.packument.versions[version].deprecated;
        delete deprecated[version];
      }
      store.save(name, rec.packument, { deprecated });
      if (log) log.info(`${message ? '标记弃用' : '取消弃用'} ${name}@${version}`);
      return ok(res, { name, version, deprecated: message || null });
    }

    if (tail.length === 1 && method === 'DELETE') {
      const rec = store.get(name);
      if (!rec) return fail(res, 404, `本地没有包 ${name}`, 'ENOTFOUND');
      const version = tail[0];
      if (!Object.prototype.hasOwnProperty.call(rec.packument.versions || {}, version)) return fail(res, 404, `版本 ${name}@${version} 不存在`, 'ENOTFOUND');
      store.deleteVersion(name, version);
      if (log) log.warn(`删除版本 ${name}@${version}`);
      return ok(res, { name, version, deleted: true, remaining: Object.keys((store.get(name) || { packument: { versions: {} } }).packument.versions).length });
    }

    if (!tail.length && method === 'DELETE') {
      if (!store.has(name)) return fail(res, 404, `本地没有包 ${name}`, 'ENOTFOUND');
      const removed = Object.keys((store.get(name) || { packument: { versions: {} } }).packument.versions || {});
      store.deletePackage(name);
      if (log) log.warn(`删除包 ${name}（${removed.length} 个版本）`);
      return ok(res, { name, deleted: true, removedVersions: removed, removedCount: removed.length });
    }
  }

  // ---------------- 上传（私有包 / 元数据） ----------------
  if (rel === '/upload' && method === 'POST') {
    const maxBytes = Math.max(1, Number(cfg.storage.maxUploadMB || 500)) * 1024 * 1024;
    const buf = await readBody(req, maxBytes);
    if (!buf.length) return fail(res, 400, '请求体为空', 'EBADREQ');
    let filename = '';
    try { filename = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch { filename = String(req.headers['x-filename'] || ''); }
    filename = path.basename(filename || `upload-${stamp()}.tgz`);
    // 只接受 tarball 或 packument JSON；其余扩展名直接拒绝，避免把任意二进制塞进 tarball 目录
    if (!/\.(tgz|tar\.gz|json)$/i.test(filename)) {
      return fail(res, 400, '只支持 .tgz / .tar.gz 包文件或 .json 元数据文件', 'EBADEXT');
    }
    if (!/\.json$/i.test(filename) && !(buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b)) {
      return fail(res, 400, '文件内容不是 gzip 格式的 tarball', 'EBADFORMAT');
    }
    const overwrite = q.get('overwrite') === '1' || q.get('overwrite') === 'true';
    const tmpDir = rootPath('data', 'tmp');
    const file = bodyToTempFile(buf, tmpDir, filename);
    try {
      if (/\.json$/i.test(filename)) {
        const json = JSON.parse(buf.toString('utf8'));
        const r = await ctx.bundle.importPackumentJson({ store, json, overwrite, source: 'upload' });
        if (log) log.info(`上传元数据 JSON：${r.name}（${r.versions} 个版本）`);
        return ok(res, { kind: 'packument', ...r, sizeBytes: buf.length });
      }
      const r = await ctx.bundle.importTarballFile({ store, file, overwrite, source: overwrite ? 'private' : 'upload' });
      if (log) log.info(`上传私有包：${r.name}@${r.version}（${formatBytes(r.sizeBytes)}）`);
      return ok(res, { kind: 'tarball', ...r });
    } catch (e) {
      if (e.code === 'EEXIST') return fail(res, 409, e.message, 'EEXIST');
      return fail(res, 400, `导入失败：${e.message}`, e.code || 'EIMPORT');
    } finally {
      try { fs.unlinkSync(file); } catch { /* 忽略 */ }
    }
  }

  // ---------------- 搜索 ----------------
  if (rel === '/search' && method === 'GET') {
    const text = (q.get('text') || q.get('q') || '').trim();
    const size = Math.min(50, Math.max(1, Number(q.get('size')) || 20));
    const local = store.list({ q: text, size, sort: '-downloads' }).items.map(i => ({
      name: i.name, version: i.latest, description: i.description, local: true, source: i.source, date: i.updatedAt,
    }));
    const seen = new Set(local.map(i => i.name));
    const remote = [];
    if ((cfg.mode || 'cache') !== 'offline' && text) {
      try {
        for (const r of await ctx.upstream.search(text, size)) {
          if (seen.has(r.name)) continue;
          seen.add(r.name);
          remote.push({ name: r.name, version: r.version, description: r.description, local: false, source: 'upstream', date: r.date });
        }
      } catch (e) { if (log) log.debug(`上游搜索失败：${e.message}`); }
    }
    return ok(res, { items: [...local, ...remote].slice(0, size), localCount: local.length, remoteCount: remote.length, offline: (cfg.mode || 'cache') === 'offline' });
  }

  // ---------------- 迁移：离线包 ----------------
  if (rel === '/bundles' && method === 'GET') {
    const { items } = ctx.bundle.listBundles();
    const manifestCache = ctx.state.bundleManifests || (ctx.state.bundleManifests = new Map());
    // 多个离线包的 manifest 并发读取（每个都要读包尾部的 tar 条目；命中缓存的不再读）
    await mapLimit(items, Math.max(1, Math.min(16, items.length || 1)), async (it) => {
      const key = `${it.file}:${it.sizeBytes}:${it.createdAt}`;
      let info = manifestCache.get(key);
      if (!info) {
        try {
          const m = await ctx.bundle.readBundleManifest(it.path);
          info = { packages: (m.packages || []).length, versions: (m.stats && m.stats.versions) || 0, tarballs: (m.stats && m.stats.tarballs) || 0, scope: m.scope, createdAt: m.createdAt, host: m.host };
          manifestCache.set(key, info);
        } catch (e) { info = { error: e.message }; manifestCache.set(key, info); }
      }
      Object.assign(it, info);
      return it;
    });
    return ok(res, {
      items,
      totalBytes: items.reduce((a, b) => a + (b.sizeBytes || 0), 0),
      limits: { uploadMB: cfg.storage.maxUploadMB, bundleUploadMB: cfg.storage.maxBundleUploadMB },
    });
  }

  if (rel === '/bundles/export' && method === 'POST') {
    const body = await readJson(req);
    const rawScope = typeof body.scope === 'string' ? body.scope : '';
    const ALLOWED_SCOPE = ['all', 'private', 'upstream', 'selected', 'added'];
    if (rawScope && !ALLOWED_SCOPE.includes(rawScope)) {
      return fail(res, 400, `不支持的导出范围：${rawScope}（可选 all / private / upstream / selected / added）`, 'EBADSCOPE');
    }
    const scope = rawScope || (Array.isArray(body.names) && body.names.length ? 'selected' : 'all');
    /* 「按添加时间」导出：把起止时间（ISO 字符串或毫秒）规范化为闭区间；
     * 格式不对 / 两个都不给 / 起晚于止 都直接 400，不启动任务。 */
    let addedRange = null;
    if (scope === 'added') {
      try {
        addedRange = ctx.bundle.normalizeAddedRange({ addedFrom: body.addedFrom, addedTo: body.addedTo });
      } catch (e) {
        return fail(res, 400, e.message, e.code || 'EBADTIME');
      }
    }
    const addedRangeOpts = addedRange ? { addedFrom: addedRange.from, addedTo: addedRange.to } : {};
    // 指定导出选中的包时，默认把它们的（递归）依赖也一起导出；显式传 withDeps:false 可关闭
    const withDeps = scope === 'selected' && (body.withDeps === undefined ? true : !!body.withDeps);
    // 镜像里没有的依赖：默认在 cache/proxy 模式下自动下载并入库（离线模式只会提示）；显式 autoFetchDeps:false 可关闭
    const autoFetchDeps = body.autoFetchDeps === undefined ? true : !!body.autoFetchDeps;
    const names = Array.isArray(body.names) ? body.names.filter(n => typeof n === 'string') : [];
    /* progress:true —— 长任务模式：立即返回 taskId，界面用 /tasks/<id> 轮询
     * 「统计 → 打包」两阶段进度、逐包打包详情与「并行打包的每个包」进度条；可取消。 */
    if (body.progress === true) {
      const pkgs = [];
      const conc = Math.max(1, Number(cfg.storage.bundleExportConcurrency) || 4);
      const taskId = startBundleTask({
        type: 'bundle-export',
        title: '导出离线包',
        phase: 'collect',
        total: 0,
        concurrency: conc,
        log,
        run: async ({ update, isCanceled }) => {
          try {
            return await ctx.bundle.exportBundle({
              store,
              ctx,
              scope,
              names,
              fileName: body.name || body.fileName,
              withDeps,
              autoFetchDeps,
              logger: log,
              isCanceled,
              concurrency: conc,
              localScanConcurrency: localScanConcurrency(cfg),
              ...addedRangeOpts,
              onProgress: (ev) => {
                if (ev.phase === 'deps-fetch') {
                  // 自动补依赖阶段：沿用 collect 阶段显示，只换文案（进度按「已处理 N 个依赖」算）
                  const doneN = (Number(ev.downloaded) || 0) + (Number(ev.failed) || 0);
                  update({
                    phase: 'collect',
                    message: ev.message || '正在自动补齐缺失依赖…',
                    done: doneN,
                    total: Math.max(doneN, Number(ev.total) || 0),
                  });
                  return;
                }
                if (ev.phase === 'collect-start') {
                  update({ phase: 'collect', total: Number(ev.total) || 0, message: '正在统计要导出的包…' });
                  return;
                }
                if (ev.phase === 'collect-done') {
                  update({
                    phase: 'pack',
                    total: Number(ev.entries) || 0,
                    bytesTotal: Number(ev.totalBytes) || 0,
                    done: 0,
                    message: '',
                    title: `导出离线包 · ${Number(ev.packages).toLocaleString('en-US')} 个包`,
                  });
                  return;
                }
                if (ev.phase === 'collect') {
                  // 统计阶段也有反馈：大镜像逐个 stat tarball 可能要几秒，界面显示「已扫描 N / M 个包」
                  update({ phase: 'collect', done: Number(ev.packages) || 0, total: Number(ev.total) || 0 });
                  return;
                }
                if (ev.phase === 'package') {
                  pkgs.push({
                    name: ev.name,
                    status: 'packed',
                    versions: Number(ev.versions) || 0,
                    tarballs: Number(ev.tarballs) || 0,
                    sizeBytes: Number(ev.sizeBytes) || 0,
                  });
                  update({ packages: pkgs.slice(-2000), ok: pkgs.length });
                  return;
                }
                if (ev.phase === 'pack') {
                  update({
                    phase: 'pack',
                    done: Number(ev.entriesDone) || 0,
                    total: Number(ev.entriesTotal) || 0,
                    bytes: Number(ev.bytes) || 0,
                    bytesTotal: Number(ev.totalBytes) || 0,
                    current: ev.pkg || '',
                    currentDone: Number(ev.pkgDone) || 0,
                    currentTotal: Number(ev.pkgTotal) || 0,
                    // 并行打包时同时有多个包在写，右栏按它渲染多行（current 保留，兼容旧前端/串行时）
                    inFlight: Array.isArray(ev.inFlight) ? ev.inFlight.slice(0, 64) : [],
                  });
                }
                if (ev.phase === 'concat') {
                  /* 全部条目压缩完但归档还没写完：正在把分片拼成最终文件（大镜像几十 GB，界面要显示写盘字节进度）。
                   * current 也一并清掉：压缩阶段最后那个包已经写完了，收尾时右栏不该再挂一行「100%」。 */
                  update({
                    phase: 'concat',
                    message: '正在拼接分片写入最终文件…',
                    concatDone: Number(ev.concatDone) || 0,
                    concatTotal: Number(ev.concatTotal) || 0,
                    concatParts: Number(ev.concatParts) || 0,
                    current: '', currentDone: 0, currentTotal: 0,
                    inFlight: [],
                  });
                  return;
                }
                if (ev.phase === 'finalize') {
                  update({
                    phase: 'finalize', message: '正在收尾：重命名最终文件…',
                    current: '', currentDone: 0, currentTotal: 0, inFlight: [],
                  });
                  return;
                }
              },
            });
          } finally {
            // 任务收尾（成功/取消/失败）都要把「并行包」清空，右栏才不会留下已结束的行
            update({ inFlight: [] });
          }
        },
      });
      return ok(res, { taskId, async: true });
    }
    try {
      const r = await ctx.bundle.exportBundle({
        store,
        ctx,
        scope,
        names,
        fileName: body.name || body.fileName,
        withDeps,
        autoFetchDeps,
        logger: log,
        concurrency: Math.max(1, Number(cfg.storage.bundleExportConcurrency) || 4),
        localScanConcurrency: localScanConcurrency(cfg),
        ...addedRangeOpts,
      });
      return ok(res, r);
    } catch (e) {
      return fail(res, e.code === 'EMPTY' ? 409 : 500, e.message, e.code || 'EEXPORT');
    }
  }

  // ---------------- 离线包：分片并发上传 ----------------
  // 网页上传几个 GB 的整机备份时，单个请求只能占用一条连接：这里让前端把文件切片、
  // 多路并发上传分片，服务端先逐片落盘，complete 时再在后台任务里顺序拼包并导入。
  if (rel === '/bundles/upload/init' && method === 'POST') {
    const body = await readJson(req);
    const name = path.basename(String(body.file || body.name || ''));
    if (!name) return fail(res, 400, '请提供 file 字段（离线包文件名）', 'EBADREQ');
    if (!/\.(tgz|tar\.gz)$/i.test(name)) return fail(res, 400, '只支持 .tgz / .tar.gz 格式的离线包', 'EBADREQ');
    const size = Number(body.size);
    if (!Number.isSafeInteger(size) || size <= 0) return fail(res, 400, 'size 必须是正整数（字节）', 'EBADREQ');
    const maxMB = Math.max(1, Number(cfg.storage.maxBundleUploadMB || 4096));
    const maxBytes = maxMB * 1024 * 1024;
    const tooLargeHint = '；更大的离线包请把 .tgz 拷贝到 data/bundles 目录后刷新列表，'
      + '点表格里的「导入」按钮（或运行 一键导入离线包.cmd），这条路不受网页上传上限限制';
    if (size > maxBytes) {
      if (log) log.warn(`拒绝分片上传离线包：声明体积 ${formatBytes(size)} 超过上限 ${maxMB} MB`);
      return fail(res, 413, `离线包 ${formatBytes(size)} 超过网页上传上限 ${maxMB} MB${tooLargeHint}`, 'ETOOLARGE');
    }
    cleanupBundleUploads();
    // 分片大小与并发路数都可由配置调整：并发太高反而抢带宽、分片太小则请求开销大
    const chunkMB = clamp(Number(cfg.storage.bundleUploadChunkMB) || 8, 1, 64);
    const chunkSize = Math.floor(chunkMB * 1024 * 1024);
    const chunkCount = Math.max(1, Math.ceil(size / chunkSize));
    const id = randomToken(16);
    const dir = path.join(rootPath('data', 'tmp'), `upload-${id}`);
    fs.mkdirSync(dir, { recursive: true });
    bundleUploads.set(id, {
      id, name, size, overwrite: body.overwrite === true, dir, chunkSize, chunkCount,
      parts: new Set(), bytes: 0, createdAt: Date.now(), assembling: false,
    });
    if (log) log.info(`开始分片上传离线包 ${name}（${formatBytes(size)}，${chunkCount} 片 × ${formatBytes(chunkSize)}）`);
    return ok(res, {
      uploadId: id, name, size, chunkSize, chunkCount,
      concurrency: clamp(Number(cfg.storage.bundleUploadConcurrency) || 4, 1, 64),
      maxSizeMB: maxMB,
    });
  }

  if (rel === '/bundles/upload/chunk' && method === 'POST') {
    const up = bundleUploads.get(String(q.get('uploadId') || ''));
    if (!up) return fail(res, 404, '上传会话不存在或已过期，请重新上传', 'ENOUP');
    const index = Number(q.get('index'));
    if (!Number.isInteger(index) || index < 0 || index >= up.chunkCount) {
      return fail(res, 400, `分片序号不合法（应为 0-${up.chunkCount - 1}）`, 'EBADCHUNK');
    }
    const expected = bundleUploadPartSize(up, index);
    const part = bundleUploadPartPath(up, index);
    // 网络抖动后浏览器会重试同一分片：已经完整落盘的直接成功，避免重复传输
    try {
      if (fs.statSync(part).size === expected) return ok(res, { index, size: expected, retried: true });
    } catch { /* 该分片还没传过 */ }
    if (up.assembling) return fail(res, 409, '上传已完成，正在合并分片', 'EBUSY');
    try {
      const { size } = await readBodyToFile(req, part, { maxBytes: expected, idleMs: 60000, totalMs: 600000 });
      if (size !== expected) {
        try { fs.unlinkSync(part); } catch { /* 忽略 */ }
        return fail(res, 400, `分片 ${index + 1}/${up.chunkCount} 大小不正确（收到 ${size} 字节，应为 ${expected} 字节）`, 'EBADCHUNK');
      }
      if (!up.parts.has(index)) { up.parts.add(index); up.bytes += expected; }
      return ok(res, { index, size, received: up.parts.size, total: up.chunkCount });
    } catch (e) {
      try { fs.unlinkSync(part); } catch { /* 忽略 */ }
      if (log) log.warn(`离线包分片 ${index + 1}/${up.chunkCount} 上传失败：${e.message}（${e.code || 'EUNKNOWN'}）`);
      return fail(res, e.status || 400, e.message, e.code || 'EBADCHUNK');
    }
  }

  if (rel === '/bundles/upload/complete' && method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const id = String(q.get('uploadId') || body.uploadId || '');
    const up = bundleUploads.get(id);
    if (!up) return fail(res, 404, '上传会话不存在或已过期，请重新上传', 'ENOUP');
    if (up.assembling) return fail(res, 409, '该上传已在合并分片', 'EBUSY');
    const missing = bundleUploadFirstMissing(up);
    if (missing >= 0) {
      return fail(res, 400, `分片不完整：缺少第 ${missing + 1}/${up.chunkCount} 片，请重试该分片`, 'EINCOMPLETE');
    }
    up.assembling = true;
    const overwrite = body.overwrite === true || up.overwrite;
    const wantProgress = q.get('progress') === '1' || q.get('progress') === 'true' || body.progress === true;
    const tempFile = tempFilePath(rootPath('data', 'tmp'), up.name);
    const cleanup = () => { try { fs.unlinkSync(tempFile); } catch { /* 忽略 */ } dropBundleUpload(up); };
    const assemble = async (update, isCanceled) => {
      update({ phase: 'assemble', bytes: 0, bytesTotal: up.size, current: up.name, message: `正在合并 ${up.chunkCount} 个上传分片…` });
      await assembleBundleUpload(up, tempFile, (copied) => update({ bytes: copied, bytesTotal: up.size }), isCanceled);
      update({ bytes: up.size, bytesTotal: up.size });
    };
    if (wantProgress) {
      const conc = Math.max(1, Number(cfg.storage.bundleImportConcurrency) || 4);
      const taskId = startBundleTask({
        type: 'bundle-import',
        title: `上传并导入离线包 · ${up.name}`,
        phase: 'assemble',
        total: 0,
        concurrency: conc,
        log,
        run: async (o) => {
          try {
            // 先合并分片（这一步也能取消），再把合并出的临时 .tgz 交给统一的导入流程
            await assemble(o.update, o.isCanceled);
            return await runBundleImportJob(ctx, { file: tempFile, overwrite, update: o.update, isCanceled: o.isCanceled });
          } finally {
            o.update({ inFlight: [] });
            cleanup();
          }
        },
      });
      return ok(res, { taskId, async: true, uploadId: id, name: up.name, size: up.size });
    }
    try {
      await assemble(() => {});
      const r = await runBundleImportJob(ctx, { file: tempFile, overwrite, update: () => {}, isCanceled: () => false });
      return ok(res, r);
    } catch (e) {
      return fail(res, 400, `导入失败：${e.message}`, e.code || 'EIMPORT');
    } finally {
      cleanup();
    }
  }

  if (rel === '/bundles/upload/abort' && method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const id = String(q.get('uploadId') || body.uploadId || '');
    const up = bundleUploads.get(id);
    if (up) {
      dropBundleUpload(up);
      if (log) log.warn(`已取消离线包上传：${up.name}`);
    }
    return ok(res, { uploadId: id, aborted: true });
  }

  if (rel === '/bundles/import' && method === 'POST') {
    let overwrite = q.get('overwrite') === '1' || q.get('overwrite') === 'true';
    let file = '';
    let temp = null;
    let wantProgress = q.get('progress') === '1' || q.get('progress') === 'true';
    const ctype = String(req.headers['content-type'] || '');
    if (ctype.includes('application/json')) {
      const body = await readJson(req);
      overwrite = body.overwrite === true || overwrite;
      if (body.progress === true) wantProgress = true;
      const name = path.basename(String(body.file || ''));
      if (!name) return fail(res, 400, '请提供 file 字段（离线包文件名）', 'EBADREQ');
      file = path.join(rootPath('data', 'bundles'), name);
      if (!fs.existsSync(file)) return fail(res, 404, `离线包不存在：${name}`, 'ENOENT');
    } else {
      // 原始体上传（网页里拖入/选择 bundle）：流式落盘，几个 GB 的整机备份也不会把内存撑爆。
      // 上限单独用 storage.maxBundleUploadMB（默认 4GB），与单包上传的 maxUploadMB 区分开。
      const maxMB = Math.max(1, Number(cfg.storage.maxBundleUploadMB || 4096));
      const maxBytes = maxMB * 1024 * 1024;
      const tooLargeHint = '；更大的离线包请把 .tgz 拷到 data/bundles 目录后刷新列表，'
        + '点表格里的「导入」按钮（或运行 一键导入离线包.cmd），这条路不受网页上传上限限制';
      const declared = Number(req.headers['content-length'] || 0);
      if (declared && declared > maxBytes) {
        // 声明体积已经超限：不必再接收几个 GB 才拒绝
        if (log) log.warn(`拒绝上传离线包：声明体积 ${formatBytes(declared)} 超过上限 ${maxMB} MB`);
        return fail(res, 413, `请求体过大（上限 ${maxMB} MB）${tooLargeHint}`, 'ETOOLARGE');
      }
      let filename = 'bundle.tgz';
      try {
        const raw = path.basename(decodeURIComponent(String(req.headers['x-filename'] || '')));
        if (raw) filename = raw;
      } catch { /* 文件名解码失败就用默认名 */ }
      temp = tempFilePath(rootPath('data', 'tmp'), filename);
      try {
        const { size } = await readBodyToFile(req, temp, { maxBytes, idleMs: 60000, totalMs: 1500000 });
        if (!size) {
          try { fs.unlinkSync(temp); } catch { /* 忽略 */ }
          temp = null;
          return fail(res, 400, '请求体为空', 'EBADREQ');
        }
        file = temp;
      } catch (e) {
        try { fs.unlinkSync(temp); } catch { /* 忽略 */ }
        temp = null;
        const hint = e.code === 'ETOOLARGE' ? tooLargeHint : '';
        if (log) log.warn(`上传离线包失败：${e.message}（${e.code || 'EUNKNOWN'}）`);
        return fail(res, e.status || 400, `${e.message}${hint}`, e.code || 'EBADREQ');
      }
    }
    // 临时文件与任务收敛统一交给 startOrRunBundleImport：同步/后台任务删文件时机一致
    return startOrRunBundleImport(ctx, {
      res,
      file,
      overwrite,
      tempFile: temp,
      wantProgress,
      title: `导入离线包 · ${path.basename(file)}`,
    });
  }

  if (rel === '/bundles/download' && method === 'GET') {
    const name = path.basename(String(q.get('file') || ''));
    const file = path.join(rootPath('data', 'bundles'), name);
    if (!name || !fs.existsSync(file)) return fail(res, 404, `离线包不存在：${name}`, 'ENOENT');
    return streamFile(res, file, { download: true, contentType: 'application/gzip' });
  }

  if (rel === '/bundles' && method === 'DELETE') {
    const name = path.basename(String(q.get('file') || ''));
    const file = path.join(rootPath('data', 'bundles'), name);
    if (!name || !fs.existsSync(file)) return fail(res, 404, `离线包不存在：${name}`, 'ENOENT');
    fs.unlinkSync(file);
    if (log) log.warn(`删除离线包 ${name}`);
    return ok(res, { file: name, deleted: true });
  }

  // ---------------- 配置 ----------------
  if (rel === '/config' && method === 'GET') {
    const config = require('./config');
    return ok(res, { config: config.publicConfig(q.get('reveal') === '1'), path: config.CONFIG_FILE, mode: cfg.mode });
  }

  if (rel === '/config' && method === 'PUT') {
    const config = require('./config');
    const body = await readJson(req);
    const patch = body && body.config ? body.config : body;
    const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    const bad = (msg) => fail(res, 400, msg, 'EBADCFG');
    if (!isPlain(patch)) return bad('配置内容不合法：必须是对象');
    // 分段字段必须是对象；否则 save() 虽会忽略，但这里提前报错，界面能及时提示
    for (const k of ['server', 'upstream', 'security', 'storage', 'log', 'ui']) {
      if (patch[k] !== undefined && !isPlain(patch[k])) return bad(`配置项 ${k} 必须是对象`);
    }
    if (patch.mode !== undefined && !['cache', 'proxy', 'offline'].includes(String(patch.mode))) {
      return bad('运行模式不合法（可选 cache / proxy / offline）');
    }
    if (patch.server) {
      const s = patch.server;
      if (s.ip !== undefined) {
        if (typeof s.ip !== 'string') return bad('server.ip 必须是字符串');
        const ip = s.ip.trim();
        // 空串（自动）与 0.0.0.0 / ::（监听所有网卡）合法；其余必须是真正的 IP，避免写进配置后启动失败
        if (ip !== '' && ip !== '0.0.0.0' && ip !== '::' && !net.isIP(ip)) {
          return bad('server.ip 必须是合法的 IP 地址（如 127.0.0.1；0.0.0.0 / :: 表示监听所有网卡）');
        }
        s.ip = ip;
      }
      if (s.port !== undefined) {
        const p = Number(s.port);
        if (!Number.isInteger(p) || p < 1 || p > 65535) return bad('server.port 必须是 1-65535 的整数');
      }
      if (s.openBrowserOnStart !== undefined && typeof s.openBrowserOnStart !== 'boolean') return bad('server.openBrowserOnStart 必须是布尔值');
    }
    if (patch.upstream) {
      const u = patch.upstream;
      if (u.registry !== undefined && !/^https?:\/\//i.test(String(u.registry))) return bad('upstream.registry 必须是 http(s) 地址');
      for (const k of ['timeoutMs', 'retries', 'metadataTtlSec', 'concurrency']) {
        if (u[k] !== undefined && !Number.isFinite(Number(u[k]))) return bad(`upstream.${k} 必须是数字`);
      }
    }
    if (patch.security) {
      const s = patch.security;
      // 令牌只能走 POST /token/regenerate（rotateToken 是唯一允许改 token 的入口），这里显式拒绝
      if (s.token !== undefined) return bad('令牌不允许通过配置接口修改，请使用「重置令牌」功能');
      const SEC_KEYS = ['requirePublish', 'requireRead', 'trustLocalhost', 'username'];
      for (const k of ['requirePublish', 'requireRead', 'trustLocalhost']) {
        if (s[k] !== undefined && typeof s[k] !== 'boolean') return bad(`security.${k} 必须是布尔值`);
      }
      if (s.username !== undefined && (typeof s.username !== 'string' || !s.username.trim())) return bad('security.username 必须是非空字符串');
      const unknown = Object.keys(s).filter(k => !SEC_KEYS.includes(k));
      if (unknown.length) return bad(`不支持的安全配置项：${unknown.join(', ')}`);
    }
    if (patch.storage) {
      const st = patch.storage;
      if (st.maxUploadMB !== undefined) {
        const m = Number(st.maxUploadMB);
        if (!Number.isInteger(m) || m < 1 || m > 4096) return bad('storage.maxUploadMB 必须是 1-4096 的整数');
      }
      if (st.maxBundleUploadMB !== undefined) {
        const m = Number(st.maxBundleUploadMB);
        if (!Number.isInteger(m) || m < 1 || m > 65536) return bad('storage.maxBundleUploadMB 必须是 1-65536 的整数');
      }
      // 分片上传：每片大小（MB）1-64；导出/导入/解包/分片上传的并发路数统一 1-64（给 32 核 64 线程档留余量）
      if (st.bundleUploadChunkMB !== undefined) {
        const m = Number(st.bundleUploadChunkMB);
        if (!Number.isInteger(m) || m < 1 || m > 64) return bad('storage.bundleUploadChunkMB 必须是 1-64 的整数（每片 MB 数）');
      }
      for (const k of ['bundleExportConcurrency', 'bundleImportConcurrency', 'bundleImportExtractConcurrency', 'bundleUploadConcurrency', 'localScanConcurrency']) {
        if (st[k] !== undefined) {
          const n = Number(st[k]);
          if (!Number.isInteger(n) || n < 1 || n > 64) return bad(`storage.${k} 必须是 1-64 的整数`);
        }
      }
      if (st.dir !== undefined) {
        if (typeof st.dir !== 'string') return bad('storage.dir 必须是字符串');
        const dir = st.dir.trim();
        if (!dir) return bad('storage.dir 不能为空');
        if (dir.includes('\0')) return bad('storage.dir 不能包含空字节');
        let abs;
        try { abs = path.resolve(dir); } catch { return bad('storage.dir 不是合法的路径'); }
        // 拒绝磁盘根（C:\ / D:\ / \\server\share\ 等）：包目录若落在根上，后续清理/迁移非常危险
        if (abs.toLowerCase() === path.parse(abs).root.toLowerCase()) {
          return bad('storage.dir 不能是磁盘根目录');
        }
        st.dir = dir;
      }
    }
    if (patch.log) {
      if (patch.log.level !== undefined && !['debug', 'info', 'warn', 'error'].includes(String(patch.log.level))) {
        return bad('log.level 不合法（可选 debug / info / warn / error）');
      }
      if (patch.log.maxDays !== undefined && !Number.isFinite(Number(patch.log.maxDays))) return bad('log.maxDays 必须是数字');
    }
    // security.token 不在这里处理：config.save() 会忽略它，令牌只能通过 POST /token/regenerate 轮换。
    // 因此传什么令牌值都不影响现有令牌，也不报错（避免把「改令牌」误当成配置保存成功）。
    const before = config.get();
    const after = config.save(patch);
    if (log) { log.level = after.log.level; log.info('配置已更新'); }
    ctx.state.upstreamCheck = null;   // 上游可能变了，重新探测
    const restartRequired = config.requiresRestart(before, after);
    ctx.state.restartRequired = restartRequired;
    return ok(res, { config: config.publicConfig(false), restartRequired, requiresRestart: restartRequired });
  }

  if (rel === '/token/regenerate' && method === 'POST') {
    const config = require('./config');
    // 必须走专用入口：config.save() 会丢弃 security.token，直接用 save 会导致「界面显示新令牌、实际仍是旧令牌」
    const token = config.rotateToken();
    if (log) log.warn('管理令牌已重新生成，旧令牌立即失效');
    return ok(res, { token });
  }

  // ---------------- npm 缓存（离线补包） ----------------
  /** 给扫描结果补上「镜像里是否已有这个包」，界面上的「本地已有 / 可导入」徽标和「仅导入不存在的包」都靠它 */
  function withLocalFlags(r) {
    if (!r || !Array.isArray(r.packages)) return r;
    const pkgs = r.packages.map(p => ({ ...p, local: store.index.has(p.name) }));
    return { ...r, packages: pkgs, localCount: pkgs.filter(p => p.local).length };
  }

  // 注意（设计如此，暂不改）：即使 GET 也可能真正扫描本机 npm 缓存（refresh=1 或首次），
  // 扫描时会同步读取/解析磁盘缓存，大缓存下会短暂阻塞事件循环；结果只写内存 lastScan，
  // 不改用户数据。若以后要长期跑在慢磁盘上，应考虑改成后台任务 + 进度查询。
  if (rel === '/npmcache/scan' && (method === 'GET' || method === 'POST')) {
    const refresh = q.get('refresh') === '1' || method === 'POST';
    const cacheDir = ctx.npmcache.resolveCacheDir(q.get('cacheDir') || ctx.npmcache.defaultCacheDir());
    if (!refresh) {
      const cached = ctx.npmcache.lastScan();
      if (cached && cached.cacheDir === cacheDir) return ok(res, { ...withLocalFlags(cached), cached: true });
    }
    try {
      const r = await ctx.npmcache.scanCache({
        cacheDir,
        registry: cfg.upstream.registry,
        anyRegistry: q.get('anyRegistry') === '1',
        logger: log,
        // 扫描 npm 缓存时的读盘并发（原来逐文件串行读，几十万个文件时很慢）
        concurrency: localScanConcurrency(cfg),
      });
      return ok(res, { ...withLocalFlags(r), cached: false });
    } catch (e) {
      return fail(res, e.code === 'NO_CACHE' ? 404 : 500, e.message, e.code || 'ESCAN');
    }
  }

  if (rel === '/npmcache/import' && method === 'POST') {
    const body = await readJson(req);
    const names = Array.isArray(body.names) ? body.names : [];
    if (!names.length && body.all !== true) return fail(res, 400, '请提供 names 数组，或设置 all:true 导入全部', 'EBADREQ');
    if (body.all === true && names.length === 0 && body.confirm !== true) {
      return fail(res, 409, '全量导入可能非常耗时并占用大量磁盘，请再次确认（confirm:true）', 'ECONFIRM');
    }
    const cacheDir = ctx.npmcache.resolveCacheDir(body.cacheDir || ctx.npmcache.defaultCacheDir());
    const importOpts = {
      store,
      cacheDir,
      names,
      all: body.all === true,
      overwrite: body.overwrite === true,
      onlyWithTarball: body.onlyWithTarball !== false,
      logger: log,
      // 导入 npm 缓存时的包级并发（原来逐包串行；每个包只锁自己，跨包可并行）
      concurrency: localScanConcurrency(cfg),
    };
    /* progress:true —— 长任务模式：立即返回 taskId，界面用 /tasks/<id> 轮询
     * 「整体进度 + 正在导入的包 + 逐包导入详情」。默认（不带该参数）仍是同步返回结果，兼容命令行/旧调用。 */
    if (body.progress === true) {
      const cached = ctx.npmcache.lastScan();
      const scanOk = !!(cached && cached.cacheDir === ctx.npmcache.resolveCacheDir(cacheDir));
      const total = body.all === true ? (scanOk ? cached.packages.length : 0) : names.length;
      const task = tasks.create({
        type: 'cache-import',
        title: `缓存导入 · ${total ? Number(total).toLocaleString('en-US') : '?'} 个包`,
        total,
        concurrency: 1,
        phase: 'import',
      });
      const pkgs = [];
      const s = { done: 0, total, ok: 0, failed: 0, skipped: 0, bytes: 0, versions: 0, tarballs: 0 };
      const pushPkg = (info) => {
        const entry = {
          name: info.name,
          status: info.status,
          versions: info.versions || 0,
          tarballs: info.tarballs || 0,
          sizeBytes: info.sizeBytes || 0,
          reason: info.reason || '',
          error: info.error || '',
        };
        const at = pkgs.findIndex(p => p.name === entry.name);
        if (at >= 0) pkgs[at] = entry; else pkgs.push(entry);
        s.done = Number(info.done) || s.done;
        s.total = Number(info.total) || s.total;
        s.ok = pkgs.filter(p => p.status === 'imported').length;
        s.failed = pkgs.filter(p => p.status === 'failed').length;
        s.skipped = pkgs.filter(p => p.status === 'skipped').length;
        s.bytes = pkgs.reduce((a, p) => a + (p.sizeBytes || 0), 0);
        s.versions = pkgs.reduce((a, p) => a + (p.versions || 0), 0);
        s.tarballs = pkgs.reduce((a, p) => a + (p.tarballs || 0), 0);
        /* 保留刚处理完的包作为「当前包」（进度停在 100%），不要清空：
         * 缓存导入每个包都在毫秒级完成，前端 500ms 轮询时几乎总是落在两个包之间，
         * 一清空右栏就永远空着。下一个包开始时会被 start 事件覆盖。 */
        const prev = tasks.get(task.id) || {};
        const lastTotal = Number(prev.currentTotal) || 0;
        tasks.update(task.id, {
          done: s.done, total: s.total, ok: s.ok, failed: s.failed, skipped: s.skipped,
          bytes: s.bytes, versions: s.versions, tarballs: s.tarballs,
          packages: pkgs, current: info.name, currentDone: lastTotal, currentTotal: lastTotal,
          errors: pkgs.filter(p => p.status === 'failed').slice(-50).map(p => ({ name: p.name, error: p.error })),
        });
      };
      /* 后台跑：任务进度写进 tasks，前端轮询；失败/取消都收敛成终态，避免任务一直挂 running */
      (async () => {
        try {
          const r = await ctx.npmcache.importFromCache(Object.assign({}, importOpts, {
            onProgress: (info) => {
              if (info.phase === 'start') {
                tasks.update(task.id, {
                  total: Number(info.total) || task.total,
                  current: info.name, currentDone: 0, currentTotal: Number(info.versionTotal) || 0,
                });
                return;
              }
              if (info.phase === 'version') {
                tasks.update(task.id, {
                  current: info.name,
                  currentDone: Number(info.versionDone) || 0,
                  currentTotal: Number(info.versionTotal) || 0,
                });
                return;
              }
              pushPkg(info);
            },
            isCanceled: () => {
              const t = tasks.get(task.id);
              return !!(t && t.cancelRequested);
            },
          }));
          tasks.finish(task.id, { status: r.canceled ? 'canceled' : 'done', result: r });
          if (log) log.info(`缓存导入任务结束：成功 ${r.imported.length} 个包 / ${r.tarballs} 个 tarball，失败 ${r.failed.length}，跳过 ${r.skipped.length}${r.canceled ? '（已取消）' : ''}`);
        } catch (e) {
          tasks.finish(task.id, { status: 'error', message: (e && e.message) || String(e) });
          if (log) log.error(`缓存导入任务失败：${(e && e.message) || e}`);
        }
      })();
      return ok(res, { taskId: task.id, async: true, total });
    }
    try {
      const r = await ctx.npmcache.importFromCache(importOpts);
      return ok(res, r);
    } catch (e) {
      return fail(res, e.code === 'NO_CACHE' ? 404 : 500, e.message, e.code || 'EIMPORT');
    }
  }

  // ---------------- 日志 ----------------
  if (rel === '/logs' && method === 'GET') {
    const lines = Math.min(2000, Math.max(10, Number(q.get('lines')) || 200));
    const level = q.get('level') || 'debug';
    const t = log.tail(lines, level);
    return ok(res, { ...t, sizeBytesText: formatBytes(t.sizeBytes), recent: log.recent(200).map(parseLevelLine) });
  }

  if (rel === '/logs' && method === 'DELETE') {
    log.clear();
    log.warn('日志已清空');
    return ok(res, { cleared: true });
  }

  // ---------------- 生成 .npmrc ----------------
  if (rel === '/npmrc' && method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    // 只保留单行安全内容：ip / token 都会被拼进 .npmrc 文本，混入 \r\n 可注入额外的 npm 配置行
    const clean = (v) => String(v == null ? '' : v).replace(/[\r\n]/g, '').trim();
    let ip = clean(body.ip) || clean(cfg.server.ip) || '127.0.0.1';
    if (ip === '0.0.0.0' || ip === '::') ip = '127.0.0.1';
    if (!net.isIP(ip)) ip = '127.0.0.1';
    const port = Number(body.port || cfg.server.port || 4873);
    const safePort = Number.isInteger(port) && port > 0 && port < 65536 ? port : 4873;
    const host = ip.includes(':') ? `[${ip}]:${safePort}` : `${ip}:${safePort}`;
    const registry = `http://${host}/`;
    // body.token：字符串=自定义令牌；false=不写鉴权行；true/缺省=使用服务端当前令牌
    const wantToken = body.token !== false;
    let token = '';
    if (wantToken) {
      const custom = typeof body.token === 'string' ? clean(body.token) : '';
      token = /^[A-Za-z0-9_-]+$/.test(custom) ? custom : clean(cfg.security.token);
      if (!/^[A-Za-z0-9_-]+$/.test(token)) token = '';   // 配置里的令牌异常时宁可不写，也不拼进文本
    }
    const npmrcLines = [`registry=${registry}`];
    const projectLines = [`registry=${registry}`];
    if (token) {
      npmrcLines.push(`//${host}/:_authToken=${token}`);
      projectLines.push(`//${host}/:_authToken=${token}`);
    }
    npmrcLines.push('always-auth=true', '');
    projectLines.push('');
    const npmrc = npmrcLines.join('\n');
    const projectNpmrc = projectLines.join('\n');
    const commands = [
      `npm config set registry ${registry}`,
      ...(token ? [`npm config set //${host}/:_authToken ${token}`] : []),
      `npm config set always-auth true`,
      `# 只给单个项目用（不写全局配置）：在项目目录建 .npmrc，内容见下方`,
      `# 临时使用：npm install <包名> --registry=${registry}`,
      `# 发布私有包：npm publish --registry=${registry}`,
      `# 恢复公共源：npm config set registry ${cfg.upstream.registry}`,
      ...(token ? [`# 取消令牌：npm config delete //${host}/:_authToken`] : []),
    ];
    return ok(res, { registry, host, token, tokenEnabled: !!token, npmrc, commands, projectNpmrc, restore: `npm config set registry ${cfg.upstream.registry}` });
  }

  // ---------------- 服务控制 ----------------
  if (rel === '/service/shutdown' && method === 'POST') {
    if (log) log.warn('收到停止指令，服务即将退出');
    sendJson(res, 200, { ok: true, data: { stopping: true } });
    setTimeout(() => ctx.requestShutdown(), 200);
    return true;
  }

  if (rel === '/service/restart' && method === 'POST') {
    const config = require('./config');
    const c = config.get();
    // 先确认端口可用，避免重启后起不来。
    // 注意：若目标地址与当前监听地址相同，端口当然被自己占用，此时必须跳过预检。
    const net = require('node:net');
    const sameAsCurrent = String(c.server.ip) === String(ctx.listenIp) && Number(c.server.port) === Number(ctx.listenPort);
    if (!sameAsCurrent) {
      const canBind = await new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => srv.close(() => resolve(true)));
        try { srv.listen(c.server.port, c.server.ip === '0.0.0.0' ? undefined : c.server.ip); } catch { resolve(false); }
      });
      if (!canBind) return fail(res, 409, `端口 ${c.server.port} 当前被占用，请先修改端口或关闭占用进程`, 'EADDRINUSE');
    }
    if (log) log.warn('收到重启指令，正在重启服务');
    sendJson(res, 200, { ok: true, data: { restarting: true } });
    setTimeout(() => ctx.requestRestart(), 200);
    return true;
  }

  return fail(res, 404, `未知的管理接口：${method} ${pathname}`, 'ENOTFOUND');
}

module.exports = { handleAdmin, API, parsePackageRoute };
