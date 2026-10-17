#!/usr/bin/env node
'use strict';
/*
 * 私人 npm 镜像源 —— 命令行工具
 * 用法：node cli.js <命令> [参数]
 * 命令：start | init | config | token | stop | restart | status | open | use | unuse |
 *       list | stats | export | import | import-cache | scan-cache | logs | doctor | help
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const util = require('./src/util');
const config = require('./src/config');
const loggerMod = require('./src/logger');
const { Store } = require('./src/store');
const bundle = require('./src/bundle');
const npmcache = require('./src/npmcache');

const PID_FILE = util.rootPath('data', 'mirror.pid');
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

// ---------------------------------------------------------------- 参数解析
// 需要取值的 flag 白名单（--flag value 或 --flag=value），其余一律按布尔开关处理，
// 避免 `import --overwrite pkg.tgz` 这类写法把后面的位置参数误吞成开关的值。
const VALUE_FLAGS = new Set([
  'ip', 'port', 'mode', 'registry', 'q', 'source', 'sort', 'size', 'scope', 'out',
  'cache', 'depth', 'limit', 'version', 'lines', 'level',
]);
const raw = process.argv.slice(2);
let command = 'start';
if (raw.length && /^(-h|--help|-help)$/.test(raw[0])) command = 'help';
else if (raw.length && !raw[0].startsWith('-')) command = raw.shift();
const flags = {};
const positional = [];
for (let i = 0; i < raw.length; i++) {
  const a = raw[i];
  if (a.startsWith('--') || a.startsWith('-')) {
    const body = a.replace(/^-+/, '');
    const eq = body.indexOf('=');
    if (eq >= 0) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    if (VALUE_FLAGS.has(body) && raw[i + 1] && !raw[i + 1].startsWith('-')) flags[body] = raw[++i];
    else flags[body] = true;
  } else {
    positional.push(a);
  }
}

const log = (msg) => process.stdout.write(msg + '\n');

// ---------------------------------------------------------------- 工具
function readPid() {
  try {
    const j = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    return j && j.pid ? j : null;
  } catch { return null; }
}

function writePid(extra) {
  const cfg = config.get();
  util.writeJsonAtomic(PID_FILE, {
    pid: process.pid,
    ip: cfg.server.ip,
    port: cfg.server.port,
    mode: cfg.mode,
    url: require('./src/http-util').registryUrl(cfg),
    startedAt: util.nowIso(),
    ...extra,
  });
}

function clearPid() {
  try { if (readPid() && readPid().pid === process.pid) fs.unlinkSync(PID_FILE); } catch { /* 忽略 */ }
}

// 进程因任何原因退出（含未捕获异常）时，如果 PID 文件记录的是本进程，就顺手清理，避免残留旧 PID
process.on('exit', () => {
  try { const p = readPid(); if (p && p.pid === process.pid) fs.unlinkSync(PID_FILE); } catch { /* 忽略 */ }
});

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function makeStore(quiet) {
  const cfg = config.get();
  const lg = loggerMod.init({ dir: config.logsDir(), level: quiet ? 'warn' : (flags.verbose ? 'debug' : cfg.log.level), maxDays: cfg.log.maxDays, console: false });
  const store = new Store({ dir: config.storageDir(), logger: lg });
  store.init();
  return { store, lg };
}

async function httpJson(url, { method = 'GET', body, token, timeoutMs = 15000 } = {}) {
  const headers = { 'X-Mirror-Token': token || config.get().security.token };
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error((json && (json.error || json.message)) || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = json && json.code;
    throw err;
  }
  return json && json.ok === true ? json.data : json;
}

function localUrl(p = '/') {
  const cfg = config.get();
  const ip = !cfg.server.ip || cfg.server.ip === '0.0.0.0' || cfg.server.ip === '::' ? '127.0.0.1' : cfg.server.ip;
  return `http://${ip}:${cfg.server.port}${p}`;
}

function human(n) { return util.formatBytes(n || 0); }

// ---------------------------------------------------------------- 命令实现
const commands = {};

