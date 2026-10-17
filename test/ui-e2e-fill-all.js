'use strict';
/*
 * 深度端到端检查（可选）：真机验证包管理页两个「全部包」批量入口 ——
 *   「全部包补 dist-tag 版本」/「全部包补最新版本」：不用勾选任何包，直接对镜像里所有包补 tarball。
 *
 * 断言链路：
 *   1) 工具栏两个按钮存在、文案正确
 *   2) 点「全部包补最新版本」→ 确认框（标题写明全部包 + 只补最新版本 + 包数）→ 点「开始补下载」
 *   3) 进度弹窗标题 = 「补 tarball · 全部包」，说明行写明「全部包」（可能还有「已跳过 N 个仅本地的包」）
 *   4) 跑完后：【取消下载】【后台运行】置灰不可点，多出一个只在跑完后出现的【关闭】，点它弹窗关闭
 *   5) 后端任务 result.scope === 'all'、标题含「全部包」、并跳过了仅本地的包（上传包/私有包）
 *   6) 点「全部包补 dist-tag 版本」也能弹出确认框（这次取消，不真的跑）
 *
 * 前置：服务已启动（node cli.js start --no-open）；本机有 Chrome/Edge；
 *      DSH 沙箱下需放宽权限执行（浏览器多进程依赖命名管道）。
 * 用法：node test/ui-e2e-fill-all.js [--base http://127.0.0.1:4873] [--shot 截图\全部包补tarball.png] [--port 9345]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const cfgPort = () => { try { return require('../src/config').get().server.port || 4873; } catch { return 4873; } };
const BASE = arg('base', `http://127.0.0.1:${cfgPort()}`).replace(/\/+$/, '');
const SHOT = arg('shot', path.join(__dirname, '..', '截图', '全部包补tarball.png'));
const TOKEN = process.env.MIRROR_TOKEN || (() => {
  try { return require('../src/config').get().security.token; } catch { return ''; }
})();
const POLL_MS = Number(arg('timeout', '60000'));
const CHROME = arg('chrome', [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'chrome.exe');
const PORT = Number(arg('port', '9345'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const H = TOKEN ? { 'X-Mirror-Token': TOKEN } : {};

let id = 0;
function rpc(ws, method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    const onMsg = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== mid) return;
      ws.removeEventListener('message', onMsg);
      if (m.error) reject(new Error(`${method}: ${m.error.message}`)); else resolve(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
}
async function evaluate(ws, expr) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页面异常：' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || JSON.stringify(r.exceptionDetails)));
  return r.result && r.result.value;
}
async function shot(ws, file) {
  await rpc(ws, 'Page.enable');
  const r = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return fs.statSync(file).size;
}
async function apiJSON(p, init) {
  const r = await fetch(BASE + p, Object.assign({ headers: H, signal: AbortSignal.timeout(60000) }, init || {}));
  return { status: r.status, body: await r.json().catch(() => null) };
}

/* 当前弹窗快照：标题 / 说明行 / 任务行文字 / 底部按钮状态 */
const SNAP = `(function(){
  var m = document.querySelector('#modal-root .modal');
  if (!m) return { open: false };
  var h3 = m.querySelector('.modal-head h3');
  var sub = m.querySelector('.modal-head .sub');
  var note = m.querySelector('.modal-body .muted');
  var stat = m.querySelector('.modal-body .fill-stat');
  var rows = [], trs = m.querySelectorAll('.tasklist .taskrow');
  for (var i = 0; i < trs.length; i++) {
    var n = trs[i].querySelector('.tr-name');
    rows.push(((n ? n.textContent : trs[i].textContent) || '').trim());
  }
  var btns = [], bs = m.querySelectorAll('.modal-foot button');
  for (var j = 0; j < bs.length; j++) btns.push({ label: (bs[j].textContent || '').trim(), disabled: !!bs[j].disabled, hidden: !!bs[j].hidden });
  return {
    open: true, title: (h3 ? h3.textContent : '').trim(), sub: (sub ? sub.textContent : '').trim(),
    note: (note ? note.textContent : '').trim(), stat: (stat ? stat.textContent : '').trim(),
    rows: rows, btns: btns,
    done: rows.some(function (r) { return r.indexOf('全部处理完毕') >= 0; })
  };
})()`;

