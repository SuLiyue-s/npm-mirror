'use strict';
/*
 * 深度端到端检查（可选）：用无头 Chrome + CDP 真机验证一条重要交互约定 ——
 *   「成功 + 失败」混合补 tarball 时，进度弹窗**不能**自动关闭（要留着让用户看失败明细）；
 *   只有全部成功或没有失败时才自动关闭。
 *
 * 做法：
 *   - 「必然失败」的包：脚本自己上传一个 mirror-e2e-bad-tarball 的测试 packument（没有 dist.tarball 地址），
 *     结束在 finally 删掉。不再依赖 api-test.js 留下的 mirror-selftest-json 残留包。
 *   - 「能成功」的包：优先用 --ok-pkg 指定的包；不指定时自动从镜像里挑一个还有未缓存版本的上游包。
 *     **绝不先删包再重建**（旧实现会永久删掉用户已缓存的 is-number 版本）。下载 tarball 是纯增量操作。
 *   - 用「全部版本」模式一起补，结束后断言弹窗仍在、有失败行、有失败明细框。
 *
 * 前置：
 *   1) 服务已启动（node cli.js start --no-open）
 *   2) 本机有 Chrome/Edge；在 DSH 沙箱下需放宽权限执行（浏览器多进程依赖命名管道）
 *   3) 上游可访问（「成功包」要真的能下到 tarball）
 * 用法：
 *   node test/ui-e2e-fail.js [--base http://127.0.0.1:4874] [--ok-pkg <包名>] [--bad-pkg mirror-e2e-bad-tarball] [--shot 截图\补tarball-失败不关闭.png]
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
const OK_PKG_ARG = arg('ok-pkg', ''); // 空 = 自动挑一个还有未缓存版本的上游包
const BAD_PKG = arg('bad-pkg', 'mirror-e2e-bad-tarball');
const CONC = arg('conc', '4');
const SHOT = arg('shot', path.join(__dirname, '..', '截图', '补tarball-失败不关闭.png'));
const TOKEN = process.env.MIRROR_TOKEN || (() => {
  try { return require('../src/config').get().security.token; } catch { return ''; }
})();
const BAD_JSON = {
  name: BAD_PKG,
  'dist-tags': { latest: '1.0.0' },
  versions: {
    '1.0.0': { name: BAD_PKG, version: '1.0.0', dist: { shasum: 'da39a3ee5e6b4b0d3255bfef95601890afd80709' } },
  },
};
const CHROME = arg('chrome', [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'chrome.exe');
const PORT = Number(arg('port', '9336'));

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
async function apiJSON(p, init) {
  const r = await fetch(BASE + p, Object.assign({ headers: H, signal: AbortSignal.timeout(180000) }, init || {}));
  return { status: r.status, body: await r.json().catch(() => null) };
}
const enc = (s) => encodeURIComponent(String(s)).replace(/%2F/gi, '%2F');

/** 详情里未缓存版本数（顺带确认包存在） */
async function uncachedOf(name) {
  const r = await apiJSON('/__admin/api/packages/' + enc(name));
  if (r.status !== 200 || !r.body || !r.body.ok) return { exists: false, uncached: 0 };
  const vs = (r.body.data && r.body.data.versions) || [];
  return { exists: true, uncached: vs.filter(v => !v.cached).length, total: vs.length };
}

/** 镜像里的全部包（分页取全） */
async function namesNow() {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const r = await apiJSON('/__admin/api/packages?page=' + page + '&size=200');
    const items = ((r.body || {}).data || {}).items || [];
    out.push(...items);
    if (items.length < 200) break;
  }
  return out;
}