commands.help = function () {
  log([
    '',
    `${C.bold}私人 npm 镜像源 —— 命令行工具 v${require('./package.json').version}${C.reset}`,
    '',
    `${C.cyan}启动与停止${C.reset}`,
    '  node cli.js start [--ip 127.0.0.1] [--port 4873] [--mode cache|proxy|offline] [--registry URL] [--no-open]',
    '  node cli.js stop              停止正在运行的镜像源',
    '  node cli.js restart           重启镜像源',
    '  node cli.js status            查看运行状态',
    '  node cli.js open              在浏览器中打开管理界面',
    '',
    `${C.cyan}配置${C.reset}`,
    '  node cli.js init              初始化配置文件（打印访问令牌）',
    '  node cli.js config [--reveal] 查看当前配置（--reveal 显示完整令牌）',
    '  node cli.js token             显示访问令牌',
    '  node cli.js use [--project]   把本机 npm 源切换为镜像源（会备份原 ~/.npmrc）',
    '  node cli.js unuse             还原 npm 源为切换前的状态',
    '  node cli.js autostart on|off|status   开机自启开关（写入「启动」文件夹，无需管理员）',
    '',
    `${C.cyan}包管理（离线可用，无需启动服务）${C.reset}`,
    '  node cli.js list [--q 关键字] [--source all|upstream|private|upload|cache] [--size 50]',
    '  node cli.js add <包名[@版本|@范围]> [--no-prefetch]   添加公共包（元数据 + tarball 缓存到本地）',
    '  node cli.js add <包名> --with-deps [--depth 8] [--limit 300] [--optional] [--peer]',
    '                                递归添加：连它的依赖、依赖的依赖一起加进来（npm: 别名会解析到真实包）',
    '  node cli.js remove <包名> [--version 1.2.3] [--yes]   删除包或单个版本',
    '  node cli.js stats             统计包/版本/占用空间',
    '  node cli.js export [--scope all|private|upstream] [--out 文件名] [包名...]',
    '  node cli.js import <文件.tgz|文件.json> [--overwrite]',
    '  node cli.js scan-cache [--cache 目录] [--any-registry] [--refresh]',
    '                                默认只扫描当前上游源的缓存条目；--any-registry 扫描所有源；--refresh 先清空上次结果再全量重扫',
    '  node cli.js import-cache [--all] [--overwrite] [包名...]',
    '',
    `${C.cyan}排查${C.reset}`,
    '  node cli.js doctor            环境自检（Node 版本、端口、目录、可离线性）',
    '  node cli.js logs [--lines 100] [--level info]',
    '',
  ].join('\n'));
};

commands.init = function () {
  const existed = fs.existsSync(config.CONFIG_FILE);
  config.load();
  const cfg = config.get();
  config.save({});
  log(`${existed ? '配置已存在，未覆盖' : '已创建配置文件'}：${config.CONFIG_FILE}`);
  log(`  监听地址 : ${cfg.server.ip}:${cfg.server.port}`);
  log(`  运行模式 : ${cfg.mode}`);
  log(`  访问令牌 : ${C.bold}${cfg.security.token}${C.reset}`);
  log(`  数据目录 : ${config.storageDir()}`);
  log('');
  log(`下一步：${C.cyan}node cli.js start${C.reset} 启动服务，然后浏览器打开 ${C.cyan}http://127.0.0.1:${cfg.server.port}${C.reset}`);
};

commands.config = function () {
  config.load();
  const cfg = flags.reveal ? config.get() : config.publicConfig(false);
  log(JSON.stringify(cfg, null, 2));
  log(`${C.dim}配置文件：${config.CONFIG_FILE}${C.reset}`);
};

commands.token = function () {
  config.load();
  log(config.get().security.token);
};

/** 开机自启：用「启动」文件夹里的一个 .cmd 实现，不需要管理员权限，也不写注册表 */
function startupDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}
function startupFile() { return path.join(startupDir(), '私人npm镜像源.cmd'); }

commands.autostart = async function () {
  const action = positional[0] || 'status';
  const file = startupFile();
  if (action === 'on' || action === 'enable') {
    util.ensureDir(startupDir());
    const cli = path.join(util.ROOT, 'cli.js');
    const body = [
      '@echo off',
      'chcp 65001 >nul',
      'rem 由 cli.js autostart on 生成：开机后自动在后台启动私人 npm 镜像源',
      `start "" /min "${process.execPath}" "${cli}" start --no-open`,
      '',
    ].join('\r\n');
    fs.writeFileSync(file, body, 'utf8');
    log(`${C.green}已开启开机自启${C.reset}`);
    log(`  启动项文件：${file}`);
    log(`${C.dim}如需关闭：node cli.js autostart off${C.reset}`);
    return;
  }
  if (action === 'off' || action === 'disable') {
    let removed = false;
    try { fs.unlinkSync(file); removed = true; } catch { /* 不存在 */ }
    log(removed ? `${C.green}已关闭开机自启${C.reset}（已删除 ${file}）` : `${C.yellow}开机自启本来就是关闭状态${C.reset}`);
    return;
  }
  log(`开机自启：${fs.existsSync(file) ? C.green + '已开启' + C.reset : C.yellow + '未开启' + C.reset}`);
  log(`  启动项文件：${file}`);
  log(`${C.dim}用法：node cli.js autostart on|off|status${C.reset}`);
};

