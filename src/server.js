'use strict';
/* HTTP 服务：静态管理界面 + npm 注册表协议 + 可视化管理 API */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
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

const PUBLIC_DIR = util.rootPath('public');
const VERSION = (() => { try { return require('../package.json').version; } catch { return '1.0.0'; } })();

const MODE_TEXT = {
  cache: 'cache（本地优先，未命中时回源并缓存）',
  proxy: 'proxy（元数据按 TTL 回源刷新，tarball 按需缓存）',
  offline: 'offline（纯离线，禁止访问外网）',
};

function applyCliOverrides(cfg, opts) {
  let changed = false;
  if (opts.ip) { cfg.server.ip = String(opts.ip); changed = true; }
  if (opts.port) { cfg.server.port = Number(opts.port); changed = true; }
  if (opts.mode) { cfg.mode = String(opts.mode); changed = true; }
  if (opts.registry) { cfg.upstream.registry = String(opts.registry); changed = true; }
  if (opts['no-open']) { cfg.server.openBrowserOnStart = false; changed = true; }
  return changed;
}

function createServer({ cliOpts = {} } = {}) {
  if (Object.keys(cliOpts).length) applyCliOverrides(config.get(), cliOpts);

  const cfg0 = config.get();
  const log = loggerMod.init({ dir: config.logsDir(), level: cfg0.log.level, maxDays: cfg0.log.maxDays, console: true });
  const store = new Store({ dir: config.storageDir(), logger: log });
  store.init();

  let stopping = false;
  let listenIp = config.get().server.ip;
  let listenPort = config.get().server.port;
  const state = {
    startedAt: Date.now(),
    version: VERSION,
    upstreamCheck: null,
    restartRequired: false,
    requestCount: 0,
    bundleManifests: new Map(),
    listenIp,
    listenPort,
  };

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
    get listenIp() { return listenIp; },
    get listenPort() { return listenPort; },
    clientIp: Hu.clientIp,
    registryUrl: Hu.registryUrl(config.get()),
    requestShutdown,
    requestRestart,
  };

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

  async function handle(req, res) {
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

    try {
      if (pathname === API || pathname.startsWith(`${API}/`)) {
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

      // 写操作（发布/取消发布/dist-tag 等）同样要做跨站来源校验：
      // 浏览器跨站页面会带 Origin，npm/curl 等命令行客户端不会。这样本地网页无法借浏览器
      // 直接 POST 到 127.0.0.1:4873 发布恶意包（CSRF），又不会影响正常的 npm 使用。
      if (req.method !== 'GET' && req.method !== 'HEAD' && !Hu.originAllowed(req)) {
        return Hu.fail(res, 403, '跨站来源被拒绝', 'EORIGIN');
      }

      if (!pathname.startsWith('/-/')) state.requestCount++;
      if (pathname === '/' || pathname === '/index.html' || pathname === '/app.js' || pathname === '/style.css' || pathname === '/favicon.ico') {
        return serveStatic(req, res, pathname);
      }
      if (/^\/(assets|static)\//.test(pathname)) return serveStatic(req, res, pathname);
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

  const server = http.createServer(handle);
  // 收完整个请求的上限：导入整机备份时浏览器要 POST 几个 GB，本机回环虽然快（GB/s），
  // 但从局域网机器上传可能要好几分钟，原来 5 分钟会把大离线包直接切断。放到 30 分钟，
  // 慢速攻击由 headersTimeout（66s）和各个 readBody/readBodyToFile 的空闲超时（30~60s）兜底。
  server.requestTimeout = 1800000;
  // keepAlive 要比客户端（npm / 浏览器 / 本机脚本）的复用心跳长，否则空闲几秒后客户端
  // 复用一个「正被服务端关闭」的连接，下一次请求（尤其是 POST）会直接 ECONNRESET。
  // headersTimeout 必须大于 keepAliveTimeout（Node 的要求）。
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  // ---------------- 生命周期 ----------------
  function closeResources() {
    try { store.close(); } catch { /* 忽略 */ }
  }

  function requestShutdown() {
    if (stopping) return;
    stopping = true;
    log.warn('服务正在停止…');
    closeResources();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }

  function requestRestart() {
    if (stopping) return;
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
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }

  function banner() {
    const cfg = config.get();
    const url = Hu.registryUrl(cfg);
    const lines = [
      '',
      '  ┌────────────────────────────────────────────────────────────┐',
      `  │  私人 npm 镜像源  v${VERSION}  已启动`,
      '  └────────────────────────────────────────────────────────────┘',
      `  管理界面   : ${url}`,
      `  npm 源地址 : ${url}/`,
      `  监听地址   : ${cfg.server.ip}:${cfg.server.port}`,
      `  运行模式   : ${MODE_TEXT[cfg.mode] || cfg.mode}`,
      `  数据目录   : ${util.rootPath('data')}`,
      `  上游公共源 : ${cfg.upstream.registry}`,
    ];
    if (cfg.server.ip === '0.0.0.0' || cfg.server.ip === '::') {
      for (const u of Hu.lanUrls(cfg.server.port)) lines.push(`  局域网地址 : ${u}`);
    } else {
      lines.push('  局域网地址 : 未开启（将监听地址设为 0.0.0.0 即可被局域网访问）');
    }
    lines.push('  提示：按 Ctrl+C 停止服务；关闭浏览器不会停止服务', '');
    process.stdout.write(lines.join('\n') + '\n');
  }

  async function start() {
    const cfg = config.get();
    const port = cfg.server.port;
    const ip = cfg.server.ip;
    let attempt = 0;
    for (;;) {
      try {
        await new Promise((resolve, reject) => {
          const onError = (e) => { server.removeListener('listening', onListening); reject(e); };
          const onListening = () => { server.removeListener('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, ip === '0.0.0.0' || ip === '::' ? undefined : ip);
        });
        listenIp = ip; listenPort = port; state.listenIp = ip; state.listenPort = port;
        break;
      } catch (e) {
        if (e.code === 'EADDRINUSE' && attempt < 20) {
          attempt++;
          log.warn(`端口 ${port} 仍被占用，300ms 后重试（${attempt}/20）…`);
          await util.sleep(300);
          continue;
        }
        const msg = e.code === 'EADDRINUSE'
          ? `端口 ${port} 已被占用。请关闭占用该端口的程序，或修改 data/config.json 里的 server.port 后重启。`
          : e.code === 'EACCES'
            ? `没有权限监听 ${ip}:${port}（端口 <1024 需要管理员权限，建议改用 1024 以上端口）。`
            : `启动失败：${e.message}`;
        const err = new Error(msg);
        err.code = e.code;
        throw err;
      }
    }
    log.info(`私人 npm 镜像源 v${VERSION} 已启动：${Hu.registryUrl(cfg)}（模式：${cfg.mode}）`);
    banner();
    if (cfg.server.openBrowserOnStart && !process.env.MIRROR_NO_OPEN) {
      try {
        const url = Hu.registryUrl(cfg);
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
    closeResources();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  process.on('SIGINT', () => { log.warn('收到 Ctrl+C，正在停止…'); requestShutdown(); });
  process.on('SIGTERM', () => { requestShutdown(); });
  process.on('uncaughtException', (e) => { log.error(`未捕获异常：${e.stack || e.message}`); });
  process.on('unhandledRejection', (e) => { log.error(`未处理的 Promise 拒绝：${e && (e.stack || e.message) || e}`); });

  return { ctx, server, start, stop, store, log, requestShutdown, requestRestart, VERSION };
}

module.exports = { createServer, VERSION, MODE_TEXT };
