'use strict';
/*
 * 深度端到端检查（可选）：用无头 Chrome + CDP 真机打开「包详情抽屉」，验证：
 *   1) 版本表格分页（默认每页 50 行，不是把 3800+ 行一次渲染）
 *   2) 一键筛选「未下载 / 已下载」
 *   3) 版本号关键字过滤
 *   4) 每行勾选 + 「补选中 N 个」按钮走后台任务（进度弹窗）
 *   5) 表头同时有「本地体积」与「源体积」两列，未缓存版本也有源体积
 *
 * 前置：
 *   1) 服务已启动（node cli.js start --no-open）
 *   2) 本机有 Chrome/Edge；在 DSH 沙箱下需放宽权限执行（浏览器多进程依赖命名管道）
 * 用法：
 *   node test/ui-e2e-detail.js [--base http://127.0.0.1:4873] [--pkg typescript] [--pick 2] [--shot 截图\详情页-分页筛选.png]
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
const PKG = arg('pkg', 'typescript');
const PICK = Number(arg('pick', '2'));
const SHOT = arg('shot', path.join(__dirname, '..', '截图', '详情页-分页筛选.png'));
const SHOT2 = arg('shot2', path.join(__dirname, '..', '截图', '详情页-抽屉.png'));
const CHROME = arg('chrome', [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'chrome.exe');
const PORT = Number(arg('port', '9334'));
// --nofill：只验证抽屉渲染（时间/概要/表头/筛选/翻页），不做勾选-补下载。
// 用于「上游没有发布时间」这类不该造下载任务的包。
const NOFILL = args.includes('--nofill');
const TOKEN = process.env.MIRROR_TOKEN || '';

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
  if (r.exceptionDetails) throw new Error('页面异常：' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || JSON.stringify(r.exceptionDetails)));
  return r.result && r.result.value;
}

/** 抽屉里的版本行快照（每次读取都用最新的 DOM） */
const SNAP = `(function(){
  var d = document.querySelector('.drawer');
  if (!d) return null;
  // 先读表头定位「发布时间」列：不写死列下标，列顺序调整后仍然正确
  var heads = [];
  d.querySelectorAll('table.tbl thead th').forEach(function(th){ heads.push(th.textContent.replace(/\\s+/g,' ').trim()); });
  var vTimeIdx = -1;
  for (var h = 0; h < heads.length; h++) if (/发布|时间/.test(heads[h])) { vTimeIdx = h; break; }
  var rows = [];
  d.querySelectorAll('table.tbl tbody tr').forEach(function(tr){
    var tds = tr.querySelectorAll('td');
    var txt = tr.textContent.replace(/\\s+/g,' ').trim();
    var cb = tr.querySelector('input[type=checkbox]');
    var time = '';
    if (vTimeIdx >= 0) time = (tds[vTimeIdx] && tds[vTimeIdx].textContent || '').replace(/\\s+/g, ' ').trim();
    if (!time) {
      for (var i = 0; i < tds.length; i++) {
        var s = (tds[i].textContent || '').replace(/\\s+/g, ' ').trim();
        if (/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$/.test(s)) { time = s; break; }
      }
    }
    rows.push({
      text: txt.slice(0, 70),
      version: txt.split(' ')[0],
      cached: txt.indexOf('已缓存') >= 0 && txt.indexOf('未缓存') < 0,
      hasCb: !!cb,
      checked: !!(cb && cb.checked),
      cols: tds.length,
      time: time
    });
  });
  var btns = [];
  d.querySelectorAll('button').forEach(function(b){ btns.push(b.textContent.replace(/\\s+/g,' ').trim()); });
  var inputs = [];
  d.querySelectorAll('input').forEach(function(i){ inputs.push({ type: i.type, ph: i.placeholder || '', val: i.value || '' }); });
  var chips = [];
  d.querySelectorAll('.chip-s').forEach(function(c){ chips.push(c.textContent.replace(/\\s+/g,' ').trim()); });
  return {
    rows: rows, heads: heads, btns: btns, inputs: inputs, chips: chips,
    bodyText: d.querySelector('.drawer-body').textContent.replace(/\\s+/g,' ').trim().slice(0, 400)
  };
})()`;

