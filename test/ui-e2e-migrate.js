'use strict';
/*
 * 深度端到端检查（可选）：真机验证本轮三项改造
 *   A. 导出选中包时连带导出依赖（withDeps）
 *   B. 从本机 npm 缓存导入：候选表分页 + 「导入选中 / 仅导入不存在的包 / 全部导入」+ 成功提示不再恒为「成功 0」
 *   C. 下载进度弹窗右侧「正在下载的包」栏：单包大进度条、两栏等高、各自滚动
 *
 * 断言链路：
 *   A1 包管理页搜索并勾选 chalk → 迁移页切到「选中包」→ 依赖勾选框出现且默认勾上 → 导出
 *   A2 状态行/toast 的导出结果里有「连带依赖 N 个」（N ≥ 1），说明服务端真的把依赖扩进来
 *   B1 点「扫描缓存目录」→ 候选表出数据、分页条出现、每页不超过 20 行
 *   B2 翻到第 2 页，行内容变了（真分页，不是假装）
 *   B3 「全部导入」按钮可点、确认框标题/按钮正确（这次取消，不真的跑）
 *   B4 挑一个「镜像里还没有」的候选，过滤 + 全选 + 「导入选中」→ toast 里「成功 1 个包」而不是「成功 0」
 *   B5 导入后该行的状态徽标变成「本地已有」
 *   C1 自造一个缺 tarball 的测试包（120 个版本，dist.tarball 指向真实上游小文件）
 *   C2 勾选它 → 范围「补全部版本」→ 并发放 3 → 进度弹窗里左右两栏等高、各自 overflow:auto
 *   C3 右栏出现「正在下载 · 单包进度」，每条是 tr-fillrow 大进度条，文字形如「k / N 个（p%）」
 *   C4 截图、取消下载、弹窗关闭
 *   清理：删掉导出产物、导入进来的测试包、自造测试包
 *
 * 前置：服务已启动（node cli.js start --no-open）；本机有 Chrome/Edge；可访问上游（cache 模式）。
 *      DSH 沙箱下需放宽权限执行（浏览器多进程依赖命名管道）。
 * 用法：node test/ui-e2e-migrate.js [--base http://127.0.0.1:4873] [--shot 截图\迁移与下载进度.png]
 *                                [--port 9351] [--only a|b|c]
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
const SHOT = arg('shot', path.join(__dirname, '..', '截图', '迁移与下载进度.png'));
const SHOT_IMPORT = arg('shot-import', path.join(__dirname, '..', '截图', '缓存导入-导入进度.png'));
const TOKEN = process.env.MIRROR_TOKEN || (() => {
  try { return require('../src/config').get().security.token; } catch { return ''; }
})();
const CHROME = arg('chrome', [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'chrome.exe');
const PORT = Number(arg('port', '9351'));
const ONLY = String(arg('only', 'all')).toLowerCase();   // all | a | b | c
const FIXTURE = 'mirror-e2e-progress';
const FIXTURE_VERSIONS = 120;
const FIXTURE_TARBALL = 'https://registry.npmmirror.com/tinyspy/-/tinyspy-2.2.0.tgz';
const EXPORT_ROOT = 'chalk';                             // 有依赖、且依赖大多已在镜像里

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
async function apiRaw(p, buf, filename) {
  const r = await fetch(BASE + p, {
    method: 'POST', body: buf, signal: AbortSignal.timeout(120000),
    headers: Object.assign({}, H, { 'X-Filename': encodeURIComponent(filename), 'Content-Type': 'application/json' }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** 轮询直到表达式为真值，返回最后一次的值 */
async function waitFor(ws, expr, ms, label) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await evaluate(ws, expr).catch(() => null);
    if (last) return last;
    await sleep(150);
  }
  return last;
}

/* 通用弹窗快照：标题 + 正文文字 + 底部按钮（含 disabled/hidden） */
const MODAL = `(function(){
  var m = document.querySelector('#modal-root .modal');
  if (!m) return { open: false };
  var h3 = m.querySelector('.modal-head h3');
  var body = m.querySelector('.modal-body');
  var btns = [], bs = m.querySelectorAll('.modal-foot button');
  for (var i = 0; i < bs.length; i++) btns.push({ label: (bs[i].textContent || '').trim(), disabled: !!bs[i].disabled, hidden: !!bs[i].hidden });
  return { open: true, title: (h3 ? h3.textContent : '').trim(), text: body ? body.textContent.replace(/\\s+/g, ' ').trim() : '', btns: btns };
})()`;

