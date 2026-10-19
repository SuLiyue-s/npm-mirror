'use strict';
/**
 * 桌面版宿主：把 Node 服务接入 Rust（Tauri）外壳。
 *  - 管理 stdin/stdout 行协议桥（desktop-bridge.js）；
 *  - 处理 Rust 发来的 cmd（shutdown / restartWebAdmin / restartRegistry / showWebAdmin / console.log）；
 *  - 为管理 API 提供「需要 Rust 干活」的动作代理（选目录/选文件/开机自启/打开路径/重启/退出/窗口显隐）；
 *  - 把托盘操作等写入运行控制台（source=desktop）。
 * 非桌面模式不会创建本对象，Node 端行为与旧版完全一致。
 */
const path = require('node:path');
const util = require('./util');
const consoleMod = require('./console');
const { DesktopBridge } = require('./desktop-bridge');

/** 产品名（窗口标题 / 关于页；可由 MIRROR_PRODUCT_NAME 覆盖，Rust 端也读同一份环境变量） */
const PRODUCT_NAME = String(process.env.MIRROR_PRODUCT_NAME || '').trim() || '离月私人 npm 镜像源';

/** 选目录/选文件是用户交互，Node 侧必须等足够久（GUI 侧对应 120s），不能套用普通桥请求的 30s 超时 */
const PICK_TIMEOUT_MS = 120000;
const DEFAULT_TIMEOUT_MS = 30000;

function normalizeDir(dir) {
  const raw = String(dir == null ? '' : dir).trim();
  if (!raw) throw Object.assign(new Error('数据目录不能为空'), { code: 'EBADPARAM' });
  if (raw.includes('\0')) throw Object.assign(new Error('数据目录不能包含空字节'), { code: 'EBADPARAM' });
  if (!path.isAbsolute(raw)) throw Object.assign(new Error(`数据目录必须是绝对路径：${raw}`), { code: 'EBADPARAM' });
  return path.resolve(raw);
}

/** 桥协议里的地址统一带结尾斜杠（DESIGN 第 6 节示例） */
function withSlash(u) {
  if (!u) return '';
  const s = String(u);
  return s.endsWith('/') ? s : `${s}/`;
}