commands.doctor = async function () {
  config.load();
  const cfg = config.get();
  log('');
  log(`${C.bold}环境自检${C.reset}`);
  log(`  Node 版本        : ${process.version}  ${Number(process.versions.node.split('.')[0]) >= 18 ? C.green + 'OK' + C.reset : C.red + '需要 >= 18' + C.reset}`);
  log(`  运行平台         : ${os.platform()} ${os.arch()}`);
  log(`  项目目录         : ${util.ROOT}`);
  log(`  数据目录         : ${config.storageDir()}  ${fs.existsSync(config.storageDir()) ? '已存在' : '尚未创建'}`);
  log(`  监听地址         : ${cfg.server.ip}:${cfg.server.port}`);
  const occupied = await new Promise((resolve) => {
    const net = require('node:net');
    const s = net.createServer();
    s.once('error', (e) => resolve(e.code === 'EADDRINUSE' ? true : 'error:' + e.code));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(cfg.server.port, cfg.server.ip === '0.0.0.0' || cfg.server.ip === '::' ? undefined : cfg.server.ip);
  });
  log(`  端口 ${String(cfg.server.port).padEnd(6)}     : ${occupied === true ? C.yellow + '已被占用（可能是镜像源已在运行）' + C.reset : occupied ? C.red + String(occupied) + C.reset : C.green + '空闲' + C.reset}`);
  const d = npmcache.defaultCacheDir();
  let cacheText = '未找到';
  try {
    if (fs.existsSync(d)) {
      const st = require('./src/npmcache').lastScan();
      cacheText = `${d}（${st && st.total ? `上次扫描到 ${st.total} 个包 / ${st.withTarball} 个含 tarball` : '尚未扫描'}）`;
    }
  } catch { /* 忽略 */ }
  log(`  npm 缓存目录     : ${cacheText}`);
  log(`  当前 npm 源      : ${JSON.stringify(cfg.upstream.registry)}`);
  log(`  离线模式         : ${cfg.mode === 'offline' ? '已开启（不会访问外网）' : '未开启（缺少的包会尝试回源下载）'}`);
  const pkgCount = fs.existsSync(config.storageDir()) ? (() => { try { return fs.readdirSync(config.storageDir()).length; } catch { return 0; } })() : 0;
  log(`  已缓存包目录数   : ${pkgCount}`);
  log('');
  log(`${C.dim}提示：迁移到无网络环境时，把整个「${path.basename(util.ROOT)}」文件夹拷贝过去，运行「启动镜像源.cmd」即可。${C.reset}`);
  log('');
};

commands.start = async function () {
  const cliOpts = {};
  if (flags.ip) cliOpts.ip = flags.ip;
  if (flags.port) cliOpts.port = flags.port;
  if (flags.mode) cliOpts.mode = flags.mode;
  if (flags.registry) cliOpts.registry = flags.registry;
  if (flags['no-open']) cliOpts['no-open'] = true;

  const { createServer } = require('./src/server');
  const app = createServer({ cliOpts });
  try {
    await app.start();
  } catch (e) {
    process.stderr.write(`${C.red}${e.message}${C.reset}\n`);
    process.exitCode = 1;
    return;
  }
  writePid({ version: app.VERSION });
  process.on('SIGINT', () => { clearPid(); app.requestShutdown(); });
  process.on('SIGTERM', () => { clearPid(); app.requestShutdown(); });
};

commands.status = async function () {
  const pid = readPid();
  try {
    const d = await httpJson(localUrl('/__admin/api/overview'), { timeoutMs: 5000 });
    log('');
    log(`${C.green}● 运行中${C.reset}  ${d.registryUrl}  （模式：${d.mode}，PID ${d.node.pid}，已运行 ${Math.floor(d.uptimeSec / 60)} 分钟）`);
    log(`  包 ${d.stats.packages} 个 / 版本 ${d.stats.versions} 个 / tarball ${d.stats.tarballs} 个 / 占用 ${human(d.stats.storageBytes)} / 下载累计 ${d.stats.downloads}`);
    log(`  上游 ${d.upstream.registry} ${d.upstream.reachable ? C.green + '可达' + C.reset : C.yellow + '不可达' + C.reset}`);
    if (d.lanUrls && d.lanUrls.length) log(`  局域网地址：${d.lanUrls.join('  ')}`);
    log('');
    return;
  } catch (e) {
    if (pid && pidAlive(pid.pid)) {
      log(`${C.yellow}○ 进程存在但接口无响应${C.reset}（PID ${pid.pid}，${e.message}）`);
      log(`  可尝试：node cli.js stop 后再 node cli.js start`);
    } else {
      log(`${C.dim}○ 未运行${C.reset}（启动：node cli.js start）`);
    }
  }
};

commands.stop = async function () {
  const pid = readPid();
  let stopped = false;
  try {
    await httpJson(localUrl('/__admin/api/service/shutdown'), { method: 'POST', timeoutMs: 8000 });
    stopped = true;
    log(`${C.green}已发送停止指令${C.reset}，服务正在关闭…`);
  } catch (e) {
    if (pid && pidAlive(pid.pid)) {
      try {
        process.kill(pid.pid, 'SIGTERM');
        stopped = true;
        log(`${C.yellow}接口无响应，已按 PID ${pid.pid} 结束进程${C.reset}`);
      } catch (e2) {
        log(`${C.red}停止失败：${e2.message}${C.reset}`);
      }
    } else {
      log(`${C.dim}镜像源未在运行${C.reset}`);
      return;
    }
  }
  if (stopped) {
    for (let i = 0; i < 20; i++) {
      await util.sleep(300);
      if (!(pid && pidAlive(pid.pid))) break;
    }
    // 只删除「确实是自己停止的那个 pid」的 PID 文件，避免误删期间新启动实例的文件
    const cur = readPid();
    if (cur && pid && Number(cur.pid) === Number(pid.pid)) {
      try { fs.unlinkSync(PID_FILE); } catch { /* 忽略 */ }
    } else if (cur) {
      log(`${C.yellow}PID 文件已指向其它进程（PID ${cur.pid}），已保留${C.reset}`);
    }
  }
};

commands.restart = async function () {
  try {
    await httpJson(localUrl('/__admin/api/service/restart'), { method: 'POST', timeoutMs: 8000 });
    log(`${C.green}已发送重启指令${C.reset}，约 1 秒后恢复（端口不变）。`);
    return;
  } catch (e) {
    log(`${C.yellow}接口无响应（${e.message}），尝试完全重启…${C.reset}`);
  }
  await commands.stop();
  await util.sleep(600);
  await commands.start();
};

