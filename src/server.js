'use strict';
/*
 * HTTP 服务（双监听）：
 *   1) 镜像源监听（server.ip:server.port）——只提供 npm 注册表协议与 /-/ping 等只读探针，
 *      不再暴露管理界面与管理 API（局域网只能当 npm 源用）。
 *   2) 管理界面监听（admin.ip:admin.port）——只允许 127.0.0.0/8 本地回环地址，只有本机能访问；
 *      提供管理页面静态资源与 /__admin/api/* 管理接口。
 * 两个监听各自独立，可以在管理界面里分别「重启镜像源服务」「重启管理界面」，互不打断。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const util = require('./util');
const loggerMod = require('./logger');
const config = require('./config');
const { Store } = require('./store');
const { Upstream } = require('./upstream');
const { makeAuth } = require('./auth');
const bundle = require('./bundle');
const npmcache = require('./npmcache');
const registry = require('./registry');
const Hu = require('./http-util');
const { handleAdmin, API } = require('./api');
const consoleMod = require('./console');
const { DesktopHost } = require('./desktop');
const desktopScripts = require('./desktop-scripts');

const PUBLIC_DIR = util.rootPath('public');
/** 桌面版：Rust（Tauri 外壳）拉起本进程，stdin/stdout 是行协议桥，网页从内部回环端口加载 */
const DESKTOP = util.isDesktop();
const VERSION = (() => { try { return require('../package.json').version; } catch { return '1.0.0'; } })();

const MODE_TEXT = {
  cache: 'cache（本地优先，未命中时回源并缓存）',
  proxy: 'proxy（元数据按 TTL 回源刷新，tarball 按需缓存）',
  offline: 'offline（纯离线，禁止访问外网）',
};

/* v0.0.7：桌面窗口内部管理监听的令牌门禁。
 * 内部回环端口（127.0.0.1:随机）承载 GUI 页面与管理 API，但浏览器也能猜到/扫到端口；
 * 因此每次内部监听启动/重启都生成一次性随机令牌：外壳用 ?__mirror_token=<令牌> 完成首访，
 * 之后靠 HttpOnly + SameSite=Strict 的 Cookie 通行；浏览器直接访问一律 403 且不返回任何数据。 */
const GUI_TOKEN_PARAM = '__mirror_token';
const GUI_TOKEN_COOKIE = 'mirror_gui_token';
const GUI_TOKEN_DENY_TEXT = '该端口仅供桌面程序窗口内部使用，浏览器无法直接访问。';

/** 镜像源服务探测超时与缓存（session 每 1 秒轮询一次，多个标签页同时轮询时避免重复探测） */
const PROBE_TIMEOUT_MS = 800;
const PROBE_CACHE_MS = 600;

function applyCliOverrides(cfg, opts) {
  let changed = false;
  if (opts.ip) { cfg.server.ip = String(opts.ip); changed = true; }
  if (opts.port) { cfg.server.port = Number(opts.port); changed = true; }
  if (opts.mode) { cfg.mode = String(opts.mode); changed = true; }
  if (opts.registry) { cfg.upstream.registry = String(opts.registry); changed = true; }
  // 注意：--no-open 只影响本次启动是否打开浏览器，绝不能写回配置对象，
  // 否则用户在管理界面保存任意配置时会把 openBrowserOnStart 永久改成 false。
  return changed;
}

function listenErrorMessage(e, ip, port, label) {
  if (e.code === 'EADDRINUSE') return `${label}端口 ${port} 已被占用。请关闭占用该端口的程序，或修改 data/config.json 里的端口后重试。`;
  if (e.code === 'EACCES') return `没有权限监听${label} ${ip}:${port}（端口 <1024 需要管理员权限，建议改用 1024 以上端口）。`;
  return `${label}监听 ${ip}:${port} 失败：${e.message || e.code || '未知错误'}`;
}