async function main() {
  const checks = [];
  const check = (name, ok, extra) => { checks.push({ name: name, ok: !!ok, extra: extra || '' }); };

  const userDir = path.join(os.tmpdir(), 'dsh-fillall-cdp-' + Date.now().toString(36));
  console.log(`启动无头浏览器：${CHROME}`);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-crash-reporter', '--no-sandbox', '--window-size=1680,1050',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
    `${BASE}/#/packages`,
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await sleep(400);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
  }
  if (!wsUrl) { chrome.kill(); throw new Error('无法连接无头浏览器（CDP 端口无响应）'); }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
  });
  await rpc(ws, 'Runtime.enable');
  await rpc(ws, 'Page.enable');
  /* 无头浏览器刚起时，CDP 的 page target 可能还停在 about:blank / 正在导航，
   * 这时读写 localStorage 会抛 SecurityError；先等页面真正落到镜像源地址再继续 */
  let onApp = false;
  for (let i = 0; i < 40 && !onApp; i++) {
    const href = await evaluate(ws, `String(location.href)`).catch(() => '');
    if (href && href.indexOf(BASE) === 0) onApp = true;
    else await sleep(300);
  }
  if (!onApp) {
    await rpc(ws, 'Page.navigate', { url: `${BASE}/#/packages` }).catch(() => null);
    await sleep(1500);
  }
  if (TOKEN) {
    await evaluate(ws, `localStorage.setItem('npm-mirror-token', ${JSON.stringify(TOKEN)}); location.reload(); 1`);
    await sleep(1500);
  }
  let rowsReady = 0;
  for (let i = 0; i < 60; i++) {
    rowsReady = await evaluate(ws, `document.querySelectorAll('#pkg-tbody input[data-name]').length`).catch(() => 0);
    if (rowsReady > 0) break;
    await sleep(300);
  }
  check('包管理页渲染出行（带 data-name 的勾选框）', rowsReady > 0, `rows=${rowsReady}`);

  const btns = await evaluate(ws, `(function(){
    var a = document.getElementById('pkg-fill-tags-all'), b = document.getElementById('pkg-fill-latest-all'), c = document.getElementById('pkg-fill-all-all');
    return { tags: a ? (a.textContent||'').trim() : null, latest: b ? (b.textContent||'').trim() : null,
             all: c ? (c.textContent||'').trim() : null, ids: !!a && !!b && !!c };
  })()`);
  check('工具栏有「全部包补 dist-tag 版本」按钮', btns.ids && /全部包补 dist-tag 版本/.test(btns.tags || ''), String(btns.tags));
  check('工具栏有「全部包补最新版本」按钮', btns.ids && /全部包补最新版本/.test(btns.latest || ''), String(btns.latest));
  check('工具栏有「全部包补全部版本」按钮', btns.ids && /全部包补全部版本/.test(btns.all || ''), String(btns.all));

  // ---- 「缺 tarball / 不缺 tarball」快捷筛选：真机点一下，断言列表真的按徽标过滤，再点同一个按钮回到全部
  const tbState = () => evaluate(ws, `(function(){
    var segs = document.querySelectorAll('#pkg-tb [data-tb]');
    var on = null;
    for (var i = 0; i < segs.length; i++) if (segs[i].classList.contains('is-on')) on = segs[i].getAttribute('data-tb');
    var rows = document.querySelectorAll('#pkg-tbody tr');
    var badges = 0;
    for (var j = 0; j < rows.length; j++) if ((rows[j].textContent || '').indexOf('缺 tarball') >= 0) badges++;
    var pager = document.getElementById('pkg-pager');
    return { on: on, rows: rows.length, badges: badges, pager: pager ? (pager.textContent || '').trim().slice(0, 48) : '' };
  })()`);
  const clickTb = v => evaluate(ws, `(function(){ var b = document.querySelector('#pkg-tb [data-tb="${v}"]'); if (b) b.click(); return !!b; })()`);
  const waitTb = async (fn, ms) => {
    let st = null;
    for (let i = 0; i < Math.ceil((ms || 8000) / 250); i++) {
      await sleep(250);
      st = await tbState();
      if (st && fn(st)) return st;
    }
    return st;
  };
  const tb0 = await tbState();
  check('工具栏有「缺 tarball / 不缺 tarball」两个分段按钮（默认都不选中）', tb0 && tb0.on === null && tb0.rows > 0, JSON.stringify(tb0));
  await clickTb('missing');
  const tbM = await waitTb(s => s.on === 'missing' && s.rows > 0 && s.badges === s.rows);
  check('点「缺 tarball」后列表只剩缺 tarball 的包（每行都带徽标）', !!tbM && tbM.on === 'missing' && (tbM.rows === 0 || tbM.badges === tbM.rows), JSON.stringify(tbM));
  await clickTb('complete');
  const tbC = await waitTb(s => s.on === 'complete' && s.rows > 0 && s.badges === 0);
  check('点「不缺 tarball」后列表只剩齐全的包（行内没有缺 tarball 徽标）', !!tbC && tbC.on === 'complete' && (tbC.rows === 0 || tbC.badges === 0), JSON.stringify(tbC));
  await clickTb('complete');
  const tbBack = await waitTb(s => s.on === null && s.rows > 0);
  check('再点一次同一个按钮取消筛选、回到全部包', !!tbBack && tbBack.on === null && tbBack.rows > 0, JSON.stringify(tbBack));

  // ---- 自绘悬浮提示：真机悬停，断言不再用浏览器原生 title、浮层按项目风格显示并自动隐藏
  const tipState = () => evaluate(ws, `(function(){
    var t = document.querySelector('.ui-tip');
    var on = !!(t && t.classList.contains('on'));
    var r = t ? t.getBoundingClientRect() : null;
    return {
      nativeTitles: document.querySelectorAll('[title]').length,
      tips: document.querySelectorAll('[data-tip]').length,
      on: on, text: t ? (t.textContent || '') : '',
      rect: r ? { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) } : null,
      vw: window.innerWidth, vh: window.innerHeight
    };
  })()`);
  const hover = async (sel) => {
    const box = await evaluate(ws, `(function(){ var n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null;
      var r = n.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(r.width / 2, 24)), y: Math.round(r.top + r.height / 2) }; })()`);
    if (!box) return null;
    await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
    for (let i = 0; i < 16; i++) {
      await sleep(120);
      const st = await tipState();
      if (st && st.on) return st;
    }
    return await tipState();
  };
  const waitTipGone = async () => {
    for (let i = 0; i < 16; i++) {
      const st = await tipState();
      if (st && !st.on) return st;
      await sleep(120);
    }
    return await tipState();
  };
  const tip0 = await tipState();
  check('页面不再用浏览器原生 title 提示（提示都走自绘浮层）', tip0 && tip0.nativeTitles === 0 && tip0.tips > 0, JSON.stringify({ nativeTitles: tip0 && tip0.nativeTitles, tips: tip0 && tip0.tips }));
  await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, buttons: 0 });
  const tipHover = await hover('#chip-mode');
  const inView = tipHover && tipHover.rect && tipHover.rect.l >= 0 && tipHover.rect.t >= 0 && tipHover.rect.r <= tipHover.vw && tipHover.rect.b <= tipHover.vh;
  check('悬停顶栏「运行模式」出现自绘浮层，文案正确且完整落在视口内',
    !!(tipHover && tipHover.on && /运行模式/.test(tipHover.text) && inView), JSON.stringify(tipHover && { text: tipHover.text, rect: tipHover.rect, vw: tipHover.vw, vh: tipHover.vh }));
  await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, buttons: 0 });
  const tipGone = await waitTipGone();
  check('鼠标移开后自绘浮层自动隐藏', !!(tipGone && !tipGone.on), JSON.stringify(tipGone && { on: tipGone.on }));

  try {
    // ---- 全部包补最新版本
    await evaluate(ws, `document.getElementById('pkg-fill-latest-all').click(); 1`);
    let confirm = null;
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      confirm = await evaluate(ws, SNAP);
      if (confirm && confirm.open) break;
    }
    check('点「全部包补最新版本」弹出确认框', !!(confirm && confirm.open), JSON.stringify(confirm && { title: confirm.title, note: confirm.note }));
    check('确认框标题写明「全部包 · 只补最新版本」', /全部包/.test((confirm && confirm.title) || '') && /只补最新版本/.test((confirm && confirm.title) || ''), confirm && confirm.title);
    check('确认框说明里带镜像全量包数', /个包/.test((confirm && confirm.note) || ''), confirm && confirm.note);

    // 记录点击前已有的任务 id + 镜像全量包数：后面只认本次运行新建的 pull 任务，并用全量数核对规划数
    const tasksBefore = new Set();
    try {
      const tl0 = await apiJSON('/__admin/api/tasks');
      for (const t of ((((tl0.body || {}).data) || {}).items || [])) tasksBefore.add(t.id);
    } catch { /* 忽略 */ }
    const pkg0 = await apiJSON('/__admin/api/packages?size=1');
    const mirrorTotal = Number((((pkg0.body || {}).data) || {}).total || 0);

    const startOk = await evaluate(ws, `(function(){
      var bs = document.querySelectorAll('#modal-root .modal .modal-foot button');
      for (var i = 0; i < bs.length; i++) if ((bs[i].textContent||'').indexOf('开始补下载') >= 0) { bs[i].click(); return true; }
      return false;
    })()`);
    check('点「开始补下载」进入进度弹窗', !!startOk);

    // 右栏必须是「版本进度」：每个正在并发下载的 tarball 一条，显示自身已收/总共字节（不是包级版本计数）
    const rightPane = await evaluate(ws, `(function(){
      var h = document.querySelector('#modal-root .fill-col-right .fill-col-head');
      var rows = document.querySelectorAll('#modal-root .fill-col-right .fill-run .taskrow');
      return {
        head: h ? (h.textContent||'').trim() : '',
        rows: rows.length,
        texts: Array.prototype.map.call(rows, function(r){ return (r.textContent||'').trim(); }).slice(0, 4)
      };
    })()`);
    check('进度弹窗右栏标题是「正在下载 · 版本进度」', /版本进度/.test(rightPane.head || ''), rightPane.head);
    check('版本进度行显示单文件的「已下载 / 总共」字节（有正在下的版本时）',
      rightPane.rows === 0 || rightPane.texts.some(x => /\//.test(x) && /(B|KB|MB|GB)/.test(x)),
      `rows=${rightPane.rows} texts=${JSON.stringify(rightPane.texts)}`);

    // ---- 进度弹窗：标题 / 说明 / 跑完后的按钮状态
    let snap = null, finishedSnap = null;
    const t0 = Date.now();
    while (Date.now() - t0 < POLL_MS) {
      await sleep(300);
      snap = await evaluate(ws, SNAP);
      if (!snap || !snap.open) { await sleep(200); continue; }
      if (snap.done) { finishedSnap = snap; break; }
    }
    snap = finishedSnap || snap || { open: false };
    check('进度弹窗标题是「补 tarball · 全部包」', /补 tarball/.test(snap.title || '') && /全部包/.test(snap.title || ''), snap.title);
    check('说明行写明「全部包」（并提示跳过仅本地的包）', /全部包/.test(snap.note || ''), snap.note);
    check('跑完后出现「全部处理完毕」汇总行', !!snap.done, (snap.rows || []).join(' | ').slice(0, 160));

    const btnOf = (label) => ((snap.btns || []).find(b => b.label === label) || null);
    const cancel = btnOf('取消下载'), bg = btnOf('后台运行'), close = btnOf('关闭');
    check('跑完后【取消下载】置灰不可点', !!cancel && cancel.disabled === true, JSON.stringify(cancel));
    check('跑完后【后台运行】置灰不可点', !!bg && bg.disabled === true, JSON.stringify(bg));
    check('跑完后多出可点的【关闭】按钮', !!close && close.disabled === false && close.hidden === false, JSON.stringify(close));

    const shotSize = await shot(ws, SHOT);
    check(`截图已保存（${path.basename(SHOT)}）`, shotSize > 10000, `${shotSize} 字节`);

    const closed = await evaluate(ws, `(function(){
      var bs = document.querySelectorAll('#modal-root .modal .modal-foot button');
      for (var i = 0; i < bs.length; i++) if ((bs[i].textContent||'').trim() === '关闭') { bs[i].click(); return true; }
      return false;
    })()`);
    await sleep(400);
    const stillOpen = await evaluate(ws, `!!document.querySelector('#modal-root .modal')`);
    check('点【关闭】能关掉进度弹窗（不影响原有自动关闭/失败不关闭逻辑）', !!closed && !stillOpen, `closed=${closed} stillOpen=${stillOpen}`);

    // ---- 后端任务确实是「全部包」作用域，且跳过了仅本地的包
    const tl = await apiJSON('/__admin/api/tasks');
    const items = ((tl.body || {}).data || {}).items || [];
    // 只认本次运行新建的 pull 任务（旧实现取列表首个 pull，会命中历史旧任务、核对错对象）
    const newPulls = items.filter(t => t.type === 'pull' && !tasksBefore.has(t.id))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const pull = newPulls[0] || null;
    let detail = null;
    if (pull) {
      const g = await apiJSON('/__admin/api/tasks/' + pull.id);
      detail = ((g.body || {}).data) || null;
    }
    const res = (detail && detail.result) || {};
    check('后端任务标题含「全部包」（本次运行新建的任务）', !!detail && /全部包/.test(String(detail.title || '')), detail && detail.title);
    check('任务结果 scope=all（服务端按镜像里所有包规划，不是前端塞名单）', res.scope === 'all', `scope=${res.scope}`);
    const planned = Number((res.packages || []).length);
    const skipped = Number(res.skippedLocal || 0);
    check('全部包模式覆盖镜像全量包、只跳过仅本地的包（规划数 + 跳过本地数 = 镜像包总数）',
      res.scope === 'all' && mirrorTotal > 0 && planned + skipped === mirrorTotal,
      `规划=${planned} + 跳过本地=${skipped} / 镜像全量=${mirrorTotal}`);

    // ---- 真机验证「版本进度」：再跑一次补全部版本，等右栏出现「已下载 / 总共」字节数，截图后取消
    try {
      const tasksBefore2 = new Set();
      const tl2 = await apiJSON('/__admin/api/tasks');
      for (const t of ((((tl2.body || {}).data) || {}).items || [])) tasksBefore2.add(t.id);
      await evaluate(ws, `document.getElementById('pkg-fill-all-all').click(); 1`);
      let confirmAll = null;
      for (let i = 0; i < 40; i++) {
        await sleep(200);
        confirmAll = await evaluate(ws, SNAP);
        if (confirmAll && confirmAll.open) break;
      }
      check('点「全部包补全部版本」弹出确认框（用于版本进度真机验证）', !!(confirmAll && confirmAll.open));
      await evaluate(ws, `(function(){
        var bs = document.querySelectorAll('#modal-root .modal .modal-foot button');
        for (var i = 0; i < bs.length; i++) if (/(开始补下载|确认补)/.test(bs[i].textContent||'')) { bs[i].click(); return true; }
        return false;
      })()`);

      let bytesRow = null;
      const t1 = Date.now();
      while (Date.now() - t1 < 25000) {
        await sleep(350);
        const info = await evaluate(ws, `(function(){
          var rows = document.querySelectorAll('#modal-root .fill-col-right .fill-run .taskrow');
          var texts = Array.prototype.map.call(rows, function(r){ return (r.textContent||'').trim(); });
          return { rows: rows.length, texts: texts.slice(0, 8) };
        })()`).catch(() => null);
        if (!info) continue;
        const hit = (info.texts || []).find(x => x.indexOf(' / ') >= 0 && /(B|KB|MB|GB)/.test(x));
        if (hit) { bytesRow = hit; console.log('右栏示例：' + JSON.stringify(info.texts.slice(0, 3))); break; }
      }
      check('版本进度行真的显示单文件实时字节（如「3.08 MB / 8.84 MB（35%）· 3.65 MB/秒」）',
        !!bytesRow, bytesRow || '25 秒内没等到字节数');
      const midShot = await shot(ws, SHOT);
      check(`真机截图已保存（${path.basename(SHOT)}）`, midShot > 10000, `${midShot} 字节`);

      await evaluate(ws, `(function(){
        var bs = document.querySelectorAll('#modal-root .modal .modal-foot button');
        for (var i = 0; i < bs.length; i++) if ((bs[i].textContent||'').indexOf('取消下载') >= 0) { bs[i].click(); return true; }
        return false;
      })()`);
      await sleep(800);
      const tl3 = await apiJSON('/__admin/api/tasks');
      for (const t of ((((tl3.body || {}).data) || {}).items || [])) {
        if (t.type === 'pull' && !tasksBefore2.has(t.id)) await apiJSON('/__admin/api/tasks/' + t.id + '/cancel', { method: 'POST' });
      }
      for (let i = 0; i < 40; i++) {
        await sleep(300);
        const tl4 = await apiJSON('/__admin/api/tasks');
        const mine = ((((tl4.body || {}).data) || {}).items || []).filter(t => t.type === 'pull' && !tasksBefore2.has(t.id));
        if (!mine.some(t => t.status === 'running')) break;
      }
      await sleep(300);
      const closed2 = await evaluate(ws, `(function(){
        var bs = document.querySelectorAll('#modal-root .modal .modal-foot button');
        for (var i = 0; i < bs.length; i++) if ((bs[i].textContent||'').trim() === '关闭') { bs[i].click(); return true; }
        return false;
      })()`);
      await sleep(300);
      check('版本进度真机验证后弹窗能正常关闭/收尾', !!closed2 || !(await evaluate(ws, `!!document.querySelector('#modal-root .modal')`)));
    } catch (e) {
      check('版本进度真机验证（不因验证本身失败而中断主流程）', false, (e && e.message) || String(e));
    }

    // ---- 另一个入口：确认框能弹出（这次取消）
    await evaluate(ws, `document.getElementById('pkg-fill-tags-all').click(); 1`);
    let confirm2 = null;
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      confirm2 = await evaluate(ws, SNAP);
      if (confirm2 && confirm2.open) break;
    }
    check('点「全部包补 dist-tag 版本」弹出确认框（标题含 dist-tag）',
      !!(confirm2 && confirm2.open) && /全部包/.test(confirm2.title || '') && /dist-tag/.test(confirm2.title || ''), confirm2 && confirm2.title);
    await evaluate(ws, `(function(){
      var bs = document.querySelectorAll('#modal-root .modal .modal-foot button');
      for (var i = 0; i < bs.length; i++) if ((bs[i].textContent||'').trim() === '取消') { bs[i].click(); return true; }
      return false;
    })()`);
    await sleep(400);
    const gone = await evaluate(ws, `!document.querySelector('#modal-root .modal')`);
    check('取消后确认框关闭（不会真的开跑）', !!gone);

    // ---- 第三个入口：全部包补全部版本（只验证确认框就取消，绝不真的开跑：全部版本下载量最大）
    await evaluate(ws, `document.getElementById('pkg-fill-all-all').click(); 1`);
    let confirm3 = null;
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      confirm3 = await evaluate(ws, SNAP);
      if (confirm3 && confirm3.open) break;
    }
    check('点「全部包补全部版本」弹出确认框（标题写明补全部版本）',
      !!(confirm3 && confirm3.open) && /全部版本/.test(confirm3.title || ''),
      JSON.stringify({ title: confirm3 && confirm3.title, note: (confirm3 && confirm3.note || '').slice(0, 120) }));
    // SNAP.note 只取第一个 .muted（这里是 detail），确认框的正文（message）要单独取整个 modal-body 看
    const body3 = await evaluate(ws, `(function(){
      var b = document.querySelector('#modal-root .modal .modal-body');
      return b ? (b.textContent || '').replace(/\\s+/g, ' ').trim() : '';
    })()`);
    check('确认框正文写明补「所有缺失版本」，并给出未缓存版本数估计',
      /所有缺失版本/.test(body3 || '') && /个版本的 tarball 没缓存/.test(body3 || ''),
      String(body3 || '').slice(0, 160));
    await evaluate(ws, `(function(){
      var bs = document.querySelectorAll('#modal-root .modal .modal-foot button');
      for (var i = 0; i < bs.length; i++) if ((bs[i].textContent||'').trim() === '取消') { bs[i].click(); return true; }
      return false;
    })()`);
    await sleep(400);
    const gone3 = await evaluate(ws, `!document.querySelector('#modal-root .modal')`);
    check('取消后确认框关闭（不会真的去补全部版本）', !!gone3);
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    chrome.kill();
  }

  console.log('');
  for (const c of checks) console.log(`  ${c.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${c.name}${c.extra ? '  ' + c.extra : ''}`);
  const bad = checks.filter(c => !c.ok).length;
  console.log(`\n结果：${checks.length - bad} 项通过，${bad} 项失败${bad ? '（上面带 ✗ 的行是失败项）' : '（全部通过）'}\n`);
  process.exitCode = bad ? 1 : 0;
  setTimeout(() => process.exit(bad ? 1 : 0), 300);
}

main().catch(e => { console.error('真机检查异常：', e && e.message || e); process.exitCode = 1; setTimeout(() => process.exit(1), 300); });
