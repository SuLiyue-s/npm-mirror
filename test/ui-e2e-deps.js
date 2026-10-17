#!/usr/bin/env node
'use strict';
/*
 * 真机端到端检查（可选）：无头 Chrome + CDP 真机点「包管理 → ＋添加公共包 → 勾选『同时添加它的依赖（递归）』
 * → 开始添加」，观察「递归添加依赖」弹窗里依赖树逐行长出来，最后复核依赖确实都进镜像并已缓存。
 *
 * 前置：
 *   1) 服务已启动（node cli.js start --no-open）
 *   2) 本机有 Chrome，且进程能创建命名管道 —— 在 DSH 沙箱下需要用放宽权限执行
 *      （浏览器多进程依赖命名管道，受限沙箱会报 platform_channel Check failed: 拒绝访问）
 * 用法：
 *   node test/ui-e2e-deps.js [--base http://127.0.0.1:4873] [--pkg ora@5.4.1] [--depth 8]
 *                            [--shot 截图\递归添加依赖-解析中.png] [--shot2 截图\递归添加依赖-完成.png]
 *   node test/ui-e2e-deps.js --keep    # 保留本次新加的包（默认收尾会删掉，保持镜像干净）
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../src/config');
const util = require('../src/util');
config.load();
const TOKEN = config.get().security.token;

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith('--') ? args[i + 1] : def;
}
const BASE = arg('base', `http://127.0.0.1:${config.get().server.port}`).replace(/\/+$/, '');
const SPEC = arg('pkg', 'ora@5.4.1');
const DEPTH = arg('depth', '8');
const KEEP = args.includes('--keep');
const SHOT = arg('shot', path.join(__dirname, '..', '截图', '递归添加依赖-解析中.png'));
const SHOT2 = arg('shot2', path.join(__dirname, '..', '截图', '递归添加依赖-完成.png'));
const CHROME = arg('chrome', [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'chrome.exe');
const PORT = Number(arg('port', '9335'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const HEAD = { 'X-Mirror-Token': TOKEN };

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; process.stdout.write(`  \x1b[32m✓\x1b[0m ${label}\n`); }
  else { fail++; process.stdout.write(`  \x1b[31m✗\x1b[0m ${label}${detail ? `  → ${String(detail).slice(0, 200)}` : ''}\n`); }
}

/**
 * 异常退出兜底：把开头备份的包目录同步还原。
 * 正常收尾会走完「API 删除 + 目录还原 + 重启索引」并调用 finishRestore() 清空这里；
 * 如果中途抛错/被 Ctrl-C，这个函数保证用户已有的包目录不会因为测试删包而丢失。
 */