commands.open = async function () {
  const url = localUrl('/');
  log(`管理界面：${url}`);
  try {
    const { spawn } = require('node:child_process');
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) { log(`无法自动打开浏览器，请手动访问：${e.message}`); }
};

// ---- npm 源切换（直接改 .npmrc，无需调用 npm 命令）----
function npmrcPath(project) { return project ? path.join(process.cwd(), '.npmrc') : path.join(os.homedir(), '.npmrc'); }

function readNpmrc(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

/** 判断 registry 地址是否指向本镜像源（只识别本工具会写入的地址，避免误删用户其它源的配置） */
function isMirrorRegistry(value, cfg) {
  let u;
  try { u = new URL(String(value).trim()); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const port = String(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (port !== String(cfg.server.port)) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host)) return true;
  return host === String(cfg.server.ip || '').toLowerCase();
}

/** 备份 npmrc：文件名区分 global/project，并写一份 .json 记录来源与目标路径，供 unuse 精确还原 */
function backupNpmrc(file, project) {
  const text = readNpmrc(file);
  const kind = project ? 'project' : 'global';
  const base = `npmrc-backup-${kind}-${util.stamp()}`;
  const bak = util.rootPath('data', `${base}.bak`);
  const meta = util.rootPath('data', `${base}.json`);
  util.ensureDir(path.dirname(bak));
  fs.writeFileSync(bak, text, 'utf8');
  util.writeJsonAtomic(meta, { backup: path.basename(bak), kind, target: file, existed: fs.existsSync(file), createdAt: util.nowIso() });
  return { bak, meta, text, kind };
}

commands.use = function () {
  const cfg = config.get();
  const project = !!flags.project;
  const file = npmrcPath(project);
  const kindName = project ? '项目级' : '用户级';
  const ip = !cfg.server.ip || cfg.server.ip === '0.0.0.0' || cfg.server.ip === '::' ? '127.0.0.1' : cfg.server.ip;
  const host = `${ip}:${cfg.server.port}`;
  const registry = `http://${host}/`;
  const { bak } = backupNpmrc(file, project);
  const text = readNpmrc(file);
  const hadAlwaysAuth = /^\s*always-auth\s*=/mi.test(text);
  // 只删本镜像源写入的 registry / 令牌行，用户其它源（含其它私有源令牌）和 always-auth 原样保留
  const lines = text.split(/\r?\n/).filter((l) => {
    const reg = /^\s*registry\s*=\s*(.+)$/i.exec(l);
    if (reg) return !isMirrorRegistry(reg[1], cfg);
    const auth = /^\s*\/\/([^/\s]+)\/:_authToken\s*=/i.exec(l);
    if (auth) return !isMirrorRegistry(`http://${auth[1]}`, cfg);
    return true;
  });
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines.push(`registry=${registry}`, `//${host}/:_authToken=${cfg.security.token}`);
  if (!hadAlwaysAuth) lines.push('always-auth=true');
  lines.push('');
  util.ensureDir(path.dirname(file));
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  log(`${C.green}已切换 npm 源${C.reset} ${file}${C.dim}（${kindName}）${C.reset}`);
  log(`  registry = ${registry}`);
  log(`  原文件已备份到 ${bak}${C.dim}（来源：${kindName}，记录在 ${path.basename(bak).replace(/\.bak$/, '.json')}）${C.reset}`);
  log(`${C.dim}还原：node cli.js unuse${project ? ' --project' : ''}${C.reset}`);
};

commands.unuse = function () {
  config.load();
  const project = !!flags.project;
  const file = npmrcPath(project);
  const kind = project ? 'project' : 'global';
  const kindName = project ? '项目级' : '用户级';
  const dataDir = util.rootPath('data');
  const entries = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];
  const backups = entries.filter((f) => /^npmrc-backup-.+\.bak$/.test(f)).sort();
  const candidates = [];
  for (const f of entries.filter((x) => /^npmrc-backup-.+\.json$/.test(x)).sort()) {
    const meta = util.readJson(path.join(dataDir, f), null);
    if (!meta || !meta.backup || meta.kind !== kind) continue;
    if (project && String(meta.target || '').toLowerCase() !== file.toLowerCase()) continue;
    candidates.push(meta);
  }
  if (!candidates.length) {
    log(`${C.yellow}没有找到${kindName} npm 配置的备份，无法还原。${C.reset}`);
    log(`  目标文件：${file}`);
    if (backups.length) log(`  ${C.dim}data 目录现有备份：${backups.join('、')}（请确认来源后手动还原，或换用对应的 unuse 参数）${C.reset}`);
    else log(`  ${C.dim}还没有执行过 node cli.js use${project ? ' --project' : ''}。${C.reset}`);
    return;
  }
  const meta = candidates[candidates.length - 1]; // 文件名带时间戳，取最新的一份
  const bak = path.join(dataDir, meta.backup);
  if (!fs.existsSync(bak)) { log(`${C.red}备份文件已丢失：${bak}${C.reset}`); return; }
  if (meta.existed === false) { try { fs.unlinkSync(file); } catch { /* 原本就不存在 */ } }
  else fs.writeFileSync(file, fs.readFileSync(bak, 'utf8'), 'utf8');
  fs.rmSync(bak, { force: true });
  fs.rmSync(path.join(dataDir, meta.backup.replace(/\.bak$/, '.json')), { force: true });
  log(`${C.green}已还原${C.reset} ${file}  ${C.dim}（${kindName}备份：${meta.backup}）${C.reset}`);
};

