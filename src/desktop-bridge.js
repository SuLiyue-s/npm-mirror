'use strict';
/**
 * 桌面版 Node↔Rust 行协议桥（DESIGN 第 6 节）
 *
 *   Node stdout → Rust：每行 `@@BRIDGE@@{...}`（无前缀的 stdout 行 Rust 会当普通日志写 desktop.log）
 *   Rust stdin  → Node：同样以 `@@BRIDGE@@` 开头（Node 只处理带前缀的行）
 *
 * 消息类型：
 *   Node→Rust  {"type":"ready",...} / {"type":"req","id":N,"method","params"}
 *              / {"type":"event","method","params"} / {"type":"bye","code":0}
 *   Rust→Node  {"type":"res","id":N,"ok":true,"data":{...}}
 *              {"type":"res","id":N,"ok":false,"error":{"code","message"}}
 *              {"type":"cmd","id":N,"method","params"}   ← Node 必须回 res
 *
 * 本模块只做协议层：不依赖 server.js/api.js，可用 node 子进程模拟 Rust 端单独测试。
 */
const PREFIX = '@@BRIDGE@@';

function bridgeError(message, code = 'EBRIDGE') {
  const e = new Error(message);
  e.code = code;
  return e;
}

class DesktopBridge {
  constructor(opts = {}) {
    this.prefix = opts.prefix || PREFIX;
    this.input = opts.input || process.stdin;
    this.output = opts.output || process.stdout;
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30000;
    this.nextId = 1;
    this.pending = new Map();     // id → {resolve, reject, method, timer}
    this.handlers = new Map();    // cmd method → async (params, msg) => data
    this.buffer = '';
    this.closed = false;
    this.started = false;
    this.onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
    this.onMessage = typeof opts.onMessage === 'function' ? opts.onMessage : null;
    this._onData = (chunk) => this._feed(chunk);
    this._onEnd = () => this._handleEnd('stdin 已关闭（EOF）');
    this._onError = () => this._handleEnd('stdin 读取失败');
  }

  // ---------------- 发送 ----------------

  /** 发送一行桥消息；stdout 已关闭时静默返回 false（Rust 已退出时不应让 Node 崩溃） */
  send(msg) {
    if (this.closed) return false;
    let line;
    try { line = this.prefix + JSON.stringify(msg); } catch { return false; }
    try {
      this.output.write(line + '\n');
      return true;
    } catch {
      return false;
    }
  }

  /** 启动完成握手：internalAdminPort / dataDir / pid / webAdmin 等 */
  sendReady(data) {
    return this.send({ type: 'ready', ...(data || {}) });
  }

  /** Node 主动通知 Rust（不需要回包）：webAdminChanged、console 行等 */
  event(method, params) {
    return this.send({ type: 'event', method, params: params || {} });
  }

  /** 优雅退出前告知 Rust */
  sendBye(code = 0) {
    return this.send({ type: 'bye', code });
  }

  /**
   * 发起一次桥请求（Node→Rust），等 Rust 回 res。
   * 超时/桥断开时 reject，error.code 统一为 'EBRIDGE'（管理 API 会映射成 504 EBRIDGE）。
   */
  request(method, params, opts = {}) {
    if (this.closed) return Promise.reject(bridgeError('桌面桥未连接，无法执行：' + method));
    const id = this.nextId++;
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(bridgeError(`桥请求超时（${method}，${Math.round(timeoutMs / 1000)}s 无响应）`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, method, timer });
      const ok = this.send({ type: 'req', id, method, params: params || {} });
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(bridgeError('桌面桥已断开，无法执行：' + method));
      }
    });
  }

  /** 注册 Rust 发起的 cmd 处理函数（method → async(params) → data；抛错则回 ok:false） */
  handle(method, fn) {
    this.handlers.set(String(method), fn);
    return this;
  }

  // ---------------- 接收 ----------------

  start() {
    if (this.started) return this;
    this.started = true;
    if (this.input && typeof this.input.on === 'function') {
      this.input.setEncoding && this.input.setEncoding('utf8');
      this.input.on('data', this._onData);
      this.input.on('end', this._onEnd);
      this.input.on('close', this._onEnd);
      this.input.on('error', this._onError);
      if (typeof this.input.resume === 'function') this.input.resume();
    }
    return this;
  }

  _feed(chunk) {
    if (this.closed) return;
    this.buffer += String(chunk == null ? '' : chunk);
    // 防止对端长时间不发换行把内存撑爆
    if (this.buffer.length > 4 * 1024 * 1024) {
      this.buffer = '';
      return;
    }
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      this._onLine(line);
    }
  }

  _onLine(line) {
    const text = String(line == null ? '' : line).trim();
    if (!text) return;
    if (!text.startsWith(this.prefix)) return;   // 非桥消息（异常输出等）忽略
    const payload = text.slice(this.prefix.length).trim();
    if (!payload) return;
    let msg = null;
    try { msg = JSON.parse(payload); } catch { return; }   // 坏行忽略，不让桥挂掉
    if (!msg || typeof msg !== 'object') return;
    if (this.onMessage) {
      try { this.onMessage(msg); } catch { /* 忽略观察者异常 */ }
    }
    this._handleMessage(msg);
  }

  _handleMessage(msg) {
    if (msg.type === 'res') return this._handleResponse(msg);
    if (msg.type === 'cmd') return this._handleCommand(msg);
    // 其它类型（Rust→Node 的 event 等）目前无需处理
    return undefined;
  }

  _handleResponse(msg) {
    const id = msg.id;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.data === undefined ? {} : msg.data);
    else {
      const err = (msg.error && typeof msg.error === 'object') ? msg.error : {};
      const e = bridgeError(String(err.message || '桌面桥请求失败'), String(err.code || 'EBRIDGE'));
      e.bridgeMethod = entry.method;
      entry.reject(e);
    }
  }

  async _handleCommand(msg) {
    const id = msg.id;
    const method = String(msg.method || '');
    const fn = this.handlers.get(method);
    if (!fn) {
      this.send({ type: 'res', id, ok: false, error: { code: 'EMETHOD', message: `桌面桥不支持的命令：${method}` } });
      return;
    }
    try {
      const data = await fn(msg.params || {}, msg);
      this.send({ type: 'res', id, ok: true, data: data === undefined ? {} : data });
    } catch (e) {
      this.send({
        type: 'res', id, ok: false,
        error: { code: (e && e.code) || 'EBRIDGE', message: (e && e.message) || String(e) },
      });
    }
  }

  _handleEnd(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(bridgeError(`桌面桥已断开（${reason}），无法执行：${entry.method}`));
    }
    this.pending.clear();
    if (this.onClose) {
      try { this.onClose(reason); } catch { /* 忽略关闭回调异常 */ }
    }
  }

  /** 主动关闭（内部/测试用）：不再处理输入，拒绝所有未完成请求 */
  close() {
    try { if (this.input && typeof this.input.pause === 'function') this.input.pause(); } catch { /* 忽略 */ }
    this._handleEnd('已主动关闭');
  }
}

module.exports = { DesktopBridge, PREFIX, bridgeError };
