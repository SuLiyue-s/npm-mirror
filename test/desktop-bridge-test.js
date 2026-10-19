'use strict';
/* 桌面桥协议单测（DESIGN 第 6 节）
 *
 * Node 端 src/desktop-bridge.js 是「子进程侧」：逐行处理 `@@BRIDGE@@{json}`，向对端写同样格式。
 * 本测试让同一个脚本同时扮演两侧：
 *   - 父进程 = 模拟 Rust 外壳：监听回环 TCP 端口、spawn 子进程、解析桥行、发 cmd/res；
 *   - 子进程（--child <port>） = 使用 DesktopBridge 的 Node 端：发 ready/req/event/bye、处理 cmd。
 *
 * 传输说明：真实部署走 stdin/stdout，但 DSH 沙箱内 child_process 的 stdio:'pipe' 会 EPERM
 * （Windows 命名管道限制），因此测试用回环 TCP 套接字作为 DesktopBridge 的 input/output 流，
 * 走的是完全相同的桥协议代码路径（逐行 JSON、前缀过滤、超时、EOF 关闭）。
 *
 * 覆盖：ready 消息 / Node→Rust req 与 Rust→Node res / Rust→Node cmd 与 Node→Rust res /
 *       未知 cmd（EMETHOD）/ 处理函数抛错 / 超时（EBRIDGE）/ 非前缀行与坏 JSON 被忽略 /
 *       分片写入的行重组 / EOF 时 pending 请求被拒绝且触发 onClose（优雅退出）。
 *
 * 运行：node test/desktop-bridge-test.js       退出码 0=通过，1=失败
 */
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PREFIX = '@@BRIDGE@@';
const DEBUG = process.env.BRIDGE_DEBUG === '1';
const dbg = (...args) => { if (DEBUG) process.stderr.write(`[bridge-test ${process.argv[2] === '--child' ? 'child' : 'parent'} ${Date.now() % 100000}] ${args.join(' ')}\n`); };
const RAW_WRITE = (socket, msg, cb) => { try { socket.write(`${PREFIX}${JSON.stringify(msg)}\n`, cb); } catch { /* 忽略 */ } };

// ===========================================================================
// 子进程：Node 端（DesktopBridge 使用方）
// ===========================================================================
function runChild(port) {
  const { DesktopBridge } = require(path.join(ROOT, 'src', 'desktop-bridge.js'));
  const socket = net.connect({ port: Number(port), host: '127.0.0.1', allowHalfOpen: true });
  socket.setEncoding('utf8');
  socket.on('error', () => { /* 父进程关闭时忽略 */ });
  const bridge = new DesktopBridge({ input: socket, output: socket, timeoutMs: 3000 });

  bridge.handle('ping', async (params) => { dbg('child handler ping', JSON.stringify(params)); return { pong: (Number(params && params.v) || 0) + 1 }; });
  bridge.handle('boom', async () => { dbg('child handler boom'); const e = new Error('处理函数故意抛错'); e.code = 'EBOOM'; throw e; });
  if (DEBUG) bridge.onMessage = (msg) => dbg('child recv', msg.type, msg.method || '', msg.id || '');

  let pendingRejected = null;
  bridge.request('neverAnswered', {}, { timeoutMs: 60000 }).catch((e) => {
    pendingRejected = { code: e.code, message: e.message };
  });

  bridge.onClose = (reason) => {
    dbg('child onClose', reason);
    setTimeout(() => {
      // bridge 已 closed，send() 会拒绝；这里直接写套接字（等价于 Rust 侧观察到的最后两行）
      let wrote = 0;
      const done = () => { dbg('child wrote', wrote + 1); if (++wrote >= 2) setTimeout(() => process.exit(0), 60); };
      RAW_WRITE(socket, { type: 'event', method: 'childClosed', params: { reason } }, done);
      RAW_WRITE(socket, { type: 'event', method: 'pendingRejected', params: pendingRejected || { code: '', message: '' } }, done);
    }, 40);
  };

  socket.on('connect', () => {
    dbg('child connected');
    bridge.start();
    bridge.sendReady({
      version: '0.0.1',
      internalAdminPort: 45678,
      dataDir: 'X:\\tmp\\desk-data',
      pid: process.pid,
      webAdmin: { enabled: false, url: null },
    });

    // 非桥输出行：父进程必须忽略（模拟服务日志混在 stdout 里）
    socket.write('普通日志行，不属于桥协议\n');

    // 1) Node → Rust 请求，Rust 回 ok:true
    bridge.request('doThing', { a: 1, b: '中文' }).then((data) => {
      bridge.send({ type: 'event', method: 'reqResult', params: { ok: true, data } });
    }).catch((e) => {
      bridge.send({ type: 'event', method: 'reqResult', params: { ok: false, code: e.code, message: e.message } });
    });

    // 2) Rust 一直不回：验证超时（200ms）
    bridge.request('noResponse', {}, { timeoutMs: 200 }).then(() => {
      bridge.send({ type: 'event', method: 'reqTimeout', params: { timedOut: false } });
    }).catch((e) => {
      bridge.send({ type: 'event', method: 'reqTimeout', params: { timedOut: true, code: e.code, message: e.message } });
    });

    // 3) 发一次 bye（模拟优雅退出前通知外壳）
    setTimeout(() => bridge.sendBye(0), 600);
  });
}