commands.list = function () {
  const { store } = makeStore(true);
  const r = store.list({ q: flags.q || '', source: flags.source || 'all', sort: flags.sort || 'name', page: 1, size: Number(flags.size || 50) });
  log(`共 ${r.total} 个包（显示 ${r.items.length} 个）：`);
  log(`  ${'包名'.padEnd(38)} ${'最新版本'.padEnd(12)} ${'版本数'.padEnd(6)} ${'来源'.padEnd(9)} 大小`);
  for (const it of r.items) {
    log(`  ${String(it.name).slice(0, 37).padEnd(38)} ${String(it.latest || '-').padEnd(12)} ${String(it.versionCount).padEnd(6)} ${String(it.source).padEnd(9)} ${human(it.sizeBytes)}${it.missingVersions ? `  ${C.yellow}(缺 ${it.missingVersions} 个 tarball)${C.reset}` : ''}`);
  }
  store.close();
};

commands.stats = function () {
  const { store } = makeStore(true);
  const s = store.stats();
  log('');
  log(`  包          : ${s.packages}`);
  log(`  版本        : ${s.versions}`);
  log(`  tarball     : ${s.tarballs}`);
  log(`  占用空间    : ${human(s.storageBytes)}`);
  log(`  累计下载    : ${s.downloads}`);
  log(`  来源分布    : ${JSON.stringify(s.bySource)}`);
  log('');
  store.close();
};