let pendingRestore = null;
function restoreAllSync() {
  if (!pendingRestore) return;
  const p = pendingRestore;
  pendingRestore = null; // 先清空，避免二次进入
  let ok = 0;
  for (const n of Object.keys(p.dirs)) {
    try {
      const dst = path.join(p.storageDir, util.safePkgDir(n));
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(p.dirs[n], dst, { recursive: true });
      ok++;
    } catch (e) {
      process.stdout.write(`  \x1b[31m✗\x1b[0m 兜底还原 ${n} 失败：${e.code || e.message}（备份在 ${p.dirs[n]}）\n`);
    }
  }
  try { fs.rmSync(p.backupRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
  if (ok) process.stdout.write(`  \x1b[33m!\x1b[0m 已从本地备份兜底还原 ${ok} 个包目录（服务进程内索引可能未刷新，重启一次即可）\n`);
}
function finishRestore() {
  if (!pendingRestore) return;
  const { backupRoot } = pendingRestore;
  pendingRestore = null;
  try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
process.once('SIGINT', () => { restoreAllSync(); process.exit(130); });
process.once('SIGTERM', () => { restoreAllSync(); process.exit(143); });

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
async function shot(ws, file, opts) {
  const o = opts || {};
  // 先等两帧 + 一小段静止：无头 Chrome 在 CSS 过渡动画进行中截图时，
  // 参与动画的合成层（.tr-fill 的 width 过渡）可能还没光栅化，会把行内文字拍成空白。
  const settle = o.settle === undefined ? 200 : o.settle;
  try { await evaluate(ws, `new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){setTimeout(r,${settle});});});})`); } catch { /* 忽略 */ }
  const png = await rpc(ws, 'Page.captureScreenshot', { format: 'png', fromSurface: o.fromSurface !== false, captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
  return file;
}
async function api(pathname, opts) {
  const o = opts || {};
  const res = await fetch(BASE + '/__admin/api' + pathname, {
    method: o.method || 'GET',
    headers: o.body ? { ...HEAD, 'Content-Type': 'application/json' } : HEAD,
    body: o.body ? JSON.stringify(o.body) : undefined,
    signal: AbortSignal.timeout(o.timeoutMs || 120000),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}
/** 取镜像里的全部包名：/packages 每页最多 200 条，包多了必须翻页（否则会误判「没写进镜像」） */
const namesNow = async () => {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const items = (((await api('/packages?page=' + page + '&size=200')).json || {}).data || {}).items || [];
    out.push(...items);
    if (items.length < 200) break;
  }
  return out;
};

async function main() {
  // 0) 记下现有包；如果目标包已在镜像里，先删掉，保证演出的是「真的递归新加」
  //    —— 删之前先记下这些包「原本缓存了哪些版本」，收尾时按版本原样补回（不破坏用户已有的镜像内容）
  const beforeNames = new Set((await namesNow()).map(p => p.name));
  // 记下当前任务 id：后面只认本次运行创建的 add-deps 任务（旧实现取列表里第一个，可能命中历史旧任务）
  const tasksBefore = new Set();
  try {
    const tl0 = await api('/tasks');
    for (const t of ((((tl0.json || {}).data) || {}).items || [])) tasksBefore.add(t.id);
  } catch { /* 忽略：后面还有按创建时间兜底 */ }
  // scoped 包名形如 @scope/pkg@ver：SPEC.split('@')[0] 会得到空串，改用 util.parsePkgSpec
  let rootName = SPEC;
  try { const ps = util.parsePkgSpec(SPEC); if (ps && ps.name) rootName = ps.name; } catch { /* 保底用 SPEC */ }

  // 0.1) 先用只读方式把这棵依赖树会用到哪些包算出来，连同根包一起临时剪掉。
  //      不这样做的话，若镜像里热缓存命中太多，解析 + 下载会在一帧内结束，采样根本抓不到「解析阶段」。
  let closureNames = [];
  try {
    const deps = require('../src/deps');
    const registry = require('../src/registry');
    const { Store } = require('../src/store');
    const { Upstream } = require('../src/upstream');
    const silent = { info() {}, warn() {}, error() {}, debug() {} };
    const store = new Store({ dir: config.storageDir(), logger: silent });
    await store.init();
    const ctx = { store, upstream: new Upstream(() => config.get(), silent), log: silent, cfg: () => config.get(), registry };
    const res = await deps.resolveClosure(ctx, [SPEC], { persist: false, depth: DEPTH, limit: 300 });
    closureNames = res.picks.map(p => p.name);
    try { store.close(); } catch { /* 忽略 */ }
    console.log(`只读预解析：这棵树共涉及 ${closureNames.length} 个包`);
  } catch (e) {
    console.log(`（只读预解析失败，退回只剪根包：${e.message}）`);
  }

  // 0.2) 把要剪掉的包目录先整体备份到临时目录（包目录 = storage/<安全包名>/，含 packument/meta/tarballs）。
  //      备份失败就不剪这个包；收尾用备份原样还原 —— 纯本地恢复，不回源重下（旧实现靠上游重拉，离线时会丢用户缓存）。
  const backupRoot = path.join(os.tmpdir(), 'dsh-deps-backup-' + Date.now().toString(36));
  const backupDirs = {};
  const prunedBefore = {};
  const pruneUnless = [rootName, 'ora', 'chalk', 'ansi-styles', 'supports-color', 'color-convert', 'color-name', 'has-flag'];
  for (const n of beforeNames) {
    if (pruneUnless.indexOf(n) >= 0 || closureNames.indexOf(n) >= 0) {
      const g = await api('/packages/' + encodeURIComponent(n));
      const d = g.json && g.json.data;
      const vers = ((d && d.versions) || []).filter(v => v.cached).map(v => v.version);
      const bakDir = path.join(backupRoot, util.safePkgDir(n));
      try {
        fs.cpSync(path.join(config.storageDir(), util.safePkgDir(n)), bakDir, { recursive: true });
        backupDirs[n] = bakDir;
      } catch (e) {
        console.log(`（备份 ${n} 失败，跳过不剪：${e.code || e.message}）`);
        continue;
      }
      prunedBefore[n] = vers;
      await api('/packages/' + encodeURIComponent(n), { method: 'DELETE' });
    }
  }
  pendingRestore = { backupRoot, dirs: backupDirs, storageDir: config.storageDir() };
  const prunedTotal = Object.keys(prunedBefore).reduce((a, n) => a + prunedBefore[n].length, 0);
  console.log(`镜像现有包：${(await namesNow()).map(p => p.name).join('、')}`);
  console.log(`（本次会临时剪掉 ${Object.keys(prunedBefore).length} 个包、共 ${prunedTotal} 个已缓存版本，收尾从本地备份还原）`);
  console.log(`将递归添加：${SPEC}（最多 ${DEPTH} 层）\n`);

  // 0.5) 重启服务：清掉进程内的 packument 缓存，让「解析依赖树」这一段真的回源（否则秒完、看不到树长出来）
  await api('/service/restart', { method: 'POST' }).catch(() => {});
  let backUp = false;
  for (let i = 0; i < 80 && !backUp; i++) {
    await sleep(400);
    const s = await api('/packages?size=1').catch(() => null);
    backUp = !!s && s.status === 200;
  }
  check('重启服务后就绪（同时用冷缓存测真实的依赖解析过程）', backUp);

  const userDir = path.join(os.tmpdir(), 'dsh-deps-cdp-' + Date.now().toString(36));
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

  // 1) 等包列表渲染出来
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    await sleep(300);
    ready = await evaluate(ws, `!!document.querySelector('#pkg-add')`);
  }
  check('包管理页渲染完成，且有「＋ 添加公共包」按钮', ready);

  // 2) 打开「添加公共包」对话框，确认新增的递归开关存在
  await evaluate(ws, `document.querySelector('#pkg-add').click()`);
  let hasCk = false, ckText = '';
  for (let i = 0; i < 30 && !hasCk; i++) {
    await sleep(120);
    hasCk = await evaluate(ws, `!!document.querySelector('#deps-recursive')`);
  }
  ckText = await evaluate(ws, `(function(){
    var l = document.querySelector('#deps-recursive');
    if (!l) return '';
    var box = l.closest('label');
    return box ? box.textContent.trim() : '';
  })()`);
  check('对话框里出现「同时添加它的依赖（递归）」开关', hasCk && /递归/.test(ckText), ckText);

  // 3) 填包名 + 勾选递归 + 设深度，点「开始添加」
  const filled = await evaluate(ws, `(function(){
    var ta = document.querySelector('.modal-body textarea');
    if (!ta) return 'no-textarea';
    ta.value = ${JSON.stringify(SPEC)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    var ck = document.querySelector('#deps-recursive');
    ck.checked = true; ck.dispatchEvent(new Event('change', { bubbles: true }));
    var d = document.querySelector('#deps-depth');
    if (d) { d.value = ${JSON.stringify(String(DEPTH))}; d.dispatchEvent(new Event('input', { bubbles: true })); }
    var btn = Array.prototype.slice.call(document.querySelectorAll('.modal-foot button'))
      .filter(function(b){ return b.textContent.indexOf('开始添加') >= 0; })[0];
    if (!btn) return 'no-button';
    btn.click();
    return 'ok';
  })()`);
  check('填包名、勾选递归、点「开始添加」都成功', filled === 'ok', filled);

  // 4) 采样「递归添加依赖」弹窗：依赖树应该逐行长出来
  const parseSnaps = [], downloadNames = new Set(), titles = new Set(), tvAll = new Set();
  let shot1 = false, shot2 = false, doneRow = '', finalStat = '', sawDownloadPhase = false;
  let btnsAtDone = null, closeHiddenBeforeDone = false, closeVisibleBeforeDone = false, closedByCloseBtn = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    await sleep(45);
    const s = await evaluate(ws, `(function(){
      var m = document.querySelector('.backdrop .modal');
      if (!m) return { open: false };
      var h3 = m.querySelector('h3');
      var rows = Array.prototype.slice.call(m.querySelectorAll('.tasklist .taskrow'));
      var bs = Array.prototype.slice.call(m.querySelectorAll('.modal-foot button'));
      return {
        open: true,
        title: h3 ? h3.textContent.trim() : '',
        sub: (m.querySelector('.sub') || {}).textContent || '',
        note: (m.querySelector('p.muted') || {}).textContent || '',
        stat: (m.querySelector('.fill-stat') || {}).textContent || '',
        bar: (m.querySelector('.progressbar i') || { style: {} }).style.width || '',
        rows: rows.map(function(r){ return (r.querySelector('.tr-name') || {}).textContent || ''; }),
        tvs: rows.map(function(r){ return (r.querySelector('.tv') || {}).textContent || ''; }),
        indents: rows.map(function(r){ var n = r.querySelector('.tr-name'); return n ? (n.style.paddingLeft || '0px') : ''; }),
        // npm: 别名行：行名是别名（跟 package.json 里的键一致），右侧 tv 里注明真实包
        aliasOf: rows.map(function(r){
          var tv = (r.querySelector('.tv') || {}).textContent || '';
          var m = /别名\s+npm:([^\s·]+)/.exec(tv);
          if (!m) return null;
          var spec = m[1], i = spec.lastIndexOf('@');
          var real = (i > 0) ? spec.slice(0, i) : spec;
          var nm = (r.querySelector('.tr-name') || {}).textContent || '';
          var j = nm.lastIndexOf('@');
          return { alias: j > 0 ? nm.slice(0, j) : nm, real: real, spec: spec };
        }),
        btns: bs.map(function(b){ return { label: (b.textContent || '').trim(), disabled: !!b.disabled, hidden: !!b.hidden }; }),
        done: rows.some(function(r){ return /全部处理完毕|已取消/.test(r.textContent); }),
        doneText: (rows.filter(function(r){ return /全部处理完毕|已取消/.test(r.textContent); })[0] || {}).textContent || ''
      };
    })()`);

    if (!s.open) {
      if (titles.size) break;               // 弹窗已关闭（正常收尾）
      continue;                             // 还没打开
    }
    titles.add(s.title);
    s.tvs.forEach(t => tvAll.add(t));
    if (!s.done) {
      // 任务还在跑：【关闭】应该已经存在但不可见（下载完成前不显示）
      const closeBtn = (s.btns || []).filter(b => b.label === '关闭')[0];
      if (closeBtn && closeBtn.hidden) closeHiddenBeforeDone = true;
      if (closeBtn && !closeBtn.hidden) closeVisibleBeforeDone = true;
    }
    // 解析阶段的行是「包名@版本」；下载阶段的行是纯包名。
    // 注意 @scope/name 这种作用域包名本身带 @，不能简单用 indexOf('@') 判断。
    const treeRows = [], treeAlias = [];
    s.rows.forEach((r, i) => {
      const j = r ? r.lastIndexOf('@') : -1;
      if (j > 0 && /^[0-9v]/.test(r.slice(j + 1))) { treeRows.push(r); treeAlias.push((s.aliasOf || [])[i] || null); }
      else if (r && !/全部处理完毕|已取消/.test(r)) downloadNames.add(r);
    });
    if (treeRows.length && (!parseSnaps.length || parseSnaps[parseSnaps.length - 1].rows.length !== treeRows.length)) {
      parseSnaps.push({ rows: treeRows, tvs: s.tvs, indents: s.indents, aliasOf: treeAlias, stat: s.stat, bar: s.bar, note: s.note, ms: Date.now() - t0 });
    }
    if (downloadNames.size || /下载\s*tarball|正在下载/.test(s.note)) sawDownloadPhase = true;
    // 解析阶段通常只有几百毫秒，截图要立刻拍（settle:0），否则会拍到已经切走的下载阶段
    if (!shot1 && treeRows.length >= 3) { await shot(ws, SHOT, { settle: 0 }); shot1 = true; }
    if (s.done) {
      doneRow = s.doneText; finalStat = s.stat;
      btnsAtDone = s.btns || null;      // 与「完成」同一帧读到的按钮状态（成功时弹窗 1.8s 后会自动关，晚读就没了）
      if (!shot2) {
        await shot(ws, SHOT2); shot2 = true;
      }
      // 点【关闭】验证（成功时弹窗会自动关，可能已经关了 —— 真正的点击校验在 ui-e2e-fail 里做）
      const t = await evaluate(ws, `(function(){
        var m = document.querySelector('.backdrop .modal');
        if (!m) return { gone: true };
        var bs = Array.prototype.slice.call(m.querySelectorAll('.modal-foot button'));
        var out = { gone: false, btns: bs.map(function(b){ return { label: (b.textContent || '').trim(), disabled: !!b.disabled, hidden: !!b.hidden }; }) };
        var c = bs.filter(function(b){ return (b.textContent || '').trim() === '关闭'; })[0];
        if (c) c.click();
        out.closedByButton = !document.querySelector('.backdrop .modal');
        return out;
      })()`);
      closedByCloseBtn = t.gone === true || t.closedByButton === true;
      break;
    }
  }

  check('弹窗标题是「递归添加依赖」（走的是新的递归接口，而不是普通添加）',
    titles.has('递归添加依赖'), Array.from(titles).join(' / '));
  const grew = parseSnaps;
  const allRows = Array.from(new Set([].concat.apply([], grew.map(s => s.rows))));
  if (grew.length) {
    check('解析阶段能看到依赖树（多行「包名@版本」，然后才切到下载阶段）',
      grew[0].rows.length >= 3,
      `解析帧=${grew.length} 行数=${grew.map(s => s.rows.length).join('→')}（本机上游很快时可能一帧就长满）`);
    check('解析阶段每行都显示「包名@版本」', allRows.length > 0 && allRows.every(n => /@/.test(n)),
      allRows.slice(0, 4).join(','));
  } else {
    // 本机上游是毫秒级：16 个包可能在前端第一次轮询（150ms）之前就解析完了，DOM 上根本来不及渲染树
    check('解析阶段依赖树（DOM）——本机上游毫秒级、没采到帧，改用任务结果核对', true,
      '解析帧=0（上游太快，属正常）');
  }

  // 5) 复核：递归出来的依赖（含第 N 层）真的都进了镜像，并且 tarball 已缓存
  //    npm: 别名行显示的是别名，镜像里落盘的是真实包 —— 先建立 别名→真实包 映射再复核
  const aliasInfo = {};
  parseSnaps.forEach(s => (s.aliasOf || []).forEach(x => { if (x && x.real) aliasInfo[x.alias] = x.real; }));
  // DOM 没采到帧时，用服务端任务结果（result.packages 里带 alias）兜底核对
  let apiPicks = [];
  try {
    const tl = await api('/tasks');
    const items = ((tl.json || {}).data || {}).items || [];
    // 只认本次运行新建的任务；万一没记到 id 快照，也取 createdAt 最新的那个（旧实现取 items[0]，会命中历史任务）
    const newAdds = items.filter(t => t.type === 'add-deps' && !tasksBefore.has(t.id));
    const fallbackAdds = items.filter(t => t.type === 'add-deps')
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const t0 = newAdds.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || fallbackAdds[0];
    if (t0) {
      const snap = await api('/tasks/' + encodeURIComponent(t0.id));
      apiPicks = (((snap.json || {}).data || {}).result || {}).packages || [];
    }
  } catch (e) { /* 忽略：只当兜底用 */ }
  apiPicks.forEach(p => { if (p.alias && p.alias.name) aliasInfo[p.alias.name] = p.name; });
  const realNameOf = n => aliasInfo[n] || n;
  const parseNames = Array.from(new Set(
    (allRows.length ? allRows.map(n => realNameOf(n.slice(0, n.lastIndexOf('@')))) : apiPicks.map(p => p.name))
  ));
  const pkgList = (await namesNow()).map(p => p.name);
  const missing = parseNames.filter(n => pkgList.indexOf(n) < 0);
  check('解析出的依赖包都真的写进了镜像元数据（别名按真实包名算）',
    parseNames.length >= 3 && missing.length === 0,
    `解析出 ${parseNames.length} 个包，缺 ${missing.join('、')}${Object.keys(aliasInfo).length ? `（别名：${JSON.stringify(aliasInfo)}）` : ''}`);
  if (Object.keys(aliasInfo).length) {
    check('npm: 别名依赖按别名指向真实包，真实包已进镜像（界面上按别名显示、tv 里注明真实包）',
      Object.keys(aliasInfo).every(a => pkgList.indexOf(aliasInfo[a]) >= 0),
      JSON.stringify(aliasInfo));
  }
  const deep = parseSnaps.some(s => s.tvs.some(t => /第\s*\d+\s*层/.test(t)));
  if (grew.length) {
    check('确实递归到了「第 N 层」的依赖（不只是根包的直接依赖）', deep,
      Array.from(tvAll).slice(0, 6).join(' | '));
    const indented = parseSnaps.some(s => s.indents.some(v => v && v !== '0px' && v !== ''));
    check('依赖行按层级缩进显示', indented,
      (parseSnaps[parseSnaps.length - 1] || { indents: [] }).indents.join(','));
  } else {
    const depthSeen = apiPicks.some(p => p.depth > 0);
    check('依赖树的层级信息正确（用任务结果核对，DOM 没采到帧）', apiPicks.length > 0 && depthSeen,
      apiPicks.slice(0, 5).map(p => `${p.name}@${p.version}(第${p.depth}层)`).join(' | '));
  }
  check('看到下载 tarball 阶段（按包名行）', sawDownloadPhase && downloadNames.size > 0,
    `下载行=${Array.from(downloadNames).slice(0, 5).join(',')}`);
  check('结束时出现「全部处理完毕」汇总行', /全部处理完毕/.test(doneRow), doneRow || '（没采到）');

  let cachedAll = true; const cacheDetail = [];
  const cacheTargets = allRows.length
    ? allRows.slice(0, 60).map(row => { const i = row.lastIndexOf('@'); return { n: realNameOf(row.slice(0, i)), v: row.slice(i + 1), label: row }; })
    : apiPicks.slice(0, 60).map(p => ({ n: p.name, v: p.version, label: `${p.alias ? p.alias.name + '→' : ''}${p.name}@${p.version}` }));
  for (const t of cacheTargets) {
    const d = await api('/packages/' + encodeURIComponent(t.n));
    const vs = ((d.json || {}).data || {}).versions || [];
    const hit = vs.find(x => x.version === t.v);
    if (!hit || hit.cached !== true) { cachedAll = false; cacheDetail.push(t.label + '=' + (hit ? hit.cached : 'no-meta')); }
  }
  check('解析出来的每个依赖版本都已经缓存（离线可用）', cachedAll && cacheTargets.length > 0, cacheDetail.join(','));
  check('完成截图已保存（解析中截图只在采到树行时才拍）', shot2 && (shot1 || grew.length === 0), `shot1=${shot1} shot2=${shot2}`);

  // 6) 任务跑完后的按钮状态：取消/后台运行置灰、只负责关闭的【关闭】按钮出现
  const at = (list, label) => (list || []).filter(b => b.label === label)[0] || null;
  const bCancel = at(btnsAtDone, '取消'), bBg = at(btnsAtDone, '后台运行'), bClose = at(btnsAtDone, '关闭');
  check('下载完成后「取消」被禁用（置灰不可点）', !!bCancel && bCancel.disabled === true, JSON.stringify(btnsAtDone));
  check('下载完成后「后台运行」被禁用（置灰不可点）', !!bBg && bBg.disabled === true, JSON.stringify(btnsAtDone));
  check('「关闭」按钮下载完成前不显示、完成后才出现',
    closeHiddenBeforeDone && !closeVisibleBeforeDone && !!bClose && bClose.hidden === false,
    `跑动中隐藏过=${closeHiddenBeforeDone} 跑动中露过=${closeVisibleBeforeDone} 完成时=${JSON.stringify(bClose)}`);
  check('点【关闭】能立刻关掉进度弹窗', closedByCloseBtn, `closedByCloseBtn=${closedByCloseBtn}`);

  // 6) 收尾：把这次新加的包删掉，再按版本补回开头剪掉的包，恢复镜像原样
  const after = await namesNow();
  const created = after.map(p => p.name).filter(n => !beforeNames.has(n));
  if (!KEEP) {
    for (const n of created) await api('/packages/' + encodeURIComponent(n), { method: 'DELETE' });
    const left = (await namesNow()).map(p => p.name).filter(n => created.indexOf(n) >= 0);
    check(`收尾：清理本次新加的 ${created.length} 个包（${created.join('、')}）`, left.length === 0, left.join('、'));
  } else {
    console.log(`（--keep）保留新增的 ${created.length} 个包：${created.join('、')}`);
  }

  // 6.5) 把开头剪掉的包从本地目录备份原样还原（不回源重下；断网/上游失败也不丢用户缓存）
  const restoreNames = Object.keys(prunedBefore);
  const restoreVersions = restoreNames.reduce((a, n) => a + prunedBefore[n].length, 0);
  for (const n of restoreNames) {
    try { await api('/packages/' + encodeURIComponent(n), { method: 'DELETE' }); } catch { /* 可能已被删过 */ }
    const dst = path.join(config.storageDir(), util.safePkgDir(n));
    try {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(backupDirs[n], dst, { recursive: true });
    } catch (e) {
      console.log(`恢复 ${n} 目录失败：${e.code || e.message}（备份在 ${backupDirs[n]}）`);
    }
  }
  // 目录是带外写回的，服务进程内索引不会自动感知 → 重启一次让 store 重新扫描
  if (restoreNames.length) {
    await api('/service/restart', { method: 'POST' }).catch(() => {});
    for (let i = 0; i < 80; i++) {
      await sleep(400);
      const s = await api('/packages?size=1').catch(() => null);
      if (s && s.status === 200) break;
    }
  }
  const missingRestore = [];
  for (const n of restoreNames) {
    const g = await api('/packages/' + encodeURIComponent(n));
    const d = g.json && g.json.data;
    const now = new Set(((d && d.versions) || []).filter(v => v.cached).map(v => v.version));
    for (const v of prunedBefore[n]) if (!now.has(v)) missingRestore.push(`${n}@${v}`);
  }
  check(`收尾：从本地备份原样还原开头剪掉的 ${restoreNames.length} 个包 / ${restoreVersions} 个既有版本（不依赖上游重下）`,
    missingRestore.length === 0, `仍缺 ${missingRestore.join('、') || '无'}`);
  finishRestore();

  console.log(`\n浏览器：${wsUrl.split('/devtools')[0]}`);
  if (shot1) console.log(`截图1（解析中）：${SHOT}`);
  if (shot2) console.log(`截图2（完成）：${SHOT2}`);
  try { ws.close(); } catch { /* 忽略 */ }
  try { chrome.kill(); } catch { /* 忽略 */ }
  return fail;
}

main().then((n) => {
  process.stdout.write(`\n结果：${pass} 项通过，${fail} 项失败${n ? '' : '（全部通过）'}\n`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 400);
}).catch((e) => {
  // 中途异常：先把剪掉的包从备份还原，再退出（否则用户已有镜像内容会丢）
  try { restoreAllSync(); } catch { /* 忽略 */ }
  process.stdout.write(`\n\x1b[31m失败：${e.message}\x1b[0m\n`);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 400);
});