// ===========================================================================
// 父进程：模拟 Rust 外壳
// ===========================================================================
function runParent() {
  let pass = 0;
  const failures = [];
  const events = [];
  let sawBye = null;
  let sawReady = null;
  const reqs = [];
  let childExit = null;
  let child = null;
  let socket = null;
  let finished = false;

  const check = (name, fn) => {
    try { fn(); pass++; process.stdout.write(`  ✓ ${name}\n`); }
    catch (e) { failures.push({ name, error: (e && e.message) || String(e) }); process.stdout.write(`  ✗ ${name}\n      ${(e && e.message) || e}\n`); }
  };
  const eq = (a, b, label) => { if (a !== b) throw new Error(`${label || '值'}不相等：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
  const okTrue = (v, label) => { if (!v) throw new Error(`${label || '条件'}不成立`); };

  let pingRes = null;
  let splitRes = null;
  let unknownRes = null;
  let boomRes = null;

  const hardTimer = setTimeout(() => finish(new Error('测试超时（20 秒内未完成协议交互）')), 20000);
  hardTimer.unref();

  function finish(err) {
    if (finished) return;
    finished = true;
    clearTimeout(hardTimer);
    try { if (child) child.kill(); } catch { /* 忽略 */ }
    try { if (socket) socket.destroy(); } catch { /* 忽略 */ }
    try { server.close(); } catch { /* 忽略 */ }
    process.stdout.write('\n');
    if (err) { process.stdout.write(`  ✗ ${err.message}\n`); failures.push({ name: '整体流程', error: err.message }); }
    // ---------------- 断言 ----------------
    check('收到 ready 消息（含 internalAdminPort/dataDir/pid/webAdmin）', () => {
      okTrue(sawReady, 'ready 消息');
      eq(sawReady.internalAdminPort, 45678, 'internalAdminPort');
      eq(sawReady.dataDir, 'X:\\tmp\\desk-data', 'dataDir');
      eq(typeof sawReady.pid, 'number', 'pid 类型');
      eq(sawReady.webAdmin.enabled, false, 'webAdmin.enabled');
    });
    check('非桥输出行不破坏协议（之后仍有正常应答）', () => {
      okTrue(pingRes, '普通输出行之后的 ping 应答');
    });
    check('Node→Rust req 被正确解析，Rust→Node res 被正确消费', () => {
      const r = events.find((e) => e.method === 'reqResult');
      okTrue(r, '未收到 reqResult 事件');
      eq(r.params.ok, true, 'req 成功');
      eq(r.params.data.value, 42, 'res data 透传');
    });
    check('req 无响应 → 超时错误（EBRIDGE）', () => {
      const r = events.find((e) => e.method === 'reqTimeout');
      okTrue(r, '未收到 reqTimeout 事件');
      eq(r.params.timedOut, true, 'timedOut');
      eq(r.params.code, 'EBRIDGE', '错误码');
      okTrue(/超时/.test(r.params.message || ''), '错误信息含「超时」');
    });
    check('Rust→Node cmd 正常回 res（ok:true + data）', () => {
      okTrue(pingRes, 'ping 无响应');
      eq(pingRes.ok, true, 'ok');
      eq(pingRes.data.pong, 2, 'pong');
    });
    check('cmd 分片写入（一行拆两次写）能被重组', () => {
      okTrue(splitRes, '分片 cmd 无响应');
      eq(splitRes.ok, true, 'ok');
      eq(splitRes.data.pong, 6, 'pong');
    });
    check('未知 cmd → res ok:false + EMETHOD', () => {
      okTrue(unknownRes, '未知 cmd 无响应');
      eq(unknownRes.ok, false, 'ok:false');
      eq(unknownRes.error && unknownRes.error.code, 'EMETHOD', '错误码');
    });
    check('cmd 处理函数抛错 → res ok:false + 自定义 code', () => {
      okTrue(boomRes, 'boom 无响应');
      eq(boomRes.ok, false, 'ok:false');
      eq(boomRes.error && boomRes.error.code, 'EBOOM', '错误码');
    });
    check('bye 消息被 Rust 侧收到（code=0）', () => {
      okTrue(sawBye, '未收到 bye');
      eq(sawBye.code, 0, 'bye code');
    });
    check('EOF → onClose 触发、pending 请求被拒绝', () => {
      const closed = events.find((e) => e.method === 'childClosed');
      okTrue(closed, '未收到 childClosed');
      okTrue(/EOF|关闭/.test(closed.params.reason || ''), `关闭原因应含 EOF，实际：${closed.params.reason}`);
      const rej = events.find((e) => e.method === 'pendingRejected');
      okTrue(rej, '未收到 pendingRejected');
      eq(rej.params.code, 'EBRIDGE', 'pending 拒绝码');
    });
    check('子进程优雅退出（exit code 0）', () => {
      okTrue(childExit !== null, '子进程未退出');
      eq(childExit, 0, 'child exit code');
    });

    process.stdout.write(`\ndesktop-bridge-test：${pass} 个用例通过，${failures.length} 个失败\n`);
    if (failures.length) {
      for (const f of failures) process.stdout.write(`  ✗ ${f.name}\n      ${f.error}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  function send(msg) { dbg('parent send', msg.type, msg.method || '', msg.id || ''); try { socket.write(`${PREFIX}${JSON.stringify(msg)}\n`); } catch { /* 忽略 */ } }

  const server = net.createServer({ allowHalfOpen: true }, (sock) => {
    socket = sock;
    sock.setEncoding('utf8');
    sock.on('error', () => { /* 子进程退出时忽略 ECONNRESET */ });
    sock.on('end', () => dbg('parent socket end'));
    sock.on('close', () => dbg('parent socket close'));
    let buffer = '';
    sock.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith(PREFIX)) { dbg('parent recv raw line', JSON.stringify(line.slice(0, 80))); continue; }
        let msg = null;
        try { msg = JSON.parse(line.slice(PREFIX.length)); } catch { continue; }
        if (!msg || typeof msg !== 'object') continue;
        dbg('parent recv', msg.type, msg.method || '', msg.id || '');
        if (msg.type === 'ready') { sawReady = msg; continue; }
        if (msg.type === 'bye') { sawBye = msg; continue; }
        if (msg.type === 'req') {
          reqs.push(msg);
          if (msg.method === 'doThing') send({ type: 'res', id: msg.id, ok: true, data: { value: 42 } });
          // neverAnswered / noResponse 故意不回
          continue;
        }
        if (msg.type === 'event') {
          events.push(msg);
          if (msg.method === 'reqResult') {
            // 收到第一条要求后，注入坏行与分片 cmd，验证健壮性
            sock.write(`${PREFIX}{这不是合法 JSON}\n`);
            sock.write('不是桥协议的行\n');
            // 正常 cmd（先整行发，避免与后面的半行拼接）
            send({ type: 'cmd', id: 7, method: 'ping', params: { v: 1 } });
            send({ type: 'cmd', id: 8, method: 'unknownCmd', params: {} });
            send({ type: 'cmd', id: 11, method: 'boom', params: {} });
            // 最后单独分片写一条 cmd（半行先写，80ms 后写另一半）
            const cmd = JSON.stringify({ type: 'cmd', id: 9, method: 'ping', params: { v: 5 } });
            const half = Math.floor(cmd.length / 2);
            sock.write(`${PREFIX}${cmd.slice(0, half)}`);
            setTimeout(() => { try { sock.write(`${cmd.slice(half)}\n`); } catch { /* 忽略 */ } }, 80);
          }
          continue;
        }
        if (msg.type === 'res') {
          if (msg.id === 7) pingRes = msg;
          else if (msg.id === 9) splitRes = msg;
          else if (msg.id === 8) unknownRes = msg;
          else if (msg.id === 11) boomRes = msg;
          continue;
        }
      }
    });
  });

  server.on('error', (e) => finish(e));
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    child = spawn(process.execPath, [__filename, '--child', String(port)], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],   // 沙箱内 'pipe' 会 EPERM；协议本身走 TCP，子进程 stderr 直接继承便于调试
      windowsHide: true,
      env: { ...process.env },
    });
    child.on('exit', (code) => {
      childExit = code;
      // 等事件全部读完再断言
      setTimeout(() => finish(null), 120);
    });
    child.on('error', (e) => finish(e));
  });

  // 收到 reqTimeout 后关闭我方写端（模拟 Rust 退出 → Node 收到 EOF 优雅退出）
  const waitTimeoutEvent = setInterval(() => {
    if (events.some((e) => e.method === 'reqTimeout')) {
      clearInterval(waitTimeoutEvent);
      setTimeout(() => { try { if (socket) socket.end(); } catch { /* 忽略 */ } }, 400);
    }
  }, 50);
  waitTimeoutEvent.unref();
}

if (process.argv[2] === '--child') runChild(process.argv[3]);
else runParent();