commands.export = async function () {
  const { store, lg } = makeStore(false);
  const scope = flags.scope || (positional.length ? 'selected' : 'all');
  const t0 = Date.now();
  try {
    const r = await bundle.exportBundle({
      store,
      scope,
      names: positional,
      fileName: flags.out,
      logger: lg,
      concurrency: Math.max(1, Number(config.get().storage.bundleExportConcurrency) || 4),
      onProgress: (p) => {
        if (!flags.verbose) return;
        if (p.phase === 'collect') log(`  …已统计 ${p.packages}/${p.total} 个包`);
        else if (p.phase === 'pack') log(`  …已打包 ${p.entriesDone}/${p.entriesTotal} 个文件（${human(p.bytes)} / ${human(p.totalBytes)}）`);
      },
    });
    log(`${C.green}导出完成${C.reset} ${r.path}`);
    log(`  包含 ${r.packages} 个包 / ${r.versions} 个版本 / ${r.tarballs} 个 tarball，共 ${human(r.sizeBytes)}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    log(`${C.dim}把这个 .tgz 拷到离线机器，用「node cli.js import <文件>」或管理界面「迁移备份」页导入。${C.reset}`);
  } catch (e) {
    log(`${C.red}导出失败：${e.message}${C.reset}`);
    process.exitCode = 1;
  }
  store.close();
};

commands.import = async function () {
  const file = positional[0];
  if (!file) { log(`${C.red}用法：node cli.js import <文件.tgz|文件.json> [--overwrite]${C.reset}`); process.exitCode = 1; return; }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) { log(`${C.red}文件不存在：${abs}${C.reset}`); process.exitCode = 1; return; }
  const { store, lg } = makeStore(false);
  const overwrite = !!flags.overwrite;
  let lastPct = -1;
  try {
    if (/\.json$/i.test(abs)) {
      const json = util.readJson(abs, null);
      const r = await bundle.importPackumentJson({ store, json, overwrite, source: 'upload', logger: lg });
      log(`${C.green}导入完成${C.reset} 包 ${r.name}，版本 ${r.versions} 个`);
    } else if (/\.tgz$/i.test(abs)) {
      let isBundle = false;
      try { isBundle = !!(await bundle.readBundleManifest(abs)); } catch { isBundle = false; }
      if (isBundle) {
        let totalPkgs = 0;
        let donePkgs = 0;
        const r = await bundle.importBundle({
          store, file: abs, overwrite, logger: lg,
          concurrency: Math.max(1, Number(config.get().storage.bundleImportConcurrency) || 4),
          onProgress: (p) => {
            let pct = -1;
            if (p.phase === 'extract' && p.totalBytes > 0) pct = Math.floor((p.bytes / p.totalBytes) * 100);
            else if (p.phase === 'extract-done') { totalPkgs = Number(p.packages) || 0; pct = 0; }
            else if (p.phase === 'package' && totalPkgs > 0) { donePkgs++; pct = Math.floor((donePkgs / totalPkgs) * 100); }
            if (pct >= 0 && pct !== lastPct) { lastPct = pct; process.stdout.write(`\r  导入进度 ${pct}%  ${p.name || ''}`.padEnd(60)); }
          },
        });
        process.stdout.write('\r' + ' '.repeat(60) + '\r');
        log(`${C.green}导入完成${C.reset} 包 ${r.packages} 个 / 版本 ${r.versions} 个 / tarball ${r.tarballs} 个${r.overwritten ? `，覆盖 ${r.overwritten}` : ''}${r.skipped ? `，跳过已存在 ${r.skipped}` : ''}${r.failed && r.failed.length ? `，失败 ${r.failed.length}` : ''}`);
        for (const f of (r.failed || []).slice(0, 5)) log(`  ${C.red}✗ ${f.name}：${f.error}${C.reset}`);
      } else {
        const r = await bundle.importTarballFile({ store, file: abs, overwrite, source: 'upload' });
        log(`${C.green}导入完成${C.reset} ${r.name}@${r.version}（${human(r.sizeBytes)}）`);
      }
    } else {
      log(`${C.red}只支持 .tgz 或 .json 文件${C.reset}`); process.exitCode = 1;
    }
  } catch (e) {
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
    log(`${C.red}导入失败：${e.message}${C.reset}`);
    process.exitCode = 1;
  }
  store.close();
};

commands['scan-cache'] = async function () {
  const { lg } = makeStore(true);
  const cfg = config.get();
  const dir = flags.cache ? path.resolve(flags.cache) : npmcache.resolveCacheDir();
  if (!dir) { log(`${C.red}未找到 npm 缓存目录，可用 --cache <目录> 指定${C.reset}`); process.exitCode = 1; return; }
  const anyRegistry = !!flags['any-registry'];
  // 默认只扫当前上游源；--any-registry 扫描缓存里所有 registry 的条目
  const registry = anyRegistry ? '' : cfg.upstream.registry;
  if (flags.refresh) {
    // 先清空上次扫描结果再全量重扫，避免扫描失败时旧结果残留
    try { fs.unlinkSync(npmcache.stateFile()); } catch { /* 本来就没有 */ }
  }
  log(`正在扫描本机 npm 缓存：${dir}${anyRegistry ? '（所有源）' : `（仅 ${cfg.upstream.registry}）`} …`);
  const t0 = Date.now();
  const r = await npmcache.scanCache({
    cacheDir: dir,
    registry,
    anyRegistry,
    logger: lg,
    onProgress: (p) => {
      process.stdout.write(`\r  已扫描 ${p.scanned}/${p.total} 个索引文件，命中 ${p.found} 个包…`.padEnd(50));
    },
  });
  process.stdout.write('\r' + ' '.repeat(50) + '\r');
  log(`${C.green}扫描完成${C.reset} 命中 ${r.total} 个包，其中 ${r.withTarball} 个含 tarball，共 ${human(r.bytes)}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(`${C.dim}导入全部：node cli.js import-cache --all${C.reset}`);
  log(`${C.dim}导入部分：node cli.js import-cache <包名...>${C.reset}`);
};

commands['import-cache'] = async function () {
  const { store, lg } = makeStore(false);
  const dir = flags.cache ? path.resolve(flags.cache) : npmcache.resolveCacheDir();
  const names = positional.slice();
  const all = !!flags.all;
  if (!all && !names.length) { log(`${C.red}请指定包名，或加 --all 导入全部${C.reset}`); store.close(); process.exitCode = 1; return; }
  if (all && names.length) log(`${C.dim}已指定 --all，忽略包名参数。${C.reset}`);
  try {
    const r = await npmcache.importFromCache({
      store, cacheDir: dir, names, all,
      overwrite: !!flags.overwrite,
      onlyWithTarball: !flags['include-empty'],
      logger: lg,
      onProgress: (p) => {
        // npmcache 的事件：导入阶段是 {phase:'start'|'version'|'done', done,total,...}，没有 p.phase 的旧进度字段
        let text = null;
        if (p.phase === 'version') text = `  ${p.name} 版本 ${p.versionDone}/${p.versionTotal}…`;
        else if (p.phase && p.total) text = `  导入进度 ${Math.min(p.done, p.total)}/${p.total}  ${p.name || ''}`;
        if (text) process.stdout.write(`\r${text}`.padEnd(60));
      },
    });
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
    log(`${C.green}从 npm 缓存导入完成${C.reset} 成功 ${r.imported.length} 个包${r.tarballs ? `，tarball ${r.tarballs} 个` : ''}${r.skipped.length ? `，跳过 ${r.skipped.length}` : ''}${r.failed.length ? `，失败 ${r.failed.length}` : ''}`);
    for (const f of r.failed.slice(0, 5)) log(`  ${C.red}✗ ${f.name}：${f.error}${C.reset}`);
  } catch (e) {
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
    log(`${C.red}导入失败：${e.message}${C.reset}`);
    process.exitCode = 1;
  }
  store.close();
};

/** 添加公共包：从上游公共源拉取元数据并把 tarball 缓存到本地（无需启动服务） */
commands.add = async function () {
  const specs = positional.slice();
  if (!specs.length) {
    log(`${C.red}用法：node cli.js add <包名[@版本|@范围]> [--no-prefetch]${C.reset}`);
    log(`${C.red}      node cli.js add <包名> --with-deps [--depth 8] [--limit 300] [--optional] [--peer]${C.reset}`);
    log(`${C.dim}例如：node cli.js add lodash axios@1.6.0 "react@^18"${C.reset}`);
    log(`${C.dim}      node cli.js add chalk@4.1.2 --with-deps    （连 chalk 的依赖一起加）${C.reset}`);
    log(`${C.dim}      node cli.js add "@popperjs/core@npm:@sxzz/popperjs-es@^2.11.8" --with-deps    （npm: 别名也会一起解析下载）${C.reset}`);
    process.exitCode = 1;
    return;
  }
  const cfg = config.get();
  if ((cfg.mode || 'cache') === 'offline') {
    log(`${C.red}当前是纯离线模式（mode=offline），无法从公共源添加包。${C.reset}`);
    log(`${C.dim}可改用：node cli.js import <离线包.tgz>，或 node cli.js import-cache --all${C.reset}`);
    process.exitCode = 1;
    return;
  }
  const { store, lg } = makeStore(false);
  const { Upstream } = require('./src/upstream');
  const registry = require('./src/registry');
  const deps = require('./src/deps');
  const upstream = new Upstream(() => config.get(), lg);
  const ctx = { store, upstream, log: lg, cfg: () => config.get(), registry };
  try {
    const ping = await upstream.ping();
    if (!ping.reachable) log(`${C.yellow}提示：上游 ${cfg.upstream.registry} 当前不可达（${ping.reason || '未知原因'}），只能使用本地已有的包。${C.reset}`);
  } catch { /* 忽略探活失败 */ }

  // 递归添加：把根包的依赖、依赖的依赖一起解析出来并缓存
  if (flags['with-deps']) {
    const depth = Math.max(0, Math.min(50, Math.round(Number(flags.depth) || 8)));
    const limit = Math.max(1, Math.min(5000, Math.round(Number(flags.limit) || 300)));
    let lastN = -1;
    const r = await deps.resolveClosure(ctx, specs, {
      depth, limit, persist: true,
      optional: !!flags.optional, peer: !!flags.peer,
      onProgress: (info) => {
        const n = info.picks.length;
        if (n === lastN) return;
        lastN = n;
        process.stdout.write(`\r  正在解析依赖…已找到 ${n} 个版本`.padEnd(56));
      },
    });
    process.stdout.write('\r' + ' '.repeat(56) + '\r');
    log(`解析完成：${r.stats.packages} 个包 / ${r.stats.versions} 个版本（其中新增 ${r.stats.newPackages} 个包`
      + (r.stats.aliases ? `，含 ${r.stats.aliases} 个 npm: 别名` : '')
      + `，耗时 ${(r.stats.ms / 1000).toFixed(1)}s）`);
    for (const p of r.picks) {
      const tag = p.newPackage ? `${C.green}新增${C.reset}` : (p.newVersion ? `${C.yellow}补版本${C.reset}` : `${C.dim}已存在${C.reset}`);
      const alias = p.alias ? `${C.dim}（别名 ${p.alias.name} → ${p.alias.spec}）${C.reset}` : '';
      log(`  ${tag} ${p.name}@${p.version}${alias}${p.depth ? `   （第 ${p.depth} 层，被 ${p.parents.join('、')} 依赖）` : '   （根包）'}`);
    }
    for (const u of r.unresolved) {
      log(`  ${C.yellow}! ${u.name}@${u.range || ''} 没能自动添加：${u.error}${u.parent ? `（被 ${u.parent} 依赖）` : ''}${C.reset}`);
    }
    for (const e of r.errors) log(`  ${C.red}✗ ${e.name}：${e.error}${C.reset}`);
    if (r.bad.length) for (const b of r.bad) log(`  ${C.red}✗ ${b.name}：${b.error}${C.reset}`);
    let okN = 0, failN = 0;
    if (!flags['no-prefetch']) {
      for (const p of r.picks) {
        process.stdout.write(`\r  正在下载 ${p.name}@${p.version}`.padEnd(56));
        try { const f = await registry.ensureTarball(ctx, p.name, p.version); if (f) okN++; else failN++; }
        catch (e) { failN++; log(`\n  ${C.yellow}! ${p.name}@${p.version} 的 tarball 下载失败：${e.message}${C.reset}`); }
      }
      process.stdout.write('\r' + ' '.repeat(56) + '\r');
    }
    log(`${C.green}递归添加完成${C.reset} 包 ${r.stats.packages} 个 / 版本 ${r.stats.versions} 个`
      + (okN || failN ? `，tarball 成功 ${okN} 个${failN ? `、失败 ${failN} 个` : ''}` : ''));
    if (r.errors.length || r.bad.length) process.exitCode = 1;
    store.close();
    return;
  }

  let okCount = 0; let failCount = 0; let tbCount = 0;
  for (const spec of specs) {
    const parsed = util.parsePkgSpec(spec);
    if (!parsed || !parsed.name) { log(`  ${C.red}✗ ${spec}：包名格式不正确${C.reset}`); failCount++; continue; }
    let { name, version } = parsed;
    // `别名@npm:真实包名@范围`：别名只是装到本地时的名字，镜像里要缓存的是真实包
    if (/npm:/i.test(name) || /^npm:/i.test(version || '')) {
      const root = deps.splitRootSpec(spec);
      const alias = root && /^npm:/i.test(root.range) ? deps.parseNpmAlias(root.range) : null;
      if (!alias) { log(`  ${C.red}✗ ${spec}：npm: 别名写法不正确${C.reset}`); failCount++; continue; }
      log(`  ${C.dim}识别到 npm: 别名 ${spec} → ${alias.name}${alias.range ? '@' + alias.range : ''}${C.reset}`);
      name = alias.name;
      version = alias.range || null;
    }
    process.stdout.write(`  正在获取 ${spec} …`.padEnd(52));
    try {
      const rec = await registry.ensurePackument(ctx, name, { force: true, full: true });
      if (!rec) { throw new Error('上游没有找到该包（或网络不可用）'); }
      const all = Object.keys(rec.packument.versions);
      let targets;
      if (!version) {
        const latest = rec.packument['dist-tags'] && rec.packument['dist-tags'].latest;
        const highest = all.slice().sort(util.compareVersions).pop(); // 没有 latest 时用最高 semver，而不是对象键的最后一个
        targets = latest ? [latest] : (highest ? [highest] : []);
      } else if (rec.packument.versions[version]) {
        targets = [version];
      } else {
        const best = util.maxSatisfying(all, version);
        targets = best ? [best] : [];
      }
      if (!targets.length) throw new Error(`找不到匹配 ${version} 的版本`);
      let got = 0;
      if (!flags['no-prefetch']) {
        for (const v of targets) {
          try { const p = await registry.ensureTarball(ctx, name, v); if (p) got++; }
          catch (e) { log(`\n  ${C.yellow}! ${name}@${v} 的 tarball 下载失败：${e.message}${C.reset}`); }
        }
      }
      tbCount += got;
      process.stdout.write('\r' + ' '.repeat(52) + '\r');
      const after = store.get(name);
      const vCount = after ? Object.keys(after.packument.versions).length : 0;
      log(`  ${C.green}✓ ${name}${version ? '@' + version : ''}${C.reset}  版本共 ${vCount} 个${got ? `，缓存 tarball ${got} 个（已可离线安装）` : ''}`);
      okCount++;
    } catch (e) {
      process.stdout.write('\r' + ' '.repeat(52) + '\r');
      log(`  ${C.red}✗ ${spec}：${e.message}${C.reset}`);
      failCount++;
    }
  }
  log(`添加完成：成功 ${okCount} 个，失败 ${failCount} 个${tbCount ? `，共缓存 tarball ${tbCount} 个` : ''}`);
  if (failCount) process.exitCode = 1;
  store.close();
};

/** 删除包或单个版本（无需启动服务；整包删除需要 --yes 确认） */
commands.remove = async function () {
  const name = positional[0];
  if (!name) {
    log(`${C.red}用法：node cli.js remove <包名> [--version 1.2.3] [--yes]${C.reset}`);
    log(`${C.dim}删除单个版本：node cli.js remove lodash --version 4.17.21${C.reset}`);
    process.exitCode = 1;
    return;
  }
  const { store, lg } = makeStore(false);
  if (!store.has(name)) {
    log(`${C.red}本地没有包 ${name}${C.reset}`);
    process.exitCode = 1;
    store.close();
    return;
  }
  if (flags.version) {
    const v = String(flags.version);
    const rec = store.get(name);
    if (!rec.packument.versions[v]) {
      log(`${C.red}版本 ${name}@${v} 不存在${C.reset}`);
      process.exitCode = 1;
    } else {
      store.deleteVersion(name, v);
      lg.warn(`[CLI] 删除版本 ${name}@${v}`);
      const rest = Object.keys((store.get(name) || { packument: { versions: {} } }).packument.versions).length;
      log(`${C.green}已删除 ${name}@${v}${C.reset}，该包剩余 ${rest} 个版本`);
      if (rest === 0) log(`${C.dim}该包已没有版本；如需彻底删除，执行：node cli.js remove ${name} --yes${C.reset}`);
    }
  } else if (flags.yes || flags.force) {
    store.deletePackage(name);
    lg.warn(`[CLI] 删除包 ${name}`);
    log(`${C.green}已删除包 ${name}${C.reset}（含全部版本与 tarball）`);
  } else {
    const rec = store.get(name);
    const vCount = Object.keys(rec.packument.versions).length;
    log(`${C.yellow}即将删除整个包 ${name}（${vCount} 个版本，含 tarball），此操作不可撤销。${C.reset}`);
    log(`确认请执行：node cli.js remove ${name} --yes`);
    process.exitCode = 1;
  }
  store.close();
};

commands.logs = function () {
  const lg = loggerMod.init({ dir: config.logsDir(), level: 'debug', maxDays: config.get().log.maxDays, console: false });
  const r = lg.tail(Number(flags.lines || 100), flags.level || 'debug');
  log(`${C.dim}日志文件：${r.file}（${human(r.sizeBytes)}）${C.reset}`);
  log(r.lines.join('\n'));
};

// ---------------------------------------------------------------- 分发
(async () => {
  const fn = commands[command];
  if (!fn) {
    log(`${C.red}未知命令：${command}${C.reset}`);
    commands.help();
    process.exitCode = 1;
    return;
  }
  if (command !== 'help' && !['start'].includes(command)) config.load();
  try {
    await fn();
  } catch (e) {
    if (e && e.code === 'ECONNREFUSED') log(`${C.red}无法连接镜像源，请先启动：node cli.js start${C.reset}`);
    else log(`${C.red}执行失败：${e && (e.stack || e.message)}${C.reset}`);
    process.exitCode = 1;
  }
})();