async function createServer({ cliOpts = {} } = {}) {
  if (Object.keys(cliOpts).length) applyCliOverrides(config.get(), cliOpts);

  // 桌面版：先建运行控制台环形缓冲，再初始化 logger（logger 输出到控制台的行会同步进缓冲）
  if (DESKTOP) consoleMod.init({ max: 3000 });

  const cfg0 = config.get();
  const log = loggerMod.init({ dir: config.logsDir(), level: cfg0.log.level, maxDays: cfg0.log.maxDays, console: true });
  const store = new Store({ dir: config.storageDir(), logger: log });
  // 启动前并发加载索引：原来 1500+ 个包逐个同步读 meta.json，监听端口前要多等几百毫秒
  await store.initAsync();

  let stopping = false;

  // ---------------- 监听状态（镜像源监听 / 管理界面监听各自独立） ----------------
  let registryServer = null;
  let adminServer = null;
  let registryIp = config.get().server.ip;
  let registryPort = config.get().server.port;
  let adminIp = config.get().admin.ip;
  let adminPort = config.get().admin.port;
  let registryStartedAt = Date.now();   // 镜像源监听实例的创建时间（每次重置监听都会更新）
  let adminStartedAt = Date.now();      // 管理界面监听实例的创建时间（每次重启管理界面都会更新）
  let adminListenError = '';            // 管理界面监听失败原因（镜像源服务继续可用）

  // 桌面版：内部管理监听（127.0.0.1:0 随机端口）承载 GUI 页面与管理 API，始终存在；
  // adminServer 在桌面版只表示「网页版管理」监听（cfg.admin.enabled=true 时才绑定）。
  let internalServer = null;
  let internalIp = '127.0.0.1';
  let internalPort = 0;
  let internalToken = '';          // 内部管理监听的一次性随机令牌（只交给外壳；绝不写日志/绝不经 API 暴露）
  let internalRestarting = null;   // 「重启窗口的管理界面」进行中的 Promise（并发调用共享结果）

  const state = {
    startedAt: Date.now(),
    version: VERSION,
    upstreamCheck: null,
    restartRequired: false,
    requestCount: 0,
    bundleManifests: new Map(),
    listenIp: registryIp,
    listenPort: registryPort,
  };

  // ---------------- 镜像源服务探测 ----------------
  // 管理界面在「服务」页与顶栏显示镜像源服务是否可用：由后端从本机发一个 /-/ping 探测，
  // 页面只跟管理界面通信（CSP connect-src 'self' 禁止跨端口请求）。
  let probeCache = { at: 0, value: null };
  function probeRegistry() {
    const now = Date.now();
    if (probeCache.value && now - probeCache.at < PROBE_CACHE_MS) return Promise.resolve(probeCache.value);
    const host = Hu.urlHost(registryIp);
    const target = `http://${host.includes(':') ? `[${host}]` : host}:${registryPort}/-/ping`;
    const t0 = Date.now();
    return new Promise((resolve) => {
      let finished = false;
      const done = (value) => {
        if (finished) return;
        finished = true;
        probeCache = { at: Date.now(), value };
        resolve(value);
      };
      let req = null;
      try {
        req = http.get(target, { timeout: PROBE_TIMEOUT_MS }, (probeRes) => {
          probeRes.resume();
          done({ reachable: true, latencyMs: Date.now() - t0, checkedAt: new Date().toISOString(), target, error: '' });
        });
      } catch (e) {
        done({ reachable: false, latencyMs: null, checkedAt: new Date().toISOString(), target, error: e.message || '探测失败' });
        return;
      }
      req.on('timeout', () => { try { req.destroy(new Error('探测超时')); } catch { /* 忽略 */ } });
      req.on('error', (e) => {
        const msg = e.code === 'ECONNREFUSED'
          ? '连接被拒绝（镜像源服务未监听）'
          : e.code === 'ETIMEDOUT' ? '探测超时' : (e.message || '探测失败');
        done({ reachable: false, latencyMs: null, checkedAt: new Date().toISOString(), target, error: msg });
      });
    });
  }

  const ctx = {
    cfg: () => config.get(),
    store,
    upstream: new Upstream(() => config.get(), log),
    auth: makeAuth(() => config.get()),
    log,
    bundle,
    npmcache,
    registry,
    state,
    get listenIp() { return registryIp; },
    get listenPort() { return registryPort; },
    get registryListenIp() { return registryIp; },
    get registryListenPort() { return registryPort; },
    get adminListenIp() { return adminIp; },
    get adminListenPort() { return adminPort; },
    get adminListenError() { return adminListenError; },
    get registryStartedAt() { return registryStartedAt; },
    get adminStartedAt() { return adminStartedAt; },
    get registryUrl() { return Hu.registryUrl(config.get()); },
    // 管理界面地址：非桌面 = admin.ip:admin.port（旧语义，保持不变）；桌面 = 网页版开启时用其地址，否则内部回环端口
    get adminUrl() { return webAdminUrl(); },
    desktop: DESKTOP,
    desktopHost: null,                        // DesktopHost（仅桌面模式，ctx 建好后赋值）
    scripts: DESKTOP ? desktopScripts : null, // 一键脚本（仅桌面模式暴露给 API）
    get internalAdminIp() { return internalIp; },
    get internalAdminPort() { return internalPort; },
    internalGuiUrl,
    restartInternalAdmin,
    webAdminEnabled,
    webAdminUrl,
    webAdminState,
    rebindWebAdmin,
    restartRegistry,
    clientIp: Hu.clientIp,
    probeRegistry,
    requestShutdown,
    requestRestart,
    requestRestartRegistry,
    requestRestartAdmin,
  };

  // 桌面版宿主：行协议桥 + 托盘/外壳动作代理 + 运行控制台。非桌面模式完全不创建，保持旧行为。
  if (DESKTOP) {
    const host = new DesktopHost({
      version: VERSION,
      getCtx: () => ctx,
      // Rust 关闭 stdin（正常退出/外壳崩溃）时优雅退出，避免变成孤儿进程
      onBridgeClose: () => requestShutdown(),
    });
    ctx.desktopHost = host;
    host.start();
  }

  // ---------------- 请求分发 ----------------
  const STATIC_EXT = new Set(['.html', '.js', '.mjs', '.css', '.map', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.woff', '.woff2', '.ttf']);
  function serveStatic(req, res, pathname) {
    // 项目图标（public/favicon.ico，网页标签页与 Windows 托盘共用）：有就正常返回，没有才回 204
    if (pathname === '/favicon.ico') {
      let hasIcon = false;
      try { hasIcon = fs.statSync(path.join(PUBLIC_DIR, 'favicon.ico')).isFile(); } catch { hasIcon = false; }
      if (!hasIcon) { res.writeHead(204); return res.end(); }
    }
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    try { rel = decodeURIComponent(rel); } catch { /* 保持原样 */ }
    // 去掉盘符/前导分隔符，再用 path.relative 做真正的包含校验（前缀 startsWith 在兄弟目录名同前缀时会被绕过）
    rel = rel.replace(/^[/\\]+/, '');
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    const relToPublic = path.relative(PUBLIC_DIR, file);
    if (!relToPublic || relToPublic.startsWith('..') || path.isAbsolute(relToPublic)) {
      return Hu.fail(res, 403, '非法路径', 'EPATH');
    }
    if (!STATIC_EXT.has(path.extname(file).toLowerCase())) return Hu.fail(res, 403, '非法路径', 'EPATH');
    let st = null;
    try { st = fs.statSync(file); } catch { st = null; }
    if (!st || !st.isFile()) return Hu.sendText(res, 404, '页面不存在：' + pathname);
    if (path.extname(file).toLowerCase() === '.html') {
      // 管理页面的 CSP：只允许同源资源（页面本身不使用内联脚本/外链）
      try {
        res.setHeader('content-security-policy',
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        res.setHeader('x-frame-options', 'DENY');
      } catch { /* 忽略 */ }
    }
    return Hu.streamFile(res, file, { cache: 'no-cache' });
  }

  /** 管理界面页面路径（仅这些路径在管理界面上提供静态文件） */
  function isAdminPagePath(pathname) {
    return pathname === '/' || pathname === '/index.html' || pathname === '/app.js' ||
      pathname === '/style.css' || pathname === '/favicon.ico' || /^\/(assets|static)\//.test(pathname);
  }

  // ---------------- 桌面版：内部管理监听令牌门禁 ----------------

  /** 生成内部管理监听令牌：crypto 32 字节随机 → 64 位十六进制（每次内部监听启动/重启都重新生成） */
  function newInternalToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  /** 定时安全地比较令牌（先 sha256 定长，避免长度差异导致提前返回） */
  function internalTokenMatches(candidate) {
    if (!internalToken || typeof candidate !== 'string' || !candidate) return false;
    const a = crypto.createHash('sha256').update(candidate, 'utf8').digest();
    const b = crypto.createHash('sha256').update(internalToken, 'utf8').digest();
    return crypto.timingSafeEqual(a, b);
  }

  /** 从请求 Cookie 头读取内部窗口令牌 */
  function internalCookieToken(req) {
    const raw = req.headers && req.headers.cookie;
    if (!raw) return '';
    for (const part of String(raw).split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() !== GUI_TOKEN_COOKIE) continue;
      let v = part.slice(i + 1).trim();
      if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      return v;
    }
    return '';
  }

  /** 内部监听门禁拒绝：页面回纯文本 403，管理 API 回 JSON 403（都不返回任何页面/数据） */
  function denyInternalGui(res, url) {
    try { res.setHeader('cache-control', 'no-store'); } catch { /* 忽略 */ }
    if (url.pathname === API || url.pathname.startsWith(`${API}/`)) {
      return Hu.fail(res, 403, GUI_TOKEN_DENY_TEXT, 'EGUIINTERNAL');
    }
    return Hu.sendText(res, 403, `${GUI_TOKEN_DENY_TEXT}\n请通过桌面程序窗口访问管理界面。`);
  }

  /**
   * 内部管理监听门禁（仅桌面版窗口使用的监听）：
   *  - 首访带 ?__mirror_token=<正确令牌>：种 HttpOnly + SameSite=Strict Cookie → 302 到去掉 query 的同一地址；
   *  - 令牌错误：403；
   *  - 没有 Cookie / Cookie 不匹配：403（页面与 API 一律不返回数据）。
   * 返回 true 表示已响应（调用方直接 return），false 表示放行。
   */
  function internalGuiGate(req, res, url) {
    const supplied = url.searchParams.get(GUI_TOKEN_PARAM);
    if (supplied !== null) {
      if (!internalTokenMatches(supplied)) { denyInternalGui(res, url); return true; }
      try {
        res.setHeader('cache-control', 'no-store');
        res.writeHead(302, {
          location: url.pathname || '/',
          'set-cookie': `${GUI_TOKEN_COOKIE}=${internalToken}; HttpOnly; SameSite=Strict; Path=/`,
        });
        res.end();
      } catch { try { res.destroy(); } catch { /* 忽略 */ } }
      return true;
    }
    if (internalTokenMatches(internalCookieToken(req))) return false;
    denyInternalGui(res, url);
    return true;
  }

  async function handle(req, res, isAdmin, isInternal) {
    const t0 = Date.now();
    let status = 200;
    const rawWriteHead = res.writeHead.bind(res);
    res.writeHead = (code, ...rest) => { status = code; return rawWriteHead(code, ...rest); };
    // 安全响应头：管理界面不允许被任意站点 iframe 嵌套（防点击劫持），并禁止 MIME 嗅探
    try {
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('referrer-policy', 'no-referrer');
    } catch { /* 忽略 */ }
    if (req.method === 'HEAD') {
      // HEAD 只回响应头：屏蔽 body 写入
      res.write = () => true;
      const rawEnd = res.end.bind(res);
      res.end = () => rawEnd();
    }

    let url = null;
    try { url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`); }
    catch { return Hu.fail(res, 400, '非法的请求地址', 'EURL'); }
    const pathname = url.pathname;
    // 每个请求一份视图，req/res/url/method 挂在自己身上，其余能力沿原型链共享
    const rctx = Object.create(ctx);
    rctx.req = req; rctx.res = res; rctx.url = url; rctx.method = req.method; rctx.pathname = pathname;
    rctx.isAdminListener = !!isAdmin;
    rctx.isInternalListener = !!isInternal;

    try {
      // 桌面窗口内部的 GUI 管理监听：浏览器直接访问必须先过令牌门禁（页面/静态资源/管理 API 全部适用）
      if (isInternal && internalGuiGate(req, res, url)) return;

      if (pathname === API || pathname.startsWith(`${API}/`)) {
        // 管理 API 只在独立的管理界面监听上提供。镜像源监听即使带令牌也不提供，
        // 这样局域网里即使有人扫到镜像源端口，也拿不到管理接口。
        if (!isAdmin) {
          return Hu.fail(res, 403, `管理接口只在本机管理界面上提供，请访问 ${ctx.adminUrl}/`, 'EADMINONLY');
        }
        if (!Hu.hostAllowed(req, config.get())) {
          return Hu.fail(res, 403, 'Host 校验失败：只允许通过本机或已绑定的地址访问管理界面', 'EHOST');
        }
        if (!Hu.originAllowed(req)) return Hu.fail(res, 403, '跨站来源被拒绝', 'EORIGIN');
        const isSession = pathname.replace(/\/+$/, '') === `${API}/session`;
        const auth = ctx.auth.check(req, url);
        // anonymous 表示「既没带令牌、也不是本机回环」：即使 requirePublish/requireRead 关闭，
        // 管理接口也绝不允许匿名访问（否则局域网任何人可删包/改配置/拿令牌）。
        if (!isSession && (!auth.ok || auth.anonymous)) {
          return Hu.fail(res, 401, '需要管理令牌：请在页面上填入令牌（令牌见 data/config.json 的 security.token；本机访问可直接在地址后加 ?token=<令牌>）', 'EAUTH');
        }
        state.requestCount++;
        await handleAdmin(rctx);
        return;
      }

      if (isAdmin) {
        // 管理界面监听只提供管理页面与 API，不代理 npm 注册表请求
        if (isAdminPagePath(pathname)) return serveStatic(req, res, pathname);
        return Hu.sendText(res, 404, `管理界面不提供该路径：${pathname}`);
      }

      // 镜像源监听不再暴露管理界面：本机浏览器打开镜像源地址时友好地跳到管理界面，
      // 局域网访问者只看到「管理界面仅限本机访问」的提示（不会泄露管理页面）。
      if (isAdminPagePath(pathname)) {
        if (util.isLoopback(req.socket && req.socket.remoteAddress)) {
          res.writeHead(302, { location: `${ctx.adminUrl}/` });
          return res.end();
        }
        return Hu.sendText(res, 403, `管理界面仅限本机访问（${ctx.adminUrl}/）。这里提供的是 npm 镜像源，请把客户端 npm 源配置为 ${ctx.registryUrl}/。`);
      }

      // 写操作（发布/取消发布/dist-tag 等）同样要做跨站来源校验：
      // 浏览器跨站页面会带 Origin，npm/curl 等命令行客户端不会。这样本地网页无法借浏览器
      // 直接 POST 到镜像源端口发布恶意包（CSRF），又不会影响正常的 npm 使用。
      if (req.method !== 'GET' && req.method !== 'HEAD' && !Hu.originAllowed(req)) {
        return Hu.fail(res, 403, '跨站来源被拒绝', 'EORIGIN');
      }

      if (!pathname.startsWith('/-/')) state.requestCount++;
      return await registry.handleRegistry(rctx);
    } catch (e) {
      // 业务错误统一映射成合理的 HTTP 状态码（默认 500）：参数/格式类 400，冲突 409，超大 413，超时 408
      const CODE_STATUS = {
        EBADNAME: 400, EBADPATH: 400, EBADVERSION: 400, EBADPAYLOAD: 400, EBADJSON: 400,
        EBADFORMAT: 400, EBADBUNDLE: 400, EBADTAR: 400, EBADSIZE: 400, EBADMANIFEST: 400,
        ECONFLICT: 409, EEXIST: 409,
        ETOOLARGE: 413, ETIMEDOUT: 408, EINTEGRITY: 502, EREMOTEHOST: 502, EEMPTY: 502,
      };
      const code = (e && e.status) || CODE_STATUS[e && e.code] || 500;
      status = code;
      if (!res.headersSent) {
        // 读请求体时超限/超时的请求：明确告知连接即将关闭，并让客户端有机会先读完响应
        if (code === 413 || code === 408) { try { res.setHeader('connection', 'close'); } catch { /* 忽略 */ } }
        Hu.fail(res, code, e.message || '服务器内部错误', e.code || 'EINTERNAL');
      } else { try { res.destroy(); } catch { /* 忽略 */ } }
      if (code >= 500) log.error(`请求处理异常 ${req.method} ${pathname}: ${e.stack || e.message}`);
      else if (code === 413 || code === 408) log.warn(`请求被拒绝 ${req.method} ${pathname}: ${e.code || ''} ${e.message}`);
      else log.debug(`请求被拒绝 ${req.method} ${pathname}: ${e.code || ''} ${e.message}`);
      return undefined;
    } finally {
      const ms = Date.now() - t0;
      if (status >= 500) log.error(`${req.method} ${pathname} → ${status} (${ms}ms)`);
      else if (status >= 400) log.debug(`${req.method} ${pathname} → ${status} (${ms}ms)`);
      else log.debug(`${req.method} ${pathname} → ${status} (${ms}ms)`);
    }
  }

  function makeServer(isAdmin, isInternal = false) {
    const srv = http.createServer((req, res) => handle(req, res, isAdmin, isInternal));
    // 收完整个请求的上限：导入整机备份时浏览器要 POST 几个 GB，本机回环虽然快（GB/s），
    // 但从局域网机器上传可能要好几分钟，原来 5 分钟会把大离线包直接切断。放到 30 分钟，
    // 慢速攻击由 headersTimeout（66s）和各个 readBody/readBodyToFile 的空闲超时（30~60s）兜底。
    srv.requestTimeout = 1800000;
    // keepAlive 要比客户端（npm / 浏览器 / 本机脚本）的复用心跳长，否则空闲几秒后客户端
    // 复用一个「正被服务端关闭」的连接，下一次请求（尤其是 POST）会直接 ECONNRESET。
    // headersTimeout 必须大于 keepAliveTimeout（Node 的要求）。
    srv.keepAliveTimeout = 65000;
    srv.headersTimeout = 66000;
    return srv;
  }

  // ---------------- 监听生命周期 ----------------
  function closeServer(srv) {
    return new Promise((resolve) => {
      if (!srv) return resolve();
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      // 先主动断开 keep-alive 连接：否则 server.close() 要等 65 秒的空闲连接超时，重启会卡住
      try { if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections(); } catch { /* 忽略 */ }
      try { srv.close(() => finish()); } catch { finish(); }
      setTimeout(finish, 1200).unref();
    });
  }

  async function listenServer(srv, ip, port, { retries = 0 } = {}) {
    let attempt = 0;
    for (;;) {
      try {
        await new Promise((resolve, reject) => {
          const onError = (e) => { srv.removeListener('listening', onListening); reject(e); };
          const onListening = () => { srv.removeListener('error', onError); resolve(); };
          srv.once('error', onError);
          srv.once('listening', onListening);
          srv.listen(port, ip === '0.0.0.0' || ip === '::' ? undefined : ip);
        });
        return;
      } catch (e) {
        if (e.code === 'EADDRINUSE' && attempt < retries) {
          attempt++;
          log.warn(`端口 ${port} 仍被占用，300ms 后重试（${attempt}/${retries}）…`);
          await util.sleep(300);
          continue;
        }
        throw e;
      }
    }
  }

  /** 按当前配置绑定镜像源监听（调用方负责先关闭旧监听） */
  async function bindRegistryListener({ retries = 20 } = {}) {
    const cfg = config.get();
    const srv = makeServer(false);
    await listenServer(srv, cfg.server.ip, cfg.server.port, { retries });
    registryServer = srv;
    registryIp = cfg.server.ip;
    registryPort = cfg.server.port;
    registryStartedAt = Date.now();
    state.listenIp = registryIp;
    state.listenPort = registryPort;
    return { ip: registryIp, port: registryPort };
  }

  /** 按当前配置绑定管理界面监听（调用方负责先关闭旧监听） */
  async function bindAdminListener({ retries = 0 } = {}) {
    const cfg = config.get();
    const srv = makeServer(true);
    await listenServer(srv, cfg.admin.ip, cfg.admin.port, { retries });
    adminServer = srv;
    adminIp = cfg.admin.ip;
    adminPort = cfg.admin.port;
    adminStartedAt = Date.now();
    adminListenError = '';
    return { ip: adminIp, port: adminPort };
  }

  // ---------------- 桌面版：内部管理监听 / 网页版管理监听 ----------------

  /** 内部管理监听：127.0.0.1:0（系统分配随机端口），承载桌面 GUI 页面与管理 API，必须成功；
   *  每次绑定都重新生成一次性令牌（门禁见 internalGuiGate）。 */
  async function bindInternalListener() {
    const srv = makeServer(true, true);
    await new Promise((resolve, reject) => {
      const onError = (e) => { srv.removeListener('listening', onListening); reject(e); };
      const onListening = () => { srv.removeListener('error', onError); resolve(); };
      srv.once('error', onError);
      srv.once('listening', onListening);
      srv.listen(0, '127.0.0.1');
    });
    internalServer = srv;
    internalIp = '127.0.0.1';
    internalPort = srv.address().port;
    internalToken = newInternalToken();
    return { ip: internalIp, port: internalPort };
  }

  /** 网页版管理监听（桌面版可选）：按 cfg.admin.ip:cfg.admin.port 绑定 */
  async function bindWebAdminListener({ retries = 0 } = {}) {
    const cfg = config.get();
    const srv = makeServer(true);
    await listenServer(srv, cfg.admin.ip, cfg.admin.port, { retries });
    adminServer = srv;
    adminIp = cfg.admin.ip;
    adminPort = cfg.admin.port;
    adminStartedAt = Date.now();
    adminListenError = '';
    return { ip: adminIp, port: adminPort };
  }

  /** 是否「网页版管理」可用：桌面版看 cfg.admin.enabled 且监听成功；非桌面版固定开启（旧行为） */
  function webAdminEnabled() {
    if (!DESKTOP) return true;
    return config.get().admin.enabled === true && !adminListenError && !!adminServer;
  }

  /** 内部回环管理地址（桌面 GUI 加载的地址） */
  function internalAdminUrl() {
    return Hu.httpUrl(internalIp || '127.0.0.1', internalPort || 0);
  }

  /** 桌面 GUI 的完整内部管理地址（含一次性令牌）。
   *  只经 ready 消息与 restartWindowAdmin 的命令响应交给外壳；绝不能写入日志或任何 API 响应。 */
  function internalGuiUrl() {
    if (!internalPort) return '';
    const base = Hu.httpUrl(internalIp || '127.0.0.1', internalPort);
    if (!internalToken) return base;
    return `${base}/?${GUI_TOKEN_PARAM}=${internalToken}`;
  }

  /** 管理界面地址：桌面版网页管理开启用其地址，否则内部回环地址；非桌面版沿用旧语义 */
  function webAdminUrl() {
    if (!DESKTOP) return Hu.adminUrl(config.get());
    const cfg = config.get();
    if (webAdminEnabled()) return Hu.httpUrl(cfg.admin.ip, cfg.admin.port);
    return internalAdminUrl();
  }

  /** 桌面版协议里的地址统一带结尾斜杠（DESIGN 第 6 节示例：http://127.0.0.1:4874/） */
  function withSlash(u) {
    if (!u) return u;
    const s = String(u);
    return s.endsWith('/') ? s : `${s}/`;
  }

  /** /desktop/info 与 ready 消息用的网页版管理状态 */
  function webAdminState() {
    const cfg = config.get();
    if (!DESKTOP) {
      return { enabled: true, ip: cfg.admin.ip, port: cfg.admin.port, url: Hu.adminUrl(config.get()), listening: !!adminServer, listenError: adminListenError || '' };
    }
    const listening = !!adminServer;
    // DESIGN 第 5 节示例：未开启网页版管理时 url 为 null（内部回环地址由 GUI 通过 internalAdminPort 自行拼）
    const url = listening ? withSlash(Hu.httpUrl(cfg.admin.ip, cfg.admin.port)) : null;
    return { enabled: cfg.admin.enabled === true, ip: cfg.admin.ip, port: cfg.admin.port, url, listening, listenError: adminListenError || '' };
  }

  function notifyWebAdminChanged(st) {
    if (!DESKTOP) return;
    try { if (ctx.desktopHost) ctx.desktopHost.webAdminChanged({ enabled: !!(st && st.enabled && st.listening), url: st && st.url, listenError: (st && st.listenError) || '' }); } catch { /* 忽略 */ }
  }

  /**
   * 桌面版：网页版管理开关/地址变化后立即重建（关闭或开启）该监听，不需要重启程序。
   * 返回 {enabled,url,listenError}；失败只记录 adminListenError，不影响内部监听与镜像源。
   */
  async function rebindWebAdmin({ retries = 1 } = {}) {
    if (!DESKTOP) return restartAdmin();
    if (stopping) return { enabled: false, url: internalAdminUrl(), listenError: '服务正在停止' };
    const cfg = config.get();
    const wantEnabled = cfg.admin.enabled === true;
    log.info(wantEnabled ? `正在开启网页版管理：${cfg.admin.ip}:${cfg.admin.port}` : '正在关闭网页版管理监听');
    const old = adminServer;
    adminServer = null;
    await closeServer(old);
    adminIp = cfg.admin.ip;
    adminPort = cfg.admin.port;
    if (wantEnabled) {
      try {
        await bindWebAdminListener({ retries });
        log.info(`网页版管理已开启：${webAdminUrl()}/`);
      } catch (e) {
        adminListenError = listenErrorMessage(e, cfg.admin.ip, cfg.admin.port, '网页版管理界面');
        log.error(`网页版管理开启失败：${adminListenError}`);
      }
    } else {
      adminListenError = '';
      log.info('网页版管理已关闭');
    }
    const st = webAdminState();
    notifyWebAdminChanged(st);
    return { enabled: st.enabled && st.listening, url: st.url, listenError: st.listenError || '' };
  }

  /**
   * 桌面版：重启「窗口的管理界面」内部监听（仅内部回环端口；镜像源与网页版管理监听不受影响）。
   * 关闭旧监听 → 重新 listen(127.0.0.1:0) 新随机端口 → 重新生成令牌；日志只写端口，绝不写令牌。
   * 返回 {ok:true, port, url}（url 含新令牌，只交给外壳）；停止中/失败返回 {ok:false, error}。
   */
  async function restartInternalAdmin() {
    if (!DESKTOP) return { ok: false, error: '仅桌面版支持重启窗口的管理界面' };
    if (stopping) return { ok: false, error: '服务正在停止' };
    if (internalRestarting) return internalRestarting;
    internalRestarting = (async () => {
      log.info('正在重启窗口的管理界面（内部管理监听）…');
      const old = internalServer;
      internalServer = null;
      internalToken = '';
      await closeServer(old);
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await bindInternalListener();
          // 日志与运行控制台只写端口：令牌属于敏感凭证，绝不能出现在日志里
          log.info(`窗口的管理界面已重启：127.0.0.1:${internalPort}（旧端口与旧令牌已失效）`);
          return { ok: true, port: internalPort, url: internalGuiUrl() };
        } catch (e) {
          lastErr = e;
          log.warn(`窗口的管理界面重启失败（第 ${attempt}/3 次）：${(e && (e.message || e.code)) || e}${attempt < 3 ? '，300ms 后重试…' : ''}`);
          if (attempt < 3) await util.sleep(300);
        }
      }
      const msg = `窗口的管理界面重启失败：${(lastErr && (lastErr.message || lastErr.code)) || '未知错误'}；请重启程序`;
      log.error(msg);
      return { ok: false, error: msg };
    })();
    try { return await internalRestarting; } finally { internalRestarting = null; }
  }

  /**
   * 重启镜像源服务：只重建镜像源监听，管理界面监听不受影响（管理界面不会断线）。
   * 新地址监听失败时自动回滚到原监听地址，保证镜像源继续可用。
   */
  async function restartRegistry() {
    if (stopping) return { ok: false, error: '服务正在停止' };
    const cfg = config.get();
    const want = { ip: cfg.server.ip, port: cfg.server.port };
    log.warn(`正在重启镜像源服务：${want.ip}:${want.port}`);
    const old = registryServer;
    registryServer = null;
    await closeServer(old);
    try {
      await bindRegistryListener({ retries: 10 });
      log.info(`镜像源服务已重启：${ctx.registryUrl}/（监听 ${registryIp}:${registryPort}）`);
      return { ok: true, ip: registryIp, port: registryPort };
    } catch (e) {
      const msg = listenErrorMessage(e, want.ip, want.port, '镜像源服务');
      log.error(`${msg} 正在回滚到原监听地址 ${registryIp}:${registryPort}`);
      try {
        const srv = makeServer(false);
        await listenServer(srv, registryIp, registryPort, { retries: 10 });
        registryServer = srv;
        registryStartedAt = Date.now();
        log.warn(`已回滚到原监听地址：${registryIp}:${registryPort}`);
        return { ok: false, error: `${msg}；已回滚到原监听地址 ${registryIp}:${registryPort}` };
      } catch (e2) {
        log.error(`镜像源监听回滚失败：${e2.message || e2.code}；镜像源服务当前不可用，请重启程序`);
        return { ok: false, error: `${msg}；回滚失败，请重启程序（node cli.js restart）` };
      }
    }
  }

  /**
   * 重启管理界面：只重建管理界面监听，镜像源服务不受影响（npm 客户端不中断）。
   * 新地址监听失败时自动回滚到原监听地址。
   */
  async function restartAdmin() {
    // 桌面版：没有「重启管理界面」这一步，网页版管理监听按配置即时重绑（内部监听始终不动）
    if (DESKTOP) {
      const st = await rebindWebAdmin({ retries: 10 });
      return { ok: !!st.enabled, ...st };
    }
    if (stopping) return { ok: false, error: '服务正在停止' };
    const cfg = config.get();
    const want = { ip: cfg.admin.ip, port: cfg.admin.port };
    log.warn(`正在重启管理界面：${want.ip}:${want.port}`);
    const old = adminServer;
    adminServer = null;
    await closeServer(old);
    try {
      await bindAdminListener({ retries: 10 });
      log.info(`管理界面已重启：${ctx.adminUrl}/（监听 ${adminIp}:${adminPort}）`);
      return { ok: true, ip: adminIp, port: adminPort };
    } catch (e) {
      const msg = listenErrorMessage(e, want.ip, want.port, '管理界面');
      log.error(`${msg} 正在回滚到原监听地址 ${adminIp}:${adminPort}`);
      try {
        const srv = makeServer(true);
        await listenServer(srv, adminIp, adminPort, { retries: 10 });
        adminServer = srv;
        adminStartedAt = Date.now();
        adminListenError = '';
        log.warn(`管理界面已回滚到原监听地址：${adminIp}:${adminPort}`);
        return { ok: false, error: `${msg}；已回滚到原监听地址 ${adminIp}:${adminPort}` };
      } catch (e2) {
        adminListenError = msg;
        log.error(`管理界面监听回滚失败：${e2.message || e2.code}；管理界面当前不可用，请重启程序`);
        return { ok: false, error: `${msg}；回滚失败，请重启程序（node cli.js restart）` };
      }
    }
  }

  function requestRestartRegistry() { return restartRegistry(); }
  function requestRestartAdmin() { return restartAdmin(); }

  // ---------------- 生命周期 ----------------
  function closeResources() {
    try { store.close(); } catch { /* 忽略 */ }
  }

  function requestShutdown() {
    if (stopping) return;
    stopping = true;
    log.warn('服务正在停止…');
    if (DESKTOP) {
      // 先给外壳发 bye，并留一点点时间让 stdout 冲刷，再关闭监听退出
      try { if (ctx.desktopHost) ctx.desktopHost.sendBye(0); } catch { /* 忽略 */ }
      setTimeout(doShutdown, 60);
      return;
    }
    doShutdown();
  }

  function doShutdown() {
    try { if (ctx.scripts) ctx.scripts.cancelAll(); } catch { /* 忽略 */ }
    try { if (ctx.desktopHost) ctx.desktopHost.stop(); } catch { /* 忽略 */ }
    closeResources();
    let pending = DESKTOP ? 3 : 2;
    const done = () => { if (--pending <= 0) process.exit(0); };
    try { if (internalServer) internalServer.close(done); else if (DESKTOP) done(); } catch { done(); }
    try { if (adminServer) adminServer.close(done); else done(); } catch { done(); }
    try { if (registryServer) registryServer.close(done); else done(); } catch { done(); }
    setTimeout(() => process.exit(0), 3000).unref();
  }

  function requestRestart() {
    if (stopping) return;
    if (DESKTOP) {
      // 桌面版：进程由外壳管理，重启 = 请求 Rust 重启程序（Node 不再 spawn 新进程，避免双实例）
      log.warn('桌面模式：请求外壳重启程序…');
      try {
        if (ctx.desktopHost) {
          ctx.desktopHost.appRestart().catch((e) => log.error(`请求外壳重启失败：${(e && e.message) || e}；请手动重启程序`));
        } else {
          log.error('桌面桥不可用，无法重启程序，请手动重启程序');
        }
      } catch (e) { log.error(`请求外壳重启失败：${(e && e.message) || e}`); }
      return;
    }
    stopping = true;
    log.warn('服务正在重启…');
    closeResources();
    try {
      const args = process.argv.slice(2);
      const child = spawn(process.execPath, [process.argv[1], ...args], {
        detached: true, stdio: 'ignore', cwd: process.cwd(),
        // MIRROR_RESTARTING：标记这是一次重启；MIRROR_NO_OPEN：重启时不要再弹一次浏览器
        env: { ...process.env, MIRROR_RESTARTING: '1', MIRROR_NO_OPEN: '1' },
      });
      child.unref();
    } catch (e) {
      log.error(`重启失败（无法拉起新进程）：${e.message}，请手动重新启动`);
    }
    let pending = 2;
    const done = () => { if (--pending <= 0) process.exit(0); };
    try { if (adminServer) adminServer.close(done); else done(); } catch { done(); }
    try { if (registryServer) registryServer.close(done); else done(); } catch { done(); }
    setTimeout(() => process.exit(0), 3000).unref();
  }

  function banner() {
    const cfg = config.get();
    if (DESKTOP) {
      const wa = webAdminState();
      const lines = [
        '',
        '  ┌────────────────────────────────────────────────────────────┐',
        `  │  离月私人 npm 镜像源  v${VERSION}  已启动（桌面版）`,
        '  └────────────────────────────────────────────────────────────┘',
        `  内部管理端口 : 127.0.0.1:${internalPort}（仅桌面程序窗口可访问，浏览器直接打开会被拒绝）`,
        `  网页版管理   : ${wa.enabled ? (wa.listening ? wa.url : `已开启，但监听失败：${wa.listenError}`) : '未开启（可在设置中开启，开启后可用浏览器访问）'}`,
        `  npm 源地址   : ${ctx.registryUrl}/`,
        `  镜像源监听   : ${registryIp}:${registryPort}`,
        `  运行模式     : ${MODE_TEXT[cfg.mode] || cfg.mode}`,
        `  数据目录     : ${util.dataRoot()}`,
        `  程序目录     : ${util.appRoot()}`,
        `  上游公共源   : ${cfg.upstream.registry}`,
      ];
      if (adminListenError) lines.push(`  ⚠ 网页版管理监听失败：${adminListenError}`);
      if (cfg.server.ip === '0.0.0.0' || cfg.server.ip === '::') {
        for (const u of Hu.lanUrls(cfg.server.port)) lines.push(`  局域网地址   : ${u}`);
      }
      lines.push('  提示：桌面版由外壳管理窗口与托盘；退出程序请使用托盘菜单或设置中的「退出」', '');
      // 启动横幅也进运行控制台（DESIGN 4.6）：每行一条，方便 GUI 直接展示
      try {
        const buf = consoleMod.get();
        for (const line of lines) if (line.trim()) buf.push({ source: 'server', level: 'info', text: line.replace(/^\s+/, '') });
      } catch { /* 忽略 */ }
      process.stdout.write(lines.join('\n') + '\n');
      return;
    }
    const lines = [
      '',
      '  ┌────────────────────────────────────────────────────────────┐',
      `  │  私人 npm 镜像源  v${VERSION}  已启动`,
      '  └────────────────────────────────────────────────────────────┘',
      `  管理界面   : ${ctx.adminUrl}/  （仅本机可访问）`,
      `  npm 源地址 : ${ctx.registryUrl}/`,
      `  镜像源监听 : ${registryIp}:${registryPort}`,
      `  管理界面监听: ${adminIp}:${adminPort}（仅允许 127.0.0.0/8 本地回环）`,
    ];
    if (adminListenError) lines.push(`  ⚠ 管理界面监听失败：${adminListenError}`);
    lines.push(
      `  运行模式   : ${MODE_TEXT[cfg.mode] || cfg.mode}`,
      `  数据目录   : ${util.dataRoot()}`,
      `  上游公共源 : ${cfg.upstream.registry}`,
    );
    if (cfg.server.ip === '0.0.0.0' || cfg.server.ip === '::') {
      for (const u of Hu.lanUrls(cfg.server.port)) lines.push(`  局域网地址 : ${u}`);
    } else {
      lines.push('  局域网地址 : 未开启（将镜像源监听地址设为 0.0.0.0 即可被局域网访问）');
    }
    lines.push(
      '  提示：管理界面「服务」页可分别「重启镜像源服务」（不打断管理界面）与「重启管理界面」（不打断 npm）',
      '        按 Ctrl+C 停止服务；关闭浏览器不会停止服务',
      '',
    );
    process.stdout.write(lines.join('\n') + '\n');
  }

  async function start() {
    const cfg = config.get();
    const openOnStart = cfg.server.openBrowserOnStart && !cliOpts['no-open'];

    // ---------------- 桌面模式 ----------------
    if (DESKTOP) {
      // 内部管理监听必须成功：它承载 GUI 页面与管理 API，失败等于桌面界面无法加载，直接报错
      try {
        await bindInternalListener();
      } catch (e) {
        const err = new Error(`内部管理端口绑定失败（127.0.0.1:0）：${e.message || e.code}；请重启程序`);
        err.code = e.code;
        throw err;
      }
      try {
        await bindRegistryListener({ retries: 20 });
      } catch (e) {
        const err = new Error(listenErrorMessage(e, cfg.server.ip, cfg.server.port, '镜像源服务'));
        err.code = e.code;
        throw err;
      }
      // 网页版管理监听：仅在配置显式开启时绑定；失败只记录错误，不影响内部监听与镜像源
      if (cfg.admin.enabled === true) {
        try {
          await bindWebAdminListener({ retries: 0 });
        } catch (e) {
          adminListenError = listenErrorMessage(e, cfg.admin.ip, cfg.admin.port, '网页版管理界面');
          log.error(`网页版管理启动失败（镜像源与桌面界面仍在运行）：${adminListenError}`);
        }
      } else {
        adminListenError = '';
      }
      log.info(`私人 npm 镜像源 v${VERSION} 已启动（桌面版）：镜像源 ${ctx.registryUrl}/（模式：${cfg.mode}）；内部管理端口 127.0.0.1:${internalPort}`);
      banner();
      // 通知外壳：服务就绪。之后 Rust 才会创建/显示窗口并加载内部管理地址。
      try {
        if (ctx.desktopHost) {
          const st = webAdminState();
          ctx.desktopHost.sendReady({
            internalAdminPort: internalPort,
            // v0.0.7：含一次性令牌的完整内部管理地址；Rust 优先用它导航（旧外壳会忽略该字段）
            internalAdminUrl: internalGuiUrl(),
            dataDir: util.dataRoot(),
            webAdmin: { enabled: st.enabled, url: st.listening ? st.url : null },
          });
        }
      } catch (e) { log.error(`发送 ready 消息失败：${(e && e.message) || e}`); }
      // 桌面模式不自动打开外部浏览器（GUI 就是界面本身）
      return ctx;
    }

    // ---------------- 非桌面模式：保持旧行为完全不变 ----------------
    try {
      await bindRegistryListener({ retries: 20 });
    } catch (e) {
      const err = new Error(listenErrorMessage(e, cfg.server.ip, cfg.server.port, '镜像源服务'));
      err.code = e.code;
      throw err;
    }
    // 管理界面监听失败不阻塞镜像源服务：镜像源（npm 安装依赖）优先可用，
    // 用户可修改配置后重启程序；后台会记录明确的错误并在 banner 中提示。
    try {
      await bindAdminListener({ retries: 0 });
    } catch (e) {
      adminListenError = listenErrorMessage(e, cfg.admin.ip, cfg.admin.port, '管理界面');
      log.error(`管理界面启动失败（镜像源服务仍在运行）：${adminListenError}`);
    }
    log.info(`私人 npm 镜像源 v${VERSION} 已启动：镜像源 ${ctx.registryUrl}/（模式：${cfg.mode}）；管理界面 ${adminListenError ? '未启动' : `${ctx.adminUrl}/`}`);
    banner();
    if (openOnStart && !process.env.MIRROR_NO_OPEN && !adminListenError) {
      try {
        const url = `${ctx.adminUrl}/`;
        if (process.platform === 'win32') {
          spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        } else if (process.platform === 'darwin') {
          spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
        }
        log.info(`已尝试打开浏览器：${url}`);
      } catch (e) { log.debug(`打开浏览器失败（可手动访问）：${e.message}`); }
    }
    return ctx;
  }

  async function stop() {
    try { if (ctx.scripts) ctx.scripts.cancelAll(); } catch { /* 忽略 */ }
    closeResources();
    await Promise.all([closeServer(registryServer), closeServer(adminServer), closeServer(internalServer)]);
    registryServer = null;
    adminServer = null;
    internalServer = null;
    internalToken = '';
    try { if (ctx.desktopHost) ctx.desktopHost.stop(); } catch { /* 忽略 */ }
  }

  process.on('SIGINT', () => { log.warn('收到 Ctrl+C，正在停止…'); requestShutdown(); });
  process.on('SIGTERM', () => { requestShutdown(); });
  process.on('uncaughtException', (e) => { log.error(`未捕获异常：${e.stack || e.message}`); });
  process.on('unhandledRejection', (e) => { log.error(`未处理的 Promise 拒绝：${e && (e.stack || e.message) || e}`); });

  return {
    ctx, start, stop, store, log, requestShutdown, requestRestart,
    requestRestartRegistry, requestRestartAdmin, VERSION,
    get registryServer() { return registryServer; },
    get adminServer() { return adminServer; },
    get internalServer() { return internalServer; },
    get internalAdminPort() { return internalPort; },
    get desktop() { return DESKTOP; },
    webAdminState,
    rebindWebAdmin,
  };
}

// ---------------- 直接启动入口 ----------------
// 桌面版由 Rust 直接拉起 `node.exe <appRoot>/src/server.js --desktop --data-dir <目录>`；
// CLI（cli.js）通过 require 复用本模块，不会触发这里（require.main !== module）。
if (require.main === module) {
  const cliOpts = {};
  for (const name of ['ip', 'port', 'mode', 'registry']) {
    const v = util.argvValue(name);
    if (v !== undefined && v !== '') cliOpts[name] = v;
  }
  if (util.hasArgvFlag('no-open')) cliOpts['no-open'] = true;
  createServer({ cliOpts })
    .then((app) => app.start())
    .catch((e) => {
      process.stderr.write(`\n启动失败：${(e && e.message) || e}\n`);
      process.exit(1);
    });
}

module.exports = { createServer, VERSION, MODE_TEXT };