class DesktopHost {
  constructor(opts = {}) {
    this.version = String(opts.version || '');
    this.productName = opts.productName || PRODUCT_NAME;
    this.getCtx = typeof opts.getCtx === 'function' ? opts.getCtx : (() => null);
    this.console = consoleMod.get();
    this.bridge = new DesktopBridge({
      input: opts.input || process.stdin,
      output: opts.output || process.stdout,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    this.onBridgeClose = typeof opts.onBridgeClose === 'function' ? opts.onBridgeClose : null;
    this.readySent = false;
    this.stopped = false;
    this._appInfo = null;         // Rust 端 app.info 返回（exePath/exeDir 等），可能为 null
    this._appInfoLoaded = false;
    this._appInfoPromise = null;
    this._registerCommands();
  }

  get dataDir() { return util.dataRoot(); }
  get appRoot() { return util.appRoot(); }

  // ---------------- 生命周期 ----------------

  start() {
    if (this.stopped) return this;
    this.bridge.onClose = (reason) => {
      this.pushConsole('warn', `桌面桥已断开：${reason}`, 'desktop');
      if (this.onBridgeClose) { try { this.onBridgeClose(reason); } catch { /* 忽略 */ } }
    };
    this.bridge.start();
    /* 注意：不要在 ready 之前主动请求 app.info。
     * DESIGN §5/§6 的启动顺序是 Node 先发 ready，Rust 侧看到 ready 后才认为 Node 就绪；
     * 提前发 req 会让某些外部实现先收到 req。程序信息改为按需获取（GET /desktop/info
     * 会 await ensureAppInfo() 再读 exePath/exeDir），不影响任何功能。 */
    return this;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.bridge.close();
  }

  /** 通知 Rust 服务已就绪（internalAdminPort 已绑定后调用）
   *  v0.0.7：新增 internalAdminUrl（含一次性令牌的完整地址，Rust 优先用它导航）；旧字段全部保留。 */
  sendReady({ internalAdminPort, internalAdminUrl, dataDir, webAdmin } = {}) {
    const sent = this.bridge.sendReady({
      version: this.version,
      internalAdminPort: Number(internalAdminPort) || 0,
      internalAdminUrl: internalAdminUrl ? String(internalAdminUrl) : null,
      dataDir: dataDir || util.dataRoot(),
      pid: process.pid,
      webAdmin: {
        enabled: !!(webAdmin && webAdmin.enabled),
        url: (webAdmin && webAdmin.enabled && webAdmin.url) ? String(webAdmin.url) : null,
      },
    });
    if (sent) this.readySent = true;
    return sent;
  }

  sendBye(code = 0) { return this.bridge.sendBye(code); }

  // ---------------- 控制台 ----------------

  pushConsole(level, text, source = 'desktop') {
    try { return this.console.push({ level, text, source }); } catch { return null; }
  }

  // ---------------- Rust 发来的命令 ----------------

  _registerCommands() {
    const c = () => this.getCtx() || {};

    this.bridge.handle('shutdown', async () => {
      this.pushConsole('info', '收到桌面端退出请求，正在停止服务…', 'desktop');
      // 先回 res 再退出（延时给 stdout 冲刷与外壳处理留时间）
      setTimeout(() => { try { c().requestShutdown(); } catch { /* 忽略 */ } }, 120);
      return { ok: true };
    });

    this.bridge.handle('restartWebAdmin', async () => {
      const ctx = c();
      if (typeof ctx.rebindWebAdmin !== 'function') return { enabled: false, url: null, listenError: '服务未就绪' };
      const st = await ctx.rebindWebAdmin({ retries: 1 });
      this.pushConsole('info', st && st.enabled ? `网页版管理已开启：${st.url}` : '网页版管理已关闭', 'desktop');
      return { enabled: !!(st && st.enabled && !st.listenError), url: (st && st.url) || null, listenError: (st && st.listenError) || '' };
    });

    this.bridge.handle('restartRegistry', async () => {
      const ctx = c();
      this.pushConsole('info', '正在重启镜像源监听…', 'desktop');
      if (typeof ctx.restartRegistry === 'function') await ctx.restartRegistry();
      return { url: withSlash(ctx.registryUrl || '') };
    });

    /* v0.0.7：托盘/设置里「重启窗口的管理界面」：只重建内部回环监听并换新令牌，
     * 镜像源与网页版管理监听不受影响；返回含新令牌的完整 URL（仅经桥交给外壳，不落日志/API）。 */
    this.bridge.handle('restartWindowAdmin', async () => {
      const ctx = c();
      this.pushConsole('info', '正在重启窗口的管理界面…', 'desktop');
      if (typeof ctx.restartInternalAdmin !== 'function') return { ok: false, error: '服务未就绪' };
      try {
        const r = await ctx.restartInternalAdmin();
        if (!r || !r.ok) return { ok: false, error: (r && r.error) || '重启窗口的管理界面失败' };
        return { ok: true, port: r.port, url: r.url };
      } catch (e) {
        return { ok: false, error: (e && (e.message || e.code)) || String(e) };
      }
    });

    this.bridge.handle('showWebAdmin', async () => {
      const ctx = c();
      const url = typeof ctx.webAdminUrl === 'function' ? ctx.webAdminUrl() : (ctx.adminUrl || '');
      return { url: withSlash(url || '') };
    });

    this.bridge.handle('console.log', async (params = {}) => {
      const level = ['debug', 'info', 'warn', 'error'].includes(params.level) ? params.level : 'info';
      const text = String(params.text == null ? '' : params.text);
      if (text) this.pushConsole(level, text, 'desktop');
      return { ok: true };
    });
  }

  // ---------------- Node → Rust 请求 ----------------

  request(method, params, opts = {}) { return this.bridge.request(method, params, opts); }

  event(method, params) { return this.bridge.event(method, params); }

  /** 网页版管理监听状态变化后通知 Rust（托盘菜单勾选状态等） */
  webAdminChanged(info) {
    return this.event('webAdminChanged', info || {});
  }

  async _loadAppInfo() {
    if (this._appInfoPromise) return this._appInfoPromise;
    this._appInfoPromise = (async () => {
      try {
        const data = await this.bridge.request('app.info', {}, { timeoutMs: 3000 });
        this._appInfo = (data && typeof data === 'object') ? data : null;
      } catch {
        this._appInfo = null;
      } finally {
        this._appInfoLoaded = true;
      }
      return this._appInfo;
    })();
    return this._appInfoPromise;
  }

  /** Rust 端程序信息（可能为 null）：{ exePath, exeDir, ... } */
  appInfo() { return this._appInfo; }
  async ensureAppInfo() {
    if (this._appInfoLoaded) return this._appInfo;
    try { await this._loadAppInfo(); } catch { /* 忽略 */ }
    return this._appInfo;
  }

  // 以下是管理 API 的动作代理：参数校验在 api.js 做，这里只负责过桥。

  pickFolder(params = {}) { return this.request('pickFolder', params, { timeoutMs: PICK_TIMEOUT_MS }); }
  pickFile(params = {}) { return this.request('pickFile', params, { timeoutMs: PICK_TIMEOUT_MS }); }
  setDataDir(dir) { return this.request('setDataDir', { dir: normalizeDir(dir) }); }
  autostartGet() { return this.request('autostart.get', {}); }
  autostartSet(enabled) { return this.request('autostart.set', { enabled: enabled === true }); }
  openPath(payload) { return this.request('openPath', payload || {}); }
  appRestart() { return this.request('app.restart', {}); }
  appQuit() { return this.request('app.quit', {}); }
  windowShow() { return this.request('window.show', {}); }
  windowHide() { return this.request('window.hide', {}); }
}

module.exports = { DesktopHost, PRODUCT_NAME, PICK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, normalizeDir };