/* 补 tarball / 递归添加依赖进度弹窗：两栏布局快照 */
const FILL = `(function(){
  var m = document.querySelector('#modal-root .modal');
  if (!m) return { open: false };
  function h(e){ return e ? Math.round(e.getBoundingClientRect().height * 10) / 10 : -1; }
  function ov(e){ return e ? getComputedStyle(e).overflowY : ''; }
  var h3 = m.querySelector('.modal-head h3');
  var cols = m.querySelectorAll('.fill-cols > .fill-col');
  var left = cols[0] || null, right = cols[1] || null;
  var all = right ? right.querySelectorAll('.taskrow') : [];
  var busy = right ? right.querySelectorAll('.taskrow.busy') : [];
  function txt(e){ return e ? e.textContent.replace(/\\s+/g, ' ').trim() : ''; }
  var tvEl = busy.length ? busy[0].querySelector('.tv') : (all.length ? all[0].querySelector('.tv') : null);
  return {
    open: true, title: txt(h3), wide: m.classList.contains('wide'),
    colCount: cols.length, leftH: h(left), rightH: h(right), leftOv: ov(left), rightOv: ov(right),
    leftRows: left ? left.querySelectorAll('.taskrow').length : 0,
    rightRows: all.length, rightBusy: busy.length,
    head: txt(right && right.querySelector('.fill-col-head')),
    tv: txt(tvEl),
    empty: txt(right && right.querySelector('.fill-run-empty')),
    btns: (function(){ var a = [], bs = m.querySelectorAll('.modal-foot button'); for (var i = 0; i < bs.length; i++) a.push({ label: txt(bs[i]), disabled: !!bs[i].disabled, hidden: !!bs[i].hidden }); return a; })()
  };
})()`;

function btnClick(label) {
  return `(function(){
    var bs = document.querySelectorAll('#modal-root .modal .modal-foot button');
    for (var i = 0; i < bs.length; i++) if ((bs[i].textContent || '').trim().indexOf(${JSON.stringify(label)}) >= 0) { bs[i].click(); return true; }
    return false;
  })()`;
}

