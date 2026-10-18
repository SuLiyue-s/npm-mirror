'use strict';
/*
 * 深度端到端检查（可选）：用无头 Chrome + CDP 真机点击「包管理 → 勾选 → 补 tarball」，
 * 采样进度弹窗的百分比 / 字节 / 速率，验证「真实进度 + 并发下载 + 取消」。
 *
 * 前置：
 *   1) 服务已启动（node cli.js start --no-open）
 *   2) 本机有 Chrome，且进程能创建命名管道 —— 在 DSH 沙箱下需要用放宽权限执行本脚本
 *      （浏览器多进程依赖命名管道，受限沙箱会报 platform_channel Check failed: 拒绝访问）
 * 用法：
 *   node test/ui-e2e-fill.js [--base http://127.0.0.1:4874] [--pkg ms] [--mode all] [--conc 6] [--shot 截图\补tarball-进度.png]
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
// BASE 指向管理界面（admin.port）：页面与 /__admin/api 都在管理界面监听上，镜像源监听只提供 registry 协议。
const cfgPort = () => { try { const c = require('../src/config').get(); return (c.admin && c.admin.port) || c.server.port || 4874; } catch { return 4874; } };
const BASE = arg('base', `http://127.0.0.1:${cfgPort()}`).replace(/\/+$/, '');
const PKG = arg('pkg', 'ms');
const MODE = arg('mode', 'all');
const CONC = arg('conc', '6');
const SHOT = arg('shot', path.join(__dirname, '..', '截图', '补tarball-进度.png'));
const CHROME = arg('chrome', [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'chrome.exe');
const PORT = Number(arg('port', '9333'));
const TOKEN = process.env.MIRROR_TOKEN || (() => {
  try { return require('../src/config').get().security.token; } catch { return ''; }
})();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  if (r.exceptionDetails) throw new Error('页面异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || JSON.stringify(r.exceptionDetails)));
  return r.result && r.result.value;
}

async function main() {
  const userDir = path.join(os.tmpdir(), 'dsh-fill-cdp-' + Date.now().toString(36));
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
    } catch { /* 浏览器还没起来 */ }
  }
  if (!wsUrl) { chrome.kill(); throw new Error('无法连接无头浏览器（CDP 端口无响应）'); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
  });
  await rpc(ws, 'Runtime.enable');
  await rpc(ws, 'Page.enable');

  // 0) 确保目标包已在本镜像里（没有就先按「添加公共包」拉元数据，tarball 仍留空 → 可演示补全进度）
  const HEAD = TOKEN ? { 'X-Mirror-Token': TOKEN } : {};
  const WANT = String(PKG).split(',').map(s => s.trim()).filter(Boolean);
  try {
    for (const one of WANT) {
      const list = await (await fetch(`${BASE}/__admin/api/packages?q=${encodeURIComponent(one)}&size=50`, { headers: HEAD })).json();
      const items = (list.data && list.data.items) || [];
      const found = items.find(it => it.name === one);
      const missing = found ? Number(found.missingVersions || 0) : -1;
      if (!found) {
        console.log(`本地没有 ${one}，先添加公共包元数据…`);
        const add = await (await fetch(`${BASE}/__admin/api/packages`, {
          method: 'POST', headers: { ...HEAD, 'content-type': 'application/json' }, body: JSON.stringify({ names: [one] }),
        })).json();
        console.log('添加结果：' + JSON.stringify(add.data || add).slice(0, 200));
        await evaluate(ws, 'location.reload(); 1');
        await sleep(1800);
      } else if (missing === 0) {
        console.log(`注意：${one} 当前没有缺失的 tarball，补全会立即结束（换一个包或用 --mode tags）`);
      } else {
        console.log(`${one} 当前缺 ${missing} 个版本的 tarball`);
      }
    }
  } catch (e) { console.log('准备阶段警告：' + e.message); }

  // 等包列表渲染
  for (let i = 0; i < 40; i++) {
    const n = await evaluate(ws, `document.querySelectorAll('#pkg-tbody tr').length`).catch(() => 0);
    if (n > 0) break;
    await sleep(300);
  }

  const token = TOKEN;
  if (token) {    await evaluate(ws, `localStorage.setItem('npm-mirror-token', ${JSON.stringify(token)}); location.reload(); 1`);
    await sleep(1500);
  }
  // 包表加载时会先渲染 6 行骨架屏（没有 data-name），必须等真实行出现，
  // 否则勾选循环拿到的是骨架行（没有 checkbox），会误判成「没有勾选」。
  for (let i = 0; i < 60; i++) {
    const n = await evaluate(ws, `document.querySelectorAll('#pkg-tbody input[data-name]').length`).catch(() => 0);
    if (n > 0) break;
    await sleep(300);
  }

  // 1) 勾选目标包（最多重试 5 次：列表可能刚渲染完又被刷新重建）
  let picked = null;
  for (let i = 0; i < 5; i++) {
    picked = await evaluate(ws, `(function(){
    var want = ${JSON.stringify(String(PKG).split(',').map(function(s){ return s.trim(); }).filter(Boolean))};
    var got = [];
    var rows = document.querySelectorAll('#pkg-tbody tr');
    for (var i=0;i<rows.length;i++){
      var cb = rows[i].querySelector('input[type=checkbox]');
      var name = rows[i].getAttribute('data-name') || (cb && cb.getAttribute('data-name')) || '';
      var t = rows[i].textContent || '';
      if (cb && want.some(function(w){ return name === w || t.indexOf(w + '@') >= 0 || t.trim().indexOf(w) === 0; })) {
        if (!cb.checked) cb.click();
        got.push(t.replace(/\\s+/g,' ').trim().slice(0,40));
      }
    }
    return got.length ? { ok:true, rows: got } : { ok:false, rows: rows.length };
  })()`);
    if (picked && picked.ok) break;
    await sleep(600);
  }
  await sleep(400);
  const selbar = await evaluate(ws, `(function(){
    var b = document.getElementById('pkg-selbar');
    var h = document.getElementById('pkg-miss-hint');
    return { hidden: !!(b && b.hidden), text: b ? b.textContent.replace(/\\s+/g,' ').trim() : '', hint: h ? h.textContent : '' };
  })()`);

  // 2) 设置并发数与范围
  await evaluate(ws, `(function(){
    var c = document.getElementById('pkg-fill-conc'); if (c) { c.value = ${JSON.stringify(CONC)}; c.dispatchEvent(new Event('change', {bubbles:true})); }
    var m = document.getElementById('pkg-fill-mode'); if (m) { m.value = ${JSON.stringify(MODE)}; }
    return 1;
  })()`);
  await sleep(500);
  const persisted = await (await fetch(`${BASE}/__admin/api/config`, { headers: token ? { 'X-Mirror-Token': token } : {} })).json().catch(() => null);

  // 3) 点「补 tarball」，all 模式会先弹确认框
  await evaluate(ws, `document.getElementById('pkg-fill-tarball').click(); 1`);
  await sleep(600);
  const confirmText = await evaluate(ws, `(function(){
    var b = document.querySelectorAll('#modal-root .modal-foot button');
    for (var i=0;i<b.length;i++) if (b[i].textContent.indexOf('开始') >= 0) { b[i].click(); return b[i].textContent; }
    return null;
  })()`);

  // 4) 采样进度
  const samples = [];
  let shot = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    await sleep(150);
    const s = await evaluate(ws, `(function(){
      var bar = document.querySelector('#modal-root .modal .progressbar i');
      var stat = document.querySelector('#modal-root .modal .fill-stat');
      var note = document.querySelector('#modal-root .modal .modal-body p');
      var rows = [];
      document.querySelectorAll('#modal-root .modal .taskrow').forEach(function(r){ rows.push(r.textContent.replace(/\\s+/g,' ').trim()); });
      var fills = [];
      document.querySelectorAll('#modal-root .modal .taskrow .tr-fill').forEach(function(f){ fills.push(f.style.width); });
      var heights = [];
      document.querySelectorAll('#modal-root .modal .taskrow').forEach(function(r){ heights.push(Math.round(r.getBoundingClientRect().height)); });
      var toast = document.querySelector('.toast, #toast');
      return {
        open: !!document.querySelector('#modal-root .modal'),
        width: bar ? bar.style.width : null,
        stat: stat ? stat.textContent.replace(/\\s+/g,' ').trim() : null,
        note: note ? note.textContent.replace(/\\s+/g,' ').trim() : null,
        rows: rows, fills: fills, heights: heights, toast: toast ? toast.textContent.replace(/\\s+/g,' ').trim() : null,
      };
    })()`).catch(() => null);
    if (!s) break;
    if (s.width && s.width !== '0%' && s.width !== '100%' && !shot && fs.existsSync(path.dirname(SHOT))) {
      try {
        const cap = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(SHOT, Buffer.from(cap.data, 'base64'));
        shot = true;
      } catch { /* 截图失败不影响判定 */ }
    }
    samples.push({ t: Date.now() - t0, width: s.width, stat: s.stat, rows: s.rows.slice(0, 3), fills: s.fills, heights: s.heights, toast: s.toast });
    if (!s.open) break;                              // 弹窗关闭 = 结束
    // total=0 的分支不会自动关闭弹窗，靠「已齐全 / 已缓存 / 无需补充」文字收尾
    if (s.rows && s.rows.some(r => /已齐全|已缓存|无需补充/.test(r)) && Date.now() - t0 > 800) break;
    if (s.toast && /完成|取消|出错/.test(s.toast) && Date.now() - t0 > 1000) break;
  }

  // 中途没抓到图（例如只有失败的一两个任务、百分比直接跳到 100%）就补一张结束态
  if (!shot) {
    try {
      const cap = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(SHOT, Buffer.from(cap.data, 'base64'));
      shot = true;
    } catch { /* 忽略 */ }
  }

  const percents = Array.from(new Set(samples.map(s => s.width).filter(Boolean)));
  const mid = samples.filter(s => s.width && s.width !== '0%' && s.width !== '100%');
  const last = samples[samples.length - 1] || {};
  const out = {
    pick: picked, selbar, confirmText,
    concInConfig: persisted && persisted.data && persisted.data.config && persisted.data.config.upstream
      ? persisted.data.config.upstream.concurrency : null,
    percentSeen: percents,
    midFlightStates: mid.length,
    sampleStatAtMid: mid.length ? mid[Math.floor(mid.length / 2)].stat : null,
    rowFillSeen: Array.from(new Set([].concat.apply([], samples.map(s => s.fills || [])))),
    rowHeights: Array.from(new Set([].concat.apply([], samples.map(s => s.heights || [])))),
    finalToast: last.toast || null,
    finalRows: last.rows || [],
    samples: samples.length,
    screenshot: shot ? SHOT : null,
  };
  console.log(JSON.stringify(out, null, 2));

  // 说明：mode=latest 只会下 1 个 tarball（分母为 1），百分比必然 0% → 100%，
  // 抓不到中间态属于正常；此时改用「弹窗打开 + 任务只下 latest 那一个」作为判据。
  // 另一种正常收尾：latest 那个版本早就缓存过了 → 弹窗直接走「无需补充」（0 / 0 个），
  // 根本没有下载过程，这时百分比/统计文案按「无需补充」判定，不算失败。
  const singleTarget = MODE === 'latest';
  const statSeen = samples.map(s => s.stat).filter(Boolean);
  const noWork = (out.finalRows || []).some(r => r.indexOf('无需补下载') >= 0)
    || statSeen.some(t => /^0\s*\/\s*0/.test(t));
  const okProgress = noWork ? true
    : (singleTarget
      ? samples.length > 1
      : (percents.some(p => p !== '0%' && p !== '100%') && mid.length >= 1));
  const okStat = noWork ? true
    : (singleTarget
      ? statSeen.some(t => /个/.test(t) && /已下载/.test(t))
      : !!(out.sampleStatAtMid && /个/.test(out.sampleStatAtMid) && /已下载/.test(out.sampleStatAtMid)));
  const okRowFill = singleTarget
    ? samples.some(s => (s.fills || []).length > 0)
    : out.rowFillSeen.some(w => w && w !== '0%' && w !== '100%');
  console.log(`\n判定：进度百分比${singleTarget ? '（latest 模式只下 1 个，允许无中间态）' : '中间态'} ${okProgress ? '✓' : '✗'}（观察到 ${percents.join(' → ')}）；统计文案 ${okStat ? '✓' : '✗'}${noWork ? '（本次 latest 早已缓存 → 走「无需补充」收尾，没有下载过程）' : ''}；逐包行内进度条 ${okRowFill ? '✓' : '✗'}（观察到 ${out.rowFillSeen.join(' → ')}；行高 ${out.rowHeights.join('/')}px）`);
  try { ws.close(); } catch { /* 忽略 */ }
  chrome.kill();
  await sleep(300);
  process.exit(okProgress && okStat && okRowFill ? 0 : 1);
}

main().catch(e => { console.error('检查失败：' + e.message); process.exit(2); });