async function main() {
  const checks = [];
  const check = (name, ok, extra) => { checks.push({ name, ok: !!ok, extra: extra || '' }); };
  let createdBad = false;
  const cleanupBadPackage = async () => {
    if (!createdBad) return;
    createdBad = false;
    try { await apiJSON('/__admin/api/packages/' + enc(BAD_PKG), { method: 'DELETE' }); } catch { /* 忽略 */ }
  };

  // ---- 准备「必然失败」的包：自己上传一个没有 dist.tarball 地址的测试 packument（自带清理，不依赖 api-test 残留）
  const up = await fetch(BASE + '/__admin/api/upload?overwrite=1', {
    method: 'POST',
    headers: Object.assign({ 'X-Filename': BAD_PKG + '.json', 'Content-Type': 'application/json' }, H),
    body: Buffer.from(JSON.stringify(BAD_JSON)),
    signal: AbortSignal.timeout(60000),
  });
  createdBad = up.status === 200;
  console.log(`准备必败包 ${BAD_PKG}：上传 status=${up.status}`);
  if (!createdBad) { console.error(`\n上传必败测试包失败（status=${up.status}），无法构造“成功+失败”混合场景。\n`); process.exitCode = 2; return; }
  const badInfo = await uncachedOf(BAD_PKG);
  if (!badInfo.exists || !badInfo.uncached) {
    console.error(`\n必败包 ${BAD_PKG} 未就绪（exists=${badInfo.exists} uncached=${badInfo.uncached}）。\n`);
    await cleanupBadPackage();
    process.exitCode = 2;
    return;
  }

  // ---- 准备「能成功」的包：只挑「还有未缓存版本」的包，绝不删包重建（下载 tarball 是增量操作）
  let OK_PKG = OK_PKG_ARG;
  if (OK_PKG) {
    const o = await uncachedOf(OK_PKG);
    if (!o.exists || !o.uncached) {
      console.error(`\n--ok-pkg ${OK_PKG} 没有可补的未缓存版本；为不破坏镜像数据，不再「先删后加」。\n请换一个还有未缓存版本的包，或去掉 --ok-pkg 让脚本自动挑。\n`);
      await cleanupBadPackage();
      process.exitCode = 2;
      return;
    }
  } else {
    const all = await namesNow();
    let best = null;
    for (const p of all) {
      if (p.name === BAD_PKG) continue;
      if (p.source === 'upload' || p.source === 'private') continue;
      const u = await uncachedOf(p.name);
      if (u.exists && u.uncached > 0 && (!best || (u.total <= 40 && u.total < best.total))) best = { name: p.name, uncached: u.uncached, total: u.total };
      if (best && best.total <= 40) break;
    }
    OK_PKG = best ? best.name : '';
  }
  if (!OK_PKG) {
    console.error(`\n镜像里找不到「还有未缓存版本」的上游包：本用例需要联网补一个 tarball 才能构造“成功”行，跳过。\n`);
    await cleanupBadPackage();
    process.exitCode = 2;
    return;
  }
  const okInfo = await uncachedOf(OK_PKG);
  console.log(`可成功包 ${OK_PKG}：未缓存 ${okInfo.uncached} / 共 ${okInfo.total}；必然失败包 ${BAD_PKG}：存在=${badInfo.exists} 未缓存 ${badInfo.uncached}`);
  console.log(`（注意：只会给 ${OK_PKG} 增量补 tarball，不会删除镜像里任何包/版本）`);

  // ---- 浏览器
  const userDir = path.join(os.tmpdir(), 'dsh-fail-cdp-' + Date.now().toString(36));
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
  if (TOKEN) {
    await evaluate(ws, `localStorage.setItem('npm-mirror-token', ${JSON.stringify(TOKEN)}); location.reload(); 1`);
    await sleep(1500);
  }
  for (let i = 0; i < 60; i++) {
    // 注意：包表在加载时会先渲染 6 行骨架屏（<tr> 里没有 data-name），
    // 所以这里必须等“真实行”（带 data-name 的勾选框）出现，不能只数 <tr>。
    const n = await evaluate(ws, `document.querySelectorAll('#pkg-tbody input[data-name]').length`).catch(() => 0);
    if (n > 0) break;
    await sleep(300);
  }

  try {
    // 1) 逐个搜索 + 精确勾选（镜像里包多了以后，目标包不一定在第一页；按行文本模糊匹配会点错）
    const gotPicks = [];
    for (const want of [OK_PKG, BAD_PKG]) {
      await evaluate(ws, `(function(){
        var q = document.getElementById('pkg-q');
        if (q) {
          q.value = ${JSON.stringify(want)};
          q.dispatchEvent(new Event('input', { bubbles: true }));
          q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
        return 1;
      })()`);
      let ok = false, detail = null;
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        const r = await evaluate(ws, `(function(){
          var cb = document.querySelector('#pkg-tbody input[data-name="' + ${JSON.stringify(want)} + '"]');
          var rows = document.querySelectorAll('#pkg-tbody input[data-name]').length;
          if (!cb) return { rows: rows, found: false };
          if (!cb.checked) cb.click();
          return { rows: rows, found: true, checked: !!cb.checked, name: cb.getAttribute('data-name') };
        })()`);
        detail = r;
        if (r.found) { ok = !!r.checked; break; }
      }
      gotPicks.push({ name: want, ok: ok, detail: detail });
    }
    const picked = {
      count: gotPicks.filter(g => g.ok).length,
      got: gotPicks.map(g => g.name + (g.ok ? '' : '(没勾上)')),
      all: gotPicks.map(g => g.detail),
    };
    check(`勾选「${OK_PKG} + ${BAD_PKG}」两行`, picked && picked.count === 2, JSON.stringify(picked));

    // 2) 全部版本模式 + 并发数
    await evaluate(ws, `(function(){
      var c = document.getElementById('pkg-fill-conc'); if (c) { c.value = ${JSON.stringify(String(CONC))}; c.dispatchEvent(new Event('change',{bubbles:true})); }
      var m = document.getElementById('pkg-fill-mode'); if (m) { m.value = 'all'; }
      return 1;
    })()`);
    await sleep(500);

    // 3) 点「补 tarball」→ all 模式确认框
    await evaluate(ws, `document.getElementById('pkg-fill-tarball').click(); 1`);
    await sleep(700);
    const confirmText = await evaluate(ws, `(function(){
      var b = document.querySelectorAll('#modal-root .modal-foot button');
      for (var i=0;i<b.length;i++) if (b[i].textContent.indexOf('开始') >= 0) { b[i].click(); return b[i].textContent.trim(); }
      return null;
    })()`);
    check('「全部版本」模式弹出确认框并已确认', !!confirmText, String(confirmText));

    // 4) 等任务结束（出现「全部处理完毕」行）
    const t0 = Date.now();
    let finished = false, lastText = '';
    let finalState = null;
    let closeHiddenDuringRun = false, closeVisibleDuringRun = false;
    while (Date.now() - t0 < 180000) {
      await sleep(400);
      const s = await evaluate(ws, `(function(){
        var m = document.querySelector('#modal-root .modal');
        if (!m) return { open:false };
        var rows = [];
        m.querySelectorAll('.taskrow').forEach(function(r){ rows.push({ cls: r.className, text: r.textContent.replace(/\\s+/g,' ').trim().slice(0,90) }); });
        var stat = m.querySelector('.fill-stat');
        var bs = Array.prototype.slice.call(m.querySelectorAll('.modal-foot button'));
        return { open:true, rows:rows, stat: stat ? stat.textContent.replace(/\\s+/g,' ').trim() : '', err: !!m.querySelector('.fill-err'), errText: (m.querySelector('.fill-err')||{}).textContent || '',
          btns: bs.map(function(b){ return { label: (b.textContent||'').trim(), disabled: !!b.disabled, hidden: !!b.hidden }; }) };
      })()`).catch(() => null);
      if (!s || !s.open) { lastText = '弹窗已关闭'; break; }
      lastText = s.stat + ' || ' + s.rows.map(r => r.text).join(' | ');
      const isDone = s.rows.some(r => r.text.indexOf('全部处理完毕') >= 0);
      if (!isDone) {
        // 任务还在跑：【关闭】应该已经存在但不可见（下载完成前不显示）
        const closeBtn = (s.btns || []).filter(b => b.label === '关闭')[0];
        if (closeBtn && closeBtn.hidden) closeHiddenDuringRun = true;
        if (closeBtn && !closeBtn.hidden) closeVisibleDuringRun = true;
      }
      if (isDone) { finished = true; finalState = s; break; }
    }
    finalState = await evaluate(ws, `(function(){
      var m = document.querySelector('#modal-root .modal');
      if (!m) return { open:false };
      var rows = [];
      m.querySelectorAll('.taskrow').forEach(function(r){ rows.push({ cls: r.className, text: r.textContent.replace(/\\s+/g,' ').trim().slice(0,90) }); });
      var stat = m.querySelector('.fill-stat');
      var err = m.querySelector('.fill-err');
      var bs = Array.prototype.slice.call(m.querySelectorAll('.modal-foot button'));
      return { open:true, rows:rows, stat: stat ? stat.textContent.replace(/\\s+/g,' ').trim() : '', err: !!err, errText: err ? err.textContent.replace(/\\s+/g,' ').trim().slice(0,200) : '',
        btns: bs.map(function(b){ return { label: (b.textContent||'').trim(), disabled: !!b.disabled, hidden: !!b.hidden }; }) };
    })()`);

    // 5) 截图（无论弹窗是否还在，都先拍下最终画面）
    try {
      const png = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(SHOT), { recursive: true });
      fs.writeFileSync(SHOT, Buffer.from(png.data, 'base64'));
      console.log(`截图：${SHOT}`);
    } catch (e) { console.log('截图失败：' + e.message); }

    const open = !!(finalState && finalState.open);
    const rows = (finalState && finalState.rows) || [];
    const errRow = rows.filter(r => /(^|\s)err(\s|$)/.test(r.cls) || r.text.indexOf('失败') >= 0);
    const okRow = rows.filter(r => /(^|\s)ok(\s|$)/.test(r.cls));
    check('任务确实结束（出现「全部处理完毕」）', finished, `finalState=${JSON.stringify(finalState && finalState.rows)}`);
    check('混合结果下进度弹窗保持打开（不自动关闭）', open, open ? '' : '弹窗被自动关闭了：' + lastText);
    check('弹窗里有失败包的行（红色/失败文案）', errRow.length >= 1, JSON.stringify(errRow.map(r => r.text)));
    check('弹窗里有成功包的行', okRow.length >= 1, JSON.stringify(okRow.map(r => r.text)));
    check('弹窗底部有失败明细框（.fill-err）', !!(finalState && finalState.err), (finalState && finalState.errText) || '');
    check('统计行包含「失败」计数', !!(finalState && /失败/.test(finalState.stat)), (finalState && finalState.stat) || '');

    // 5.1) 任务结束后的按钮：取消/后台运行置灰、【关闭】出现且真的能关掉弹窗
    const at = (list, label) => (list || []).filter(b => b.label === label)[0] || null;
    const bCancel = at(finalState && finalState.btns, '取消下载');
    const bBg = at(finalState && finalState.btns, '后台运行');
    const bClose = at(finalState && finalState.btns, '关闭');
    check('任务结束后「取消下载」被禁用（置灰不可点）', !!bCancel && bCancel.disabled === true,
      JSON.stringify(finalState && finalState.btns));
    check('任务结束后「后台运行」被禁用（置灰不可点）', !!bBg && bBg.disabled === true,
      JSON.stringify(finalState && finalState.btns));
    check('「关闭」按钮跑动中不显示、失败收尾后出现（失败仍不自动关闭）',
      closeHiddenDuringRun && !closeVisibleDuringRun && !!bClose && bClose.hidden === false,
      `跑动中隐藏过=${closeHiddenDuringRun} 跑动中露过=${closeVisibleDuringRun} 结束时=${JSON.stringify(bClose)}`);
    const closedByBtn = await evaluate(ws, `(function(){
      var bs = Array.prototype.slice.call(document.querySelectorAll('#modal-root .modal-foot button'));
      var c = bs.filter(function(b){ return (b.textContent||'').trim() === '关闭'; })[0];
      if (!c) return 'no-close-button';
      c.click();
      return document.querySelector('#modal-root .modal') ? 'still-open' : 'closed';
    })()`);
    check('点【关闭】能手动关掉这个失败弹窗（自动关闭逻辑没被改动）', closedByBtn === 'closed', String(closedByBtn));

    // 6) 服务端确认：成功包确实补到了 tarball
    const after = await uncachedOf(OK_PKG);
    check(`${OK_PKG} 的未缓存版本确实减少了（${okInfo.uncached} → ${after.uncached}）`, after.uncached < okInfo.uncached, '');
    const cfgResp = await apiJSON('/__admin/api/config').catch(() => null);
    const cfgData = ((cfgResp && cfgResp.body) || {}).data || {};
    const concNow = cfgData.config && cfgData.config.upstream ? cfgData.config.upstream.concurrency : '?';
    console.log(`（当前配置的并发数 upstream.concurrency = ${concNow}）`);
  } finally {
    try { ws.close(); } catch { /* 忽略 */ }
    try { chrome.kill(); } catch { /* 忽略 */ }
    await cleanupBadPackage();
  }

  const fail = checks.filter(c => !c.ok).length;
  console.log('');
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.extra ? '  → ' + c.extra : ''}`);
  console.log(`\n结果：${checks.length - fail}/${checks.length} 通过\n`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}

main().catch((e) => { console.error('检查异常：', e); process.exitCode = 1; });