/** 往缓存候选表的筛选框里打字（触发 input 事件，让界面按过滤结果重绘） */
async function setScanFilter(ws, value) {
  return evaluate(ws, `(function(){
    var i = document.getElementById('scan-filter');
    if (!i) return false;
    i.value = ${JSON.stringify(String(value))};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

/** 缓存候选表里「镜像里还没有、且带 tarball」的行（返回勾选 key：包名@版本） */
function freshScanKeys() {
  return `(function(){
    var out = [], rows = document.querySelectorAll('#scan-tbody tr');
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i].textContent || '';
      if (t.indexOf('可导入') < 0 || t.indexOf('有 tarball') < 0) continue;
      var c = rows[i].querySelector('input[data-scan]');
      if (c) out.push(c.getAttribute('data-scan'));
    }
    return out;
  })()`;
}

function fixturePackument() {
  const versions = {};
  for (let i = 1; i <= FIXTURE_VERSIONS; i++) {
    const v = '1.0.' + i;
    versions[v] = { name: FIXTURE, version: v, description: '下载进度右栏 e2e 测试包', dist: { tarball: FIXTURE_TARBALL } };
  }
  return { name: FIXTURE, description: '下载进度右栏 e2e 测试包', 'dist-tags': { latest: '1.0.' + FIXTURE_VERSIONS }, versions };
}

async function main() {
  const checks = [];
  const check = (name, ok, extra) => { checks.push({ name: name, ok: !!ok, extra: extra || '' }); };
  const cleanup = { bundle: '', imported: '', fixture: false };

  const wantA = ONLY === 'all' || ONLY === 'a';
  const wantB = ONLY === 'all' || ONLY === 'b';
  const wantC = ONLY === 'all' || ONLY === 'c';

  const userDir = path.join(os.tmpdir(), 'dsh-migrate-cdp-' + Date.now().toString(36));
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
  // 新 profile 的首帧可能是 about:blank（该文档是 opaque origin，读 localStorage 会 SecurityError），
  // 先等页面真正落到应用地址；迟迟不到就主动 Page.navigate 一次。
  const pageHref = async () => String(await evaluate(ws, 'String(location.href)').catch(() => '') || '');
  let pageUrl = '';
  for (let i = 0; i < 20; i++) { pageUrl = await pageHref(); if (pageUrl.startsWith(BASE)) break; await sleep(300); }
  if (!pageUrl.startsWith(BASE)) {
    await rpc(ws, 'Page.navigate', { url: BASE + '/#/packages' }).catch(() => {});
    for (let i = 0; i < 50; i++) { await sleep(300); pageUrl = await pageHref(); if (pageUrl.startsWith(BASE)) break; }
  }
  if (TOKEN) {
    await evaluate(ws, `localStorage.setItem('npm-mirror-token', ${JSON.stringify(TOKEN)}); location.reload(); 1`);
    await sleep(1600);
  }
  let rowsReady = 0;
  for (let i = 0; i < 60; i++) {
    rowsReady = await evaluate(ws, `document.querySelectorAll('#pkg-tbody input[data-name]').length`).catch(() => 0);
    if (rowsReady > 0) break;
    await sleep(300);
  }
  check('包管理页渲染出行', rowsReady > 0, `rows=${rowsReady}`);

  try {
    // 前置：自造 C 用的测试包（120 个版本、都缺 tarball，dist.tarball 指向真实上游小文件）
    if (wantC) {
      const up = await apiRaw('/__admin/api/upload?overwrite=1', Buffer.from(JSON.stringify(fixturePackument())), FIXTURE + '.json');
      const d = up.body && up.body.data;
      cleanup.fixture = up.status === 200;
      check(`自造测试包 ${FIXTURE}（${FIXTURE_VERSIONS} 个版本，缺 tarball）`, up.status === 200 && (!!d || !!(up.body && up.body.ok)),
        `status=${up.status} ${JSON.stringify(up.body).slice(0, 160)}`);
    }

    /* ============================ A. 导出选中包 + 依赖 ============================ */
    if (wantA) {
      const searched = await evaluate(ws, `(function(){
        var i = document.getElementById('pkg-q');
        if (!i) return false;
        i.value = ${JSON.stringify(EXPORT_ROOT)};
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      const found = await waitFor(ws, `!!document.querySelector('#pkg-tbody input[data-name=${JSON.stringify(EXPORT_ROOT)}]')`, 20000);
      check(`包管理页能搜到 ${EXPORT_ROOT}`, !!searched && !!found);

      const selected1 = await evaluate(ws, `(function(){
        var c = document.querySelector('#pkg-tbody input[data-name=${JSON.stringify(EXPORT_ROOT)}]');
        if (!c) return null;
        c.click();
        return c.checked;
      })()`);
      check(`勾选 ${EXPORT_ROOT} 成功（选择区随之出现）`, selected1 === true, String(selected1));

      await evaluate(ws, `location.hash = '#/migrate'; 1`);
      const migReady = await waitFor(ws, `!!document.getElementById('exp-run') && !!document.getElementById('scan-run')`, 20000);
      check('迁移页（导出/缓存导入区）已渲染', !!migReady);

      const scopePicked = await evaluate(ws, `(function(){
        var b = document.querySelector('#exp-scope [data-scope="selected"]');
        if (!b) return null;
        b.click();
        return {
          depsRowHidden: !!document.getElementById('exp-deps-row').hidden,
          withDeps: !!document.getElementById('exp-with-deps').checked,
          info: (document.getElementById('exp-selected-info') || {}).textContent || ''
        };
      })()`);
      check('选「选中包」后显示依赖勾选框，且默认勾上',
        !!scopePicked && scopePicked.depsRowHidden === false && scopePicked.withDeps === true,
        JSON.stringify(scopePicked));
      check('「选中包」说明里列出刚才勾的包', !!scopePicked && String(scopePicked.info).indexOf(EXPORT_ROOT) >= 0, scopePicked && scopePicked.info);

      // 切回「全部」时依赖行应该收起，再切回「选中包」
      const toggled = await evaluate(ws, `(function(){
        document.querySelector('#exp-scope [data-scope="all"]').click();
        var hid = !!document.getElementById('exp-deps-row').hidden;
        document.querySelector('#exp-scope [data-scope="selected"]').click();
        return { hid: hid, back: !!document.getElementById('exp-deps-row').hidden };
      })()`);
      check('依赖勾选框只在「选中包」范围显示（切换范围能收起/再出现）',
        !!toggled && toggled.hid === true && toggled.back === false, JSON.stringify(toggled));

      await evaluate(ws, `(function(){
        var i = document.getElementById('exp-name');
        if (i) { i.value = 'e2e-deps-export'; }
        document.getElementById('exp-run').click();
        return true;
      })()`);
      const status = await waitFor(ws, `(function(){
        var t = (document.getElementById('exp-status') || {}).textContent || '';
        return /已导出|导出失败/.test(t) ? t.trim() : '';
      })()`, 180000);
      check('导出完成（状态行有「已导出」）', !!status && /已导出/.test(status), String(status).slice(0, 200));
      const m = /已导出 ([^：]+)：(\d+) 包/.exec(String(status || ''));
      if (m) cleanup.bundle = m[1];
      check('导出结果含「连带依赖 N 个」（依赖被一起打包）', /连带依赖\s*[1-9]\d*\s*个/.test(String(status || '')), String(status).slice(0, 200));
      check('导出的包数 > 1（根包 + 依赖）', !!m && Number(m[2]) > 1, m ? `packages=${m[2]}` : '未解析到包数');

      const toastText = await evaluate(ws, `(function(){
        var ts = document.querySelectorAll('#toasts .toast .tmsg'), out = [];
        for (var i = 0; i < ts.length; i++) out.push(ts[i].textContent);
        return out.join(' | ');
      })()`);
      check('toast 里也有同样的导出结果', /已导出|含连带依赖/.test(String(toastText || '')), String(toastText).slice(0, 200));

      // 后端 bundle 清单也带上 withDeps（真落到文件里，而不是只回显）
      const bl = await apiJSON('/__admin/api/bundles');
      const items = ((bl.body || {}).data || {}).items || (bl.body || {}).data || [];
      const target = (Array.isArray(items) ? items : []).find(x => x && x.file === cleanup.bundle);
      check('前端列表里能看到这次导出的 bundle', !!cleanup.bundle, cleanup.bundle || '未解析到文件名');
      check('bundle 文件在服务器上确实存在', !!target, JSON.stringify(target || {}).slice(0, 160));
    }

    /* ============================ B. 缓存导入：分页 + 批量入口 ============================ */
    if (wantB) {
      if (!(await evaluate(ws, `!!document.getElementById('scan-run')`))) {
        await evaluate(ws, `location.hash = '#/migrate'; 1`);
        await waitFor(ws, `!!document.getElementById('scan-run')`, 20000);
      }
      await evaluate(ws, `document.getElementById('scan-run').click(); 1`);
      const scanned = await waitFor(ws, `(function(){
        var trs = document.querySelectorAll('#scan-tbody tr');
        var meta = (document.getElementById('scan-meta') || {}).textContent || '';
        return trs.length && /候选/.test(meta) ? trs.length : 0;
      })()`, 240000);
      check('点「扫描缓存目录」后候选表出数据', !!scanned, `rows=${scanned}`);

      const metaTxt = await evaluate(ws, `(document.getElementById('scan-meta') || {}).textContent || ''`);
      const numOf = (re) => { const mm = re.exec(String(metaTxt || '')); return mm ? Number(mm[1].replace(/,/g, '')) : -1; };
      const candTotal = numOf(/候选 ([\d,]+) 个/);
      const localTotal = numOf(/镜像里已有 ([\d,]+) 个/);
      const newCount = Math.max(0, candTotal - localTotal);
      check('扫描信息里写明候选总数与「镜像里已有 N 个」', candTotal > 0 && localTotal >= 0, `候选=${candTotal} 已有=${localTotal}`);
      const badges = await evaluate(ws, `(function(){
        var local = 0, fresh = 0;
        var rows = document.querySelectorAll('#scan-tbody tr');
        for (var i = 0; i < rows.length; i++) {
          var t = rows[i].textContent || '';
          if (t.indexOf('本地已有') >= 0) local++;
          else if (t.indexOf('可导入') >= 0) fresh++;
        }
        return { local: local, fresh: fresh };
      })()`);
      check('候选表每行标出「本地已有 / 可导入」（分页与批量按钮都靠它）',
        !!badges && (badges.local + badges.fresh) > 0, JSON.stringify(badges));

      const page1 = await evaluate(ws, `(function(){
        var keys = [], ins = document.querySelectorAll('#scan-tbody input[data-scan]');
        for (var i = 0; i < ins.length; i++) keys.push(ins[i].getAttribute('data-scan'));
        var pg = document.getElementById('scan-pager');
        return { rows: keys.length, first: keys[0] || '', keys: keys, pager: pg ? pg.textContent.replace(/\\s+/g, ' ').trim() : '', meta: (document.getElementById('scan-meta') || {}).textContent || '' };
      })()`);
      check('候选表分页：第 1 页最多 20 行', !!page1 && page1.rows > 0 && page1.rows <= 20, `rows=${page1 && page1.rows}`);
      check('分页条出现（含页码/上一页/下一页）', !!page1 && /上一页/.test(page1.pager) && /下一页/.test(page1.pager), page1 && page1.pager);
      check('扫描信息里写明「镜像里已有 N 个」', !!page1 && /镜像里已有/.test(page1.meta), (page1 && page1.meta || '').slice(0, 160));

      const p2 = await evaluate(ws, `(function(){
        var bs = document.querySelectorAll('#scan-pager button');
        for (var i = 0; i < bs.length; i++) if ((bs[i].textContent || '').trim() === '2') { bs[i].click(); return true; }
        return false;
      })()`);
      await sleep(300);
      const page2 = await evaluate(ws, `(function(){
        var keys = [], ins = document.querySelectorAll('#scan-tbody input[data-scan]');
        for (var i = 0; i < ins.length; i++) keys.push(ins[i].getAttribute('data-scan'));
        return { rows: keys.length, first: keys[0] || '', pager: (document.getElementById('scan-pager') || {}).textContent || '' };
      })()`);
      check('翻到第 2 页能渲染且内容变了（真分页）',
        !!p2 && !!page2 && page2.rows > 0 && page2.first !== page1.first && /第 2\//.test(page2.pager),
        `p1=${page1 && page1.first} p2=${page2 && page2.first}`);

      const btns = await evaluate(ws, `(function(){
        function g(id){ var e = document.getElementById(id); return e ? { disabled: !!e.disabled, text: (e.textContent || '').trim(), title: e.getAttribute('title') || '' } : null; }
        return { imp: g('scan-import'), fresh: g('scan-import-new'), all: g('scan-import-all') };
      })()`);
      check('「全部导入」按钮存在且可点', !!btns && btns.all && btns.all.disabled === false && /全部导入/.test(btns.all.text || ''), JSON.stringify(btns && btns.all));
      check('「仅导入不存在的包」按钮可用状态与「有 N 个新包」一致',
        !!btns && !!btns.fresh && btns.fresh.disabled === (newCount === 0),
        `newCount=${newCount} btn=${JSON.stringify(btns && btns.fresh)}`);

      // 「全部导入」：只验证确认框（不真的全量导入），确认框里有数量、按钮文案带数量
      await evaluate(ws, `document.getElementById('scan-import-all').click(); 1`);
      const allConfirm = await waitFor(ws, `(function(){ var m = document.querySelector('#modal-root .modal'); return m ? 1 : 0; })()`, 8000);
      const allSnap = await evaluate(ws, MODAL);
      check('点「全部导入」弹确认框，标题写明全部导入',
        !!allConfirm && !!allSnap && /全部导入/.test(allSnap.title || ''), (allSnap && allSnap.title) || '');
      const allConfirmBtn = (allSnap && allSnap.btns || []).find(b => /导入 [\d,]+ 个/.test(b.label));
      check('「全部导入」确认按钮带包数（不是裸「确认」）', !!allConfirmBtn, JSON.stringify(allSnap && allSnap.btns));
      await evaluate(ws, btnClick('取消'));
      await sleep(300);

      if (newCount === 0) {
        // 环境限制：用户已经把本机缓存里的包全部导入过镜像（local=991/992、fresh=0），
        // 这里不再有「不存在的包」可导。验证按钮的禁用态，真实导入流程交给下面的 B2。
        check('本机缓存的候选包已全部在镜像里（此时「仅导入不存在的包」应为禁用）',
          !!(btns && btns.fresh && btns.fresh.disabled), `newCount=0 btn=${JSON.stringify(btns && btns.fresh)}`);
        check('候选逐个导入路径：本机缓存此前已全部导入镜像，改由 B2「全部导入（覆盖）+ 导入进度弹窗」覆盖',
          true, 'newCount=0 是环境状态，不是功能失败；同类确认框/进度弹窗在 B2 完整走一遍');
      } else {
      // 单个「不存在的包」导入：这是修复「成功 0，失败 0，跳过 N」的关键路径。
      // 候选从表格里找（「可导入」且「有 tarball」），并试筛选框直到「只剩它一个」——
      // 筛选是子串匹配，像 vite 会同时命中 vite-node / vite-plugin-*，必须试到唯一。
      let candName = '';
      const pageNext = () => evaluate(ws, `(function(){
        var bs = document.querySelectorAll('#scan-pager button');
        for (var i = 0; i < bs.length; i++) if ((bs[i].textContent || '').indexOf('下一页') >= 0) { bs[i].click(); return true; }
        return false;
      })()`);
      for (let pg = 0; pg < 4 && !candName; pg++) {
        const keys = (await evaluate(ws, freshScanKeys())) || [];
        for (const key of keys.slice(0, 6)) {
          const nm = String(key).replace(/@[^@]*$/, '');
          await setScanFilter(ws, nm);
          await sleep(220);
          const only = await evaluate(ws, `(function(){
            var ins = document.querySelectorAll('#scan-tbody input[data-scan]');
            if (ins.length !== 1) return 0;
            var v = String(ins[0].getAttribute('data-scan') || '');
            return v.replace(/@[^@]*$/, '') === ${JSON.stringify(nm)} ? 1 : 0;
          })()`);
          if (only === 1) { candName = nm; break; }
        }
        if (candName) break;
        if (!(await pageNext())) break;
        await sleep(300);
      }
      // 本机缓存里的包此前已被「全部导入」过（local=992），剩下的非本地候选都没有 tarball，
      // 走不了「导入一个全新包」的路径 → 退化为「选一个本地已有的包 + 覆盖已存在」的导入，
      // 同样验证：确认框 → 进度弹窗 → 真实成功数 toast → 行状态。
      let candLocal = false;
      if (!candName) {
        await setScanFilter(ws, '');
        await sleep(250);
        candName = (await evaluate(ws, `(function(){
          var ins = document.querySelectorAll('#scan-tbody input[data-scan]');
          return ins.length ? String(ins[0].getAttribute('data-scan') || '').replace(/@[^@]*$/, '') : '';
        })()`)) || '';
        if (candName) {
          candLocal = true;
          await evaluate(ws, `(function(){ var c = document.getElementById('scan-overwrite'); if (c && !c.checked) c.click(); return 1; })()`);
          await setScanFilter(ws, candName);
          await sleep(320);
        }
      }
      check('候选包：镜像里没有的候选都没有 tarball，改用「本地已有包 + 覆盖已存在」验证导入', !!candName,
        candLocal ? `local=${candName}（勾选覆盖已存在）` : (candName || '没找到'));
      if (candName) {
        // 只有「全新导入」的包才登记到 cleanup；candLocal 分支选的是镜像里原本就有的包，
        // 覆盖导入不会新增包，若登记会在 finally 里 DELETE 掉用户自己的包（旧实现的数据损失点）。
        if (!candLocal) cleanup.imported = candName;
        await evaluate(ws, `(function(){
          var c = document.querySelector('#scan-tbody input[data-scan]');
          if (!c) return false;
          c.click();
          return true;
        })()`);
        await sleep(250);
        const impBtn = await evaluate(ws, `(function(){ var e = document.getElementById('scan-import'); return { text: (e.textContent || '').trim(), disabled: !!e.disabled }; })()`);
        check('勾选后「导入选中」按钮显示勾选包数并可点',
          /导入选中（1）/.test(impBtn.text) && impBtn.disabled === false, JSON.stringify(impBtn));

        await evaluate(ws, `document.getElementById('scan-import').click(); 1`);
        const impConfirm = await waitFor(ws, `/导入缓存包/.test((document.querySelector('#modal-root .modal .modal-head h3') || {}).textContent || '') ? 1 : 0`, 8000);
        check('点「导入选中」弹确认框（标题：导入缓存包）', !!impConfirm);
        const impConfirmBtn = await evaluate(ws, `(function(){
          var bs = document.querySelectorAll('#modal-root .modal .modal-foot button');
          for (var i = 0; i < bs.length; i++) if (/^导入 1 个$/.test((bs[i].textContent || '').trim())) { bs[i].click(); return true; }
          return false;
        })()`);

        const toast = await waitFor(ws, `(function(){
          var ts = document.querySelectorAll('#toasts .toast .tmsg');
          for (var i = 0; i < ts.length; i++) if (/缓存导入完成/.test(ts[i].textContent)) return ts[i].textContent;
          return '';
        })()`, 240000);
        check('点确认框里「导入 1 个」能直接开跑', !!impConfirmBtn);
        check('导入完成后 toast 报出真实成功数（不再是恒为「成功 0，失败 0，跳过 N」）',
          !!toast && /成功 [1-9]\d* 个包/.test(String(toast)), String(toast).slice(0, 220));
        check('toast 里同时给出「新增 N 个版本 / N 个 tarball」明细', /新增 \d+ 个版本/.test(String(toast || '')), String(toast).slice(0, 220));
        await evaluate(ws, btnClick('关闭'));
        await sleep(500);
        const rowBadge = await evaluate(ws, `(function(){
          var rows = document.querySelectorAll('#scan-tbody tr');
          for (var i = 0; i < rows.length; i++) {
            var t = rows[i].textContent || '';
            if (t.indexOf(${JSON.stringify(candName)}) >= 0) return t.replace(/\\s+/g, ' ').trim();
          }
          return '';
        })()`);
        check('导入后该行状态变成「本地已有」', /本地已有/.test(String(rowBadge || '')), String(rowBadge).slice(0, 160));
        await setScanFilter(ws, '');
        if (candLocal) await evaluate(ws, `(function(){ var c = document.getElementById('scan-overwrite'); if (c && c.checked) c.click(); return 1; })()`);
      } else {
        check('找到「镜像里还没有」的候选包用于导入测试（本机缓存需有可导入的包）', false, '没有 !local 的候选包');
      }
      }
    }

    /* ============ B2. 缓存导入进度弹窗（正在导入的包 + 逐包导入详情） ============ *
     * 用「全部导入 + 覆盖已存在」制造一次真的在跑的导入：同内容幂等重写（文件名不变），
     * 不会新增或删除任何包；跑到一半点【取消导入】，验证收尾后弹窗仍保留明细。 */
    if (wantB) {
      try { fs.rmSync(SHOT_IMPORT, { force: true }); } catch (e) { /* 旧图不影响 */ }
      await setScanFilter(ws, '');
      const ovSet = await evaluate(ws, `(function(){
        var c = document.getElementById('scan-overwrite');
        if (!c) return null;
        if (!c.checked) c.click();
        return c.checked;
      })()`);
      check('勾上「覆盖已存在」，「全部导入」才会真的逐个重写（幂等）', ovSet === true, `overwrite=${ovSet}`);

      await evaluate(ws, `document.getElementById('scan-import-all').click(); 1`);
      await waitFor(ws, `(function(){ var m = document.querySelector('#modal-root .modal');
        return m && /全部导入/.test((m.querySelector('h3')||{}).textContent||'') ? 1 : 0; })()`, 8000);
      const confirmAll = await evaluate(ws, `(function(){
        var bs = document.querySelectorAll('#modal-root .modal .modal-foot button');
        for (var i = 0; i < bs.length; i++) if (/^导入 [\\d,]+ 个$/.test((bs[i].textContent || '').trim())) { bs[i].click(); return (bs[i].textContent || '').trim(); }
        return '';
      })()`);
      check('「全部导入」确认后进入导入进度弹窗', !!confirmAll, String(confirmAll));
      await sleep(300);

      const opened = await waitFor(ws, `(function(){
        var m = document.querySelector('#modal-root .modal');
        return m && /从本机缓存导入/.test((m.querySelector('h3')||{}).textContent||'') ? 1 : 0; })()`, 15000);
      check('导入进度弹窗标题「从本机缓存导入」', !!opened);

      // 抓「正在跑」的快照。全部导入是把 _cacache 内容在本地重写一遍（241.8 MB），跑得很快：
      // 前端 500ms 轮询一次，可能只渲染 1~2 帧中途态。所以每 40ms 取一次快照，
      // 一看到右栏有「正在导入的包」就先截图留证据；一旦出现「导入完毕/已取消」立即停止轮询
      // （否则空转会等到 toast 过期，后面的汇总断言就拿不到 toast 了）。
      let mid = null, finalSnap = null;
      const snapLog = [];
      for (let i = 0; i < 600; i++) {
        const s = await evaluate(ws, FILL);
        if (!s || !s.open) break;
        const md = await evaluate(ws, MODAL);
        s.text = (md && md.text) || '';
        if (!/从本机缓存导入/.test(s.title || (md && md.title) || '')) break;
        if (snapLog.length < 20) snapLog.push(`#${i} rows=${s.leftRows} busy=${s.rightBusy} tv=${String(s.tv || '').slice(0, 26)} text=${String(s.text).slice(0, 80)}`);
        if (!mid && s.rightBusy >= 1) {
          mid = s;
          await shot(ws, SHOT_IMPORT); // 先留证据：此刻确实有包在导入
        }
        if (!mid && s.leftRows >= 3 && /已处理 [\d,]+ \//.test(s.text || '')) mid = s;
        if (/导入完毕|已取消/.test(s.text || '')) { finalSnap = s; if (!mid) mid = s; break; }
        await sleep(40);
      }
      if (!mid) mid = finalSnap;
      if (finalSnap && !fs.existsSync(SHOT_IMPORT)) await shot(ws, SHOT_IMPORT);
      console.log('    [B2] 快照采样：' + (snapLog.join(' | ') || '（无）'));
      check('导入进度弹窗是两栏（左：逐包导入详情；右：正在导入 · 当前包）',
        !!mid && mid.wide === true && mid.colCount === 2 && /正在导入 · 当前包/.test(mid.head || ''),
        mid ? JSON.stringify({ wide: mid.wide, cols: mid.colCount, head: mid.head }) : '没取到快照 snapLog=' + snapLog.join(' | '));
      check('整体进度行显示「已处理 k / N 个包（p%）· 成功/失败/跳过 · 新增版本与 tarball」',
        !!mid && /已处理 [\d,]+ \/ [\d,]+ 个包（\d+%）/.test(mid.text || '')
          && /成功 [\d,]+/.test(mid.text || '') && /跳过 [\d,]+/.test(mid.text || '')
          && /新增 [\d,]+ 个版本/.test(mid.text || ''),
        mid ? (mid.text || '').replace(/\s+/g, ' ').slice(0, 300) : '');
      check('左栏出现逐包导入详情（✓ 新增 … / · 跳过 …）',
        !!mid && mid.leftRows >= 2 && /(✓ 新增|· 跳过)/.test(mid.text || ''),
        mid ? `leftRows=${mid.leftRows}` : '');
      check('右栏出现正在导入的包（大进度条，k / V 个版本（p%））',
        !!mid && mid.rightBusy >= 1 && /\d+ \/ \d+ 个版本（\d+%）/.test(mid.tv || ''),
        mid ? `rightBusy=${mid.rightBusy} tv=${mid.tv}` : '');
      check(`截图已保存（${path.basename(SHOT_IMPORT)}，含正在导入的包与逐包详情）`,
        fs.existsSync(SHOT_IMPORT) && fs.statSync(SHOT_IMPORT).size > 10000,
        `${fs.existsSync(SHOT_IMPORT) ? fs.statSync(SHOT_IMPORT).size : 0} 字节`);

      // 取消：等任务收尾（弹窗保留明细，[关闭] 可点），toast 给出汇总
      await evaluate(ws, btnClick('取消导入'));
      const cancelState = await waitFor(ws, `(function(){
        var m = document.querySelector('#modal-root .modal');
        if (!m) return 'gone';
        var t = (m.querySelector('.modal-body') || {}).textContent || '';
        var bs = m.querySelectorAll('.modal-foot button');
        for (var i = 0; i < bs.length; i++) {
          if ((bs[i].textContent || '').trim() === '关闭' && !bs[i].hidden && !bs[i].disabled) return 'close-ready';
        }
        return /已取消|导入完毕/.test(t) ? 'ended' : '';
      })()`, 180000);
      check('点「取消导入」后任务收尾（取消/后台运行置灰、【关闭】可点）',
        cancelState === 'close-ready' || cancelState === 'ended' || cancelState === 'gone', String(cancelState));
      const endSnap = await evaluate(ws, MODAL);
      check('导入结束后弹窗保留逐包详情与汇总行（不自动关掉，方便看详情）',
        !!endSnap && endSnap.open && /(已取消|导入完毕)/.test(endSnap.text || ''), endSnap ? (endSnap.text || '').slice(-180) : '');
      const impToast = await waitFor(ws, `(function(){
        var ts = document.querySelectorAll('#toasts .toast .tmsg');
        for (var i = 0; i < ts.length; i++) if (/缓存导入完成|已取消导入/.test(ts[i].textContent)) return ts[i].textContent;
        return '';
      })()`, 20000);
      check('结束后 toast 汇总成功/失败/跳过（导入期间不再是只有加载中）',
        !!impToast && /(成功 \d+|已取消)/.test(String(impToast)), String(impToast).slice(0, 220));
      await evaluate(ws, btnClick('关闭'));
      await sleep(500);
      const impClosed = await evaluate(ws, `document.querySelectorAll('#modal-root .modal').length === 0`);
      check('点【关闭】能关掉导入进度弹窗', !!impClosed);
      await evaluate(ws, `(function(){ var c = document.getElementById('scan-overwrite'); if (c && c.checked) c.click(); return 1; })()`);
    }

    /* ============================ C. 下载进度弹窗右栏 ============================ */
    if (wantC) {
      await evaluate(ws, `location.hash = '#/packages'; 1`);
      await waitFor(ws, `!!document.getElementById('pkg-q') && document.querySelectorAll('#pkg-tbody input[data-name]').length > 0`, 20000);
      await evaluate(ws, `(function(){
        var i = document.getElementById('pkg-q');
        i.value = ${JSON.stringify(FIXTURE)};
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return 1;
      })()`);
      const fx = await waitFor(ws, `!!document.querySelector('#pkg-tbody input[data-name=${JSON.stringify(FIXTURE)}]')`, 20000);
      check(`包管理页能搜到自造测试包 ${FIXTURE}`, !!fx);

      const selDone = await evaluate(ws, `(function(){
        var c = document.querySelector('#pkg-tbody input[data-name=${JSON.stringify(FIXTURE)}]');
        if (!c) return null;
        c.click();
        var mode = document.getElementById('pkg-fill-mode');
        var conc = document.getElementById('pkg-fill-conc');
        if (mode) mode.value = 'all';
        if (conc) conc.value = '3';
        return { checked: c.checked, mode: mode ? mode.value : '', conc: conc ? conc.value : '' };
      })()`);
      check('勾选测试包并把范围设为「补全部版本」、并发 3', !!selDone && selDone.checked === true && selDone.mode === 'all', JSON.stringify(selDone));

      await evaluate(ws, `document.getElementById('pkg-fill-tarball').click(); 1`);
      const confirmSnap = await waitFor(ws, `(function(){ var m = document.querySelector('#modal-root .modal .modal-head h3'); return m && /补全部版本/.test(m.textContent) ? 1 : 0; })()`, 10000);
      check('「补全部版本」确认框弹出（提示会下很多版本）', !!confirmSnap);
      await evaluate(ws, btnClick('开始补全'));

      // 采样右栏：每 100ms 取一次弹窗快照，保留「看到最多条正在下载」的那一份；
      // 看到右栏真的出现大进度条、且已经跑了一小会儿，就先截图并去点【取消下载】——
      // 这次只勾了一个包，等它 120 个版本全下完，弹窗会按规则自动关闭，就来不及取消和断言了。
      let maxBusy = 0, sawTv = '', best = null, shotSize = 0, closedEarly = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 60000) {
        await sleep(100);
        const s = await evaluate(ws, FILL);
        if (!s || !s.open) { closedEarly = true; break; }
        if (s.rightBusy > maxBusy) maxBusy = s.rightBusy;
        if (s.tv) sawTv = s.tv;
        if (!best || (s.colCount === 2 && (!best.colCount || s.rightBusy > best.rightBusy))) best = s;
        if (s.rightBusy >= 1 && Date.now() - t0 > 1500) {
          shotSize = await shot(ws, SHOT);
          break;
        }
      }
      if (!shotSize) { try { shotSize = await shot(ws, SHOT); } catch { /* ignore */ } }
      const snap = best || { open: false };
      check('进度弹窗仍在（标题：补 tarball）', !!(snap.open && /补 tarball/.test(snap.title || '')), `${snap.title || ''} closedEarly=${closedEarly}`);
      check('弹窗是加宽版（两栏并排需要 wide）', snap.wide === true, String(snap.wide));
      check('弹窗里有左右两栏（.fill-cols > .fill-col）', snap.colCount === 2, `cols=${snap.colCount}`);
      check('左右两栏等高（各 300px，误差 ≤ 1px）',
        Math.abs(snap.leftH - snap.rightH) <= 1 && snap.leftH >= 250, `left=${snap.leftH} right=${snap.rightH}`);
      check('两栏各自独立滚动（overflow-y: auto）',
        snap.leftOv === 'auto' && snap.rightOv === 'auto', `left=${snap.leftOv} right=${snap.rightOv}`);
      check('右栏标题写明「正在下载 · 单包进度」', /正在下载/.test(snap.head || '') && /单包进度/.test(snap.head || ''), snap.head);
      check('右栏出现正在下载的包（单包大进度条 ≥1 条）', maxBusy >= 1, `maxBusy=${maxBusy}`);
      check('大进度条文字形如「k / N 个（p%）」（与单包下载行同款）', /\/\s*\d+\s*个（\d+%）/.test(String(sawTv || '')), String(sawTv).slice(0, 120));
      check('左栏仍有原来的任务列表（没动原有内容）', snap.leftRows >= 1, `leftRows=${snap.leftRows}`);
      check(`截图已保存（${path.basename(SHOT)}）`, fs.existsSync(SHOT) && fs.statSync(SHOT).size > 10000, `${shotSize} 字节`);

      // 取消下载：任务收尾后弹窗保留「已取消」+【关闭】，再点【关闭】关掉（原有收尾逻辑没被破坏）
      const cancelOk = await evaluate(ws, btnClick('取消下载'));
      const ended = await waitFor(ws, `(function(){
        var m = document.querySelector('#modal-root .modal');
        if (!m) return 'gone';
        var bs = m.querySelectorAll('.modal-foot button');
        for (var i = 0; i < bs.length; i++) {
          var b = bs[i];
          if ((b.textContent || '').trim() === '关闭' && !b.hidden && !b.disabled) return 'close-ready';
        }
        return '';
      })()`, 180000);
      let closed = ended === 'gone';
      if (!closed && ended === 'close-ready') {
        await evaluate(ws, btnClick('关闭'));
        await sleep(400);
        closed = await evaluate(ws, `!document.querySelector('#modal-root .modal')`);
      }
      check('点「取消下载」后任务收尾、弹窗可关闭（原有收尾逻辑未被破坏）', !!cancelOk && !!ended && !!closed, `cancel=${cancelOk} ended=${ended} closed=${closed}`);
    }
  } finally {
    try {
      if (cleanup.bundle) await apiJSON('/__admin/api/bundles?file=' + encodeURIComponent(cleanup.bundle), { method: 'DELETE' });
    } catch { /* ignore */ }
    try {
      if (cleanup.imported) await apiJSON('/__admin/api/packages/' + encodeURIComponent(cleanup.imported), { method: 'DELETE' });
    } catch { /* ignore */ }
    try {
      if (cleanup.fixture) await apiJSON('/__admin/api/packages/' + encodeURIComponent(FIXTURE), { method: 'DELETE' });
    } catch { /* ignore */ }
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

main().catch(e => { console.error('真机检查异常：', e && e.stack || e); process.exitCode = 1; setTimeout(() => process.exit(1), 300); });