async function main() {
  const userDir = path.join(os.tmpdir(), 'dsh-detail-cdp-' + Date.now().toString(36));
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

  if (TOKEN) {
    await evaluate(ws, `localStorage.setItem('npm-mirror-token', ${JSON.stringify(TOKEN)}); 1`);
    await evaluate(ws, 'location.reload(); 1');
    await sleep(1500);
  }
  for (let i = 0; i < 60; i++) {
    // 包表加载时会先渲染 6 行骨架屏（没有 data-name），必须等真实行出现
    const n = await evaluate(ws, `document.querySelectorAll('#pkg-tbody input[data-name]').length`).catch(() => 0);
    if (n > 0) break;
    await sleep(300);
  }

  // 1) 包列表里的「更新时间」与补 tarball 范围下拉（时间必须带年份）
  const pkgTime = await evaluate(ws, `(function(){
    var tr = document.querySelector('#pkg-tbody tr');
    if (!tr) return '';
    // 不写死列下标：挑「形如 YYYY-MM-DD HH:mm」的单元格（列顺序调整后仍然正确）
    var tds = tr.querySelectorAll('td');
    for (var i = 0; i < tds.length; i++) {
      var s = (tds[i].textContent || '').replace(/\\s+/g,' ').trim();
      if (/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$/.test(s)) return s;
    }
    return '';
  })()`).catch(() => '');
  const fillModeOpts = await evaluate(ws, `(function(){
    var s = document.getElementById('pkg-fill-mode');
    if (!s) return [];
    return Array.prototype.map.call(s.options, function(o){ return o.textContent.trim() + '=' + o.value; });
  })()`).catch(() => []);
  console.log('包列表更新时间：' + JSON.stringify(pkgTime) + '；补 tarball 范围：' + JSON.stringify(fillModeOpts));

  // 2) 用搜索框过滤出目标包（镜像里包多了以后，目标包不一定在第一页），再点它的「详情」按钮
  const searched = await evaluate(ws, `(function(){
    var q = document.getElementById('pkg-q');
    if (!q) return false;
    // 先把每页调到最大：镜像里包多了以后，搜索 "typescript" 的第一页会被
    // @typescript/* 之类「包含关系」的包占满，真正的 typescript 可能落在第二页。
    var sz = document.getElementById('pkg-size');
    if (sz) {
      var best = null;
      for (var i=0;i<sz.options.length;i++){ var v = parseInt(sz.options[i].value, 10); if (!isNaN(v) && (!best || v > best)) best = v; }
      if (best) { sz.value = String(best); sz.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    q.value = ${JSON.stringify(PKG)};
    q.dispatchEvent(new Event('input', { bubbles: true }));
    q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    return true;
  })()`).catch(() => false);
  if (searched) {
    for (let i = 0; i < 40; i++) {
      const found = await evaluate(ws, `!!document.querySelector('#pkg-tbody input[data-name=' + JSON.stringify(${JSON.stringify(PKG)}) + ']')`).catch(() => false);
      if (found) break;
      await sleep(250);
    }
    await sleep(300);
  }
  const opened = await evaluate(ws, `(function(){
    var want = ${JSON.stringify(PKG)};
    var rows = document.querySelectorAll('#pkg-tbody tr');
    // 优先按勾选框上的 data-name 精确匹配：搜索 "typescript" 时第一行可能是
    // @typescript/typescript-sunos-x64 这种「包含关系」的包，不能拿它当目标。
    function nameOf(r){ var cb = r.querySelector('input[data-name]'); return cb ? cb.getAttribute('data-name') : ''; }
    function clickDetail(r){
      var bs = r.querySelectorAll('button');
      for (var j=0;j<bs.length;j++){
        if (bs[j].textContent.replace(/\\s+/g,'').indexOf('详情') >= 0) { bs[j].click(); return true; }
      }
      return false;
    }
    for (var i=0;i<rows.length;i++){
      if (nameOf(rows[i]) === want && clickDetail(rows[i])) return { ok:true, exact:true, row:(rows[i].textContent||'').replace(/\\s+/g,' ').trim().slice(0,60) };
    }
    for (var k=0;k<rows.length;k++){
      var t = rows[k].textContent || '';
      if (t.indexOf(want) < 0) continue;
      if (clickDetail(rows[k])) return { ok:true, exact:false, row:t.replace(/\\s+/g,' ').trim().slice(0,60) };
    }
    return { ok:false, rows: rows.length };
  })()`);
  console.log('打开详情：' + JSON.stringify(opened));
  if (!opened || !opened.ok) { chrome.kill(); throw new Error('没找到包 ' + PKG + ' 的「详情」按钮'); }

  let snap = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    snap = await evaluate(ws, SNAP).catch(() => null);
    if (snap && snap.rows.length) break;
  }
  if (!snap) { chrome.kill(); throw new Error('详情抽屉没有渲染出版本表'); }

  const out = { pkg: PKG, shot: SHOT };
  out.pkgTime = pkgTime;
  out.fillModeOpts = fillModeOpts;
  out.firstVerTime = (snap.rows[0] && snap.rows[0].time) || '';
  out.chips = snap.chips || [];
  // 版本表所有采样行的发布时间（用来判断「是不是都变成了同一个本地时间」）
  out.verTimes = (snap.rows || []).map(r => r.time).filter(Boolean);
  out.distinctVerTimes = Array.from(new Set(out.verTimes));
  out.realVerTimes = out.distinctVerTimes.filter(t => t !== '—');
  out.heads = snap.heads;
  out.rowCountFirstPage = snap.rows.length;
  out.cols = snap.rows[0] ? snap.rows[0].cols : 0;
  out.pageText = (snap.bodyText.match(/共[^，。]{0,24}?页/g) || []).concat(snap.bodyText.match(/第\s*\d+\s*\/\s*\d+\s*页/g) || []);
  out.filterButtons = snap.btns.filter(b => /未下载|已下载|全部/.test(b)).slice(0, 6);
  out.keywordInput = snap.inputs.some(i => i.type === 'text' || i.type === 'search');
  out.hasSelectAll = snap.btns.some(b => /全选/.test(b));
  out.hasFillSelected = snap.btns.some(b => /补选中/.test(b)) || /补选中/.test(snap.bodyText);
  out.hasTagFill = snap.btns.some(b => /dist-tag/i.test(b));
  out.hasLatestFill = snap.btns.some(b => /补最新版本/.test(b));
  out.hasAllFill = snap.btns.some(b => /补.*缺失|全部缺失|补全部/.test(b));
  out.headHasSource = snap.heads.some(h => /源/.test(h));
  out.headHasLocal = snap.heads.some(h => /本地|体积/.test(h));

  // 2) 一键筛选「未下载」
  const clickedUndl = await evaluate(ws, `(function(){
    var bs = document.querySelectorAll('.drawer button');
    for (var i=0;i<bs.length;i++){ var t=bs[i].textContent.replace(/\\s+/g,''); if (t.indexOf('未下载')>=0){ bs[i].click(); return t; } }
    return null;
  })()`);
  await sleep(500);
  const onlyUncached = await evaluate(ws, SNAP);
  out.filterUncached = clickedUndl;
  out.uncachedAllUncached = onlyUncached.rows.length > 0 && onlyUncached.rows.every(r => !r.cached);
  out.uncachedRows = onlyUncached.rows.length;

  // 3) 关键字过滤（用当前页第一个版本号的前两段，例如 0.8）
  const kw = (onlyUncached.rows[0] && onlyUncached.rows[0].version || '0.0').split('.').slice(0, 2).join('.');
  const typed = await evaluate(ws, `(function(){
    var ins = document.querySelectorAll('.drawer input');
    for (var i=0;i<ins.length;i++){
      if (ins[i].type === 'text' || ins[i].type === 'search') {
        ins[i].value = ${JSON.stringify(kw)};
        ins[i].dispatchEvent(new Event('input', {bubbles:true}));
        ins[i].dispatchEvent(new Event('change', {bubbles:true}));
        return ins[i].placeholder || 'ok';
      }
    }
    return null;
  })()`);
  await sleep(600);
  const filtered = await evaluate(ws, SNAP);
  out.keyword = kw;
  out.keywordInputFound = typed;
  out.keywordAllMatch = filtered.rows.length > 0 && filtered.rows.every(r => r.version.indexOf(kw) >= 0);
  out.keywordRows = filtered.rows.length;

  // 清空关键字 + 回到「全部」
  await evaluate(ws, `(function(){
    var ins = document.querySelectorAll('.drawer input');
    for (var i=0;i<ins.length;i++){ if (ins[i].type==='text'||ins[i].type==='search'){ ins[i].value=''; ins[i].dispatchEvent(new Event('input',{bubbles:true})); } }
    // 注意：只能点「分段筛选」里的「全部」，不能用 .drawer button 模糊匹配「全部」——
    // 版本区标题旁的「补全部缺失 N 个」按钮也含「全部」二字，会误触发一次全量补下载任务。
    var bs = document.querySelectorAll('.drawer .segbar button');
    for (var j=0;j<bs.length;j++){ if (bs[j].textContent.replace(/\\s+/g,'') === '全部'){ bs[j].click(); break; } }
    return 1;
  })()`);
  await sleep(600);

  // 4) 翻页：记录第 1 页首行版本，点「下一页」，比较
  const firstOfPage1 = (await evaluate(ws, SNAP)).rows.map(r => r.version)[0] || null;
  // 版本数少于每页行数时（例如 ms 只有 32 个版本、每页 50 行）根本没有第 2 页，翻页断言不适用
  out.pagerText = await evaluate(ws, `(function(){
    var p = document.querySelector('.drawer .pager');
    return p ? p.textContent.replace(/\\s+/g,' ').trim() : '';
  })()`).catch(() => '');
  out.paginateApplicable = !!out.pagerText && !/第\s*1\s*\/\s*1\s*页/.test(String(out.pagerText));
  await evaluate(ws, `(function(){
    var bs = document.querySelectorAll('.drawer button');
    for (var i=0;i<bs.length;i++){ if (bs[i].textContent.replace(/\\s+/g,'').indexOf('下一页')>=0){ bs[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(700);
  const page2 = await evaluate(ws, SNAP);
  out.page2First = page2.rows.map(r => r.version)[0] || null;
  out.page1First = firstOfPage1;
  out.paginationWorks = (!out.paginateApplicable)
    || (!!firstOfPage1 && !!out.page2First && out.page2First !== firstOfPage1);
  await evaluate(ws, `(function(){
    var bs = document.querySelectorAll('.drawer button');
    for (var i=0;i<bs.length;i++){ if (bs[i].textContent.replace(/\\s+/g,'').indexOf('上一页')>=0){ bs[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(600);

  // 5) 勾选前 N 行 → 点「补选中」
  //    优先勾「未缓存」的行：否则 total=0，走的是「无需补充」分支，验证不到下载进度与汇总行。
  let picked = []; let afterPick = null; let started = null;
  let samples = []; let shot = false;
  if (NOFILL) {
    out.skipFill = true;
    await sleep(700);
    try {
      const cap0 = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(SHOT2), { recursive: true });
      fs.writeFileSync(SHOT2, Buffer.from(cap0.data, 'base64'));
      fs.writeFileSync(SHOT, Buffer.from(cap0.data, 'base64'));
      out.shotDrawer = SHOT2; out.shot = SHOT;
    } catch { /* 忽略 */ }
  } else {
  picked = await evaluate(ws, `(function(){
    var rows = document.querySelectorAll('.drawer table.tbl tbody tr');
    var cand = [];
    for (var i=0;i<rows.length;i++){
      var cb = rows[i].querySelector('input[type=checkbox]');
      if (!cb) continue;
      var t = rows[i].textContent.replace(/\\s+/g,' ').trim();
      cand.push({ cb: cb, t: t, un: t.indexOf('未缓存') >= 0 });
    }
    var list = cand.filter(function(c){ return c.un; });
    if (list.length < ${PICK}) list = list.concat(cand.filter(function(c){ return !c.un; }));
    list = list.slice(0, ${PICK});
    var got = [];
    list.forEach(function(c){ c.cb.click(); got.push(c.t.split(' ')[0]); });
    return got;
  })()`);
  await sleep(400);
  afterPick = await evaluate(ws, SNAP);
  out.pickedVersions = picked;
  out.pickButtonText = (afterPick.btns.filter(b => /补选中/.test(b))[0]) || null;

  // 6.0) 勾选完成、还没开始补下载时，先拍一张「抽屉本体」截图（筛选条 + 分页 + 本地/源体积两列）
  //      注意：Page.captureScreenshot 要等渲染器出一帧，若紧接着就点「补选中」，
  //      抓到的可能是「弹窗已经打开」的那一帧，所以拍照前后各留一点静止时间。
  await sleep(700);
  try {
    const cap0 = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(SHOT2), { recursive: true });
    fs.writeFileSync(SHOT2, Buffer.from(cap0.data, 'base64'));
    out.shotDrawer = SHOT2;
  } catch { /* 忽略 */ }
  await sleep(300);

  // 6) 点「补选中」→ 进度弹窗
  started = await evaluate(ws, `(function(){
    var bs = document.querySelectorAll('.drawer button, #modal-root button');
    for (var i=0;i<bs.length;i++){ if (/补选中/.test(bs[i].textContent.replace(/\\s+/g,''))) { bs[i].click(); return bs[i].textContent.replace(/\\s+/g,' ').trim(); } }
    return null;
  })()`);
  await sleep(500);
  // all/selected 若弹确认框，点「开始/确定」
  await evaluate(ws, `(function(){
    var bs = document.querySelectorAll('#modal-root .modal-foot button');
    for (var i=0;i<bs.length;i++){ var t=bs[i].textContent.replace(/\\s+/g,''); if (t.indexOf('开始')>=0||t.indexOf('确定')>=0){ bs[i].click(); return t; } }
    return null;
  })()`);

  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    await sleep(150);
    const s = await evaluate(ws, `(function(){
      var bar = document.querySelector('#modal-root .modal .progressbar i');
      var stat = document.querySelector('#modal-root .modal .fill-stat');
      return {
        modal: !!document.querySelector('#modal-root .modal'),
        width: bar ? bar.style.width : null,
        stat: stat ? stat.textContent.replace(/\\s+/g,' ').trim() : null,
        note: (function(){ var p=document.querySelector('#modal-root .modal .modal-body p'); return p ? p.textContent.replace(/\\s+/g,' ').trim().slice(0,120) : null; })(),
        rows: Array.prototype.map.call(document.querySelectorAll('#modal-root .modal .taskrow'), function(r){ return r.textContent.replace(/\\s+/g,' ').trim(); })
      };
    })()`).catch(() => null);
    if (!s) break;
    samples.push(s);
    if (!shot && s.modal && (s.width === '100%' || (s.rows || []).some(r => /完成|齐全|失败|已取消/.test(r)))) {
      try {
        const cap = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(SHOT, Buffer.from(cap.data, 'base64'));
        shot = true;
      } catch { /* 忽略 */ }
    }
    if (s.modal && (s.rows || []).some(r => /全部处理完毕|已齐全|完成|出错/.test(r))) break;
    if (!s.modal && samples.length > 6) break;
  }
  out.startedBy = started;
  out.modalStates = samples.filter(s => s.modal).length;
  out.percents = Array.from(new Set(samples.map(s => s.width).filter(Boolean)));
  out.lastStat = (samples.filter(s => s.stat).slice(-1)[0] || {}).stat || null;
  out.lastRows = (samples.filter(s => s.rows && s.rows.length).slice(-1)[0] || {}).rows || [];
  out.shot = shot ? SHOT : null;
  }

  const verdicts = [];
  const v = (name, ok, extra) => verdicts.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
  v('版本表按页渲染出数据行（首页行数 > 0 且 ≤ 200，不是一次性全量渲染）', out.rowCountFirstPage > 0 && out.rowCountFirstPage <= 200, `首页 ${out.rowCountFirstPage} 行 / ${out.heads.length} 列`);
  v('包列表「更新时间」带年份（YYYY-MM-DD HH:mm）', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(out.pkgTime)), String(out.pkgTime));
  const timeOk = t => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(t)) || String(t) === '—';
  v('版本表「发布时间」带年份（或显示 —）', out.verTimes.length > 0 && out.verTimes.every(timeOk), out.verTimes.slice(0, 3).join(' / '));
  // 回归：旧实现 publishedAt 拿本地收录时间兜底，一页里所有版本都显示同一个「今天」的时间。
  // 合法情况只有两种：全是 —（上游确实没有时间）或至少两个不同的真实时间。
  const allDash = out.verTimes.length > 0 && out.verTimes.every(t => t === '—');
  v('版本发布时间要么是全 —（上游没有），要么是多个不同的真实时间（不能全是同一本地时间）',
    allDash || out.realVerTimes.length >= 2,
    `${out.verTimes.length} 行 → 不同真实时间 ${out.realVerTimes.length} 个：${out.realVerTimes.slice(0, 3).join(' / ')}${allDash ? '（全部 —）' : ''}`);
  v('详情「概要」把上游时间与本地时间分开显示（上游创建 / 本地收录）',
    out.chips.some(c => /上游创建/.test(c)) && out.chips.some(c => /本地收录/.test(c)),
    out.chips.join(' | '));
  v('补 tarball 范围含「只补最新版本」', fillModeOpts.some(o => /只补最新版本/.test(o)), fillModeOpts.join(' / '));
  v('详情页有「补最新版本」按钮', !!out.hasLatestFill, snap.btns.filter(b => /补/.test(b)).join(' / '));
  v('表头同时有本地体积与源体积两列', out.headHasLocal && out.headHasSource, out.heads.join(' | '));
  v('有「未下载 / 已下载」一键筛选', out.filterButtons.length >= 2, out.filterButtons.join(' / '));
  v('筛选「未下载」后全部行都是未缓存', out.uncachedAllUncached, `${out.uncachedRows} 行`);
  v('关键字过滤生效', out.keywordAllMatch, `关键字 ${out.keyword} → ${out.keywordRows} 行`);
  v('翻页生效（第 2 页首行与第 1 页不同）', out.paginationWorks,
    out.paginateApplicable ? `${out.page1First} → ${out.page2First}` : `只有 1 页（${out.pagerText}），不适用`);
  if (NOFILL) {
    v('（--nofill）跳过勾选/补下载，只验证渲染', !!out.hasFillSelected, `「补选中」按钮存在=${out.hasFillSelected}`);
  } else {
    v('版本行可勾选且出现「补选中」按钮', out.pickedVersions.length === PICK && !!out.pickButtonText, `${JSON.stringify(out.pickedVersions)} 按钮=${out.pickButtonText}`);
    v('补选中弹出进度弹窗并有进度采样', out.modalStates > 0 && out.percents.length > 0, `采样 ${out.modalStates} 次，百分比 ${out.percents.join(' → ')}`);
  }

  // 结束后 600ms 再读一次（弹窗在全部成功时 1.5s 后才自动关闭）：
  // 回归防止两次轮询都拿到终态、重复追加「全部处理完毕」行与 toast。
  await sleep(600);
  const settledRows = await evaluate(ws, `(function(){
    return Array.prototype.map.call(document.querySelectorAll('#modal-root .modal .taskrow'), function(r){ return r.textContent.replace(/\\s+/g,' ').trim(); });
  })()`).catch(() => null);
  const rowsForCheck = (settledRows && settledRows.length) ? settledRows : out.lastRows;
  out.settledRows = settledRows;
  // 汇总行去重是回归项：轮询竞态下会追加两次「全部处理完毕」。
  // 注意采样的最终态可能因为弹窗在 1.5s 后自动关闭而读不到（截图耗时可能超过这个窗口），
  // 所以把所有采样快照都纳入判断：只要出现过一次且从未出现两次，就算通过。
  const rowSets = samples.map(s => s.rows).filter(r => r && r.length)
    .concat((settledRows && settledRows.length) ? [settledRows] : [])
    .concat(rowsForCheck && rowsForCheck.length ? [rowsForCheck] : []);
  const doneCounts = rowSets.map(rows => rows.filter(r => /全部处理完毕/.test(r)).length);
  out.doneRowCounts = doneCounts;
  if (!NOFILL) v('「全部处理完毕」汇总行只出现一次（轮询竞态回归）',
    doneCounts.some(c => c === 1) && !doneCounts.some(c => c > 1),
    `各次采样汇总行数 ${doneCounts.join('/') || '无'}`);

  out.verdicts = verdicts;
  const failed = verdicts.filter(x => !x.ok);
  console.log(JSON.stringify(out, null, 2));
  console.log('\n判定：' + (failed.length
    ? failed.map(f => `✗ ${f.name}（${f.extra}）`).join('；')
    : verdicts.map(x => `✓ ${x.name}`).join('；')));

  try { ws.close(); } catch { /* 忽略 */ }
  chrome.kill();
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error('失败：' + (e && e.stack || e)); process.exitCode = 2; });
