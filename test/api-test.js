#!/usr/bin/env node
'use strict';
/*
 * 端到端自检：注册表协议 + 可视化管理 API + 私有包发布/删除 + 离线包导出导入
 * 用法：先启动镜像源，再执行  node test/api-test.js [--base 管理界面地址] [--registry-base 镜像源地址]
 * 测试范围不含会大量导包 / 全部包补 tarball / 本机 npm 缓存导入真实扫描等耗时用例（正常网络下约半分钟）；
 * 破坏性用例（重启镜像源服务 / 重启管理界面 / 清空日志）需显式加 --destructive。
 * 仅使用 fetch，不依赖任何第三方库；测试数据写入镜像源自身的存储，可重复执行。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const util = require('../src/util');
const config = require('../src/config');
const tar = require('../src/tar');

config.load();
const cfg = config.get();
const TOKEN = cfg.security.token;
// 管理界面监听地址：管理 API 与网页都只在这个地址上（默认 config.admin.ip:admin.port）。
// 镜像源监听是另一个端口（registry 协议），见下面的 REG_BASE。
const BASE = (() => {
  const i = process.argv.indexOf('--base');
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1].replace(/\/+$/, '');
  const admin = cfg.admin || {};
  return `http://127.0.0.1:${admin.port || cfg.server.port}`;
})();
// 镜像源监听地址：npm 客户端用的 registry 协议（/-/ping、包下载、发布等）走这里。
// 两个监听端口必须不同（后端有校验），测试分别用 --base 与 --registry-base 指定。
const REG_BASE = (() => {
  const i = process.argv.indexOf('--registry-base');
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1].replace(/\/+$/, '');
  return `http://127.0.0.1:${cfg.server.port}`;
})();
const BASE_URL = new URL(BASE);
const BASE_HOST = BASE_URL.hostname.replace(/^\[|\]$/g, ''); // http.request 的 host 不能带 IPv6 方括号
const BASE_PORT = Number(BASE_URL.port || 80);
const REG_URL = new URL(REG_BASE);
const REG_HOST = REG_URL.hostname.replace(/^\[|\]$/g, '');
const REG_PORT = Number(REG_URL.port || 80);

// 破坏性用例（重启服务、清空日志）默认不跑：自检不应替用户重启服务或删掉日志。
// 需要时显式加 --destructive。
const DESTRUCTIVE = process.argv.includes('--destructive');


const results = [];
let failures = 0;
let skips = 0;

function check(name, cond, detail) {
  const okFlag = !!cond;
  if (!okFlag) failures++;
  results.push({ name, ok: okFlag, detail: detail === undefined ? '' : String(detail).slice(0, 160) });
  const mark = okFlag ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  process.stdout.write(`  ${mark} ${name}${okFlag || !detail ? '' : `  → ${String(detail).slice(0, 160)}`}\n`);
  return okFlag;
}

/** 显式跳过（环境不满足，例如本机 npm 缓存为空）：计入结果但不计为失败，汇总里单列跳过数。 */
function skip(name, reason) {
  skips++;
  results.push({ name, ok: true, skipped: true, detail: reason === undefined ? '' : String(reason).slice(0, 160) });
  const why = reason === undefined ? '' : String(reason).slice(0, 160);
  process.stdout.write(`  \x1b[33m⊘\x1b[0m ${name}（跳过：${why}）\n`);
  return true;
}
let SEC0 = Date.now();
function section(t) {
  const dt = ((Date.now() - SEC0) / 1000).toFixed(1);
  SEC0 = Date.now();
  process.stdout.write(`\n\x1b[1m${t}\x1b[0m \x1b[2m(+${dt}s)\x1b[0m\n`);
}

async function api(pathname, { method = 'GET', body, raw, headers = {}, auth = true, timeoutMs = 60000, base = BASE } = {}) {
  const h = { ...headers };
  if (auth) h['X-Mirror-Token'] = TOKEN;
  let payload;
  if (raw) payload = raw;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + pathname, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

/** 造一个合法的 npm tarball（含 package/package.json） */
async function makeTarball(dir, pkg) {
  const tmp = path.join(dir, `pkg-${pkg.name}-${pkg.version}`);
  util.ensureDir(path.join(tmp, 'package'));
  fs.writeFileSync(path.join(tmp, 'package', 'package.json'), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(tmp, 'package', 'index.js'), `module.exports = ${JSON.stringify(pkg.name)};\n`);
  fs.writeFileSync(path.join(tmp, 'package', 'README.md'), `# ${pkg.name}\n\n私有包，用于镜像源自检。\n`);
  const out = path.join(dir, `${pkg.name}-${pkg.version}.tgz`);
  await tar.packTarGz(out, [
    { name: 'package/package.json', source: path.join(tmp, 'package', 'package.json') },
    { name: 'package/index.js', source: path.join(tmp, 'package', 'index.js') },
    { name: 'package/README.md', source: path.join(tmp, 'package', 'README.md') },
  ], { gzip: true });
  return { file: out, buffer: fs.readFileSync(out) };
}

/**
 * 裸 http 请求：用于需要伪造 Host/Origin 头、或故意保留 URL 里 %5C/%2F 编码的用例。
 * （Node 的 fetch 不允许改 Host、会规范化 URL，测不了这些边界。）
 */
function rawReq(pathname, { method = 'GET', headers = {}, body, timeoutMs = 15000, base } = {}) {
  const httpMod = require('node:http');
  // 默认打管理界面；传 base: REG_BASE 表示打镜像源监听（registry 协议用例）
  const target = base ? new URL(base) : BASE_URL;
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const port = Number(target.port || 80);
  return new Promise((resolve) => {
    // agent: false = 每次开新连接。node:http 的全局 agent 默认 keep-alive，
    // 而本文件有用例故意「声明了很大的 Content-Length 却不发完」（验证服务端提前 413 并断连），
    // 那条连接会被服务端 close，若下一个请求恰好复用到它就会一直等不到响应（假超时）。
    const req = httpMod.request({ host, port, path: pathname, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', (e) => resolve({ status: -1, text: String((e && e.message) || e), headers: {} }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: -2, text: 'timeout', headers: {} }); });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

(async () => {
  const t0 = Date.now();
  const tmpDir = path.join(os.tmpdir(), `mirror-selftest-${util.stamp()}`);
  util.ensureDir(tmpDir);
  const PRIVATE = 'mirror-selftest-private';
  const PRIVATE2 = '@mirror-selftest/scoped-pkg';

  process.stdout.write(`\x1b[1m私人 npm 镜像源自检\x1b[0m  管理界面：${BASE}  镜像源：${REG_BASE}\n`);

  // 清理上一轮遗留的「自检专用」数据（mirror-selftest-* 只可能由本脚本创建，删掉是安全的）。
  // 注意：不在开头删 ms / lodash 等真实公共包——它们是用户镜像里的真实数据，
  // 旧版本这里会误删用户缓存的 tarball。需要临时造前置条件的用例改为「先快照、收尾恢复」。
  for (const n of [PRIVATE, PRIVATE2, 'mirror-selftest-upload', 'mirror-selftest-json', 'mirror-selftest-autodeps-fail', 'mirror-selftest-autodeps-ok', 'mirror-selftest-chunkpkg-a', 'mirror-selftest-chunkpkg-b']) {
    try { await api(`/__admin/api/packages/${encodeURIComponent(n)}`, { method: 'DELETE' }); } catch { /* 忽略 */ }
  }
  // ms 是本脚本要用到的真实公共包：记录测试前是否已存在，收尾时只在「原本不存在」时才删掉自己加的。
  const msExistedBefore = (await api('/__admin/api/packages/ms')).status === 200;

  // ---------------------------------------------------------------- 基础协议
  section('一、基础协议');
  {
    const r = await api('/-/ping', { base: REG_BASE });
    check('GET /-/ping 返回 {}', r.status === 200 && r.json && Object.keys(r.json).length === 0, `status=${r.status}`);
  }
  {
    const r = await api('/-/whoami', { base: REG_BASE });
    // 期望用户名以「服务端当前配置」为准：直接改磁盘 config.json 时服务内存里仍是旧值，
    // 不能拿本地文件里的值来断言，否则测试会假失败。
    let serverUser = cfg.security.username || 'admin';
    try {
      const c = await api('/__admin/api/config?reveal=1');
      if (c.status === 200 && c.json && c.json.config && c.json.config.security) serverUser = c.json.config.security.username;
    } catch { /* 读不到就退回本地配置 */ }
    check('GET /-/whoami 返回用户名', r.status === 200 && r.json && r.json.username === serverUser,
      `${JSON.stringify(r.json)} 期望=${serverUser}`);
  }
  {
    const r = await api('/-/user/org.couchdb.user:admin', { method: 'PUT', body: { name: 'admin', password: 'x' } , base: REG_BASE });
    check('PUT /-/user/... 登录返回令牌', r.status === 201 && r.json && r.json.token === TOKEN, `status=${r.status}`);
  }
  {
    const r = await api('/-/v1/login', { base: REG_BASE });
    check('GET /-/v1/login 明确不支持网页登录', r.status === 404 && r.json && r.json.code === 'ENOWEBLOGIN', `status=${r.status}`);
  }
  {
    const r = await api('/-/npm/v1/security/audits/quick', { method: 'POST', body: {}, base: REG_BASE });
    check('POST audits/quick 返回空报告', r.status === 200, `status=${r.status}`);
  }
  {
    const r = await api('/-/npm/v1/security/advisories/bulk', { method: 'POST', body: {}, base: REG_BASE });
    check('POST advisories/bulk 返回 200', r.status === 200, `status=${r.status}`);
  }
  {
    const r = await api('/mirror-selftest-nonexistent-zzz', { base: REG_BASE });
    check('GET 不存在的包返回 404', r.status === 404, `status=${r.status}`);
  }
  {
    const r = await api('/%E4%B8%8D%E5%90%88%E6%B3%95%E7%9A%84%E5%8C%85%E5%90%8D', { base: REG_BASE });
    check('GET 非法包名返回 400', r.status === 400, `status=${r.status}`);
  }

  // ---------------------------------------------------------------- 管理 API
  section('二、可视化管理 API');
  {
    const r = await api('/__admin/api/session', { auth: false });
    check('GET /session 免鉴权且返回监听信息', r.status === 200 && r.json && r.json.data && !!r.json.data.registryUrl, `status=${r.status}`);
  }
  {
    // 双监听：管理界面（admin）与镜像源（registry）是两个独立端口，管理 API 只在管理界面监听上可用
    const s = await api('/__admin/api/session');
    const d = (s.json || {}).data || {};
    check('GET /session 区分两组监听（listen=镜像源端口，admin=管理界面端口）',
      s.status === 200 && !!d.listen && !!d.admin &&
      Number(d.listen.port) === REG_PORT && Number(d.admin.port) === BASE_PORT,
      `listen=${JSON.stringify(d.listen)} admin=${JSON.stringify(d.admin)}`);
    check('GET /session 同时对管理界面与镜像源服务做探测（admin 实例信息 + registry.reachable/latencyMs）',
      !!d.admin && typeof d.admin.listenError === 'string' && !!d.registry &&
      d.registry.reachable === true && Number.isFinite(Number(d.registry.latencyMs)),
      `admin=${JSON.stringify(d.admin)} registry=${JSON.stringify(d.registry)}`);
    const onRegistry = await fetch(REG_BASE + '/__admin/api/session', { signal: AbortSignal.timeout(5000) });
    check('镜像源监听不提供管理 API（/__admin/api/* 返回 403 EADMINONLY）',
      onRegistry.status === 403, `status=${onRegistry.status}`);
    const home = await fetch(REG_BASE + '/', { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const homeLoc = String(home.headers.get('location') || '');
    check('本机访问镜像源首页 302 跳转到管理界面监听（管理页面不挂在镜像源端口上）',
      home.status === 302 && homeLoc.startsWith(BASE), `status=${home.status} location=${homeLoc}`);
    const adminHome = await fetch(BASE + '/', { signal: AbortSignal.timeout(5000) });
    const adminHomeText = await adminHome.text();
    check('管理界面监听直接提供管理页面（首页 200 且是 HTML）',
      adminHome.status === 200 && /<html/i.test(adminHomeText), `status=${adminHome.status}`);
  }
  {
    // 前端要靠这两个上限做体积预检：超限直接提示「放进 data\bundles 再导入」，而不是让浏览器干等后报网络错误
    const s = await api('/__admin/api/session');
    const sl = ((s.json || {}).data || {}).limits;
    const c = await api('/__admin/api/config');
    const st = ((((c.json || {}).data || {}).config) || {}).storage || {};
    check('GET /session 返回上传上限（uploadMB / bundleUploadMB）',
      s.status === 200 && sl && Number(sl.uploadMB) === Number(st.maxUploadMB) && Number(sl.bundleUploadMB) === Number(st.maxBundleUploadMB),
      `limits=${JSON.stringify(sl)} config=${JSON.stringify(st)}`);
  }
  {
    const r = await api('/__admin/api/overview');
    const d = r.json && r.json.data;
    check('GET /overview 返回统计信息', r.status === 200 && d && d.stats && typeof d.stats.packages === 'number' && !!d.listen, `status=${r.status}`);
  }
  {
    const r = await api('/__admin/api/config?reveal=1');
    const c = r.json && r.json.data && r.json.data.config;
    check('GET /config?reveal=1 返回完整配置（含令牌）', r.status === 200 && c && c.security && c.security.token === TOKEN, `status=${r.status}`);
  }
  {
    const r = await api('/__admin/api/config');
    const c = r.json && r.json.data && r.json.data.config;
    check('GET /config 默认打码令牌', r.status === 200 && c && c.security.token !== TOKEN, c && c.security && c.security.token);
  }
  {
    const r = await api('/__admin/api/npmrc', { method: 'POST', body: { ip: REG_HOST, port: REG_PORT, token: true } });
    const d = r.json && r.json.data;
    check('POST /npmrc 生成 .npmrc（token:true 用服务端令牌）', r.status === 200 && d && d.npmrc.includes(`_authToken=${TOKEN}`) && d.npmrc.includes(`registry=http://${REG_HOST}:${REG_PORT}/`) && !d.npmrc.includes('_authToken=true'), d && d.registry);
  }
  {
    const r = await api('/__admin/api/logs?lines=10');
    check('GET /logs 返回日志', r.status === 200 && r.json && Array.isArray(r.json.data.lines), `status=${r.status}`);
  }
  {
    // 日志行首时间戳必须是「电脑本机时区」并带偏移（历史 bug：用 UTC 的 Z，日期/时间比本机差 8 小时）。
    // 只校验最新一行：日志文件里可能还留着旧版本写下的 UTC 格式历史行（不回改历史日志）。
    const r = await api('/__admin/api/logs?lines=20');
    const lines = (r.json && r.json.data && r.json.data.lines) || [];
    const off = -new Date().getTimezoneOffset();
    const expectOff = (off >= 0 ? '+' : '-') + util.pad2(Math.floor(Math.abs(off) / 60)) + ':' + util.pad2(Math.abs(off) % 60);
    const re = /^\[(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})([+-]\d{2}:\d{2})\] \[(DEBUG|INFO|WARN|ERROR)\] /;
    const last = lines.length ? lines[lines.length - 1] : '';
    const m = re.exec(last);
    const ok = !!m && m[6] === expectOff && m[1] === util.dateOnly();
    check('最新日志行的时间戳使用本机时区（带偏移，日期也是本机日期）', ok,
      `期望偏移=${expectOff}，最新行=${last.slice(0, 70)}`);
  }
  {
    const r = await api('/__admin/api/search?text=ms');
    check('GET /search 返回结果数组', r.status === 200 && r.json && Array.isArray(r.json.data.items), `status=${r.status}`);
  }
  {
    // 自定义 Host 头应被拒绝（防 DNS 重绑定）；Node 的 fetch 不允许改 Host，这里用裸 http 请求
    const status = await new Promise((resolve) => {
      const httpMod = require('node:http');
      const req = httpMod.request({ host: BASE_HOST, port: BASE_PORT, path: '/__admin/api/overview', method: 'GET', headers: { Host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve(-1));
      req.setTimeout(5000, () => { req.destroy(); resolve(-2); });
      req.end();
    });
    check('伪造 Host 头被拒绝（EHOST 403）', status === 403, `status=${status}`);
  }

  // ---------------------------------------------------------------- 公共包（回源缓存）
  section('三、添加公共包（回源并缓存）');
  {
    const r = await api('/__admin/api/packages', { method: 'POST', body: { names: ['ms@2.1.3'] } });
    const d = r.json && r.json.data;
    check('POST /packages 添加公共包 ms@2.1.3', r.status === 200 && d && ((Array.isArray(d.added) && d.added.length >= 1) || (Array.isArray(d.skipped) && d.skipped.length >= 1)), JSON.stringify(d).slice(0, 200));
  }
  {
    const r = await api('/ms', { headers: { Accept: 'application/vnd.npm.install-v1+json' }, base: REG_BASE });
    const d = r.json;
    check('GET /ms 返回 packument（含 2.1.3）', r.status === 200 && d && d.versions && d.versions['2.1.3'], `status=${r.status}`);
    if (d && d.versions && d.versions['2.1.3']) {
      check('packument 的 tarball 地址指向本镜像', String(d.versions['2.1.3'].dist.tarball).startsWith(REG_BASE), d.versions['2.1.3'].dist.tarball);
    }
  }
  {
    const r = await api('/ms/2.1.3', { base: REG_BASE });
    check('GET /ms/2.1.3 返回单版本元数据', r.status === 200 && r.json && r.json.version === '2.1.3', `status=${r.status}`);
  }
  {
    const r = await fetch(`${REG_BASE}/ms/-/ms-2.1.3.tgz`, { signal: AbortSignal.timeout(60000) });
    const buf = Buffer.from(await r.arrayBuffer());
    check('GET tarball 可下载且为 gzip', r.status === 200 && buf.length > 1000 && buf[0] === 0x1f && buf[1] === 0x8b, `status=${r.status} bytes=${buf.length}`);
  }
  {
    const r = await api('/__admin/api/packages/ms');
    const d = r.json && r.json.data;
    check('GET /packages/ms 返回版本明细', r.status === 200 && d && Array.isArray(d.versions) && d.versions.some((v) => v.version === '2.1.3'), `status=${r.status}`);
  }
  {
    const r = await api('/__admin/api/packages?q=ms&size=50');
    const d = r.json && r.json.data;
    check('GET /packages?q=ms 能检索到本地包', r.status === 200 && d && d.items.some((x) => x.name === 'ms'), `total=${d && d.total}`);
  }

  // ---------------------------------------------------------------- 私有包发布
  section('四、私有包发布（npm publish 协议）');
  const pub = await makeTarball(tmpDir, { name: PRIVATE, version: '1.0.0', description: '镜像源自检私有包', main: 'index.js' });
  {
    const body = {
      _id: PRIVATE,
      name: PRIVATE,
      description: '镜像源自检私有包',
      'dist-tags': { latest: '1.0.0' },
      versions: {
        '1.0.0': {
          name: PRIVATE, version: '1.0.0', description: '镜像源自检私有包', main: 'index.js',
          dist: { shasum: util.sha1hex(pub.buffer), integrity: util.integrityOf(pub.buffer), tarball: `${REG_BASE}/${PRIVATE}/-/${PRIVATE}-1.0.0.tgz` },
        },
      },
      _attachments: { [`${PRIVATE}-1.0.0.tgz`]: { content_type: 'application/octet-stream', data: pub.buffer.toString('base64'), length: pub.buffer.length } },
    };
    const r = await api(`/${PRIVATE}`, { method: 'PUT', body, timeoutMs: 60000, base: REG_BASE });
    check('PUT /<包名> 发布私有包', r.status === 201 || r.status === 200, `status=${r.status} ${r.text.slice(0, 120)}`);
  }
  {
    const r = await api(`/${PRIVATE}`, { base: REG_BASE });
    const d = r.json;
    const v = d && d.versions && d.versions['1.0.0'];
    check('发布后 GET 可读到版本', r.status === 200 && !!v, `status=${r.status}`);
    if (v) check('私有包 tarball 地址被改写为本镜像', String(v.dist.tarball).startsWith(REG_BASE), v.dist.tarball);
  }
  {
    const r = await fetch(`${REG_BASE}/${PRIVATE}/-/${PRIVATE}-1.0.0.tgz`, { signal: AbortSignal.timeout(30000) });
    const buf = Buffer.from(await r.arrayBuffer());
    check('私有包 tarball 可下载且内容一致', r.status === 200 && buf.equals(pub.buffer), `status=${r.status} bytes=${buf.length}/${pub.buffer.length}`);
  }
  {
    // 重复发布同一版本：应报错而不是静默覆盖
    const body = {
      name: PRIVATE,
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { name: PRIVATE, version: '1.0.0', dist: { integrity: util.integrityOf(pub.buffer) } } },
      _attachments: { [`${PRIVATE}-1.0.0.tgz`]: { content_type: 'application/octet-stream', data: pub.buffer.toString('base64'), length: pub.buffer.length } },
    };
    const r = await api(`/${PRIVATE}`, { method: 'PUT', body, base: REG_BASE });
    check('重复发布同版本被拒绝', r.status >= 400, `status=${r.status}`);
  }
  {
    const scoped = await makeTarball(tmpDir, { name: PRIVATE2, version: '2.0.0', description: '作用域私有包' });
    const body = {
      name: PRIVATE2,
      'dist-tags': { latest: '2.0.0' },
      versions: { '2.0.0': { name: PRIVATE2, version: '2.0.0', dist: { integrity: util.integrityOf(scoped.buffer) } } },
      _attachments: { [`${PRIVATE2.split('/')[1]}-2.0.0.tgz`]: { content_type: 'application/octet-stream', data: scoped.buffer.toString('base64'), length: scoped.buffer.length } },
    };
    const r = await api(`/${encodeURIComponent(PRIVATE2)}`, { method: 'PUT', body, base: REG_BASE });
    check('发布作用域包 @scope/name', r.status === 201 || r.status === 200, `status=${r.status} ${r.text.slice(0, 120)}`);
    const g = await api(`/${encodeURIComponent(PRIVATE2)}`, { base: REG_BASE });
    check('作用域包可通过编码路径读取', g.status === 200 && g.json && g.json.versions && g.json.versions['2.0.0'], `status=${g.status}`);
    const g2 = await api(`/${PRIVATE2}`, { base: REG_BASE });
    check('作用域包也可通过裸路径读取', g2.status === 200, `status=${g2.status}`);
  }
  {
    const r = await api(`/${PRIVATE}`, { method: 'PUT', body: { name: PRIVATE, versions: { '1.0.0': { deprecated: '测试弃用标记' } } }, base: REG_BASE });
    const g = await api(`/${PRIVATE}`, { base: REG_BASE });
    const v = g.json && g.json.versions && g.json.versions['1.0.0'];
    check('PUT 元数据可设置 deprecated', (r.status === 200 || r.status === 201) && v && v.deprecated === '测试弃用标记', `status=${r.status} deprecated=${v && v.deprecated}`);
  }
  {
    const r = await api(`/${PRIVATE}/beta`, { method: 'PUT', body: '1.0.0', headers: { 'Content-Type': 'application/json' }, base: REG_BASE });
    const g = await api(`/${PRIVATE}`, { base: REG_BASE });
    const tags = g.json && g.json['dist-tags'];
    check('PUT /<包名>/<tag> 可添加 dist-tag', (r.status === 200 || r.status === 201) && tags && tags.beta === '1.0.0', `status=${r.status} ${JSON.stringify(tags)}`);
  }
  {
    const r = await api(`/__admin/api/packages/${encodeURIComponent(PRIVATE)}/deprecate`, { method: 'POST', body: { version: '1.0.0', message: '界面弃用测试' } });
    check('管理接口 deprecate 生效', r.status === 200, `status=${r.status}`);
  }

  // ---------------------------------------------------------------- 上传
  section('五、上传本地包（.tgz / packument.json）');
  const upPkg = await makeTarball(tmpDir, { name: 'mirror-selftest-upload', version: '3.1.4', description: '上传测试包' });
  {
    const r = await api('/__admin/api/upload?overwrite=1', {
      method: 'POST', raw: upPkg.buffer,
      headers: { 'X-Filename': encodeURIComponent('mirror-selftest-upload-3.1.4.tgz'), 'Content-Type': 'application/octet-stream' },
      timeoutMs: 60000,
    });
    const d = r.json && r.json.data;
    check('POST /upload 上传 .tgz', r.status === 200 && d && d.name === 'mirror-selftest-upload' && d.version === '3.1.4', `status=${r.status} ${r.text.slice(0, 120)}`);
  }
  {
    const packument = { name: 'mirror-selftest-json', 'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': { name: 'mirror-selftest-json', version: '1.2.3', dist: { shasum: 'abc' } } } };
    const r = await api('/__admin/api/upload?overwrite=1', {
      method: 'POST', raw: Buffer.from(JSON.stringify(packument)),
      headers: { 'X-Filename': encodeURIComponent('mirror-selftest-json.json'), 'Content-Type': 'application/json' },
    });
    check('POST /upload 上传 packument.json', r.status === 200, `status=${r.status} ${r.text.slice(0, 120)}`);
    const g = await api('/mirror-selftest-json', { base: REG_BASE });
    check('上传的 packument 可被读取', g.status === 200 && g.json && g.json.versions && g.json.versions['1.2.3'], `status=${g.status}`);
  }

  // ---------------------------------------------------------------- 补 tarball
  section('五之二、一键补 tarball（勾选包批量补全）');
  {
    const r = await api('/__admin/api/packages/prefetch', { method: 'POST', body: { names: ['mirror-selftest-upload'], mode: 'tags' } });
    const d = r.json && r.json.data;
    check('POST /packages/prefetch（tags 模式）返回结构正确',
      r.status === 200 && d && d.mode === 'tags' && Array.isArray(d.packages) && Array.isArray(d.failed) && Array.isArray(d.skipped),
      `status=${r.status} ${r.text.slice(0, 140)}`);
    const pk = d && d.packages && d.packages[0];
    check('已缓存的包被识别为无需补充', !!pk && pk.target === 0 && pk.downloaded === 0, JSON.stringify(pk || {}));
  }
  {
    const r = await api('/__admin/api/packages/prefetch', { method: 'POST', body: { names: ['mirror-selftest-private'], mode: 'all' } });
    const d = r.json && r.json.data;
    const pk = d && d.packages && d.packages[0];
    check('POST /packages/prefetch（all 模式）可用', r.status === 200 && d && d.mode === 'all' && !!pk, `status=${r.status} ${r.text.slice(0, 140)}`);
  }
  {
    const r = await api('/__admin/api/packages?size=200');
    const items = (r.json && r.json.data && r.json.data.items) || [];
    const bad = items.filter(i => !Number.isFinite(i.cachedVersions) || i.cachedVersions < 0 || i.cachedVersions > i.versionCount);
    check('包列表带「已存版本数」cachedVersions，且 0 ≤ 已存 ≤ 总数',
      r.status === 200 && items.length > 0 && bad.length === 0,
      bad.length ? JSON.stringify(bad[0]) : `${items.length} 个包，例：${items.slice(0, 4).map(i => i.name + '=' + i.cachedVersions + '/' + i.versionCount).join('  ')}`);
  }
  {
    // 列表里的「已存」必须与详情页逐版本 cached 标记一致（不能只是两个独立数字）
    const l = await api('/__admin/api/packages?q=mirror-selftest-upload');
    const it = ((l.json && l.json.data && l.json.data.items) || [])[0];
    const r = await api('/__admin/api/packages/mirror-selftest-upload');
    const vs = (r.json && r.json.data && r.json.data.versions) || [];
    const cached = vs.filter(v => v.cached).length;
    check('列表 cachedVersions 与详情逐版本 cached 数一致',
      !!it && r.status === 200 && it.cachedVersions === cached,
      `列表=${it && it.cachedVersions} 详情=${cached}/${vs.length}`);
  }
  {
    const r = await api('/__admin/api/packages/prefetch', { method: 'POST', body: { names: [] } });
    check('POST /packages/prefetch 空列表返回 400', r.status === 400, `status=${r.status}`);
  }
  {
    const r = await api('/__admin/api/packages/prefetch', { method: 'POST', body: { names: ['不存在的包-xyz'] } });
    check('POST /packages/prefetch 本地无此包返回 404', r.status === 404, `status=${r.status}`);
  }

  section('五之三、补 tarball 异步任务（进度 / 并发 / 取消）');
  {
    const r = await api('/__admin/api/packages/pull', { method: 'POST', body: { names: ['mirror-selftest-upload'], mode: 'tags' } });
    const d = r.json && r.json.data;
    check('POST /packages/pull 返回 taskId 与总数',
      r.status === 200 && d && typeof d.taskId === 'string' && typeof d.total === 'number' && d.concurrency >= 1,
      `status=${r.status} ${r.text.slice(0, 160)}`);
    // 立刻查任务：应能拿到真实的百分比/速率字段
    const t = await api(`/__admin/api/tasks/${d.taskId}`);
    const td = t.json && t.json.data;
    check('GET /tasks/<id> 返回进度字段（percent/bytes/ratePerSec/etaSec）',
      t.status === 200 && td && typeof td.percent === 'number' && typeof td.bytes === 'number'
      && typeof td.ratePerSec === 'number' && typeof td.etaSec === 'number' && Array.isArray(td.packages),
      `status=${t.status} ${t.text.slice(0, 160)}`);
    // 这个包本身已齐全，任务会很快结束：轮询到结束再断言，避免把「还在 running」当成通过（旧写法就是假通过）
    let tdDone = td;
    for (let i = 0; i < 100 && tdDone && tdDone.status === 'running'; i++) {
      await util.sleep(50);
      const t2 = await api(`/__admin/api/tasks/${d.taskId}`);
      tdDone = t2.json && t2.json.data;
    }
    check('任务最终以 done 结束', !!tdDone && tdDone.status === 'done', `status=${tdDone && tdDone.status}`);
  }
  {
    const r = await api('/__admin/api/packages/pull', { method: 'POST', body: { names: [], mode: 'tags' } });
    check('POST /packages/pull 空列表返回 400', r.status === 400, `status=${r.status}`);
  }
  {
    const r = await api('/__admin/api/packages/pull', { method: 'POST', body: { names: ['不存在的包-xyz'] } });
    check('POST /packages/pull 本地无此包返回 404', r.status === 404, `status=${r.status}`);
  }
  {
    const r = await api('/__admin/api/tasks');
    const d = r.json && r.json.data;
    check('GET /tasks 返回任务列表', r.status === 200 && d && Array.isArray(d.items), `status=${r.status} ${r.text.slice(0, 140)}`);
  }
  {
    const r = await api('/__admin/api/tasks/t不存在的任务/cancel', { method: 'POST' });
    check('POST /tasks/<不存在的 id>/cancel 返回 404', r.status === 404, `status=${r.status}`);
  }
  {
    const r = await api('/__admin/api/tasks/nope-not-exist');
    check('GET /tasks/<不存在的 id> 返回 404', r.status === 404, `status=${r.status}`);
  }
  {
    // 并发数可自定义：显式传 3，服务端应原样返回
    const r = await api('/__admin/api/packages/pull', { method: 'POST', body: { names: ['mirror-selftest-upload'], mode: 'tags', concurrency: 3 } });
    const d = r.json && r.json.data;
    check('并发数可自定义（concurrency=3）', r.status === 200 && d && d.concurrency === 3, `status=${r.status} ${r.text.slice(0, 140)}`);
    // 取消一个刚启动的任务（该包已齐全，任务会立刻结束，取消接口至少不应 500）
    const c = await api(`/__admin/api/tasks/${d.taskId}/cancel`, { method: 'POST' });
    check('POST /tasks/<id>/cancel 不报错', c.status === 200 || c.status === 404, `status=${c.status} ${c.text.slice(0, 140)}`);
  }

  {
    // 回归：元数据里没有 tarball 下载地址的包（只上传了 packument.json）不能被算成"新增成功"
    const r = await api('/__admin/api/packages/pull', { method: 'POST', body: { names: ['mirror-selftest-json'], mode: 'all' } });
    const d = r.json && r.json.data;
    check('pull 无 tarball 地址的包：任务正常启动', r.status === 200 && d && d.total >= 1, `status=${r.status} ${r.text.slice(0, 140)}`);
    let td = null;
    for (let i = 0; i < 30; i++) {
      const t = await api(`/__admin/api/tasks/${d.taskId}`);
      td = t.json && t.json.data;
      if (td && td.status !== 'running') break;
      await util.sleep(200);
    }
    const pk = td && (td.packages || []).find(p => p.name === 'mirror-selftest-json');
    check('没有下到 tarball 时计为失败而不是"新增"', !!td && td.ok === 0 && td.failed >= 1,
      `ok=${td && td.ok} failed=${td && td.failed} status=${td && td.status}`);
    check('失败原因写明「元数据里没有 tarball 下载地址」',
      !!(td && td.errors && td.errors.length && /下载地址/.test(td.errors[0].error)), `errors=${JSON.stringify((td && td.errors || []).slice(0, 2))}`);
    check('该包状态标记为 error', !!pk && pk.status === 'error' && pk.ok === 0, `pkg=${JSON.stringify(pk)}`);
    check('速度只统计真正下到的（全失败时 ratePerSec=0）', !!td && td.ratePerSec === 0, `ratePerSec=${td && td.ratePerSec}`);
  }
  {
    // 同步版接口同样要如实报告失败
    const r = await api('/__admin/api/packages/mirror-selftest-json/prefetch', { method: 'POST', body: { mode: 'all' } });
    const d = r.json && r.json.data;
    check('POST /packages/<名>/prefetch 如实报告失败（downloaded=0）',
      r.status === 200 && d && d.downloaded.length === 0 && d.failed.length >= 1 && /下载地址/.test(d.failed[0].error),
      `status=${r.status} ${r.text.slice(0, 200)}`);
  }

  section('五之四、详情页按版本补 tarball（selected 模式 + 源体积字段）');
  {
    // 详情接口要能给出「源服务器体积」，未缓存的版本也要有。
    // 注意：不能硬编码 ms —— 镜像可能已被「全部包补全部版本」/用户操作补齐，全都缓存了就没有
    // 「未缓存且带源体积」的版本可断言（会变成环境导致的假失败）。这里动态选一个还有未缓存版本的包。
    const SRC_CANDS = ['typescript', 'debug', 'semver', 'chalk', 'lodash', 'ms'];
    let srcName = '';
    let vs = [];
    for (const cand of SRC_CANDS) {
      const cr = await api('/__admin/api/packages/' + encodeURIComponent(cand));
      const cv = (cr.json && cr.json.data && cr.json.data.versions) || [];
      if (cv.some(v => v.sourceSizeBytes > 0 && !v.cached)) { srcName = cand; vs = cv; break; }
    }
    let srcFound = !!srcName;
    if (!srcFound) {
      const r0 = await api('/__admin/api/packages/ms');
      srcName = 'ms';
      vs = (r0.json && r0.json.data && r0.json.data.versions) || [];
    }
    check('详情每个版本都带 sourceSizeBytes（源服务器 tarball 体积）',
      vs.length > 0 && vs.every(v => Number.isFinite(v.sourceSizeBytes)),
      `包=${srcName} versions=${vs.length} 首个=${JSON.stringify(vs[0] && { version: vs[0].version, src: vs[0].sourceSizeBytes })}`);
    if (srcFound) {
      check('源体积来自上游元数据（至少一个 > 0，未缓存版本也有）',
        vs.some(v => v.sourceSizeBytes > 0 && !v.cached),
        `包=${srcName} 未缓存且带源体积的版本数=${vs.filter(v => v.sourceSizeBytes > 0 && !v.cached).length}`);
    } else {
      skip('源体积来自上游元数据（至少一个 > 0，未缓存版本也有）',
        '当前镜像里所有包的所有版本都已缓存（用户已跑过「全部包补全部版本」），没有「未缓存」版本可验证');
    }
    check('详情带 unpackedSizeBytes / fileCount（可为 0）',
      vs.every(v => Number.isFinite(v.unpackedSizeBytes) && Number.isFinite(v.fileCount)),
      `首个=${JSON.stringify(vs[0] && { un: vs[0].unpackedSizeBytes, fc: vs[0].fileCount })}`);

    // selected 模式：只补点名的、且本地缺失的版本；已缓存的不计入 total。
    // 同样不能硬编码 ms：它可能已被补全（全缓存）就没有「未缓存版本」可用，动态挑一个两种版本都有的包。
    const SEL_CANDS = ['ms', 'debug', 'semver', 'chalk', 'lodash', 'typescript', 'is-number'];
    let selName = '', cachedOne = null, uncachedOne = null;
    for (const cand of SEL_CANDS) {
      const cvs = ((await api('/__admin/api/packages/' + encodeURIComponent(cand))).json.data || {}).versions || [];
      const c1 = cvs.find(v => v.cached && v.sourceSizeBytes > 0);
      const u1 = cvs.find(v => !v.cached && v.sourceSizeBytes > 0);
      if (c1 && u1) { selName = cand; cachedOne = c1; uncachedOne = u1; break; }
    }
    if (cachedOne && uncachedOne) {
      const rr = await api('/__admin/api/packages/pull', {
        method: 'POST',
        body: { mode: 'selected', targets: [{ name: selName, version: cachedOne.version }, { name: selName, version: uncachedOne.version }] },
      });
      const dd = rr.json && rr.json.data;
      check('selected 模式只统计「未缓存」的点名版本（已缓存的不计入 total）',
        rr.status === 200 && dd && dd.mode === 'selected' && dd.total === 1,
        `包=${selName} status=${rr.status} mode=${dd && dd.mode} total=${dd && dd.total}（点了 1 个已缓存 ${cachedOne.version} + 1 个未缓存 ${uncachedOne.version}）`);
      let td = null;
      for (let i = 0; i < 40; i++) {
        const t = await api(`/__admin/api/tasks/${dd.taskId}`);
        td = t.json && t.json.data;
        if (td && td.status !== 'running') break;
        await util.sleep(200);
      }
      check('selected 模式只下载点名的那一个版本',
        !!td && td.total === 1 && td.ok === 1 && td.failed === 0,
        `total=${td && td.total} ok=${td && td.ok} failed=${td && td.failed}`);
      const after = (await api('/__admin/api/packages/' + encodeURIComponent(selName))).json.data;
      const rec = (after.versions || []).find(v => v.version === uncachedOne.version);
      check('补充后该版本变为已缓存，且本地体积与源体积一致',
        !!rec && rec.cached === true && rec.sizeBytes === rec.sourceSizeBytes,
        `cached=${rec && rec.cached} 本地=${rec && rec.sizeBytes} 源=${rec && rec.sourceSizeBytes}`);
      const emp = await api('/__admin/api/packages/pull', { method: 'POST', body: { mode: 'selected', targets: [] } });
      check('selected 模式不给 targets 返回 400', emp.status === 400, `status=${emp.status} ${emp.text.slice(0, 120)}`);
    } else {
      // 不删除用户已有缓存来硬造前置条件：环境不满足就显式跳过（SKIP 会单列，不算通过）
      skip('selected 模式（按版本补 tarball）', `需要同时存在已缓存/未缓存版本的包，候选 ${SEL_CANDS.join('/')} 都没有（可能都被补全了）`);
    }
  }

  section('五之五、只补最新版本（mode=latest）');
  {
    // 找一个「latest 版本还没缓存、且镜像里已有该包元数据」的上游包做用例。
    // 旧实现是先把 lodash 整包删掉再只加 4.17.20，等于把用户已缓存的 tarball 永久丢掉；
    // 现在改为「只读挑选 + 只做增量补齐」：不删任何用户数据，补下来的 latest tarball 留在镜像里属于正常缓存增长。
    let targetName = '';
    let latestV = '';
    let uncachedBefore = 0;
    try {
      const page = (await api('/__admin/api/packages?size=200&page=1')).json.data || {};
      for (const it of (page.items || []).slice(0, 40)) {
        if (!it || !it.name || it.source !== 'upstream') continue;
        const det0 = (await api('/__admin/api/packages/' + encodeURIComponent(it.name))).json.data;
        const lv = det0 && det0.latest;
        const lr = ((det0 && det0.versions) || []).find((v) => v.version === lv);
        if (lv && lr && lr.cached === false) {
          targetName = it.name;
          latestV = lv;
          uncachedBefore = ((det0 && det0.versions) || []).filter((v) => !v.cached).length;
          break;
        }
      }
    } catch { /* 忽略：下面统一显式 SKIP */ }
    if (!targetName) {
      skip('latest 模式只补最新版本（五之五）', '镜像里找不到「latest 未缓存」的上游包（可能已全部缓存，或当前处于离线模式）');
    } else {
      const r = await api('/__admin/api/packages/pull', { method: 'POST', body: { names: [targetName], mode: 'latest', concurrency: 2 } });
      const d = r.json && r.json.data;
      check('latest 模式只规划 1 个版本（只补 latest）',
        r.status === 200 && d && d.mode === 'latest' && d.total === 1 && d.packages && d.packages[0].target === 1,
        `${targetName}@${latestV} status=${r.status} mode=${d && d.mode} total=${d && d.total} 目标=${d && d.packages && d.packages[0] && d.packages[0].target}`);
      let td = null;
      for (let i = 0; i < 60; i++) {
        const t = await api(`/__admin/api/tasks/${d.taskId}`);
        td = t.json && t.json.data;
        if (td && td.status !== 'running') break;
        await util.sleep(200);
      }
      check('latest 模式只下载 latest 那一个 tarball',
        !!td && td.total === 1 && td.ok === 1 && td.failed === 0,
        `total=${td && td.total} ok=${td && td.ok} failed=${td && td.failed}`);
      const det = (await api('/__admin/api/packages/' + encodeURIComponent(targetName))).json.data;
      const after = ((det && det.versions) || []).find((v) => v.version === latestV);
      const uncachedAfter = ((det && det.versions) || []).filter((v) => !v.cached).length;
      check('补完后 latest 已缓存、且只补了 latest 一个（未缓存版本数恰好减 1，没有顺手全下）',
        !!after && after.cached === true && uncachedAfter === uncachedBefore - 1,
        `latest.cached=${after && after.cached} 未缓存 ${uncachedBefore}→${uncachedAfter}`);
      const sync = await api('/__admin/api/packages/prefetch', { method: 'POST', body: { names: [targetName], mode: 'latest' } });
      const sd = sync.json && sync.json.data;
      check('同步 prefetch 也支持 mode=latest（已缓存 → skipped）',
        sync.status === 200 && sd && sd.mode === 'latest' && sd.skipped.length === 1,
        `status=${sync.status} mode=${sd && sd.mode} skipped=${sd && sd.skipped && sd.skipped.length} ${(sd && sd.skipped && sd.skipped[0] && sd.skipped[0].reason) || ''}`);
    }
  }

  section('五之六、每个版本的真实发布时间（不能用本地收录时间兜底）');
  {
    // 回归背景：旧实现 publishedAt = time[v] || createdAt（本地收录时间），
    // 于是上游没给 time 时，所有版本都会显示成「今天」这一个时间。
    const r = await api('/__admin/api/packages/' + encodeURIComponent('ms'));
    const d = r.json && r.json.data;
    const vs = (d && d.versions) || [];
    const first = vs.find(v => v.version === '0.1.0');
    check('上游包详情：每个版本都有真实发布时间',
      vs.length > 0 && vs.every(v => !!v.publishedAt),
      `versions=${vs.length} 无时间的版本数=${vs.filter(v => !v.publishedAt).length}`);
    check('0.1.0 的发布时间等于上游真实时间 2011-12-21T19:38:26.538Z',
      !!first && first.publishedAt === '2011-12-21T19:38:26.538Z',
      `publishedAt=${first && first.publishedAt}`);
    const uniq = new Set(vs.map(v => v.publishedAt));
    check('各版本发布时间互不相同，且不等于本地收录时间（旧 bug：全部显示今天）',
      uniq.size >= Math.min(5, vs.length) && !vs.some(v => v.publishedAt === d.createdAt),
      `不同时间数=${uniq.size}/${vs.length} 本地收录=${d.createdAt}`);
    check('详情返回上游创建/更新时间与发布时间条数',
      !!d.upstreamCreated && !!d.upstreamModified && d.publishTimeCount >= vs.length,
      `上游创建=${d.upstreamCreated} 上游更新=${d.upstreamModified} 条数=${d.publishTimeCount} 版本=${vs.length}`);
    check('上游创建时间早于本地收录时间（本地收录是镜像自己的时间）',
      Date.parse(d.upstreamCreated) < Date.parse(d.createdAt) + 1000,
      `上游创建=${d.upstreamCreated} 本地收录=${d.createdAt}`);

    // 本地上传的包没有上游时间 → publishedAt 必须是 null（界面显示 —），绝不能拿本地时间冒充
    const u = await api('/__admin/api/packages/' + encodeURIComponent('mirror-selftest-json'));
    const ud = u.json && u.json.data;
    const uvs = (ud && ud.versions) || [];
    check('本地上传包：没有上游时间就返回 null（界面显示 —）',
      uvs.length > 0 && uvs.every(v => v.publishedAt === null) && ud.upstreamCreated === null,
      `versions=${uvs.length} publishedAt=${JSON.stringify(uvs.map(v => v.publishedAt))} upstreamCreated=${ud.upstreamCreated}`);
  }

  // ---------------------------------------------------------------- 本轮修复回归：启动脚本预检查 / 回环地址免鉴权
  section('五之八之二、启动脚本预检查 / 回环地址免鉴权（新）');
  {
    const { spawnSync } = require('node:child_process');
    const ROOT = path.join(__dirname, '..');
    // 3) cli.js prestart：给「启动镜像源.cmd」/开机自启用，服务已在同端口运行时不再重复启动
    //    子进程输出用文件接（沙箱里不能开命名管道），避免 spawnSync 的 pipe EPERM
    const runCli = (args) => {
      const out = path.join(os.tmpdir(), `npm-mirror-cli-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
      const fd = fs.openSync(out, 'w');
      let r = null;
      try {
        r = spawnSync(process.execPath, [path.join(ROOT, 'cli.js'), ...args], {
          cwd: ROOT, stdio: ['ignore', fd, fd], timeout: 60000, windowsHide: true,
        });
      } finally { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
      let text = '';
      try { text = fs.readFileSync(out, 'utf8'); } catch { /* 忽略 */ }
      try { fs.unlinkSync(out); } catch { /* 忽略 */ }
      return { status: r && r.status, error: r && r.error, text };
    };
    // 期望值要跟随 pid 文件：正常单实例时 pid.port === 本次端口（退出码 10）；
    // 若测试机同时跑着另一端口的实例（pid 文件记的是它），prestart 应报 11。
    let pidRec = null;
    try { pidRec = JSON.parse(fs.readFileSync(path.join(util.dataRoot(), 'mirror.pid'), 'utf8')); } catch { pidRec = null; }
    const pidPort = pidRec ? Number(pidRec.port) || 0 : 0;
    const expectSame = pidPort && pidPort !== REG_PORT ? 11 : 10;
    const same = runCli(['prestart', '--port', String(REG_PORT), '--json', '--no-open']);
    check(`cli.js prestart：服务已在本次要用的端口运行 → 退出码 10（启动脚本据此跳过重复启动；实际 pid 端口 ${pidPort || '无'} → 期望 ${expectSame}）`,
      same.status === expectSame, `exit=${same.status} out=${String(same.text || '').trim().slice(0, 160)}`);
    let sj = null;
    try {
      const jt = String(same.text || '');
      const a = jt.indexOf('{');
      const b = jt.lastIndexOf('}');
      sj = a >= 0 && b > a ? JSON.parse(jt.slice(a, b + 1)) : null;
    } catch { sj = null; }
    check('prestart --json 输出 running/samePort/wantPort 字段（供启动脚本判断）',
      !!sj && sj.running === true && sj.samePort === (expectSame === 10) && Number(sj.wantPort) === REG_PORT,
      JSON.stringify(sj || {}).slice(0, 160));
    const other = runCli(['prestart', '--port', String(REG_PORT + 7), '--json', '--no-open']);
    check('cli.js prestart：已有实例运行在其它端口 → 退出码 11（不硬抢端口，提示先停止）',
      other.status === 11, `exit=${other.status} out=${String(other.text || '').trim().slice(0, 160)}`);
    const human = runCli(['prestart', '--port', String(REG_PORT), '--no-open']);
    const humanTxt = String(human.text || '');
    check('prestart 人类可读模式说清「服务已经在运行 / 不再重复启动」或「在其它端口运行，请先停止」',
      human.status === expectSame
        && (expectSame === 10 ? /已经在运行/.test(humanTxt) : /其它端口运行/.test(humanTxt)),
      humanTxt.trim().split(/\r?\n/).slice(0, 3).join(' / ').slice(0, 160));

    // 4) 本地回环免鉴权覆盖整个 127.0.0.0/8（不只是 127.0.0.1）
    const lp = util.isLoopback;
    check('util.isLoopback：整个 127/8 网段、::1、IPv4-mapped 都算回环，局域网 IP/主机名不算',
      lp('127.0.0.1') && lp('127.0.0.2') && lp('127.255.255.254') && lp('::1') && lp('::ffff:127.0.0.1')
        && !lp('192.168.1.2') && !lp('10.0.0.1') && !lp('localhost') && !lp('127.0.0.1.attacker.com'),
      `127.0.0.2=${lp('127.0.0.2')} 10.0.0.1=${lp('10.0.0.1')} localhost=${lp('localhost')}`);
    const hostProbe = await rawReq('/__admin/api/session', { headers: { Host: `127.0.0.5:${BASE_PORT}` } });
    let hostJson = null;
    try { hostJson = JSON.parse(hostProbe.text); } catch { hostJson = null; }
    check('Host 头写成其它 127 地址（127.0.0.5）也照常放行，且按本机回环免鉴权处理',
      hostProbe.status === 200 && !!hostJson && hostJson.ok === true && hostJson.data
        && hostJson.data.viaLocalhost === true && hostJson.data.authenticated === true,
      `status=${hostProbe.status} body=${String(hostProbe.text).slice(0, 140)}`);
  }

  // ---------------------------------------------------------------- 包管理页快捷筛选
  section('五之九、包管理页「缺 tarball / 不缺 tarball」快捷筛选（GET /packages?tarballs=）');
  {
    const { Store } = require('../src/store');
    const cfgMod = require('../src/config');
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    const roStore = new Store({ dir: cfgMod.storageDir(), logger: quiet });
    await roStore.init();

    const names = roStore.names();
    const allList = await api('/__admin/api/packages?size=1');
    const totalAll = Number((allList.json && allList.json.data && allList.json.data.total) || 0);
    let expMissing = 0;
    for (const n of names) if (roStore.missingTarballs(n).length) expMissing++;
    const expComplete = names.length - expMissing;

    const missList = await api('/__admin/api/packages?size=5&tarballs=missing');
    const compList = await api('/__admin/api/packages?size=5&tarballs=complete');
    const missTotal = Number((missList.json && missList.json.data && missList.json.data.total) || 0);
    const compTotal = Number((compList.json && compList.json.data && compList.json.data.total) || 0);
    check('tarballs=missing 与 tarballs=complete 命中数之和 = 全部包数（两个筛选互补，不漏包不重包）',
      missList.status === 200 && compList.status === 200 && missTotal + compTotal === totalAll,
      `missing=${missTotal} complete=${compTotal} all=${totalAll}`);
    check(`tarballs=missing 的命中数与逐包扫描一致（${expMissing} 个）`,
      missTotal === expMissing, `api=${missTotal} store=${expMissing}`);
    check(`tarballs=complete 的命中数与逐包扫描一致（${expComplete} 个）`,
      compTotal === expComplete, `api=${compTotal} store=${expComplete}`);

    const missItems = ((missList.json && missList.json.data && missList.json.data.items) || []);
    const compItems = ((compList.json && compList.json.data && compList.json.data.items) || []);
    check('tarballs=missing 返回的每一行都确实缺 tarball（hasAllTarballs=false，前端据此显示「缺 tarball」徽标）',
      expMissing === 0 ? missItems.length === 0 : (missItems.length > 0 && missItems.every((x) => x.hasAllTarballs === false)),
      `rows=${missItems.length} 首行=${missItems[0] && missItems[0].name}`);
    check('tarballs=complete 返回的每一行 tarball 都齐全（hasAllTarballs=true）',
      expComplete === 0 ? compItems.length === 0 : (compItems.length > 0 && compItems.every((x) => x.hasAllTarballs === true)),
      `rows=${compItems.length} 首行=${compItems[0] && compItems[0].name}`);

    const bogus = await api('/__admin/api/packages?size=1&tarballs=nonsense');
    check('未知的 tarballs 取值按「全部」处理（老调用方/拼错参数不会把列表变空）',
      Number((bogus.json && bogus.json.data && bogus.json.data.total) || -1) === totalAll,
      `total=${bogus.json && bogus.json.data && bogus.json.data.total}`);

    await roStore.close();
  }

  // ---------------------------------------------------------------- 加速镜像源
  section('五之十、加速镜像源：配置校验 / 地址推导 / 多源探测与回退（新）');
  {
    const http = require('node:http');
    const { Upstream, buildMirrorCandidates } = require('../src/upstream');

    const before = await api('/__admin/api/config');
    const beforeAccel = (before.json && before.json.data && before.json.data.config
      && before.json.data.config.upstream && before.json.data.config.upstream.accelerators) || [];
    check('配置接口暴露 upstream.accelerators（数组，默认空数组）',
      before.status === 200 && Array.isArray(beforeAccel),
      `status=${before.status} accelerators=${JSON.stringify(beforeAccel)}`);

    const putBad1 = await api('/__admin/api/config', { method: 'PUT', body: { upstream: { accelerators: 'https://registry.npmmirror.com' } } });
    check('加速镜像源必须是数组（传字符串时 400，避免界面传错静默丢配置）',
      putBad1.status === 400, `status=${putBad1.status} body=${String(putBad1.text).slice(0, 120)}`);
    const putBad2 = await api('/__admin/api/config', { method: 'PUT', body: { upstream: { accelerators: ['ftp://mirror.example.com'] } } });
    check('加速镜像源地址必须是 http(s)（拒绝 ftp:// 等）',
      putBad2.status === 400, `status=${putBad2.status}`);
    const manyAccel = [];
    for (let i = 0; i < 9; i++) manyAccel.push(`https://m${i}.example.com`);
    const putBad3 = await api('/__admin/api/config', { method: 'PUT', body: { upstream: { accelerators: manyAccel } } });
    check('加速镜像源最多 8 个（超出 400）',
      putBad3.status === 400, `status=${putBad3.status}`);

    const mainRegistry = (before.json && before.json.data && before.json.data.config
      && before.json.data.config.upstream && before.json.data.config.upstream.registry)
      || 'https://registry.npmmirror.com';
    const putOk = await api('/__admin/api/config', {
      method: 'PUT',
      body: { upstream: { accelerators: ['https://mirror.example.com/', 'https://mirror.example.com', mainRegistry] } },
    });
    const savedAccel = putOk.json && putOk.json.data && putOk.json.data.config
      && putOk.json.data.config.upstream && putOk.json.data.config.upstream.accelerators;
    check('保存加速镜像源会规整：去掉结尾斜杠、去重，并排除与主上游相同的地址',
      putOk.status === 200 && Array.isArray(savedAccel) && savedAccel.length === 1
        && savedAccel[0] === 'https://mirror.example.com',
      `status=${putOk.status} saved=${JSON.stringify(savedAccel)}`);

    const cand = buildMirrorCandidates(
      ['https://mirror-a.example.com/', 'https://mirror-b.example.com'],
      'https://registry.npmmirror.com/@scope/pkg/-/pkg-1.0.0.tgz',
    );
    check('加速镜像地址 = 镜像源 + 上游 tarball 的 pathname（scoped 包路径完整保留）',
      cand.length === 2
        && cand[0].url === 'https://mirror-a.example.com/@scope/pkg/-/pkg-1.0.0.tgz'
        && cand[0].registry === 'https://mirror-a.example.com'
        && cand[0].label === 'mirror-a.example.com',
      JSON.stringify(cand));
    const cand2 = buildMirrorCandidates(
      ['', 'ftp://x', 'https://mirror-a.example.com/', 'https://mirror-a.example.com'],
      'https://r.example.com/a/-/a-1.0.0.tgz',
    );
    check('加速镜像地址非法/重复项会被过滤（空串、非 http(s)、同一地址重复）',
      cand2.length === 1 && cand2[0].url === 'https://mirror-a.example.com/a/-/a-1.0.0.tgz',
      JSON.stringify(cand2));

    // 本地起 HTTP 服务模拟「加速镜像」与「上游源」，验证优先镜像 + 校验失败/404 回退
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    const tarballBytes = Buffer.from('fake-tarball-content-for-mirror-test-0123456789', 'utf8');
    const tarballIntegrity = util.integrityOf(tarballBytes);
    const tarballShasum = util.sha1hex(tarballBytes);
    const primaryBytes = Buffer.from('primary-upstream-tarball-bytes-should-be-fallback', 'utf8');
    let mirrorHits = 0;
    let primaryHits = 0;
    let badMirrorHits = 0;
    const mkServer = (handler) => {
      const srv = http.createServer(handler);
      return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
        srv, port: srv.address().port, base: `http://127.0.0.1:${srv.address().port}`,
      })));
    };
    const mirrorSrv = await mkServer((req, res) => {
      mirrorHits++;
      if (req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': tarballBytes.length });
      res.end(tarballBytes);
    });
    const badMirrorSrv = await mkServer((req, res) => {
      badMirrorHits++;
      if (req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
      const bad = Buffer.from('corrupted-bytes-from-bad-mirror');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bad.length });
      res.end(bad);
    });
    const missSrv = await mkServer((req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    const primarySrv = await mkServer((req, res) => {
      primaryHits++;
      if (req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': primaryBytes.length });
      res.end(primaryBytes);
    });
    const primaryUrl = `${primarySrv.base}/pkg/-/pkg-1.0.0.tgz`;
    const mkUpstream = (accels) => new Upstream(() => ({
      mode: 'cache',
      upstream: { registry: primarySrv.base, timeoutMs: 5000, retries: 0, accelerators: accels },
    }), quiet);
    try {
      const gotMirror = await mkUpstream([mirrorSrv.base]).downloadTarballPreferred(
        primaryUrl, buildMirrorCandidates([mirrorSrv.base], primaryUrl),
        { expectedIntegrity: tarballIntegrity, expectedShasum: tarballShasum },
      );
      check('加速镜像有该版本时优先从镜像下载（source=mirror、内容与校验正确、完全没碰上游源）',
        gotMirror.source === 'mirror' && gotMirror.buf.equals(tarballBytes) && mirrorHits > 0 && primaryHits === 0,
        `source=${gotMirror.source} mirrorHits=${mirrorHits} primaryHits=${primaryHits}`);

      const gotBad = await mkUpstream([badMirrorSrv.base]).downloadTarballPreferred(
        primaryUrl, buildMirrorCandidates([badMirrorSrv.base], primaryUrl),
        { expectedIntegrity: util.integrityOf(primaryBytes), expectedShasum: util.sha1hex(primaryBytes) },
      );
      check('加速镜像返回的内容校验不通过时自动回退上游源（不把坏包写进镜像）',
        gotBad.source === 'upstream' && gotBad.buf.equals(primaryBytes) && badMirrorHits > 0,
        `source=${gotBad.source} badMirrorHits=${badMirrorHits}`);

      const gotMiss = await mkUpstream([missSrv.base]).downloadTarballPreferred(
        primaryUrl, buildMirrorCandidates([missSrv.base], primaryUrl),
        { expectedIntegrity: util.integrityOf(primaryBytes), expectedShasum: util.sha1hex(primaryBytes) },
      );
      check('加速镜像没有该版本（404）时自动回退上游源下载',
        gotMiss.source === 'upstream' && gotMiss.buf.equals(primaryBytes),
        `source=${gotMiss.source}`);

      // 没配置加速镜像源时保持原有行为：直接走上游源
      const primaryHitsBefore = primaryHits;
      const gotPlain = await mkUpstream([]).downloadTarballPreferred(primaryUrl, [], {
        expectedIntegrity: util.integrityOf(primaryBytes), expectedShasum: util.sha1hex(primaryBytes),
      });
      check('未配置加速镜像源时直接走上游源（保持原有行为）',
        gotPlain.source === 'upstream' && gotPlain.buf.equals(primaryBytes) && primaryHits > primaryHitsBefore,
        `source=${gotPlain.source} primaryHits=${primaryHits}`);
    } finally {
      for (const s of [mirrorSrv, badMirrorSrv, missSrv, primarySrv]) s.srv.close();
    }

    const restore = await api('/__admin/api/config', { method: 'PUT', body: { upstream: { accelerators: beforeAccel } } });
    check('用例结束后恢复原有加速镜像源配置（不给用户留下测试地址）',
      restore.status === 200, `status=${restore.status}`);
  }

  // ---------------------------------------------------------------- 加速镜像源连通性测试
  section('五之十一、加速镜像源连通性测试（POST /upstream/accelerators/test）');
  {
    const http = require('node:http');
    const mkAccelSrv = (handler) => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
    });
    const msDoc = JSON.stringify({ name: 'ms', 'dist-tags': { latest: '2.1.3' }, versions: { '2.1.3': { name: 'ms', version: '2.1.3' } } });
    const msBytes = Buffer.from('fake-ms-tarball-' + Date.now());
    const goodSrv = await mkAccelSrv((req, res) => {
      if (req.url === '/ms') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(msDoc); return; }
      if (req.url === '/ms/-/ms-2.1.3.tgz') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(msBytes.length) });
        if (req.method === 'HEAD') { res.end(); return; }
        res.end(msBytes); return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope');
    });
    const badSrv = await mkAccelSrv((req, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom'); });
    // 先监听再关闭：拿到一个确定没人监听的端口，验证「连接被拒绝」类错误也能给中文原因
    const tmpSrv = await mkAccelSrv((req, res) => { res.writeHead(200); res.end('x'); });
    const closedPort = new URL(tmpSrv.base).port;
    await new Promise((r) => tmpSrv.srv.close(r));
    try {
      const rEmpty = await api('/__admin/api/upstream/accelerators/test', { method: 'POST', body: { urls: [] } });
      check('连通性测试接口：空列表返回 200 与空结果',
        rEmpty.status === 200 && Array.isArray(rEmpty.json.data.results) && rEmpty.json.data.results.length === 0,
        `status=${rEmpty.status} ${rEmpty.text.slice(0, 120)}`);

      const rBadType = await api('/__admin/api/upstream/accelerators/test', { method: 'POST', body: { urls: 'x' } });
      check('连通性测试接口：urls 不是数组时 400', rBadType.status === 400 && /数组/.test(rBadType.text), `status=${rBadType.status}`);

      const rBadUrl = await api('/__admin/api/upstream/accelerators/test', { method: 'POST', body: { urls: ['ftp://mirror.example.com/npm'] } });
      check('连通性测试接口：非 http(s) 地址 400（与保存配置的校验一致）', rBadUrl.status === 400 && /http\(s\)/.test(rBadUrl.text), `status=${rBadUrl.status}`);

      const rMany = await api('/__admin/api/upstream/accelerators/test', { method: 'POST', body: { urls: Array.from({ length: 9 }, (_, i) => `http://mirror-${i}.example.com/npm`) } });
      check('连通性测试接口：超过 8 个地址时 400', rMany.status === 400 && /8 个/.test(rMany.text), `status=${rMany.status}`);

      const rMixed = await api('/__admin/api/upstream/accelerators/test', {
        method: 'POST',
        body: { urls: [goodSrv.base, badSrv.base, `http://127.0.0.1:${closedPort}`, goodSrv.base + '/'] },
        timeoutMs: 60000,
      });
      const results = (rMixed.json && rMixed.json.data && rMixed.json.data.results) || [];
      check('连通性测试接口：可用的源返回 ok=true（元数据与 tarball 探测都通过、带耗时）',
        rMixed.status === 200 && results.length === 3 && results[0].ok === true && results[0].meta.ok === true && results[0].tarball.ok === true && results[0].ms >= 0,
        `status=${rMixed.status} len=${results.length} ${rMixed.text.slice(0, 160)}`);
      check('连通性测试接口：坏源返回 ok=false 并给出中文原因（HTTP 500 / 连接失败）',
        results.length === 3 && results[1].ok === false && /元数据不可用/.test(results[1].error || '')
          && results[2].ok === false && /连接被拒绝|超时|网络不可达|域名解析失败|证书/.test(results[2].error || ''),
        `bad=${JSON.stringify(results[1] && results[1].error)} closed=${JSON.stringify(results[2] && results[2].error)}`);
      check('连通性测试接口：忽略大小写去重、结尾斜杠视为同一地址',
        results.length === 3 && rMixed.json.data.total === 3, `total=${rMixed.json && rMixed.json.data && rMixed.json.data.total}`);
    } finally {
      goodSrv.srv.close(); badSrv.srv.close();
    }
  }

  // ---------------------------------------------------------------- 离线包
  section('六、离线包导出 / 导入（迁移用）');
  let bundleFile = null;
  {
    // 只导出「私有包」：自检要快且不依赖本地缓存了多少公共包
    // （若本地缓存过 npm 全量 600+ tarball，scope:'all' 会压出 2GB 的包、耗时一分多钟）
    const r = await api('/__admin/api/bundles/export', { method: 'POST', body: { scope: 'private' }, timeoutMs: 180000 });
    const d = r.json && r.json.data;
    bundleFile = d && d.file;
    check('POST /bundles/export 导出私有包', r.status === 200 && d && d.packages >= 1 && d.sizeBytes > 0, `status=${r.status} ${r.text.slice(0, 140)}`);
  }
  {
    const r = await api('/__admin/api/bundles');
    const d = r.json && r.json.data;
    check('GET /bundles 列出离线包', r.status === 200 && d && d.items.length >= 1, `items=${d && d.items.length}`);
  }
  {
    const r = await fetch(`${BASE}/__admin/api/bundles/download?file=${encodeURIComponent(bundleFile)}&token=${encodeURIComponent(TOKEN)}`, { signal: AbortSignal.timeout(120000) });
    const buf = Buffer.from(await r.arrayBuffer());
    check('GET /bundles/download 支持 ?token= 直链下载', r.status === 200 && buf.length > 1000 && buf[0] === 0x1f, `status=${r.status} bytes=${buf.length}`);
  }
  {
    // 删掉私有包，再用离线包恢复
    const del = await api(`/__admin/api/packages/${encodeURIComponent(PRIVATE)}`, { method: 'DELETE' });
    const gone = await api(`/${PRIVATE}`, { base: REG_BASE });
    check('DELETE /packages/<名> 删除整包', del.status === 200 && gone.status === 404, `del=${del.status} get=${gone.status}`);
    const imp = await api('/__admin/api/bundles/import', { method: 'POST', body: { file: bundleFile, overwrite: true }, timeoutMs: 180000 });
    const back = await api(`/${PRIVATE}`, { base: REG_BASE });
    check('POST /bundles/import 恢复被删的包', imp.status === 200 && back.status === 200, `imp=${imp.status} get=${back.status} ${imp.text.slice(0, 120)}`);
  }
  {
    const r = await api(`/__admin/api/bundles?file=${encodeURIComponent(bundleFile)}`, { method: 'DELETE' });
    check('DELETE /bundles 删除离线包文件', r.status === 200, `status=${r.status}`);
  }

  // -------------------------------------------- 网页上传整机备份（原始体流式导入）
  section('六之二、网页上传离线包（原始体上传 + 体积上限）');
  {
    // 前端靠这两个上限做体积预检：超限时直接提示「放进 data\bundles 再导入」，
    // 而不是让服务端读到上限后 413 + 断连，浏览器只报 net::ERR_CONNECTION_RESET（界面显示「上传失败（网络错误）」）
    const cRes = await api('/__admin/api/config');
    const st = ((((cRes.json || {}).data || {}).config) || {}).storage || {};
    const r = await api('/__admin/api/bundles');
    const lim = ((r.json || {}).data || {}).limits;
    check('GET /bundles 返回上传上限（uploadMB / bundleUploadMB）',
      r.status === 200 && lim
        && Number(lim.uploadMB) === Number(st.maxUploadMB)
        && Number(lim.bundleUploadMB) === Number(st.maxBundleUploadMB),
      `limits=${JSON.stringify(lim)} config=${JSON.stringify(st)}`);
  }
  let rawUploadBundle = null;
  {
    // 用「原始体」上传：这正是网页里拖入文件走的路径，服务端应流式落盘（几个 GB 也不进内存）
    const ex = await api('/__admin/api/bundles/export', { method: 'POST', body: { scope: 'private' }, timeoutMs: 180000 });
    rawUploadBundle = ((ex.json || {}).data || {}).file;
    const src = path.join(util.dataRoot(), 'bundles', rawUploadBundle);
    const buf = fs.readFileSync(src);
    // data\tmp 里可能本来就有其他临时文件，先快照，只判断本次上传有没有新增残留
    const tmpDir = path.join(util.dataRoot(), 'tmp');
    const tmpBefore = new Set(fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []);
    const up = await rawReq(`/__admin/api/bundles/import?overwrite=1&token=${encodeURIComponent(TOKEN)}`, {
      method: 'POST', body: buf, timeoutMs: 180000,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(rawUploadBundle),
        'X-Mirror-Token': TOKEN,
      },
    });
    let uj = null; try { uj = JSON.parse(up.text); } catch { /* 非 JSON */ }
    check('POST /bundles/import 原始体上传（网页拖入）→ 流式导入成功',
      up.status === 200 && uj && uj.ok && uj.data && uj.data.tarballs >= 1,
      `status=${up.status} bytes=${buf.length} ${String(up.text).slice(0, 120)}`);
    // 临时文件必须清干净（导入失败时也不能在 data\tmp 里留半截）
    const left = (fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []).filter((n) => !tmpBefore.has(n));
    check('原始体上传后临时文件已清理（data\\tmp 无新增残留）', left.length === 0, `left=${left.join(',')}`);
    const delRaw = await api(`/__admin/api/bundles?file=${encodeURIComponent(rawUploadBundle)}`, { method: 'DELETE' });
    check('原始体上传用例收尾：删除测试 bundle', delRaw.status === 200, `status=${delRaw.status}`);
  }
  {
    // content-length 已声明超限：不必真收几个 GB，服务端应在读完前就 413，并给出本地文件通路
    const cRes = await api('/__admin/api/config');
    const maxMB = Number((((((cRes.json || {}).data || {}).config) || {}).storage || {}).maxBundleUploadMB) || 4096;
    const decl = (maxMB + 16) * 1024 * 1024;
    const r = await rawReq(`/__admin/api/bundles/import?overwrite=1&token=${encodeURIComponent(TOKEN)}`, {
      method: 'POST', timeoutMs: 30000,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'too-big.tgz', 'Content-Length': String(decl) },
    });
    let j = null; try { j = JSON.parse(r.text); } catch { /* 非 JSON */ }
    check('上传声明体积超过上限 → 413 ETOOLARGE，并提示 data\\bundles 本地通路',
      r.status === 413 && j && j.code === 'ETOOLARGE' && /data[\\/]bundles/.test(String(j.error || '')),
      `status=${r.status} decl=${decl} ${String(r.text).slice(0, 160)}`);
  }
  {
    // 空请求体：不能当成一个 0 字节 bundle 去导入
    const r = await rawReq(`/__admin/api/bundles/import?overwrite=1&token=${encodeURIComponent(TOKEN)}`, {
      method: 'POST', timeoutMs: 30000,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'empty.tgz', 'Content-Length': '0' },
    });
    let j = null; try { j = JSON.parse(r.text); } catch { /* 非 JSON */ }
    check('上传空请求体 → 400 请求体为空', r.status === 400 && /请求体为空/.test(String((j && j.error) || '')), `status=${r.status} ${String(r.text).slice(0, 120)}`);
  }
  {
    // 非法上限必须被拒（保存前校验，避免写出起不来的配置）
    const r1 = await api('/__admin/api/config', { method: 'PUT', body: { storage: { maxBundleUploadMB: 70000 } } });
    check('PUT /config storage.maxBundleUploadMB 超范围 → 400', r1.status === 400 && /maxBundleUploadMB/.test(r1.text), `status=${r1.status} ${r1.text.slice(0, 120)}`);
    const r2 = await api('/__admin/api/config', { method: 'PUT', body: { storage: { maxBundleUploadMB: 0 } } });
    check('PUT /config storage.maxBundleUploadMB 非正数 → 400', r2.status === 400 && /maxBundleUploadMB/.test(r2.text), `status=${r2.status} ${r2.text.slice(0, 120)}`);
  }

  // ------------------------------------------------ 导出选中包时连带导出依赖
  section('六之三、导出选中的包时连带导出它的依赖（withDeps）');
  {
    const bundleMod = require('../src/bundle');
    // 1) 依赖范围解析：npm: 别名换成真实包名；file:/git/http 依赖不属于注册表，跳过
    check('depTargetName 把 npm: 别名解析成真实包名',
      bundleMod.depTargetName('a', 'npm:@scope/x@^1.0.0') === '@scope/x', String(bundleMod.depTargetName('a', 'npm:@scope/x@^1.0.0')));
    check('depTargetName 跳过 file:/git 等非注册表依赖（导出了也用不了）',
      bundleMod.depTargetName('a', 'file:../b') === null && bundleMod.depTargetName('a', 'github:u/r') === null
        && bundleMod.depTargetName('a', 'https://x/y.tgz') === null);
    check('depTargetName 普通版本范围返回包名本身', bundleMod.depTargetName('a', '^1.0.0') === 'a');

    // 2) 闭包收集（纯函数）：a→b→c，d 镜像里没有，f 是 file: 依赖
    const fake = {
      index: new Map([['a', 1], ['b', 1], ['c', 1]]),
      get(name) {
        const versions = {
          a: { '1.0.0': { dependencies: { b: '^1.0.0', d: '^2.0.0', f: 'file:../f' } } },
          b: { '1.0.0': { dependencies: { c: '^1.0.0' } }, '1.0.1': {} },
          c: { '1.0.0': {} },
        }[name];
        return versions ? { packument: { name, versions } } : null;
      },
      // collectDepClosure 本轮起改成了 async + mapLimit 并发：同样给它一个异步读接口（真实 Store 已有）
      async getAsync(name) { return this.get(name); },
    };
    const cls = await bundleMod.collectDepClosure(fake, ['a']);
    check('collectDepClosure 递归收集依赖闭包（a → b → c，根包不算在内）',
      cls.names.join(',') === 'b,c' && cls.added === 2, `names=${cls.names.join(',')} added=${cls.added}`);
    check('collectDepClosure 对镜像里没有的依赖记 missing（带 parent），file: 依赖不算 missing',
      cls.missing.some((m) => m.name === 'd' && m.parent === 'a') && !cls.missing.some((m) => m.name === 'f'),
      `missing=${JSON.stringify(cls.missing)}`);

    // 3) 走真接口：挑一个镜像里带依赖的真实包当根包，选中导出 + 连带依赖
    const { Store: Store2 } = require('../src/store');
    const cfgMod2 = require('../src/config');
    const st2 = new Store2({ dir: cfgMod2.storageDir(), logger: { info() {}, warn() {}, error() {}, debug() {} } });
    await st2.init();
    const cand = st2.names().find((n) => {
      const rec = st2.get(n);
      const vs = (rec && rec.packument && rec.packument.versions) || {};
      return Object.values(vs).some((v) => v.dependencies && Object.keys(v.dependencies).length);
    });
    check('镜像里有带依赖的包可作为根包', !!cand, `root=${cand}`);
    const bundleFiles = [];
    if (cand) {
      const ex1 = await api('/__admin/api/bundles/export', {
        method: 'POST', body: { scope: 'selected', names: [cand], withDeps: true, autoFetchDeps: false }, timeoutMs: 300000,
      });
      const d1 = (ex1.json && ex1.json.data) || {};
      if (d1.file) bundleFiles.push(d1.file);
      check(`POST /bundles/export {scope:selected, withDeps:true} 连带导出 ${cand} 的依赖（depsAdded=${d1.depsAdded}）`,
        ex1.status === 200 && d1.withDeps === true && Number(d1.depsAdded) >= 1 && Number(d1.packages) >= 2,
        `status=${ex1.status} withDeps=${d1.withDeps} depsAdded=${d1.depsAdded} packages=${d1.packages} missing=${(d1.missingDeps || []).length}`);

      // 真的把导出的包解开看：manifest 里必须列出根包 + 至少一个依赖包
      if (d1.file) {
        let man = null;
        try {
          man = await bundleMod.readBundleManifest(path.join(bundleMod.bundleDir(), d1.file));
        } catch (e) { man = null; }
        const inner = (man && man.packages ? man.packages.map((p) => p.name) : []);
        check(`导出的离线包 manifest 里真的含依赖（${inner.length} 个包：${inner.slice(0, 10).join('、')}）`,
          !!man && man.withDeps === true && (man.roots || []).length === 1 && inner.length >= 2 && inner.includes(cand),
          `withDeps=${man && man.withDeps} roots=${man && (man.roots || []).length} packages=${inner.length}`);
        check('manifest 的 stats 写明连带依赖数量（迁移侧可核对）',
          !!man && Number(man.stats && man.stats.depsAdded) >= 1 && man.stats.packages === inner.length,
          `stats=${JSON.stringify(man && man.stats)}`);
      }

      const ex2 = await api('/__admin/api/bundles/export', {
        method: 'POST', body: { scope: 'selected', names: [cand], withDeps: false }, timeoutMs: 180000,
      });
      const d2 = (ex2.json && ex2.json.data) || {};
      if (d2.file) bundleFiles.push(d2.file);
      check('显式 withDeps:false 时只导出选中的包本身（老行为可复现）',
        ex2.status === 200 && Number(d2.packages) === 1 && Number(d2.depsAdded) === 0,
        `status=${ex2.status} packages=${d2.packages} depsAdded=${d2.depsAdded}`);
    }
    for (const f of bundleFiles) await api(`/__admin/api/bundles?file=${encodeURIComponent(f)}`, { method: 'DELETE' });
    await st2.close();
  }

  // ------------------------------------------------ 导出时自动下载缺失依赖
  section('六之三之二、导出时自动下载镜像里没有的依赖（autoFetchDeps）');
  {
    const bundleModF = require('../src/bundle');
    const FAIL_ROOT = 'mirror-selftest-autodeps-fail';
    const OK_ROOT = 'mirror-selftest-autodeps-ok';
    const MISSING_DEP = 'mirror-selftest-missing-dep-zzz';
    const madeBundlesF = [];

    async function uploadTgz(pkg, file, version) {
      return api('/__admin/api/upload?overwrite=1', {
        method: 'POST', raw: file.buffer, timeoutMs: 60000,
        headers: { 'X-Filename': encodeURIComponent(`${pkg}-${version}.tgz`), 'Content-Type': 'application/octet-stream' },
      });
    }
    async function waitTaskF(id, timeoutMs = 180000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const r = await api('/__admin/api/tasks/' + id);
        const d = r.json && r.json.data;
        if (d && d.status !== 'running') return d;
        await util.sleep(200);
      }
      return null;
    }

    // 1) 前置：造一个「依赖在上游一定不存在」的包。下载必定失败，但导出必须照常成功并说明原因
    const failTgz = await makeTarball(tmpDir, { name: FAIL_ROOT, version: '1.0.0', description: '自检：依赖缺失', dependencies: { [MISSING_DEP]: '^1.0.0' } });
    const upF = await uploadTgz(FAIL_ROOT, failTgz, '1.0.0');
    check('造前置条件：上传「依赖不存在」的自检包', upF.status === 200, `status=${upF.status} ${upF.text.slice(0, 120)}`);

    const exF = await api('/__admin/api/bundles/export', {
      method: 'POST', body: { scope: 'selected', names: [FAIL_ROOT], withDeps: true }, timeoutMs: 180000,
    });
    const dF = (exF.json && exF.json.data) || {};
    if (dF.file) madeBundlesF.push(dF.file);
    check('依赖下载失败不会让导出失败：离线包照常生成',
      exF.status === 200 && !!dF.file && Number(dF.packages) >= 1,
      `status=${exF.status} file=${dF.file} packages=${dF.packages} ${exF.text.slice(0, 140)}`);
    check('下载失败的依赖留在 missingDeps 里，并附上具体原因（不再只说「不在镜像里」）',
      Array.isArray(dF.missingDeps) && dF.missingDeps.some((m) => m.name === MISSING_DEP && String(m.reason || '').length > 0),
      `missingDeps=${JSON.stringify((dF.missingDeps || []).slice(0, 2))}`);
    check('导出结果带 autoFetch 明细（未联网时是 skippedReason）',
      dF.autoFetch === null || (dF.autoFetch && 'mode' in dF.autoFetch),
      `autoFetch=${JSON.stringify(dF.autoFetch)}`);
    if (dF.file) {
      let manF = null;
      try { manF = await bundleModF.readBundleManifest(path.join(bundleModF.bundleDir(), dF.file)); } catch { manF = null; }
      check('离线包 manifest 记录 autoFetch 摘要（拿到别的机器也能看清哪些依赖没导出）',
        !!manF && !!manF.stats && Number(manF.stats.depsMissing) >= 1 && 'autoFetch' in manF,
        `stats=${JSON.stringify(manF && manF.stats)}`);
    }

    // 2) 显式 autoFetchDeps:false：不联网、保持老行为
    const exN = await api('/__admin/api/bundles/export', {
      method: 'POST', body: { scope: 'selected', names: [FAIL_ROOT], withDeps: true, autoFetchDeps: false }, timeoutMs: 180000,
    });
    const dN = (exN.json && exN.json.data) || {};
    if (dN.file) madeBundlesF.push(dN.file);
    check('autoFetchDeps:false 时完全不尝试下载（结果无 autoFetch 明细，缺的依赖照旧列在 missingDeps）',
      exN.status === 200 && dN.autoFetch === null && (dN.missingDeps || []).some((m) => m.name === MISSING_DEP),
      `status=${exN.status} autoFetch=${JSON.stringify(dN.autoFetch)}`);

    // 3) 进度任务模式（界面用的路径）同样支持自动补依赖
    const tq = await api('/__admin/api/bundles/export', {
      method: 'POST', body: { scope: 'selected', names: [FAIL_ROOT], withDeps: true, progress: true }, timeoutMs: 30000,
    });
    const tqd = (tq.json && tq.json.data) || {};
    check('progress:true 模式下自动补依赖走同一套逻辑（任务能正常收尾）',
      tq.status === 200 && !!tqd.taskId, `status=${tq.status} ${tq.text.slice(0, 120)}`);
    if (tqd.taskId) {
      const task = await waitTaskF(tqd.taskId);
      const tr = (task && task.result) || {};
      if (tr.file) madeBundlesF.push(tr.file);
      check('导出进度任务 status=done，且结果里同样有 missingDeps 原因',
        !!task && task.status === 'done' && (tr.missingDeps || []).some((m) => m.name === MISSING_DEP),
        `status=${task && task.status} missing=${JSON.stringify((tr.missingDeps || []).slice(0, 2))}`);
    }

    // 4) cache/proxy 模式 + 上游可达：缺失依赖自动下载入库，再一起打包导出
    let upstreamOk = false;
    if (cfg.mode !== 'offline') {
      try {
        const reg = String((cfg.upstream && cfg.upstream.registry) || '').replace(/\/+$/, '');
        const probe = await fetch(`${reg}/left-pad`, { headers: { Accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(8000) });
        upstreamOk = probe.ok;
      } catch { upstreamOk = false; }
    }
    if (!upstreamOk) {
      skip('自动下载缺失依赖并入库后再导出（cache 模式）', cfg.mode === 'offline' ? '当前是离线模式' : '上游源不可达');
    } else {
      let candF = '';
      for (const c of ['left-pad', 'is-odd', 'is-even', 'is-buffer', 'kind-of']) {
        const rc = await api('/__admin/api/packages/' + encodeURIComponent(c));
        if (rc.status === 404) { candF = c; break; }
      }
      check('能找到「镜像里没有、但上游有」的依赖包作为测试对象', !!candF, `dep=${candF}`);
      if (candF) {
        const okTgz = await makeTarball(tmpDir, { name: OK_ROOT, version: '1.0.0', description: '自检：自动补依赖', dependencies: { [candF]: 'latest' } });
        const upO = await uploadTgz(OK_ROOT, okTgz, '1.0.0');
        check('造前置条件：上传依赖缺失但上游存在的自检包', upO.status === 200, `status=${upO.status} ${upO.text.slice(0, 120)}`);
        const exO = await api('/__admin/api/bundles/export', {
          method: 'POST', body: { scope: 'selected', names: [OK_ROOT], withDeps: true }, timeoutMs: 300000,
        });
        const dO = (exO.json && exO.json.data) || {};
        if (dO.file) madeBundlesF.push(dO.file);
        check(`导出时自动下载缺失依赖并入库（${candF}，depsFetched=${dO.depsFetched}）`,
          exO.status === 200 && Number(dO.depsFetched) >= 1 && Number(dO.packages) >= 2,
          `status=${exO.status} depsFetched=${dO.depsFetched} packages=${dO.packages} `
          + `downloaded=${JSON.stringify(((dO.autoFetch && dO.autoFetch.downloaded) || []).map((x) => x.name + '@' + x.version))} `
          + `missing=${JSON.stringify((dO.missingDeps || []).slice(0, 2))}`);
        const rc2 = await api('/__admin/api/packages/' + encodeURIComponent(candF));
        check(`自动下载的依赖真的写进了镜像存储（GET /packages/${candF} → 200）`, rc2.status === 200, `status=${rc2.status}`);
        if (dO.file) {
          let manO = null;
          try { manO = await bundleModF.readBundleManifest(path.join(bundleModF.bundleDir(), dO.file)); } catch { manO = null; }
          const innerO = manO && manO.packages ? manO.packages.map((p) => p.name) : [];
          check(`离线包里真的含自动下载的依赖 ${candF}`,
            innerO.includes(candF) && innerO.includes(OK_ROOT),
            `packages=${innerO.slice(0, 8).join('、')}`);
        }
        // 收尾：把自动下载进来的依赖（可能包含传递依赖）全删掉，恢复到导出前的状态
        const fetchedNames = Array.from(new Set(((dO.autoFetch && dO.autoFetch.downloaded) || []).map((x) => x.name)));
        if (!fetchedNames.length) fetchedNames.push(candF);
        for (const n of fetchedNames) await api('/__admin/api/packages/' + encodeURIComponent(n), { method: 'DELETE' });
        const leftovers = [];
        for (const n of fetchedNames) {
          const rr = await api('/__admin/api/packages/' + encodeURIComponent(n));
          if (rr.status !== 404) leftovers.push(n);
        }
        check('收尾：自动下载的依赖（含传递依赖）都清理干净了，不会污染镜像',
          leftovers.length === 0, `fetched=${fetchedNames.join('、')} leftovers=${leftovers.join('、')}`);
      }
    }

    for (const f of madeBundlesF) await api(`/__admin/api/bundles?file=${encodeURIComponent(f)}`, { method: 'DELETE' });
    for (const n of [FAIL_ROOT, OK_ROOT]) await api(`/__admin/api/packages/${encodeURIComponent(n)}`, { method: 'DELETE' });
  }
  // ---------------------------------------------------------------- 导出 / 导入的详细进度任务
  section('六之四、导出 / 导入备份的详细进度任务（progress:true → taskId）');
  {
    const bundleMod3 = require('../src/bundle');
    const cfgMod3 = require('../src/config');
    const quietLog3 = { info() {}, warn() {}, error() {}, debug() {} };
    const { Store: Store3 } = require('../src/store');
    const st3 = new Store3({ dir: cfgMod3.storageDir(), logger: quietLog3 });
    await st3.init();
    const pref3 = ['ms', 'is-number', 'debug', 'semver', 'chalk', 'lodash'];
    let pkgName3 = pref3.find((n) => st3.get(n));
    if (!pkgName3) pkgName3 = (st3.names() || [])[0];
    await st3.close();

    async function waitTaskP(id, timeoutMs = 180000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const r = await api('/__admin/api/tasks/' + id);
        const d = r.json && r.json.data;
        if (d && d.status !== 'running') return d;
        await util.sleep(200);
      }
      return null;
    }

    check('镜像里能找到用于进度任务的包', !!pkgName3, `pkg=${pkgName3}`);
    const madeBundles3 = [];
    if (pkgName3) {
      // A) 导出带 progress:true：先回 taskId，再在后台统计/打包
      const ex = await api('/__admin/api/bundles/export', {
        method: 'POST', body: { scope: 'selected', names: [pkgName3], progress: true }, timeoutMs: 30000,
      });
      const ed = (ex.json && ex.json.data) || {};
      check('POST /bundles/export {progress:true} 立即返回 taskId（不再同步等打包完）',
        ex.status === 200 && ed.async === true && !!ed.taskId, `status=${ex.status} data=${JSON.stringify(ed)}`);
      let exTask = null;
      if (ed.taskId) {
        exTask = await waitTaskP(ed.taskId);
        const r = (exTask && exTask.result) || {};
        if (r.file) madeBundles3.push(r.file);
        check('导出进度任务：status=done 且整体进度跑满（total/done/bytesTotal）',
          !!exTask && exTask.status === 'done' && exTask.total > 0 && exTask.done === exTask.total && exTask.bytesTotal > 0,
          `status=${exTask && exTask.status} total=${exTask && exTask.total} done=${exTask && exTask.done} bytesTotal=${exTask && exTask.bytesTotal}`);
        const rows = (exTask && exTask.packages) || [];
        check('导出进度任务：逐包明细 status=packed，带 versions/tarballs/sizeBytes（左栏数据源）',
          rows.length >= 1 && rows.every((p) => p.status === 'packed' && p.tarballs >= 1 && p.versions >= 1 && p.sizeBytes > 0),
          JSON.stringify(rows.slice(0, 3)));
        check('导出进度任务：result.file 指向真实生成的 bundle 文件',
          !!r.file && fs.existsSync(path.join(bundleMod3.bundleDir(), r.file)) && Number(r.sizeBytes) > 0,
          `file=${r.file} size=${r.sizeBytes}`);
      }

      if (madeBundles3.length) {
        // B) 导入带 progress:true（按服务器上已有文件名）：先回 taskId，再后台解包 + 逐包导入
        const im = await api('/__admin/api/bundles/import', {
          method: 'POST', body: { file: madeBundles3[0], overwrite: true, progress: true }, timeoutMs: 30000,
        });
        const id = (im.json && im.json.data) || {};
        check('POST /bundles/import {progress:true} 立即返回 taskId',
          im.status === 200 && id.async === true && !!id.taskId, `status=${im.status} data=${JSON.stringify(id)}`);
        if (id.taskId) {
          const it = await waitTaskP(id.taskId);
          const r = (it && it.result) || {};
          check('导入进度任务：phase=import、包进度跑满、成功/失败有统计',
            !!it && it.status === 'done' && it.phase === 'import' && it.total >= 1 && it.done === it.total && (it.ok + it.failed) >= 1,
            `status=${it && it.status} phase=${it && it.phase} total=${it && it.total} done=${it && it.done} ok=${it && it.ok} failed=${it && it.failed}`);
          const rows = (it && it.packages) || [];
          check('导入进度任务：逐包明细 imported/skipped/failed + versions/tarballs（左栏数据源）',
            rows.length >= 1 && rows.every((p) => ['imported', 'skipped', 'failed'].includes(p.status))
              && rows.some((p) => Number.isFinite(Number(p.versions)) && Number.isFinite(Number(p.tarballs))),
            JSON.stringify(rows.slice(0, 3)));
          check('导入进度任务：result 带 packages/versions/tarballs/failed',
            Number(r.packages) >= 1 && Number.isFinite(Number(r.versions)) && Array.isArray(r.failed),
            JSON.stringify(r));
        }

        // C) 原始体上传 + ?progress=1：边收边落盘，收完立刻回 taskId（前端上传进度条 → 任务进度）
        const tmpDir3 = path.join(util.dataRoot(), 'tmp');
        const tmpBefore3 = new Set(fs.existsSync(tmpDir3) ? fs.readdirSync(tmpDir3) : []);
        const upBuf = fs.readFileSync(path.join(bundleMod3.bundleDir(), madeBundles3[0]));
        const up = await api('/__admin/api/bundles/import?progress=1&overwrite=1', {
          method: 'POST', raw: upBuf, timeoutMs: 120000,
          headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(madeBundles3[0]) },
        });
        const ud = (up.json && up.json.data) || {};
        check('原始体上传带 ?progress=1：落盘后立即返回 taskId',
          up.status === 200 && ud.async === true && !!ud.taskId, `status=${up.status} data=${JSON.stringify(ud)}`);
        if (ud.taskId) {
          const ut = await waitTaskP(ud.taskId);
          check('原始体上传的导入任务同样跑到 done（结果字段与同步路径一致）',
            !!ut && ut.status === 'done' && !!ut.result && Number(ut.result.packages) >= 1 && ut.result.failed.length === 0,
            `status=${ut && ut.status} result=${JSON.stringify(ut && ut.result)}`);
        }

        // D) 取消：导出刚建任务就请求取消（前端「取消导出」走同一接口）
        const ex2 = await api('/__admin/api/bundles/export', {
          method: 'POST', body: { scope: 'selected', names: [pkgName3], progress: true }, timeoutMs: 30000,
        });
        const id2 = (ex2.json && ex2.json.data && ex2.json.data.taskId) || null;
        if (id2) {
          const c = await api('/__admin/api/tasks/' + id2 + '/cancel', { method: 'POST' });
          const ct = await waitTaskP(id2);
          const r2 = (ct && ct.result) || null;
          if (r2 && r2.file) madeBundles3.push(r2.file);   // 包太小、取消晚了一步跑完时也别留垃圾
          check('取消导出任务：cancel 返回 200，任务以 canceled 收尾（包很小、取消晚一步时可能已经 done）',
            c.status === 200 && !!ct && (ct.status === 'canceled' ? !r2 : ct.status === 'done'),
            `cancel=${c.status} status=${ct && ct.status} msg=${ct && ct.message} result=${JSON.stringify(r2)}`);
        }

        // E) 任务结束后临时目录不留残渣（原始体上传的临时文件必须删掉；只判断本次新增）
        const residue3 = (fs.existsSync(tmpDir3) ? fs.readdirSync(tmpDir3) : []).filter((n) => !tmpBefore3.has(n));
        check('进度任务（含原始体上传）结束后 data\\tmp 无新增残留', residue3.length === 0, `residue=${residue3.join(',')}`);
      }
    }
    for (const f of madeBundles3) await api(`/__admin/api/bundles?file=${encodeURIComponent(f)}`, { method: 'DELETE' });
  }

  // ---------------------------------------------------------------- 并行处理的包（inFlight）
  section('六之四之二、并行打包 / 导入时「同时在处理的包」进度（inFlight）');
  {
    const tarMod5 = require('../src/tar');
    const os5 = require('os');
    const tmp5 = fs.mkdtempSync(path.join(os5.tmpdir(), 'mirror-inflight-'));
    try {
      // 1) tar 层：并发打包时进度里的 active 能同时包含多个条目、收尾清空
      //    （条目是「共享游标动态领取」的，不再按体积预切成固定段）
      const files5 = ['a.bin', 'b.bin', 'c.bin', 'd.bin'];
      for (const name of files5) fs.writeFileSync(path.join(tmp5, name), Buffer.alloc(768 * 1024, 7));
      const entries5 = files5.map((name) => ({
        name, source: path.join(tmp5, name), mode: 0o644, mtime: Date.now() / 1000,
      }));
      const ev5 = [];
      await tarMod5.packTarGz(path.join(tmp5, 'out.tgz'), entries5, {
        concurrency: 2, onProgress: (e) => ev5.push(e),
      });
      const maxActive5 = ev5.reduce((a, e) => Math.max(a, (e.active || []).length), 0);
      check('tar 打包进度带 active：并发写两个条目时出现过「同时 2 个在写」', maxActive5 >= 2,
        `events=${ev5.length} maxActive=${maxActive5}`);
      const lastEv5 = ev5[ev5.length - 1] || null;
      check('tar 打包进度 active 收尾清空（最后一个事件里没有在写的条目）',
        !!lastEv5 && Array.isArray(lastEv5.active) && lastEv5.active.length === 0,
        JSON.stringify(lastEv5));

      /* 收尾不塌陷（用户反馈：91% 时右栏只剩 1 个并行包）：
       * 动态领取下，任务过半之后仍应有多路同时写；旧实现按体积切固定段，收尾只剩最慢那段。 */
      const tailFiles5 = Array.from({ length: 12 }, (_, i) => `t${i}.bin`);
      for (const name of tailFiles5) fs.writeFileSync(path.join(tmp5, name), Buffer.alloc(1024 * 1024, 5));
      const tailEntries5 = tailFiles5.map((name) => ({
        name, source: path.join(tmp5, name), mode: 0o644, mtime: Date.now() / 1000,
      }));
      const evTail5 = [];
      await tarMod5.packTarGz(path.join(tmp5, 'tail.tgz'), tailEntries5, {
        concurrency: 3, onProgress: (e) => evTail5.push(e),
      });
      const maxActiveTail5 = evTail5.reduce((a, e) => Math.max(a, (e.active || []).length), 0);
      const lateEvTail5 = evTail5.filter((e) => e.count >= Math.floor(tailEntries5.length * 0.5));
      check('tar 并行打包收尾阶段仍保持多路（任务过半后仍有 ≥2 个条目同时在写）',
        maxActiveTail5 >= 3 && lateEvTail5.some((e) => (e.active || []).length >= 2),
        `events=${evTail5.length} maxActive=${maxActiveTail5} 过半事件=${JSON.stringify(lateEvTail5.map((e) => ({ count: e.count, active: e.active.length })).slice(0, 8))}`);
      // 动态分配会打乱条目顺序，归档必须仍能被完整读出（每个条目都在，顺序无关）
      let tailRead5 = 0;
      for (const name of tailFiles5) {
        // eslint-disable-next-line no-await-in-loop
        const b = await tarMod5.readTarEntry(path.join(tmp5, 'tail.tgz'), name);
        if (b && b.length === 1024 * 1024) tailRead5++;
      }
      check('动态分配后归档仍可完整读取（12 个条目按名取回、字节数一致）', tailRead5 === tailFiles5.length,
        `read=${tailRead5}/${tailFiles5.length}`);

      /* 收尾写盘阶段也要有进度（用户反馈：显示 100% 却不结束，不知道是不是卡在写盘）：
       * 并行写完后 packTarGz 要把分片拼成最终归档，这一步必须往上报 stage:'concat' 的字节进度。 */
      const stageEv5 = [];
      await tarMod5.packTarGz(path.join(tmp5, 'stage.tgz'), entries5, {
        concurrency: 2, onStage: (s) => stageEv5.push(s),
      });
      const concatEv5 = stageEv5.filter((s) => s && s.stage === 'concat');
      const lastConcat5 = concatEv5[concatEv5.length - 1] || null;
      check('tar 并行打包收尾阶段上报「拼接分片」字节进度（copied/total/parts，最后一次 copied=total）',
        concatEv5.length >= 2 && !!lastConcat5 && Number(lastConcat5.total) > 0
          && Number(lastConcat5.copied) === Number(lastConcat5.total) && Number(lastConcat5.parts) === 2,
        `events=${concatEv5.length} last=${JSON.stringify(lastConcat5)}`);

      /* 前端要靠任务快照里的字段画「正在写盘 X / Y GB」：brief() 是白名单，漏了字段界面就看不到 */
      const tasksMod5 = require('../src/tasks');
      const tsk5 = tasksMod5.create({ type: 'bundle-export', title: '收尾阶段字段测试', total: 2 });
      tasksMod5.update(tsk5.id, { phase: 'concat', done: 2, concatDone: 5, concatTotal: 10, concatParts: 2, inFlight: [] });
      const snap5 = tasksMod5.snapshot(tsk5.id);
      tasksMod5.finish(tsk5.id, { status: 'done', result: null });
      check('任务快照透传导出收尾写盘阶段的 concatDone/concatTotal/concatParts',
        !!snap5 && snap5.phase === 'concat' && snap5.concatDone === 5 && snap5.concatTotal === 10 && snap5.concatParts === 2,
        JSON.stringify({ phase: snap5 && snap5.phase, concatDone: snap5 && snap5.concatDone, concatTotal: snap5 && snap5.concatTotal, concatParts: snap5 && snap5.concatParts }));
    } finally {
      try { fs.rmSync(tmp5, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }

    // 2) 导出/导入任务：边跑边高频采样，验证快照里的 inFlight（并行包列表）
    const cfgMod5 = require('../src/config');
    const quietLog5 = { info() {}, warn() {}, error() {}, debug() {} };
    const { Store: Store5 } = require('../src/store');
    const st5 = new Store5({ dir: cfgMod5.storageDir(), logger: quietLog5 });
    await st5.init();
    const cand5 = ['debug', 'chalk', 'semver', 'ms', 'lodash', 'is-number'];
    const names5 = cand5.filter((n) => st5.get(n)).slice(0, 2);
    await st5.close();
    const cfg5 = await api('/__admin/api/config');
    const storage5 = ((((cfg5.json || {}).data || {}).config) || {}).storage || {};
    const exConc5 = Math.max(1, Number(storage5.bundleExportConcurrency) || 4);
    const imConc5 = Math.max(1, Number(storage5.bundleImportConcurrency) || 4);

    async function sampleTask5(id, ms = 20000) {
      const t0 = Date.now();
      const snaps = [];
      let fin = null;
      while (Date.now() - t0 < ms) {
        const r = await api('/__admin/api/tasks/' + id);
        const d = r.json && r.json.data;
        if (!d) break;
        snaps.push(d);
        if (d.status !== 'running') { fin = d; break; }
        await util.sleep(10);
      }
      return { snaps, fin };
    }
    function validFlight5(p) {
      return !!p && typeof p.name === 'string' && p.name.length > 0
        && Number.isFinite(Number(p.done)) && Number.isFinite(Number(p.total));
    }

    let bundle5 = null;
    check('镜像里能找到用于「并行包」进度测试的包', names5.length >= 2, `names=${names5.join(',')}`);
    if (names5.length >= 2) {
      const ex5 = await api('/__admin/api/bundles/export', {
        method: 'POST', body: { scope: 'selected', names: names5, progress: true }, timeoutMs: 30000,
      });
      const id5 = (ex5.json && ex5.json.data && ex5.json.data.taskId) || null;
      if (id5) {
        const { snaps, fin } = await sampleTask5(id5);
        const packs5 = snaps.filter((d) => d.phase === 'pack' && Array.isArray(d.inFlight));
        const maxLen5 = packs5.reduce((a, d) => Math.max(a, d.inFlight.length), 0);
        check('导出进度快照带 inFlight，并行打包时同时出现多个包（不再只剩 1 个「当前包」）',
          maxLen5 >= Math.min(2, exConc5),
          `并发=${exConc5} 采样=${snaps.length} 最大并行包=${maxLen5}`);
        /* 导出右栏改成「条目级并行文件」：一项 = 一个正在压缩的文件，带 file（短文件名）与 size，
         * 行数就是真正在干活的路数，不再按包聚合（否则收尾只剩一个包时会塌成 1 行）。 */
        const validFile5 = (x) => !!x && typeof x.name === 'string' && typeof x.file === 'string' && x.file.length > 0
          && Number.isFinite(Number(x.size));
        check('导出 inFlight 每项都是并行文件 {name,file,size}（右栏一行一个文件）',
          packs5.every((d) => d.inFlight.every(validFile5)),
          JSON.stringify(packs5.map((d) => d.inFlight).slice(0, 3)));
        check('导出并行文件行数不超过配置并发数，且至少出现过 2 行以上',
          packs5.every((d) => d.inFlight.length <= exConc5) && maxLen5 >= Math.min(2, exConc5),
          `并发=${exConc5} 最大并行文件=${maxLen5} 示例=${JSON.stringify((packs5.find((d) => d.inFlight.length > 1) || {}).inFlight || [])}`);
        const rf5 = (fin && fin.result) || {};
        if (rf5.file) bundle5 = rf5.file;
        check('导出任务结束后 inFlight 清空（右栏不留残留行）',
          !!fin && fin.status === 'done' && Array.isArray(fin.inFlight) && fin.inFlight.length === 0,
          `status=${fin && fin.status} inFlight=${JSON.stringify(fin && fin.inFlight)}`);
        /* 收尾写盘阶段字段：即使这次导出太小、没采样到 concat 阶段，快照里也必须带这两个字段（默认 0） */
        check('导出任务快照带收尾写盘阶段字段 concatDone/concatTotal',
          !!fin && Number.isFinite(Number(fin.concatDone)) && Number.isFinite(Number(fin.concatTotal)),
          JSON.stringify({ concatDone: fin && fin.concatDone, concatTotal: fin && fin.concatTotal }));
      }
    }

    if (bundle5) {
      const im5 = await api('/__admin/api/bundles/import', {
        method: 'POST', body: { file: bundle5, overwrite: true, progress: true }, timeoutMs: 60000,
      });
      const iid5 = (im5.json && im5.json.data && im5.json.data.taskId) || null;
      if (iid5) {
        const { snaps, fin } = await sampleTask5(iid5);
        const ims5 = snaps.filter((d) => Array.isArray(d.inFlight) && d.inFlight.length > 0);
        check('导入进度快照带 inFlight，并行导入时能看到同时在处理的包',
          ims5.length > 0 && ims5.every((d) => d.inFlight.every(validFlight5)),
          `采样=${snaps.length} 有并行包快照=${ims5.length} 示例=${JSON.stringify((ims5[0] || {}).inFlight || [])}`);
        check('导入任务结束后 inFlight 清空', !!fin && Array.isArray(fin.inFlight) && fin.inFlight.length === 0,
          `status=${fin && fin.status} inFlight=${JSON.stringify(fin && fin.inFlight)}`);
        /* 并行导入是「版本级动态分配」：一行仍是一个包，行内 lanes 表示当前分给它的并行路数
         * （剩余包数少于并发时，空闲路会一起导入同一个包的剩余版本），行数不超过配置并发数。 */
        const imMax5 = ims5.reduce((a, d) => Math.max(a, d.inFlight.length), 0);
        check('导入 inFlight 一行一个包（行内带 lanes 并行路数），行数不超过配置并发数',
          imMax5 >= 1 && imMax5 <= imConc5
            && ims5.every((d) => d.inFlight.every((x) => Number.isFinite(Number(x.lanes)) && Number(x.lanes) >= 0)),
          `maxRows=${imMax5} 配置并发=${imConc5} 示例=${JSON.stringify((ims5[0] || {}).inFlight || [])}`);
        check('导入任务的并发数来自配置（bundleImportConcurrency）', fin && Number(fin.concurrency) === imConc5,
          `concurrency=${fin && fin.concurrency} 期望=${imConc5}`);
      }
      await api(`/__admin/api/bundles?file=${encodeURIComponent(bundle5)}`, { method: 'DELETE' });
    }
  }

  // ---------------------------------------------------------------- 批量导入不漏 fd（EMFILE 回归）
  section('六之四之三、批量导入不漏文件句柄（EMFILE 回归）');
  {
    /* 用户反馈：一次导入 10,172 个 tarball 时有 841 个失败，报 EMFILE: too many open files。
     * 根因是 tar.openTarStream 返回 rs.pipe(gunzip) 后，调用方「只读到 package.json 就提前 close」
     * 只销毁了 gunzip，源文件流 rs 停在半路、fd 一直不释放，每个 tarball 泄漏 1 个；
     * 本机实测单进程句柄上限约 8189 个，导 1 万多个 tarball 必然用光（读写都开始失败）。
     * 这里用独立临时 Store 造 60 个包的离线包做真实导入：全部成功，且导入期间创建的文件读流
     * 结束时都已销毁（残活 0 个），保证不会再泄漏 fd。 */
    const bundleModFd = require('../src/bundle');
    const { Store: StoreFd } = require('../src/store');
    const cryptoFd = require('node:crypto');
    const quietLogFd = { info() {}, warn() {}, error() {}, debug() {} };
    const N_FD = 60;
    const workFd = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-fd-import-'));
    try {
      const stFd = new StoreFd({ dir: path.join(workFd, 'storage'), logger: quietLogFd });
      await stFd.init();
      const entriesFd = [];
      const statsFd = { packages: N_FD, versions: N_FD, tarballs: N_FD, tarballBytes: 0, depsAdded: 0, depsMissing: [] };
      for (let i = 0; i < N_FD; i++) {
        const nameFd = `mirror-selftest-fd-${i}`;
        const versionFd = '1.0.0';
        const fileFd = `${nameFd}-${versionFd}.tgz`;
        const pkgDirFd = path.join(workFd, 'pkg', nameFd);
        util.ensureDir(path.join(pkgDirFd, 'package'));
        fs.writeFileSync(path.join(pkgDirFd, 'package', 'package.json'),
          JSON.stringify({ name: nameFd, version: versionFd }));
        const tgzFd = path.join(pkgDirFd, fileFd);
        // eslint-disable-next-line no-await-in-loop
        await tar.packTarGz(tgzFd, [
          { name: 'package/package.json', source: path.join(pkgDirFd, 'package', 'package.json') },
          { name: 'package/index.js', data: Buffer.from(`module.exports=${i};\n`) },
        ], { gzip: true });
        const bufFd = fs.readFileSync(tgzFd);
        statsFd.tarballBytes += bufFd.length;
        entriesFd.push({
          name: `storage/${nameFd}/packument.json`,
          data: Buffer.from(JSON.stringify({
            name: nameFd,
            'dist-tags': { latest: versionFd },
            versions: {
              [versionFd]: {
                name: nameFd, version: versionFd,
                dist: {
                  tarball: `${REG_BASE}/${nameFd}/-/${fileFd}`,
                  integrity: `sha512-${cryptoFd.createHash('sha512').update(bufFd).digest('base64')}`,
                  shasum: cryptoFd.createHash('sha1').update(bufFd).digest('hex'),
                },
              },
            },
          })),
        });
        entriesFd.push({
          name: `storage/${nameFd}/meta.json`,
          data: Buffer.from(JSON.stringify({ files: { [versionFd]: fileFd }, sizes: { [versionFd]: bufFd.length }, deprecated: {} })),
        });
        entriesFd.push({ name: `storage/${nameFd}/tarballs/${fileFd}`, source: tgzFd });
      }
      const bundleFd = path.join(workFd, `fd-bundle-${util.stamp()}.tgz`);
      await tar.packTarGz(bundleFd, [
        {
          name: 'manifest.json',
          data: Buffer.from(JSON.stringify({
            format: bundleModFd.FORMAT, formatVersion: bundleModFd.FORMAT_VERSION,
            createdAt: new Date().toISOString(), tool: 'api-test', scope: 'selected', stats: statsFd,
          })),
        },
        ...entriesFd,
      ], {});

      // 统计导入期间创建的所有文件读流：导入结束后还存活的，就是泄漏的 fd
      const createdFd = [];
      const realCreateRSFd = fs.createReadStream.bind(fs);
      fs.createReadStream = function patchedFd(...args) {
        const s = realCreateRSFd(...args);
        createdFd.push(s);
        return s;
      };
      let impFd = null;
      try {
        impFd = await bundleModFd.importBundle({
          store: stFd, file: bundleFd, overwrite: true, concurrency: 4,
          logger: quietLogFd, onProgress: () => {},
        });
      } finally {
        fs.createReadStream = realCreateRSFd;
      }
      await util.sleep(200);
      const aliveFd = createdFd.filter((s) => !s.destroyed);
      const failedFd = (impFd && impFd.failed) || [];
      check(`批量导入 ${N_FD} 个包 / ${N_FD} 个 tarball 全部成功（不再因句柄耗尽而 EMFILE）`,
        !!impFd && failedFd.length === 0 && Number(impFd.packages) === N_FD && Number(impFd.tarballs) === N_FD,
        `packages=${impFd && impFd.packages} tarballs=${impFd && impFd.tarballs} failed=${JSON.stringify(failedFd).slice(0, 300)}`);
      check('导入读取每个 tarball 后都释放了源文件流（残活读流 0 个，批量导入不会泄漏 fd）',
        createdFd.length >= N_FD && aliveFd.length === 0,
        `created=${createdFd.length} alive=${aliveFd.length}`);
      let tgzFdCount = 0;
      for (let i = 0; i < N_FD; i++) {
        const pFd = path.join(workFd, 'storage', `mirror-selftest-fd-${i}`, 'tarballs', `mirror-selftest-fd-${i}-1.0.0.tgz`);
        if (fs.existsSync(pFd)) tgzFdCount++;
      }
      check('批量导入的 tarball 都真的写进了存储目录', tgzFdCount === N_FD, `found=${tgzFdCount}/${N_FD}`);
      await stFd.close();
    } finally {
      try { fs.rmSync(workFd, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  section('六之四之四、按添加时间导出（scope=added）');
  {
    const bundleModAdd = require('../src/bundle');
    const { Store: StoreAdd } = require('../src/store');
    const quietLogAdd = { info() {}, warn() {}, error() {}, debug() {} };

    // A) 时间参数解析/规范化：ISO 字符串、毫秒、空值、非法、起晚于止
    check('parseTimeBound 接受 ISO 字符串/毫秒，空值表示「不限」',
      bundleModAdd.parseTimeBound('2026-01-02T03:04:05.000Z', 'x') === Date.UTC(2026, 0, 2, 3, 4, 5)
      && bundleModAdd.parseTimeBound(1700000000000, 'x') === 1700000000000
      && bundleModAdd.parseTimeBound('', 'x') === null
      && bundleModAdd.parseTimeBound(undefined, 'x') === null);
    const rangeCodes = [];
    for (const arg of [{}, { addedFrom: '不是时间' }, { addedFrom: '2026-07-01T00:00:00.000Z', addedTo: '2026-02-01T00:00:00.000Z' }]) {
      try { bundleModAdd.normalizeAddedRange(arg); rangeCodes.push('NO_THROW'); } catch (e) { rangeCodes.push(e.code); }
    }
    check('normalizeAddedRange 对「两端都不给 / 时间非法 / 起晚于止」都报 EBADTIME（接口层返回 400）',
      rangeCodes.every((c) => c === 'EBADTIME'), JSON.stringify(rangeCodes));
    const metaBound = { createdAt: '2026-06-15T00:00:00.000Z' };
    const boundMs = Date.parse('2026-06-15T00:00:00.000Z');
    check('pkgAddedInRange 按 meta.createdAt 做闭区间判断（起止端点都算在区间内）',
      bundleModAdd.pkgAddedInRange(metaBound, boundMs, boundMs)
      && bundleModAdd.pkgAddedInRange(metaBound, null, boundMs)
      && bundleModAdd.pkgAddedInRange(metaBound, boundMs, null)
      && !bundleModAdd.pkgAddedInRange({ createdAt: '2026-06-15T00:00:00.001Z' }, null, boundMs)
      && !bundleModAdd.pkgAddedInRange({ createdAt: '2026-06-14T23:59:59.999Z' }, boundMs, null));

    // B) 接口参数校验：非法时间范围直接 400 + EBADTIME，不启动导出任务
    const badReq1 = await api('/__admin/api/bundles/export', { method: 'POST', body: { scope: 'added' }, timeoutMs: 15000 });
    check('POST /bundles/export {scope:added} 不给起止时间 → 400 EBADTIME',
      badReq1.status === 400 && badReq1.json && badReq1.json.code === 'EBADTIME', `status=${badReq1.status} ${badReq1.text.slice(0, 160)}`);
    const badReq2 = await api('/__admin/api/bundles/export', {
      method: 'POST',
      body: { scope: 'added', addedFrom: '2026-07-01T00:00:00.000Z', addedTo: '2026-02-01T00:00:00.000Z' },
      timeoutMs: 15000,
    });
    check('POST /bundles/export {scope:added} 起始晚于结束 → 400 EBADTIME',
      badReq2.status === 400 && badReq2.json && badReq2.json.code === 'EBADTIME'
      && /起始时间不能晚于结束时间/.test(badReq2.json.error || badReq2.json.message || ''),
      `status=${badReq2.status} ${badReq2.text.slice(0, 160)}`);
    const badReq3 = await api('/__admin/api/bundles/export', {
      method: 'POST', body: { scope: 'added', addedFrom: '不是时间' }, timeoutMs: 15000,
    });
    check('POST /bundles/export {scope:added} 时间格式非法 → 400 EBADTIME',
      badReq3.status === 400 && badReq3.json && badReq3.json.code === 'EBADTIME',
      `status=${badReq3.status} ${badReq3.text.slice(0, 160)}`);

    // C) 临时 Store 端到端：3 个包的添加时间分别落在 2026-01 / 2026-06 / 2026-12
    const workAdd = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-added-export-'));
    const exportedAdd = [];
    try {
      const stAdd = new StoreAdd({ dir: path.join(workAdd, 'storage'), logger: quietLogAdd });
      await stAdd.init();
      const mkAddedPkg = async (name, createdAt) => {
        const version = '1.0.0';
        const srcDir = path.join(workAdd, 'src', name, 'package');
        util.ensureDir(srcDir);
        fs.writeFileSync(path.join(srcDir, 'package.json'), JSON.stringify({ name, version }));
        const tgz = path.join(workAdd, `${name}.tgz`);
        await tar.packTarGz(tgz, [{ name: 'package/package.json', source: path.join(srcDir, 'package.json') }], { gzip: true });
        const put = stAdd.putTarball(name, version, fs.readFileSync(tgz));
        stAdd.save(name, {
          name,
          'dist-tags': { latest: version },
          versions: {
            [version]: {
              name, version,
              dist: { tarball: `${REG_BASE}/${name}/-/${put.file}`, integrity: put.integrity, shasum: put.shasum },
            },
          },
        }, { source: 'private', createdAt, files: { [version]: put.file }, sizes: { [version]: put.sizeBytes } });
        return put;
      };
      await mkAddedPkg('mirror-selftest-added-old', '2026-01-01T00:00:00.000Z');
      await mkAddedPkg('mirror-selftest-added-mid', '2026-06-15T00:00:00.000Z');
      await mkAddedPkg('mirror-selftest-added-new', '2026-12-01T00:00:00.000Z');

      const rAdd = await bundleModAdd.exportBundle({
        store: stAdd, scope: 'added',
        addedFrom: '2026-02-01T00:00:00.000Z', addedTo: '2026-07-01T00:00:00.000Z',
        autoFetchDeps: false, logger: quietLogAdd,
      });
      exportedAdd.push(rAdd.file);
      const manAdd = await bundleModAdd.readBundleManifest(rAdd.path);
      const namesAdd = (manAdd.packages || []).map((p) => p.name);
      check('导出 scope=added 只挑添加时间落区间内的包（2026-02~07 只命中 2026-06 那个）',
        rAdd.packages === 1 && rAdd.tarballs === 1 && namesAdd.length === 1 && namesAdd[0] === 'mirror-selftest-added-mid',
        `packages=${rAdd.packages} tarballs=${rAdd.tarballs} names=${JSON.stringify(namesAdd)}`);
      check('scope=added 的 bundle manifest 记录 scope 与 addedTimeRange（起止 ISO）',
        manAdd.scope === 'added' && !!manAdd.addedTimeRange
        && manAdd.addedTimeRange.from === '2026-02-01T00:00:00.000Z'
        && manAdd.addedTimeRange.to === '2026-07-01T00:00:00.000Z',
        JSON.stringify(manAdd.addedTimeRange));

      const rOpen = await bundleModAdd.exportBundle({
        store: stAdd, scope: 'added', addedFrom: '2026-06-01T00:00:00.000Z',
        autoFetchDeps: false, logger: quietLogAdd,
      });
      exportedAdd.push(rOpen.file);
      check('只给起始时间时上端开放（2026-06 之后命中 2 个包）', rOpen.packages === 2, `packages=${rOpen.packages}`);

      let emptyErr = null;
      try {
        await bundleModAdd.exportBundle({
          store: stAdd, scope: 'added', addedFrom: '2027-01-01T00:00:00.000Z',
          autoFetchDeps: false, logger: quietLogAdd,
        });
      } catch (e) { emptyErr = e; }
      check('区间内没有包时报 EMPTY，并给出人话提示（界面/CLI 直接展示）',
        !!emptyErr && emptyErr.code === 'EMPTY' && /所选时间段内没有添加进本地镜像的包/.test(emptyErr.message || ''),
        emptyErr ? `${emptyErr.code} ${emptyErr.message}` : '没有抛错');
      await stAdd.close();
    } finally {
      for (const f of exportedAdd) {
        try { fs.unlinkSync(path.join(util.dataPath('bundles'), f)); } catch { /* 忽略 */ }
      }
      try { fs.rmSync(workAdd, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  // D) 按版本添加时间导出（scope=added, addedBy=version）
  {
    const bundleModBy = require('../src/bundle');
    const { Store: StoreBy } = require('../src/store');
    const quietLogBy = { info() {}, warn() {}, error() {}, debug() {} };
    const workBy = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-added-by-version-'));
    const exportedBy = [];
    try {
      const stBy = new StoreBy({ dir: path.join(workBy, 'storage'), logger: quietLogBy });
      await stBy.init();
      const NAME_BY = 'mirror-selftest-added-version';
      const mkVerTarball = async (version) => {
        const srcDir = path.join(workBy, 'src', NAME_BY, version, 'package');
        util.ensureDir(srcDir);
        fs.writeFileSync(path.join(srcDir, 'package.json'), JSON.stringify({ name: NAME_BY, version }));
        const tgz = path.join(workBy, NAME_BY + '-' + version + '.tgz');
        await tar.packTarGz(tgz, [{ name: 'package/package.json', source: path.join(srcDir, 'package.json') }], { gzip: true });
        return stBy.putTarball(NAME_BY, version, fs.readFileSync(tgz));
      };
      const putOld = await mkVerTarball('1.0.0');
      const putNew = await mkVerTarball('2.0.0');
      stBy.save(NAME_BY, {
        name: NAME_BY,
        'dist-tags': { latest: '2.0.0' },
        versions: {
          '1.0.0': { name: NAME_BY, version: '1.0.0', dist: { tarball: REG_BASE + '/' + NAME_BY + '/-/' + putOld.file, integrity: putOld.integrity, shasum: putOld.shasum } },
          '2.0.0': { name: NAME_BY, version: '2.0.0', dist: { tarball: REG_BASE + '/' + NAME_BY + '/-/' + putNew.file, integrity: putNew.integrity, shasum: putNew.shasum } },
        },
      }, {
        source: 'private', createdAt: '2026-09-01T00:00:00.000Z',
        files: { '1.0.0': putOld.file, '2.0.0': putNew.file },
        sizes: { '1.0.0': putOld.sizeBytes, '2.0.0': putNew.sizeBytes },
      });
      // 版本入库时间用 tarball 文件的 mtime 表示：旧版本 2026-03，新版本 2026-09-15
      fs.utimesSync(stBy.tarballPath(NAME_BY, '1.0.0'), new Date('2026-03-01T00:00:00.000Z'), new Date('2026-03-01T00:00:00.000Z'));
      fs.utimesSync(stBy.tarballPath(NAME_BY, '2.0.0'), new Date('2026-09-15T00:00:00.000Z'), new Date('2026-09-15T00:00:00.000Z'));

      const rVer = await bundleModBy.exportBundle({
        store: stBy, scope: 'added', addedBy: 'version',
        addedFrom: '2026-08-01T00:00:00.000Z', addedTo: '2026-10-01T00:00:00.000Z',
        autoFetchDeps: false, logger: quietLogBy,
      });
      exportedBy.push(rVer.file);
      const manVer = await bundleModBy.readBundleManifest(rVer.path);
      const manPkgVer = (manVer.packages || [])[0] || {};
      check('「按版本添加时间」导出：旧包只导出区间内新增的版本（版本时间取自 tarball 文件 mtime）',
        rVer.packages === 1 && rVer.versions === 1 && rVer.tarballs === 1
        && rVer.versionFiltered === true && rVer.addedBy === 'version'
        && manVer.addedTimeRange && manVer.addedTimeRange.by === 'version'
        && (manPkgVer.versions || []).length === 1 && manPkgVer.versions[0].version === '2.0.0',
        'packages=' + rVer.packages + ' versions=' + rVer.versions + ' tarballs=' + rVer.tarballs + ' by=' + (manVer.addedTimeRange || {}).by);

      const dirBy = util.safePkgDir(NAME_BY);
      const packedDoc = JSON.parse((await tar.readTarEntry(rVer.path, 'storage/' + dirBy + '/packument.json')).toString('utf8'));
      const packedMeta = JSON.parse((await tar.readTarEntry(rVer.path, 'storage/' + dirBy + '/meta.json')).toString('utf8'));
      const vfBy = manVer.versionFilter || {};
      check('按版本导出的 bundle 已裁剪：packument/meta 只含该版本、dist-tags.latest 不悬空、manifest.versionFilter 记录版本',
        Object.keys(packedDoc.versions || {}).length === 1 && !!packedDoc.versions['2.0.0']
        && packedDoc['dist-tags'].latest === '2.0.0'
        && JSON.stringify(Object.keys(packedMeta.files || {})) === JSON.stringify(['2.0.0'])
        && JSON.stringify(vfBy[NAME_BY] || []) === JSON.stringify(['2.0.0']),
        'versions=' + JSON.stringify(Object.keys(packedDoc.versions || {})) + ' latest=' + (packedDoc['dist-tags'] || {}).latest + ' files=' + JSON.stringify(Object.keys(packedMeta.files || {})));

      const rPkgMode = await bundleModBy.exportBundle({
        store: stBy, scope: 'added', addedBy: 'package',
        addedFrom: '2026-08-01T00:00:00.000Z', addedTo: '2026-10-01T00:00:00.000Z',
        autoFetchDeps: false, logger: quietLogBy,
      });
      exportedBy.push(rPkgMode.file);
      check('「按包添加时间」口径下同一区间仍导出整包（两个版本全带），两种口径可切换',
        rPkgMode.packages === 1 && rPkgMode.versions === 2 && rPkgMode.tarballs === 2
        && rPkgMode.versionFiltered === false && rPkgMode.addedBy === 'package',
        'packages=' + rPkgMode.packages + ' versions=' + rPkgMode.versions + ' tarballs=' + rPkgMode.tarballs);

      const badBy = await api('/__admin/api/bundles/export', {
        method: 'POST', body: { scope: 'added', addedFrom: '2026-01-01T00:00:00.000Z', addedBy: 'nope' }, timeoutMs: 15000,
      });
      check('POST /bundles/export {scope:added, addedBy:非法值} → 400 EBADMODE',
        badBy.status === 400 && badBy.json && badBy.json.code === 'EBADMODE',
        'status=' + badBy.status + ' ' + String(badBy.text || '').slice(0, 140));
      await stBy.close();
    } finally {
      for (const f of exportedBy) {
        try { fs.unlinkSync(path.join(util.dataPath('bundles'), f)); } catch { /* 忽略 */ }
      }
      try { fs.rmSync(workBy, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  section('六之四之五、只导出指定版本（含依赖按所选版本解析）');
  {
    const bundleModVer = require('../src/bundle');
    const { Store: StoreVer } = require('../src/store');
    const quietLogVer = { info() {}, warn() {}, error() {}, debug() {} };

    // A) 版本清单解析：对象 / 数组（包名@版本）/ Map 三种写法；非法写法报 EBADVERSION（接口层 400）
    check('normalizeVersionFilter 支持 {包名: [版本]}、["包名@版本"]、Map<包名, 版本[]> 三种写法',
      (() => {
        const a = bundleModVer.normalizeVersionFilter({ 'pkg-aa': ['1.0.0', '2.0.0'] });
        const b = bundleModVer.normalizeVersionFilter(['pkg-aa@1.0.0', '@scope/pkg-bb@3.1.4']);
        const c = bundleModVer.normalizeVersionFilter(new Map([['pkg-aa', ['1.0.0']]]));
        const d = bundleModVer.normalizeVersionFilter(null);
        return !!a && a.get('pkg-aa').size === 2
          && !!b && b.get('@scope/pkg-bb').has('3.1.4')
          && !!c && c.get('pkg-aa').has('1.0.0')
          && d === null;
      })(), '三种写法都要能识别，null 表示不指定版本');
    check('parseVersionSpecLine 用最后一个 @ 切分包名/版本（@scope 包名不误判），缺版本的项返回 null',
      (() => {
        const ok = bundleModVer.parseVersionSpecLine('@scope/pkg-bb@1.2.3');
        const ok2 = bundleModVer.parseVersionSpecLine('pkg-aa@2.0.0');
        return !!ok && ok.name === '@scope/pkg-bb' && ok.version === '1.2.3'
          && !!ok2 && ok2.name === 'pkg-aa'
          && bundleModVer.parseVersionSpecLine('pkg-aa') === null
          && bundleModVer.parseVersionSpecLine('pkg-aa@') === null;
      })());
    const verCodes = [];
    for (const bad of ['不是对象也不是数组', 42, ['pkg-aa'], [{ name: 'pkg-aa' }]]) {
      try { bundleModVer.normalizeVersionFilter(bad); verCodes.push('NO_THROW'); } catch (e) { verCodes.push(e.code); }
    }
    check('versions 形状不对（字符串/数字/无版本项）统一报 EBADVERSION', verCodes.every((c) => c === 'EBADVERSION'), JSON.stringify(verCodes));

    // B) 临时 Store 端到端：A@1.0.0 依赖 depB ^1.0.0；A@2.0.0 依赖 depB ^2.0.0；depB 有 4 个版本
    const workVer = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-version-export-'));
    const exportedVer = [];
    try {
      const stVer = new StoreVer({ dir: path.join(workVer, 'storage'), logger: quietLogVer });
      await stVer.init();
      const mkVerPkg = async (name, version, depsMap) => {
        const srcDir = path.join(workVer, 'src', name, version, 'package');
        util.ensureDir(srcDir);
        fs.writeFileSync(path.join(srcDir, 'package.json'), JSON.stringify({ name, version, dependencies: depsMap || {} }));
        const tgz = path.join(workVer, `${name}-${version}.tgz`);
        await tar.packTarGz(tgz, [{ name: 'package/package.json', source: path.join(srcDir, 'package.json') }], { gzip: true });
        return stVer.putTarball(name, version, fs.readFileSync(tgz));
      };
      const saveVer = (name, items, latest) => {
        const versions = {}, files = {}, sizes = {};
        for (const it of items) {
          versions[it.version] = {
            name, version: it.version,
            dist: { tarball: `${REG_BASE}/${name}/-/${it.put.file}`, integrity: it.put.integrity, shasum: it.put.shasum },
            ...(it.deps ? { dependencies: it.deps } : {}),
          };
          files[it.version] = it.put.file;
          sizes[it.version] = it.put.sizeBytes;
        }
        stVer.save(name, { name, 'dist-tags': { latest: latest || items[items.length - 1].version }, versions },
          { source: 'private', files, sizes });
      };
      const vA = [], vB = [];
      for (const v of ['1.0.0', '1.5.0', '2.0.0', '2.5.0']) vB.push({ version: v, put: await mkVerPkg('mirror-selftest-verd', v) });
      saveVer('mirror-selftest-verd', vB);
      vA.push({ version: '1.0.0', put: await mkVerPkg('mirror-selftest-verc', '1.0.0', { 'mirror-selftest-verd': '^1.0.0' }), deps: { 'mirror-selftest-verd': '^1.0.0' } });
      vA.push({ version: '2.0.0', put: await mkVerPkg('mirror-selftest-verc', '2.0.0', { 'mirror-selftest-verd': '^2.0.0' }), deps: { 'mirror-selftest-verd': '^2.0.0' } });
      saveVer('mirror-selftest-verc', vA);

      const rEx1 = await bundleModVer.exportBundle({
        store: stVer, scope: 'selected', names: ['mirror-selftest-verc'], withDeps: true,
        autoFetchDeps: false, onlyVersions: { 'mirror-selftest-verc': ['1.0.0'] }, logger: quietLogVer,
      });
      exportedVer.push(rEx1.file);
      check('只导出 A@1.0.0 时，依赖按该版本 dependencies(^1.0.0) 解析：只带 depB 的 1.5.0（不是全部 4 个版本）',
        rEx1.packages === 2 && rEx1.versions === 2 && rEx1.versionFiltered === true
          && Array.isArray(rEx1.versionFilter['mirror-selftest-verd'])
          && rEx1.versionFilter['mirror-selftest-verd'].length === 1
          && rEx1.versionFilter['mirror-selftest-verd'][0] === '1.5.0',
        `packages=${rEx1.packages} versions=${rEx1.versions} filter=${JSON.stringify(rEx1.versionFilter)}`);

      const manEx1 = await bundleModVer.readBundleManifest(rEx1.path);
      const manPkgA = (manEx1.packages || []).find((p) => p.name === 'mirror-selftest-verc');
      const manPkgB = (manEx1.packages || []).find((p) => p.name === 'mirror-selftest-verd');
      check('裁剪导出的 manifest：versionFilter 记录精确版本，packages 里的版本列表也只含被导出的版本',
        !!manEx1.versionFilter && Array.isArray(manEx1.versionFilter['mirror-selftest-verc'])
          && manEx1.versionFilter['mirror-selftest-verc'][0] === '1.0.0'
          && !!manPkgA && manPkgA.versions.length === 1
          && manPkgA.versions[0] && manPkgA.versions[0].version === '1.0.0' && manPkgA.latest === '1.0.0'
          && !!manPkgB && manPkgB.versions.length === 1
          && manPkgB.versions[0] && manPkgB.versions[0].version === '1.5.0',
        JSON.stringify({ filter: manEx1.versionFilter, a: manPkgA && manPkgA.versions, b: manPkgB && manPkgB.versions }));

      const dirVerA = util.safePkgDir('mirror-selftest-verc');
      const packVerA = JSON.parse((await tar.readTarEntry(rEx1.path, `storage/${dirVerA}/packument.json`)).toString('utf8'));
      const metaVerA = JSON.parse((await tar.readTarEntry(rEx1.path, `storage/${dirVerA}/meta.json`)).toString('utf8'));
      check('bundle 里的 packument.json / meta.json 被裁剪成只含 A@1.0.0（dist-tags.latest 同步收敛，不留「指向不存在版本」的悬空 latest）',
        Object.keys(packVerA.versions).length === 1 && packVerA.versions['1.0.0']
          && packVerA['dist-tags'].latest === '1.0.0'
          && Object.keys(metaVerA.files).length === 1 && metaVerA.files['1.0.0']
          && metaVerA.versionCount === 1,
        JSON.stringify({ versions: Object.keys(packVerA.versions), tags: packVerA['dist-tags'], files: Object.keys(metaVerA.files), versionCount: metaVerA.versionCount }));

      const rEx2 = await bundleModVer.exportBundle({
        store: stVer, scope: 'selected', names: ['mirror-selftest-verc'], withDeps: true,
        autoFetchDeps: false, onlyVersions: { 'mirror-selftest-verc': ['2.0.0'] }, logger: quietLogVer,
      });
      exportedVer.push(rEx2.file);
      check('换一个根版本 A@2.0.0：依赖按 ^2.0.0 解析出 depB 2.5.0（不同版本带不同依赖版本）',
        Array.isArray(rEx2.versionFilter['mirror-selftest-verd'])
          && rEx2.versionFilter['mirror-selftest-verd'].length === 1
          && rEx2.versionFilter['mirror-selftest-verd'][0] === '2.5.0',
        JSON.stringify(rEx2.versionFilter));

      const rFull = await bundleModVer.exportBundle({
        store: stVer, scope: 'selected', names: ['mirror-selftest-verc'], withDeps: true,
        autoFetchDeps: false, logger: quietLogVer,
      });
      exportedVer.push(rFull.file);
      check('不指定版本时保持原行为（A 的 2 个版本 + depB 的 4 个版本全带，共 6 个版本），versionFiltered=false',
        rFull.packages === 2 && rFull.versions === 6 && rFull.versionFiltered === false, `packages=${rFull.packages} versions=${rFull.versions}`);

      let verErr = null;
      try {
        await bundleModVer.exportBundle({
          store: stVer, scope: 'selected', names: ['mirror-selftest-verc'], withDeps: true,
          autoFetchDeps: false, onlyVersions: { 'mirror-selftest-verc': ['9.9.9'] }, logger: quietLogVer,
        });
      } catch (e) { verErr = e; }
      check('点名了本地不存在的版本 → EVERSIONMISSING（不静默漏导），错误信息里带包名@版本',
        !!verErr && verErr.code === 'EVERSIONMISSING' && /mirror-selftest-verc@9\.9\.9/.test(verErr.message || ''),
        verErr ? `${verErr.code} ${verErr.message}` : '没有抛错');

      let scopeErr = null;
      try {
        await bundleModVer.exportBundle({
          store: stVer, scope: 'all', names: [], withDeps: false, autoFetchDeps: false,
          onlyVersions: { 'mirror-selftest-verc': ['1.0.0'] }, logger: quietLogVer,
        });
      } catch (e) { scopeErr = e; }
      check('只有导出「选中包」才能指定版本，其它范围 → EBADSCOPE',
        !!scopeErr && scopeErr.code === 'EBADSCOPE', scopeErr ? scopeErr.code : '没有抛错');

      // C) 裁剪导出的 bundle 仍可正常导入，且导入后本地只有被点名的版本（元数据与 tarball 一致）
      const stImp = new StoreVer({ dir: path.join(workVer, 'import-storage'), logger: quietLogVer });
      await stImp.init();
      await bundleModVer.importBundle({ store: stImp, file: rEx1.path, overwrite: true, logger: quietLogVer, concurrency: 1 });
      const recImpA = stImp.get('mirror-selftest-verc');
      const recImpB = stImp.get('mirror-selftest-verd');
      check('裁剪导出包导入后本地只有被点名的版本，且 tarball 齐全（不会出现「元数据有版本、盘中没 tarball」）',
        !!recImpA && Object.keys(recImpA.packument.versions).length === 1
          && !!stImp.tarballPath('mirror-selftest-verc', '1.0.0')
          && !!recImpB && Object.keys(recImpB.packument.versions).length === 1
          && !!stImp.tarballPath('mirror-selftest-verd', '1.5.0'),
        JSON.stringify({ a: recImpA && Object.keys(recImpA.packument.versions), b: recImpB && Object.keys(recImpB.packument.versions) }));
      await stImp.close();
    } finally {
      for (const f of exportedVer) {
        try { fs.unlinkSync(path.join(util.dataPath('bundles'), f)); } catch { /* 忽略 */ }
      }
      try { fs.rmSync(workVer, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }

    // B2) 回归：依赖闭包按版本解析出的依赖版本 tarball 未缓存时，不能被静默漏导。
    //     现象：只导出指定版本 + withDeps 时，依赖版本被算进 versionFilter（元数据有版本）却没有 tarball，
    //     导入端会跳过它 —— 用户看到的症状是「只导出了选中的包，依赖包的版本没导出」。
    const workVer2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-version-depcheck-'));
    const exportedVer2 = [];
    try {
      const stV2 = new StoreVer({ dir: path.join(workVer2, 'storage'), logger: quietLogVer });
      await stV2.init();
      const mkPutV2 = async (name, version, depsMap) => {
        const srcDir = path.join(workVer2, 'src', name, version, 'package');
        util.ensureDir(srcDir);
        fs.writeFileSync(path.join(srcDir, 'package.json'), JSON.stringify({ name, version, dependencies: depsMap || {} }));
        const tgz = path.join(workVer2, name + '-' + version + '.tgz');
        await tar.packTarGz(tgz, [{ name: 'package/package.json', source: path.join(srcDir, 'package.json') }], { gzip: true });
        return stV2.putTarball(name, version, fs.readFileSync(tgz));
      };
      const mkDistV2 = (name, version, put) => ({ tarball: REG_BASE + '/' + name + '/-/' + put.file, integrity: put.integrity, shasum: put.shasum });
      // 依赖包：元数据里有 2.0.0 / 2.5.0 两个版本，但只有 2.0.0 的 tarball 缓存（2.5.0 模拟「只有元数据」）
      const putE20 = await mkPutV2('mirror-selftest-vere', '2.0.0');
      stV2.save('mirror-selftest-vere', {
        name: 'mirror-selftest-vere',
        'dist-tags': { latest: '2.5.0' },
        versions: {
          '2.0.0': { name: 'mirror-selftest-vere', version: '2.0.0', dist: mkDistV2('mirror-selftest-vere', '2.0.0', putE20) },
          '2.5.0': { name: 'mirror-selftest-vere', version: '2.5.0', dist: { tarball: REG_BASE + '/mirror-selftest-vere/-/mirror-selftest-vere-2.5.0.tgz' } },
        },
      }, { source: 'private', files: { '2.0.0': putE20.file }, sizes: { '2.0.0': putE20.sizeBytes } });
      // 根包：1.0.0 依赖 depE ^2.0.0（按范围会解析出最高的 2.5.0，而它的 tarball 本地没有）
      const putR = await mkPutV2('mirror-selftest-verg', '1.0.0', { 'mirror-selftest-vere': '^2.0.0' });
      stV2.save('mirror-selftest-verg', {
        name: 'mirror-selftest-verg',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'mirror-selftest-verg', version: '1.0.0',
            dependencies: { 'mirror-selftest-vere': '^2.0.0' },
            dist: mkDistV2('mirror-selftest-verg', '1.0.0', putR),
          },
        },
      }, { source: 'private', files: { '1.0.0': putR.file }, sizes: { '1.0.0': putR.sizeBytes } });

      // B2-1) 无联网上下文：必须报 EVERSIONMISSING，而不是静默导出「有元数据、没 tarball」的假依赖版本
      let depErr = null;
      try {
        await bundleModVer.exportBundle({
          store: stV2, scope: 'selected', names: ['mirror-selftest-verg'], withDeps: true,
          autoFetchDeps: false, onlyVersions: { 'mirror-selftest-verg': ['1.0.0'] }, logger: quietLogVer,
        });
      } catch (e) { depErr = e; }
      check('依赖按版本解析出的版本 tarball 未缓存时，离线导出不会静默漏导 → EVERSIONMISSING（错误信息带依赖包@版本）',
        !!depErr && depErr.code === 'EVERSIONMISSING' && /mirror-selftest-vere@2\.5\.0/.test(depErr.message || ''),
        depErr ? depErr.code + ' ' + depErr.message : '没有抛错（会静默漏导，属于 bug）');

      // B2-2) 有联网上下文：校验阶段从上游补齐依赖版本 tarball，导出包 tarballs 数 = 版本数
      const fetchedDep = [];
      const fakeCtxVer = {
        cfg: () => ({ mode: 'cache' }),
        upstream: {},
        registry: {
          ensureTarballEx: async (ctx2, name, version) => {
            fetchedDep.push(name + '@' + version);
            await mkPutV2(name, version);
          },
        },
      };
      const rDep = await bundleModVer.exportBundle({
        store: stV2, ctx: fakeCtxVer, scope: 'selected', names: ['mirror-selftest-verg'], withDeps: true,
        autoFetchDeps: false, onlyVersions: { 'mirror-selftest-verg': ['1.0.0'] }, logger: quietLogVer,
      });
      exportedVer2.push(rDep.file);
      check('有联网上下文时补齐依赖版本 tarball：导出包 tarballs 数等于版本数（依赖版本真正被导出）',
        rDep.packages === 2 && rDep.versions === 2 && rDep.tarballs === 2
          && fetchedDep.includes('mirror-selftest-vere@2.5.0')
          && Array.isArray(rDep.versionFilter['mirror-selftest-vere'])
          && rDep.versionFilter['mirror-selftest-vere'][0] === '2.5.0',
        'packages=' + rDep.packages + ' versions=' + rDep.versions + ' tarballs=' + rDep.tarballs
          + ' fetched=' + JSON.stringify(fetchedDep) + ' filter=' + JSON.stringify(rDep.versionFilter));
      await stV2.close();
    } finally {
      for (const f of exportedVer2) {
        try { fs.unlinkSync(path.join(util.dataPath('bundles'), f)); } catch { /* 忽略 */ }
      }
      try { fs.rmSync(workVer2, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }

    // D) 接口层参数校验：versions 只能配合 scope=selected；形状/写错直接 400，不启动导出任务
    const verApiRows = [];
    for (const body of [
      { scope: 'all', versions: { 'mirror-selftest-x': ['1.0.0'] } },
      { scope: 'selected', names: ['mirror-selftest-x'], versions: '不是对象' },
      { scope: 'selected', names: ['mirror-selftest-x'], versions: ['没有版本号的字符串'] },
    ]) {
      const r = await api('/__admin/api/bundles/export', { method: 'POST', body, timeoutMs: 15000 });
      verApiRows.push({ status: r.status, code: r.json && r.json.code });
    }
    check('接口层：versions 配 scope=all 报 400 EBADSCOPE；versions 形状非法报 400 EBADVERSION',
      verApiRows[0].status === 400 && verApiRows[0].code === 'EBADSCOPE'
        && verApiRows[1].status === 400 && verApiRows[1].code === 'EBADVERSION'
        && verApiRows[2].status === 400 && verApiRows[2].code === 'EBADVERSION',
      JSON.stringify(verApiRows));

    // E) 回归：api.js 会先把 body.versions 规范化成 Map<包名, Set<版本>> 再交给 exportBundle，
    //    exportBundle 内部又会规范化一次；第二次必须按 Set 逐项展开，不能把 Set 当成一个版本值
    //    （曾导致接口层带 versions 的导出必然失败，报「playwright-core@[object Set]」）。
    const normMap = bundleModVer.normalizeVersionFilter({ 'pkg-aa': ['1.0.0', '2.0.0'] });
    const normAgain = bundleModVer.normalizeVersionFilter(normMap);
    check('归一化结果再归一化一次是幂等的（Map<包名, Set<版本>> 逐项展开，不会变成 [object Set]）',
      !!normAgain && normAgain.get('pkg-aa').size === 2
        && normAgain.get('pkg-aa').has('1.0.0') && normAgain.get('pkg-aa').has('2.0.0')
        && !normAgain.get('pkg-aa').has('[object Set]'),
      JSON.stringify(normAgain && Array.from(normAgain.get('pkg-aa') || [])));

    // 真接口成功路径：选一个本地已缓存的真实包版本，走 POST /bundles/export（api.js 预规范化 → exportBundle）
    const rms = await api('/__admin/api/packages/ms');
    const msData = (rms.json && rms.json.data) || {};
    const msCachedVer = (Array.isArray(msData.versions) ? msData.versions : []).find((v) => v && v.cached && v.version);
    if (rms.status !== 200 || !msCachedVer) {
      skip('接口层：POST /bundles/export 带 versions 成功导出指定版本', '本机没有 ms 的已缓存版本');
    } else {
      const rExpVer = await api('/__admin/api/bundles/export', {
        method: 'POST',
        body: { scope: 'selected', names: ['ms'], versions: { ms: [msCachedVer.version] }, withDeps: false },
        timeoutMs: 180000,
      });
      const dExpVer = (rExpVer.json && rExpVer.json.data) || {};
      check(`接口层：POST /bundles/export 带 versions 成功导出指定版本（ms@${msCachedVer.version}），返回 versionFiltered`,
        rExpVer.status === 200 && dExpVer.versionFiltered === true
          && !!dExpVer.versionFilter && Array.isArray(dExpVer.versionFilter.ms)
          && dExpVer.versionFilter.ms.length === 1 && dExpVer.versionFilter.ms[0] === msCachedVer.version,
        `status=${rExpVer.status} data=${JSON.stringify(dExpVer).slice(0, 300)}`);
      if (dExpVer.file) {
        await api('/__admin/api/bundles?file=' + encodeURIComponent(dExpVer.file), { method: 'DELETE' });
      }
    }
  }

  section('六之五、导出/导入并行与「根目录名不是 package」的 tarball');
  {
    const crypto = require('node:crypto');
    const bundleMod4 = require('../src/bundle');
    const cfgMod4 = require('../src/config');
    const quietLog4 = { info() {}, warn() {}, error() {}, debug() {} };
    const { Store: Store4 } = require('../src/store');
    const oddName = 'mirror-selftest-oddroot';
    const oddVersion = '1.0.0';
    const oddFile = `${oddName}-${oddVersion}.tgz`;

    // A) 造一个根目录名是 odd-root/（不是 package/）的 tarball，模拟 @types/* 这类历史包的布局
    const work = path.join(os.tmpdir(), `mirror-selftest-odd-${util.stamp()}`);
    util.ensureDir(path.join(work, 'odd-root'));
    fs.writeFileSync(path.join(work, 'odd-root', 'package.json'),
      JSON.stringify({ name: oddName, version: oddVersion, main: 'index.js' }));
    fs.writeFileSync(path.join(work, 'odd-root', 'index.js'), 'module.exports = 42;\n');
    const innerTgz = path.join(work, 'inner.tgz');
    await tar.packTarGz(innerTgz, [
      { name: 'odd-root/package.json', source: path.join(work, 'odd-root', 'package.json') },
      { name: 'odd-root/index.js', source: path.join(work, 'odd-root', 'index.js') },
    ], {});
    const innerBuf = fs.readFileSync(innerTgz);
    const integrity = `sha512-${crypto.createHash('sha512').update(innerBuf).digest('base64')}`;
    const shasum = crypto.createHash('sha1').update(innerBuf).digest('hex');
    const packument = {
      name: oddName,
      'dist-tags': { latest: oddVersion },
      versions: {
        [oddVersion]: {
          name: oddName, version: oddVersion,
          dist: { tarball: `${REG_BASE}/${oddName}/-/${oddFile}`, integrity, shasum },
        },
      },
    };
    // 非 scoped 包在 storage 下的目录名就是包名
    const dir = oddName;
    const bundleFile = path.join(work, `odd-root-bundle-${util.stamp()}.tgz`);
    await tar.packTarGz(bundleFile, [
      {
        name: 'manifest.json',
        data: Buffer.from(JSON.stringify({
          format: bundleMod4.FORMAT,
          formatVersion: bundleMod4.FORMAT_VERSION,
          createdAt: new Date().toISOString(),
          tool: 'api-test',
          scope: 'selected',
          stats: { packages: 1, versions: 1, tarballs: 1, tarballBytes: innerBuf.length, depsAdded: 0, depsMissing: [] },
        })),
      },
      { name: `storage/${dir}/packument.json`, data: Buffer.from(JSON.stringify(packument)) },
      { name: `storage/${dir}/meta.json`, data: Buffer.from(JSON.stringify({ files: { [oddVersion]: oddFile }, sizes: { [oddVersion]: innerBuf.length }, deprecated: {} })) },
      { name: `storage/${dir}/tarballs/${oddFile}`, source: innerTgz },
    ], {});

    const oddBundle = fs.readFileSync(bundleFile);
    const up = await api('/__admin/api/bundles/import?overwrite=1', {
      method: 'POST', raw: oddBundle, timeoutMs: 120000,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(`selftest-odd-${util.stamp()}.tgz`) },
    });
    const ud = (up.json && up.json.data) || {};
    check('根目录名不是 package 的 tarball（odd-root/package.json）能正常导入，不再报「无法解析 package/package.json」',
      up.status === 200 && Number(ud.tarballs) >= 1 && (ud.failed || []).length === 0,
      `status=${up.status} data=${JSON.stringify(ud).slice(0, 300)}`);
    const gotOdd = await api(`/${encodeURIComponent(oddName)}`, { base: REG_BASE });
    check('该包导入后能在镜像里取到（packument 含版本，说明没被当成坏 tarball 丢掉）',
      gotOdd.status === 200 && !!(gotOdd.json && gotOdd.json.versions && gotOdd.json.versions[oddVersion]),
      `status=${gotOdd.status}`);
    await api(`/__admin/api/packages/${encodeURIComponent(oddName)}`, { method: 'DELETE' });
    fs.rmSync(work, { recursive: true, force: true });

    // A2) tarball 内版本写法被 npm 规范化（packument 是 1.0.0-beta，tarball 里写 1.0.0beta）不该被判成「不一致」
    const fmtName = 'mirror-selftest-verfmt';
    const fmtKey = '1.0.0-beta';
    const fmtInner = '1.0.0beta';
    const fmtFile = `${fmtName}-${fmtKey}.tgz`;
    const work2 = path.join(os.tmpdir(), `mirror-selftest-verfmt-${util.stamp()}`);
    util.ensureDir(path.join(work2, 'package'));
    fs.writeFileSync(path.join(work2, 'package', 'package.json'),
      JSON.stringify({ name: fmtName, version: fmtInner }));
    const innerTgz2 = path.join(work2, 'inner.tgz');
    await tar.packTarGz(innerTgz2, [
      { name: 'package/package.json', source: path.join(work2, 'package', 'package.json') },
    ], {});
    const innerBuf2 = fs.readFileSync(innerTgz2);
    const packument2 = {
      name: fmtName,
      'dist-tags': { latest: fmtKey },
      versions: {
        [fmtKey]: {
          name: fmtName, version: fmtKey,
          dist: {
            tarball: `${REG_BASE}/${fmtName}/-/${fmtFile}`,
            integrity: `sha512-${crypto.createHash('sha512').update(innerBuf2).digest('base64')}`,
            shasum: crypto.createHash('sha1').update(innerBuf2).digest('hex'),
          },
        },
      },
    };
    const bundleFile2 = path.join(work2, `verfmt-bundle-${util.stamp()}.tgz`);
    await tar.packTarGz(bundleFile2, [
      {
        name: 'manifest.json',
        data: Buffer.from(JSON.stringify({
          format: bundleMod4.FORMAT, formatVersion: bundleMod4.FORMAT_VERSION,
          createdAt: new Date().toISOString(), tool: 'api-test', scope: 'selected',
          stats: { packages: 1, versions: 1, tarballs: 1, tarballBytes: innerBuf2.length, depsAdded: 0, depsMissing: [] },
        })),
      },
      { name: `storage/${fmtName}/packument.json`, data: Buffer.from(JSON.stringify(packument2)) },
      { name: `storage/${fmtName}/meta.json`, data: Buffer.from(JSON.stringify({ files: { [fmtKey]: fmtFile }, sizes: { [fmtKey]: innerBuf2.length }, deprecated: {} })) },
      { name: `storage/${fmtName}/tarballs/${fmtFile}`, source: innerTgz2 },
    ], {});
    const up2 = await api('/__admin/api/bundles/import?overwrite=1', {
      method: 'POST', raw: fs.readFileSync(bundleFile2), timeoutMs: 120000,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(`selftest-verfmt-${util.stamp()}.tgz`) },
    });
    const ud2 = (up2.json && up2.json.data) || {};
    check('tarball 内版本写法被规范化（packument 1.0.0-beta / tarball 内 1.0.0beta）也能导入，不误报「不一致」',
      up2.status === 200 && Number(ud2.tarballs) >= 1 && (ud2.failed || []).length === 0,
      `status=${up2.status} data=${JSON.stringify(ud2).slice(0, 300)}`);
    const gotFmt = await api(`/${encodeURIComponent(fmtName)}`, { base: REG_BASE });
    check('版本写法被规范化的包导入后能在镜像里取到该版本',
      gotFmt.status === 200 && !!(gotFmt.json && gotFmt.json.versions && gotFmt.json.versions[fmtKey]),
      `status=${gotFmt.status}`);
    await api(`/__admin/api/packages/${encodeURIComponent(fmtName)}`, { method: 'DELETE' });
    fs.rmSync(work2, { recursive: true, force: true });

    // A3) 任务快照里每个包都要带人话原因（前端「导入结果详情」直接消费这些数据）：
    //     - 缺 tarball 的包 → skipped + reason「bundle 内缺少 N 个版本的 tarball…」
    //     - 校验失败的包 → failed + reason 说明是哪一类不一致
    {
      const skipName = 'mirror-selftest-skipreason';
      const badName = 'mirror-selftest-badreason';
      const w3 = path.join(os.tmpdir(), `mirror-selftest-reason-${util.stamp()}`);
      util.ensureDir(w3);
      const mkPkg = (name) => {
        const root = path.join(w3, `${name}-root`);
        util.ensureDir(path.join(root, 'package'));
        fs.writeFileSync(path.join(root, 'package', 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
      };
      mkPkg(skipName); mkPkg(badName);
      const badTgz = path.join(w3, 'bad.tgz');
      await tar.packTarGz(badTgz, [{ name: 'package/package.json', source: path.join(w3, `${badName}-root`, 'package', 'package.json') }], {});
      const badBuf = fs.readFileSync(badTgz);
      const b64 = crypto.createHash('sha512').update(badBuf).digest('base64');
      const flipped = b64.slice(0, -1) + (b64.endsWith('A') ? 'B' : 'A');
      const badIntegrity = `sha512-${flipped}`;
      const w3entries = [
        {
          name: 'manifest.json',
          data: Buffer.from(JSON.stringify({
            format: bundleMod4.FORMAT, formatVersion: bundleMod4.FORMAT_VERSION,
            createdAt: new Date().toISOString(), tool: 'api-test', scope: 'selected',
            stats: { packages: 2, versions: 2, tarballs: 1, tarballBytes: badBuf.length, depsAdded: 0, depsMissing: [] },
          })),
        },
        {
          name: `storage/${skipName}/packument.json`,
          data: Buffer.from(JSON.stringify({
            name: skipName, 'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { name: skipName, version: '1.0.0', dist: { tarball: `${skipName}/-/${skipName}-1.0.0.tgz`, integrity: null } } },
          })),
        },
        { name: `storage/${skipName}/meta.json`, data: Buffer.from(JSON.stringify({ files: {}, sizes: {}, deprecated: {} })) },
        {
          name: `storage/${badName}/packument.json`,
          data: Buffer.from(JSON.stringify({
            name: badName, 'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { name: badName, version: '1.0.0', dist: { tarball: `${badName}/-/${badName}-1.0.0.tgz`, integrity: badIntegrity } } },
          })),
        },
        { name: `storage/${badName}/meta.json`, data: Buffer.from(JSON.stringify({ files: { '1.0.0': `${badName}-1.0.0.tgz` }, sizes: { '1.0.0': badBuf.length }, deprecated: {} })) },
        { name: `storage/${badName}/tarballs/${badName}-1.0.0.tgz`, source: badTgz },
      ];
      const reasonBundle = path.join(w3, 'reason-bundle.tgz');
      await tar.packTarGz(reasonBundle, w3entries, {});
      const up3 = await api('/__admin/api/bundles/import?progress=1', {
        method: 'POST', raw: fs.readFileSync(reasonBundle), timeoutMs: 120000,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(`selftest-reason-${util.stamp()}.tgz`) },
      });
      const tid3 = ((up3.json || {}).data || {}).taskId;
      let task3 = null;
      const t30 = Date.now();
      while (tid3 && Date.now() - t30 < 60000) {
        const r3 = await api('/__admin/api/tasks/' + tid3);
        const d3 = r3.json && r3.json.data;
        if (d3 && d3.status !== 'running') { task3 = d3; break; }
        await util.sleep(200);
      }
      const rows3 = (task3 && task3.packages) || [];
      const skipRow = rows3.find((p) => p.name === skipName);
      const badRow = rows3.find((p) => p.name === badName);
      check('缺 tarball 的包在任务快照里是 skipped 且原因写清「bundle 内缺少 N 个版本的 tarball」',
        !!skipRow && skipRow.status === 'skipped' && /bundle 内缺少 \d+ 个版本的 tarball/.test(String(skipRow.reason)),
        JSON.stringify(skipRow));
      check('校验失败的包在任务快照里是 failed 且原因是 integrity 不一致（前端据此整理成失败清单）',
        !!badRow && badRow.status === 'failed' && /integrity/.test(String(badRow.reason)),
        JSON.stringify(badRow));
      fs.rmSync(w3, { recursive: true, force: true });
    }

    // B) 并发配置项：字段暴露、默认值、非法值、改大后任务并发度跟着变
    // 注意：这是用户可改的配置（可能已被改成 10 之类），断言只要求「字段在 1~64 合法范围 + 代码默认值是 4」，
    // 并在小节结束处恢复成进来时的原值，别把测试改动留在用户配置里。
    const cfgModD4 = require('../src/config');
    const dflt4 = cfgModD4.defaults();
    const cfg0 = await api('/__admin/api/config');
    const st0 = (((cfg0.json || {}).data || {}).config || {}).storage || {};
    const numIn = (v, lo, hi) => Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi;
    check('GET /config 暴露离线包导出/导入并发（字段在 1~64 之间，代码默认 4）',
      numIn(st0.bundleExportConcurrency, 1, 64) && numIn(st0.bundleImportConcurrency, 1, 64)
        && Number(dflt4.storage.bundleExportConcurrency) === 4 && Number(dflt4.storage.bundleImportConcurrency) === 4,
      JSON.stringify(st0));
    const badC1 = await api('/__admin/api/config', { method: 'PUT', body: { storage: { bundleExportConcurrency: 0 } } });
    check('PUT /config storage.bundleExportConcurrency=0 → 400',
      badC1.status === 400 && /bundleExportConcurrency/.test(badC1.text), `status=${badC1.status}`);
    const badC2 = await api('/__admin/api/config', { method: 'PUT', body: { storage: { bundleImportConcurrency: 65 } } });
    check('PUT /config storage.bundleImportConcurrency=65 → 400（上限 64）',
      badC2.status === 400 && /bundleImportConcurrency/.test(badC2.text), `status=${badC2.status}`);
    const okC = await api('/__admin/api/config', {
      method: 'PUT', body: { storage: { bundleExportConcurrency: 6, bundleImportConcurrency: 6 } },
    });
    // 高核机器（如 18 核 22 线程）要能调到 16 以上：确认 22 这种值能被接受并回显
    const highC = await api('/__admin/api/config', {
      method: 'PUT', body: { storage: { bundleExportConcurrency: 22, bundleImportConcurrency: 22 } },
    });
    check('PUT /config 把导出/导入并发改成 6 / 22 都生效（上限已提到 64，高核机器能调到逻辑处理器数）',
      okC.status === 200 && Number(((((okC.json || {}).data || {}).config || {}).storage || {}).bundleExportConcurrency) === 6
        && highC.status === 200
        && Number(((((highC.json || {}).data || {}).config || {}).storage || {}).bundleImportConcurrency) === 22,
      `status6=${okC.status} status22=${highC.status}`);
    // 改回 6 供下面的并行导出/导入任务断言使用
    await api('/__admin/api/config', {
      method: 'PUT', body: { storage: { bundleExportConcurrency: 6, bundleImportConcurrency: 6 } },
    });
    // 本地扫描并发（补 tarball 规划 / 导出统计 / 依赖闭包 / npm 缓存扫描导入共用）
    check('GET /config 暴露本地扫描并发 localScanConcurrency（1~64，代码默认 8）',
      numIn(st0.localScanConcurrency, 1, 64) && Number(dflt4.storage.localScanConcurrency) === 8,
      JSON.stringify(st0.localScanConcurrency));
    const badC3 = await api('/__admin/api/config', { method: 'PUT', body: { storage: { localScanConcurrency: 0 } } });
    check('PUT /config storage.localScanConcurrency=0 → 400',
      badC3.status === 400 && /localScanConcurrency/.test(badC3.text), `status=${badC3.status}`);
    const badC3b = await api('/__admin/api/config', { method: 'PUT', body: { storage: { localScanConcurrency: 65 } } });
    check('PUT /config storage.localScanConcurrency=65 → 400（上限 64）',
      badC3b.status === 400 && /localScanConcurrency/.test(badC3b.text), `status=${badC3b.status}`);
    const okC3 = await api('/__admin/api/config', { method: 'PUT', body: { storage: { localScanConcurrency: 16 } } });
    check('PUT /config storage.localScanConcurrency=16 → 200 且回显 16',
      okC3.status === 200 && Number((((((okC3.json || {}).data || {}).config || {}).storage || {})).localScanConcurrency) === 16,
      `status=${okC3.status}`);
    // 恢复用户原值，别把测试改动留在配置里
    await api('/__admin/api/config', { method: 'PUT', body: { storage: { localScanConcurrency: Number(st0.localScanConcurrency) || 8 } } });

    const st4 = new Store4({ dir: cfgMod4.storageDir(), logger: quietLog4 });
    await st4.init();
    const pref4 = ['ms', 'is-number', 'debug', 'semver', 'chalk', 'lodash'];
    let pkgName4 = pref4.find(n => st4.get(n));
    if (!pkgName4) pkgName4 = (st4.names() || [])[0];
    await st4.close();

    async function waitTask4(id, timeoutMs = 180000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const r = await api('/__admin/api/tasks/' + id);
        const d = r.json && r.json.data;
        if (d && d.status !== 'running') return d;
        await util.sleep(200);
      }
      return null;
    }

    const madeBundles4 = [];
    check('镜像里能找到用于并行导出的包', !!pkgName4, `pkg=${pkgName4}`);
    if (pkgName4) {
      const ex = await api('/__admin/api/bundles/export', {
        method: 'POST', body: { scope: 'selected', names: [pkgName4], progress: true }, timeoutMs: 30000,
      });
      const exData = (ex.json && ex.json.data) || {};
      const exTask = exData.taskId ? await waitTask4(exData.taskId) : null;
      if (exTask && exTask.result && exTask.result.file) madeBundles4.push(exTask.result.file);
      check('导出进度任务按配置的并发度运行（concurrency=6）',
        !!exTask && exTask.status === 'done' && Number(exTask.concurrency) === 6,
        `status=${exTask && exTask.status} concurrency=${exTask && exTask.concurrency}`);
      check('并行打包（多段 gzip 拼接）产出的 bundle 能被正常解析（manifest/结果字段齐全）',
        !!exTask && !!exTask.result && Number(exTask.result.packages) >= 1 && Number(exTask.result.tarballs) >= 1,
        JSON.stringify(exTask && exTask.result));
      if (madeBundles4.length) {
        const im = await api('/__admin/api/bundles/import', {
          method: 'POST', body: { file: madeBundles4[0], overwrite: true, progress: true }, timeoutMs: 30000,
        });
        const imData = (im.json && im.json.data) || {};
        const imTask = imData.taskId ? await waitTask4(imData.taskId) : null;
        check('导入进度任务按配置的并发度运行（concurrency=6）',
          !!imTask && imTask.status === 'done' && Number(imTask.concurrency) === 6,
          `status=${imTask && imTask.status} concurrency=${imTask && imTask.concurrency}`);
        check('并行导入（多包同时写）结束后包进度跑满、结果与串行一致',
          !!imTask && imTask.total >= 1 && imTask.done === imTask.total
            && !!imTask.result && Number(imTask.result.packages) >= 1 && Array.isArray(imTask.result.failed),
          `total=${imTask && imTask.total} done=${imTask && imTask.done} result=${JSON.stringify(imTask && imTask.result)}`);
      }
    }
    for (const f of madeBundles4) await api(`/__admin/api/bundles?file=${encodeURIComponent(f)}`, { method: 'DELETE' });
    // 恢复成本小节开始时的原值（用户可能把并发改过，别把测试用的 6 或默认 4 留在用户配置里）
    await api('/__admin/api/config', {
      method: 'PUT',
      body: {
        storage: {
          bundleExportConcurrency: Number(st0.bundleExportConcurrency) || 4,
          bundleImportConcurrency: Number(st0.bundleImportConcurrency) || 4,
        },
      },
    });
  }

  // ---------------------------------------------------------------- 分片并发上传 + 多并发解包 + 并行路数
  section('六之六、分片并发上传 / 多并发解包 / 每个包的并行路数（新）');
  {
    const crypto = require('node:crypto');
    const bundleModNew = require('../src/bundle');
    const cfgModNew = require('../src/config');
    const quietLogNew = { info() {}, warn() {}, error() {}, debug() {} };
    const { Store: StoreNew } = require('../src/store');
    const workNew = path.join(os.tmpdir(), `mirror-selftest-new-${util.stamp()}`);
    util.ensureDir(workNew);
    const PKG_A = 'mirror-selftest-chunkpkg-a';
    const PKG_B = 'mirror-selftest-chunkpkg-b';
    const VERS = ['1.0.0', '1.1.0', '1.2.0', '1.3.0'];

    // 1) 造「多包多版本」合成离线包：每个版本带 600KB 不可压缩填充，保证分片上传能真切成多片
    const entriesNew = [];
    let tarballBytesNew = 0;
    for (const name of [PKG_A, PKG_B]) {
      const versionsNew = {};
      const filesNew = {};
      const sizesNew = {};
      for (const ver of VERS) {
        const rootNew = path.join(workNew, `inner-${name}-${ver}`);
        util.ensureDir(path.join(rootNew, 'package'));
        fs.writeFileSync(path.join(rootNew, 'package', 'package.json'), JSON.stringify({ name, version: ver }));
        fs.writeFileSync(path.join(rootNew, 'package', 'index.js'), `module.exports = ${JSON.stringify(name + '@' + ver)};\n`);
        fs.writeFileSync(path.join(rootNew, 'package', 'pad.bin'), crypto.randomBytes(600 * 1024));
        const tgzNew = path.join(workNew, `${name}-${ver}.tgz`);
        await tar.packTarGz(tgzNew, [
          { name: 'package/package.json', source: path.join(rootNew, 'package', 'package.json') },
          { name: 'package/index.js', source: path.join(rootNew, 'package', 'index.js') },
          { name: 'package/pad.bin', source: path.join(rootNew, 'package', 'pad.bin') },
        ], {});
        const bufNew = fs.readFileSync(tgzNew);
        tarballBytesNew += bufNew.length;
        const fileNew = `${name}-${ver}.tgz`;
        versionsNew[ver] = {
          name, version: ver,
          dist: {
            tarball: `${name}/-/${fileNew}`,
            integrity: `sha512-${crypto.createHash('sha512').update(bufNew).digest('base64')}`,
            shasum: crypto.createHash('sha1').update(bufNew).digest('hex'),
          },
        };
        filesNew[ver] = fileNew;
        sizesNew[ver] = bufNew.length;
        entriesNew.push({ name: `storage/${name}/tarballs/${fileNew}`, source: tgzNew });
      }
      entriesNew.unshift({ name: `storage/${name}/packument.json`, data: Buffer.from(JSON.stringify({ name, 'dist-tags': { latest: VERS[VERS.length - 1] }, versions: versionsNew })) });
      entriesNew.unshift({ name: `storage/${name}/meta.json`, data: Buffer.from(JSON.stringify({ files: filesNew, sizes: sizesNew, deprecated: {} })) });
    }
    const bundlePathNew = path.join(workNew, `new-bundle-${util.stamp()}.tgz`);
    await tar.packTarGz(bundlePathNew, [
      {
        name: 'manifest.json',
        data: Buffer.from(JSON.stringify({
          format: bundleModNew.FORMAT, formatVersion: bundleModNew.FORMAT_VERSION,
          createdAt: new Date().toISOString(), tool: 'api-test', scope: 'selected',
          stats: { packages: 2, versions: VERS.length * 2, tarballs: VERS.length * 2, tarballBytes: tarballBytesNew, depsAdded: 0, depsMissing: [] },
        })),
      },
      ...entriesNew,
    ], {});
    const bundleBufNew = fs.readFileSync(bundlePathNew);
    check('合成离线包可用于分片上传（体积 > 3MB，能切成多片）', bundleBufNew.length > 3 * 1024 * 1024, `bytes=${bundleBufNew.length}`);

    // 2) 新配置项：默认值 / 合法范围 / 非法值
    const cfgNow = await api('/__admin/api/config');
    const stBeforeNew = (((cfgNow.json || {}).data || {}).config || {}).storage || {};
    const dfltNew = cfgModNew.defaults().storage;
    const inRangeNew = (v, lo, hi) => Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi;
    check('GET /config 暴露分片上传/解包并发新配置（均为 1~64，代码默认 8/4/8）',
      inRangeNew(stBeforeNew.bundleUploadChunkMB, 1, 64) && inRangeNew(stBeforeNew.bundleUploadConcurrency, 1, 64)
        && inRangeNew(stBeforeNew.bundleImportExtractConcurrency, 1, 64)
        && Number(dfltNew.bundleUploadChunkMB) === 8 && Number(dfltNew.bundleUploadConcurrency) === 4
        && Number(dfltNew.bundleImportExtractConcurrency) === 8,
      JSON.stringify(stBeforeNew));
    const badNew1 = await api('/__admin/api/config', { method: 'PUT', body: { storage: { bundleUploadChunkMB: 0 } } });
    const badNew2 = await api('/__admin/api/config', { method: 'PUT', body: { storage: { bundleUploadChunkMB: 65 } } });
    check('PUT /config storage.bundleUploadChunkMB=0 或 65 → 400', badNew1.status === 400 && badNew2.status === 400,
      `0→${badNew1.status} 65→${badNew2.status}`);
    const badNew3 = await api('/__admin/api/config', { method: 'PUT', body: { storage: { bundleUploadConcurrency: 65 } } });
    const badNew4 = await api('/__admin/api/config', { method: 'PUT', body: { storage: { bundleImportExtractConcurrency: 0 } } });
    check('PUT /config storage.bundleUploadConcurrency=65 / bundleImportExtractConcurrency=0 → 400',
      badNew3.status === 400 && badNew4.status === 400, `65→${badNew3.status} 0→${badNew4.status}`);

    try {
      const putNew = await api('/__admin/api/config', {
        method: 'PUT',
        body: { storage: { bundleUploadChunkMB: 1, bundleUploadConcurrency: 3, bundleImportExtractConcurrency: 4 } },
      });
      const stPutNew = ((((putNew.json || {}).data || {}).config || {}).storage) || {};
      check('PUT /config 把分片大小改成 1MB、分片并发 3、解包并发 4',
        putNew.status === 200 && Number(stPutNew.bundleUploadChunkMB) === 1
          && Number(stPutNew.bundleUploadConcurrency) === 3 && Number(stPutNew.bundleImportExtractConcurrency) === 4,
        `status=${putNew.status} storage=${JSON.stringify(stPutNew)}`);

      // 3) 分片上传接口：错误分支
      const e1 = await api('/__admin/api/bundles/upload/init', { method: 'POST', body: { file: 'not-a-bundle.zip', size: 1024 } });
      check('分片上传 init：非 .tgz 文件名 → 400', e1.status === 400 && /tgz/i.test(e1.text),
        `status=${e1.status} ${e1.text.slice(0, 120)}`);
      const maxMBNew = Number(stBeforeNew.maxBundleUploadMB) || 4096;
      const e2 = await api('/__admin/api/bundles/upload/init', { method: 'POST', body: { file: 'too-big.tgz', size: (maxMBNew + 16) * 1024 * 1024 } });
      let e2j = null; try { e2j = JSON.parse(e2.text); } catch { /* 非 JSON */ }
      check('分片上传 init：声明体积超 maxBundleUploadMB → 413 ETOOLARGE 且提示 data\\bundles 本地通路',
        e2.status === 413 && !!e2j && e2j.code === 'ETOOLARGE' && /data[\\/]bundles/.test(String(e2j.error || '')),
        `status=${e2.status} ${e2.text.slice(0, 140)}`);

      const initNew = await api('/__admin/api/bundles/upload/init', {
        method: 'POST', body: { file: `selftest-chunk-${util.stamp()}.tgz`, size: bundleBufNew.length, overwrite: true },
      });
      const initData = (initNew.json && initNew.json.data) || {};
      const chunkSizeNew = Number(initData.chunkSize) || 0;
      const chunkCountNew = Number(initData.chunkCount) || 0;
      check('分片上传 init 返回 uploadId / 分片大小 / 分片数 / 并发数',
        initNew.status === 200 && !!initData.uploadId && chunkSizeNew === 1024 * 1024
          && chunkCountNew === Math.ceil(bundleBufNew.length / chunkSizeNew) && Number(initData.concurrency) === 3,
        `status=${initNew.status} data=${JSON.stringify(initData)}`);
      check('分片上传 init：大包被切成多片（>=3 片）', chunkCountNew >= 3,
        `chunkCount=${chunkCountNew} size=${bundleBufNew.length}`);
      const uploadIdNew = initData.uploadId;
      const putChunkNew = (i, buf) => rawReq(
        `/__admin/api/bundles/upload/chunk?uploadId=${encodeURIComponent(uploadIdNew)}&index=${i}`,
        {
          method: 'POST', body: buf, timeoutMs: 120000,
          headers: { 'Content-Type': 'application/octet-stream', 'X-Mirror-Token': TOKEN, 'Content-Length': String(buf.length) },
        },
      );

      const wrongNew = await putChunkNew(0, Buffer.from('short'));
      let wrongJ = null; try { wrongJ = JSON.parse(wrongNew.text); } catch { /* 非 JSON */ }
      check('分片上传 chunk：分片大小不符 → 400 EBADCHUNK（不留半截分片）',
        wrongNew.status === 400 && !!wrongJ && wrongJ.code === 'EBADCHUNK', `status=${wrongNew.status} ${wrongNew.text.slice(0, 140)}`);

      const missNew = await api('/__admin/api/bundles/upload/complete', { method: 'POST', body: { uploadId: uploadIdNew } });
      let missJ = null; try { missJ = JSON.parse(missNew.text); } catch { /* 非 JSON */ }
      check('分片上传 complete：缺片 → 400 EINCOMPLETE 且指明第几片',
        missNew.status === 400 && !!missJ && missJ.code === 'EINCOMPLETE' && /第 \d+/.test(String(missJ.error || '')),
        `status=${missNew.status} ${missNew.text.slice(0, 140)}`);

      // 3 路并发上传全部分片（模拟网页多路并行上传）
      const tUpNew = Date.now();
      const statusesNew = new Array(chunkCountNew).fill(0);
      let nextChunkNew = 0;
      const laneNew = async () => {
        for (;;) {
          const i = nextChunkNew++;
          if (i >= chunkCountNew) return;
          const start = i * chunkSizeNew;
          const part = bundleBufNew.subarray(start, Math.min(bundleBufNew.length, start + chunkSizeNew));
          let r = null;
          // 每片最多重试 2 次，覆盖网络抖动/服务端临时失败（与前端行为一致）
          for (let attempt = 0; attempt < 3; attempt++) {
            r = await putChunkNew(i, part);
            if (r.status === 200) break;
          }
          statusesNew[i] = r.status;
        }
      };
      await Promise.all([laneNew(), laneNew(), laneNew()]);
      const uploadMsNew = Math.max(1, Date.now() - tUpNew);
      check('分片上传：3 路并发把所有分片都传成功', statusesNew.every((st) => st === 200), `statuses=${statusesNew.join(',')}`);
      check('分片上传：多路并发确有吞吐（> 1MB/s，回环应远高于此）',
        (bundleBufNew.length / 1024 / 1024) / (uploadMsNew / 1000) > 1,
        `${chunkCountNew} 片 / 3 路 / ${uploadMsNew}ms / ${(bundleBufNew.length / 1024 / 1024).toFixed(2)}MB`);

      const againNew = await putChunkNew(0, bundleBufNew.subarray(0, chunkSizeNew));
      let againJ = null; try { againJ = JSON.parse(againNew.text); } catch { /* 非 JSON */ }
      check('分片上传：重复上传同一分片幂等（retried=true）',
        againNew.status === 200 && !!againJ && againJ.ok && againJ.data && againJ.data.retried === true,
        `status=${againNew.status} ${againNew.text.slice(0, 140)}`);

      const compNew = await api('/__admin/api/bundles/upload/complete', {
        method: 'POST', body: { uploadId: uploadIdNew, overwrite: true }, timeoutMs: 180000,
      });
      const compData = (compNew.json && compNew.json.data) || {};
      check('分片上传 complete：合并分片后导入成功（2 包 / 8 版本 / 8 tarball）',
        compNew.status === 200 && Number(compData.packages) === 2 && Number(compData.versions) === VERS.length * 2
          && Number(compData.tarballs) === VERS.length * 2 && (compData.failed || []).length === 0,
        `status=${compNew.status} data=${JSON.stringify(compData).slice(0, 300)}`);
      const gotA = await api('/' + PKG_A, { base: REG_BASE });
      check('分片上传导入后的包能从镜像读到（含全部版本）',
        gotA.status === 200 && !!(gotA.json && gotA.json.versions && gotA.json.versions[VERS[0]]), `status=${gotA.status}`);

      // 4) abort：init 后取消，会话立即失效
      const initAbort = await api('/__admin/api/bundles/upload/init', { method: 'POST', body: { file: 'abort-test.tgz', size: 12 * 1024 * 1024 } });
      const abortId = ((initAbort.json || {}).data || {}).uploadId;
      const ab = await api('/__admin/api/bundles/upload/abort', { method: 'POST', body: { uploadId: abortId } });
      const abComp = await api('/__admin/api/bundles/upload/complete', { method: 'POST', body: { uploadId: abortId } });
      check('分片上传 abort：会话取消后 complete 报 404 ENOUP', ab.status === 200 && abComp.status === 404 && /ENOUP/.test(abComp.text),
        `abort=${ab.status} complete=${abComp.status} ${abComp.text.slice(0, 120)}`);

      // 上传结束后 data\tmp 不留分片目录/合并临时文件
      const tmpDirNew = path.join(util.dataRoot(), 'tmp');
      const leftNew = fs.existsSync(tmpDirNew) ? fs.readdirSync(tmpDirNew).filter((n) => /selftest-chunk|^upload-/.test(n)) : [];
      check('分片上传结束后 data\\tmp 无残留分片/合并文件', leftNew.length === 0, `left=${leftNew.join(',')}`);

      // 5) 直接调模块：版本级并行路数（需求 2）+ 多并发解包（需求 1b）
      const storeNew = new StoreNew({ dir: path.join(workNew, 'store'), logger: quietLogNew });
      await storeNew.init();
      const evNew = [];
      const rNew = await bundleModNew.importBundle({
        store: storeNew, file: bundlePathNew, overwrite: true, concurrency: 6, extractConcurrency: 4,
        logger: quietLogNew, onProgress: (e) => evNew.push(e),
      });
      await storeNew.close();
      check('importBundle 直接调用：结果计数正确（2 包 / 8 版本 / 8 tarball）',
        Number(rNew.packages) === 2 && Number(rNew.versions) === VERS.length * 2
          && Number(rNew.tarballs) === VERS.length * 2 && (rNew.failed || []).length === 0,
        `packages=${rNew.packages} versions=${rNew.versions} tarballs=${rNew.tarballs}`);
      let maxLanesNew = 0;
      for (const e of evNew) {
        for (const it of (e.inFlight || [])) maxLanesNew = Math.max(maxLanesNew, Number(it.lanes) || 0);
      }
      check('版本级并行：剩余包数少于并发时，同一个包也被多路并行导入（inFlight lanes > 1）',
        maxLanesNew >= 2, `maxLanes=${maxLanesNew} 并发=6 包数=2`);
      check('inFlight 每项都带 lanes 字段（进度弹窗右栏「N 路」的数据源）',
        evNew.length > 0 && evNew.every((e) => (e.inFlight || []).every((it) => Number.isFinite(Number(it.lanes)) && Number(it.lanes) >= 0)),
        JSON.stringify((evNew.find((e) => (e.inFlight || []).length > 0) || {}).inFlight || []));

      // 5.1) 解包后「扫描包元数据」也要有进度事件：本机解出上千个包时，界面不能看着像卡住
      const scanEvNew = evNew.filter((e) => e.phase === 'scan');
      const scanDoneNew = evNew.filter((e) => e.phase === 'scan-done');
      check('导入扫描阶段逐目录上报进度（phase=scan，scanned 递增、total=包目录数、current=当前包）',
        scanEvNew.length >= 1 && scanEvNew.every((e) => Number(e.total) === 2 && Number.isFinite(Number(e.scanned)))
          && scanEvNew.some((e) => Number(e.scanned) >= 1 && String(e.current || '').length > 0)
          && Number(scanEvNew[scanEvNew.length - 1].scanned) === 2,
        `scanEvents=${scanEvNew.length} last=${JSON.stringify(scanEvNew[scanEvNew.length - 1] || null)}`);
      check('导入扫描阶段结束有 phase=scan-done（前端据此从「统计」切到「导入」）',
        scanDoneNew.length === 1 && Number(scanDoneNew[0].total) === 2 && Number(scanDoneNew[0].scanned) === 2,
        JSON.stringify(scanDoneNew[0] || null));

      // 6) 解包并发：同一批文件分别用并发 1 / 8 解，结果必须完全一致
      const filesBench = Array.from({ length: 600 }, (_, i) => ({ name: `d${i % 20}/f${i}.txt`, data: Buffer.alloc(4096, i % 251) }));
      const benchTar = path.join(workNew, 'bench.tar.gz');
      await tar.packTarGz(benchTar, filesBench, {});
      const t1New = Date.now();
      const ex1 = await tar.extractTarGz(benchTar, path.join(workNew, 'ex1'), { concurrency: 1 });
      const ms1 = Date.now() - t1New;
      const t8New = Date.now();
      const ex8 = await tar.extractTarGz(benchTar, path.join(workNew, 'ex8'), { concurrency: 8 });
      const ms8 = Date.now() - t8New;
      const f1New = fs.readFileSync(path.join(workNew, 'ex1', 'd3', 'f3.txt'));
      const f8New = fs.readFileSync(path.join(workNew, 'ex8', 'd3', 'f3.txt'));
      check('多并发解包：并发 1 与并发 8 都解出 600 个文件且总字节一致',
        ex1.entries === 600 && ex8.entries === 600 && ex8.bytes === ex1.bytes,
        `并发1=${ms1}ms 并发8=${ms8}ms entries=${ex1.entries}/${ex8.entries}`);
      check('多并发解包：并发写出的文件内容正确（与并发 1 逐字节一致）',
        f1New.length === 4096 && f8New.length === 4096 && f1New.equals(f8New), `ms1=${ms1} ms8=${ms8}`);
    } finally {
      // 恢复进入本小节前的配置，并删掉导入的测试包
      await api('/__admin/api/config', {
        method: 'PUT',
        body: {
          storage: {
            bundleUploadChunkMB: Number(stBeforeNew.bundleUploadChunkMB) || 8,
            bundleUploadConcurrency: Number(stBeforeNew.bundleUploadConcurrency) || 4,
            bundleImportExtractConcurrency: Number(stBeforeNew.bundleImportExtractConcurrency) || 8,
          },
        },
      });
      for (const n of [PKG_A, PKG_B]) await api(`/__admin/api/packages/${encodeURIComponent(n)}`, { method: 'DELETE' });
      try { fs.rmSync(workNew, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  // ---------------------------------------------------------------- 过期上传目录清理
  section('六之六之二、进程重启后遗留的分片上传目录会被清理（审计修复）');
  {
    const tmpRoot = path.join(util.dataRoot(), 'tmp');
    const staleDir = path.join(tmpRoot, 'upload-stale-' + Date.now());
    let made = false;
    try {
      fs.mkdirSync(staleDir, { recursive: true });
      made = true;
      // 模拟「上一个进程留下的 5 小时前目录」（TTL 2 小时，超过 2×TTL 就会被清理）
      const old = new Date(Date.now() - 5 * 60 * 60 * 1000);
      fs.utimesSync(staleDir, old, old);
    } catch { /* 忽略 */ }
    const initRes = await api('/__admin/api/bundles/upload/init', { method: 'POST', body: { file: 'stale-check.tgz', size: 1024 } });
    const initStale = initRes.json && initRes.json.ok ? initRes.json.data : null;
    check('分片上传：init 时清理进程重启遗留的过期上传目录', !!made && !!initStale && !fs.existsSync(staleDir), { made: made, init: initStale, exists: fs.existsSync(staleDir) });
    check('分片上传：清理后仍能正常创建新上传会话', !!initStale && !!initStale.uploadId && initStale.chunkCount === 1, initStale || initRes.text);
    if (initStale && initStale.uploadId) await api('/__admin/api/bundles/upload/abort', { method: 'POST', body: { uploadId: initStale.uploadId } });
    if (made && fs.existsSync(staleDir)) { try { fs.rmSync(staleDir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  }

  // ---------------------------------------------------------------- 版本删除
  section('七、单版本删除与取消发布');
  {
    const r = await api(`/__admin/api/packages/mirror-selftest-upload/3.1.4`, { method: 'DELETE' });
    const g = await api('/mirror-selftest-upload');
    const has = g.json && g.json.versions && g.json.versions['3.1.4'];
    check('DELETE /packages/<名>/<版本> 删除单版本', r.status === 200 && !has, `status=${r.status}`);
  }
  {
    const g = await api(`/${PRIVATE}`, { base: REG_BASE });
    const rev = (g.json && g.json._rev) || '1-0';
    const r = await api(`/${PRIVATE}/1.0.0/-rev/${rev}`, { method: 'DELETE', base: REG_BASE });
    const after = await api(`/${PRIVATE}`, { base: REG_BASE });
    const has = after.json && after.json.versions && after.json.versions['1.0.0'];
    check('DELETE /<包名>/<版本>/-rev/<rev> 取消发布单版本', (r.status === 200 || r.status === 201) && !has, `status=${r.status} rev=${rev}`);
  }

  // 八之二：npm 缓存导入要保留「只有元数据、没有缓存 tarball」的版本号。
  // 旧实现只存带 tarball 的版本，导入后 packument 残缺（例如 make-dir 只剩 4.0.0），
  // 依赖解析就会报「没有满足 ^2.1.0 的版本」。这里造一个合成 npm 缓存目录直接测 importFromCache。
  {
    const npmcacheMod = require('../src/npmcache');
    const crypto = require('node:crypto');
    const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-cache-fixture-'));
    const statePath = npmcacheMod.stateFile ? npmcacheMod.stateFile() : null;
    const stateBackup = statePath && fs.existsSync(statePath) ? fs.readFileSync(statePath) : null;
    const pkgName = 'mirror-cache-meta-' + util.stamp().replace(/[^a-zA-Z0-9]/g, '');
    try {
      const contentDir = path.join(cacheRoot, '_cacache', 'content-v2', 'sha512');
      fs.mkdirSync(contentDir, { recursive: true });
      // 按 cacache 的内容寻址规则（sha512 hex：前 2 / 3-4 / 其余）写 blob，返回 sha512-<base64> integrity
      const putContent = (buf) => {
        const hex = crypto.createHash('sha512').update(buf).digest('hex');
        const full = path.join(contentDir, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, buf);
        return 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');
      };
      const packument = {
        name: pkgName,
        'dist-tags': { latest: '2.1.0' },
        versions: {
          '1.0.0': { name: pkgName, version: '1.0.0', dependencies: {} },
          '2.1.0': { name: pkgName, version: '2.1.0', dependencies: {} },
        },
      };
      const tarballBuf = Buffer.from('fake tgz for ' + pkgName + '@1.0.0');
      const tarInteg = putContent(tarballBuf);
      packument.versions['1.0.0'].dist = {
        integrity: tarInteg,
        shasum: crypto.createHash('sha1').update(tarballBuf).digest('hex'),
      };
      const docInteg = putContent(Buffer.from(JSON.stringify(packument)));
      const indexDir = path.join(cacheRoot, '_cacache', 'index-v5', 'aa');
      fs.mkdirSync(indexDir, { recursive: true });
      const indexKey = 'make-fetch-happen:request-cache:https://registry.npmjs.org/' + pkgName;
      fs.writeFileSync(path.join(indexDir, 'bb'), `${crypto.createHash('sha1').update(indexKey).digest('hex')}\t${JSON.stringify({ key: indexKey, integrity: docInteg, time: Date.now(), size: 1 })}\n`);
      const fakeStore = {
        saved: null,
        async getAsync() { return null; },
        hasTarball() { return false; },
        async withLock(n, fn) { return fn(); },
        async putTarballFromFileAsync(name, version, src) {
          const b = fs.readFileSync(src);
          return { file: `${name}-${version}.tgz`, sizeBytes: b.length };
        },
        save(name, packument2, meta) {
          this.saved = { name, packument: JSON.parse(JSON.stringify(packument2)), meta: JSON.parse(JSON.stringify(meta)) };
        },
      };
      const imp = await npmcacheMod.importFromCache({
        store: fakeStore,
        cacheDir: cacheRoot,
        names: [pkgName],
        logger: quietLog,
        concurrency: 2,
      });
      const saved = fakeStore.saved && fakeStore.saved.packument;
      const savedMeta = fakeStore.saved && fakeStore.saved.meta;
      check('npm 缓存导入保留「仅有元数据、没有缓存 tarball」的版本（1.0.0 有 tarball + 2.1.0 仅元数据）',
        imp.imported.length === 1 && !!saved && !!saved.versions['1.0.0'] && !!saved.versions['2.1.0']
          && Object.keys(saved.versions).length === 2 && imp.imported[0].metadataVersions === 1,
        `imported=${JSON.stringify(imp.imported)} versions=${saved ? Object.keys(saved.versions).join(',') : 'null'}`);
      check('npm 缓存导入后的 packument 标记「元数据已完整」，dist-tags 不再悬空',
        !!saved && savedMeta.source === 'cache' && savedMeta.metadataComplete === true
          && saved['dist-tags'].latest === '2.1.0'
          && Object.keys(savedMeta.files || {}).join(',') === '1.0.0',
        `meta=${JSON.stringify(savedMeta && { source: savedMeta.source, complete: savedMeta.metadataComplete, files: savedMeta.files })}`);
    } finally {
      // 扫描状态文件是真实的 data/npmcache-scan.json：测试前后还原，避免影响用户页面的扫描结果
      try {
        if (statePath && stateBackup) fs.writeFileSync(statePath, stateBackup);
        else if (statePath && fs.existsSync(statePath)) fs.unlinkSync(statePath);
      } catch { /* 忽略 */ }
      try { fs.rmSync(cacheRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  // ---------------------------------------------------------------- 鉴权与重启
  section('九、鉴权与服务控制');
  {
    const r = await api('/__admin/api/overview', { auth: false, headers: { 'X-Mirror-Token': 'wrong-token' } });
    check('错误令牌在信任回环时仍放行（信任本机）', r.status === 200, `status=${r.status}`);
  }
  {
    if (!DESTRUCTIVE) {
      // 重启会短暂打断正在用镜像的用户，默认不自作主张：显式 SKIP，加 --destructive 才执行
      skip('POST /service/restart（重启镜像源服务）并验证自动恢复', '破坏性用例未执行：加 --destructive 开启');
      skip('POST /service/restart-admin（重启管理界面）并验证恢复', '破坏性用例未执行：加 --destructive 开启');
    } else {
      // 「重启镜像源服务」= 只重建镜像源监听：管理界面全程可用，registry 短暂不可用后恢复
      const before = ((await api('/__admin/api/session')).json || {}).data || {};
      const r = await api('/__admin/api/service/restart', { method: 'POST' });
      check('POST /service/restart 返回重启中（target=registry）',
        r.status === 200 && r.json && r.json.data && r.json.data.restarting === true && r.json.data.target === 'registry',
        `status=${r.status} ${r.text.slice(0, 120)}`);
      let adminOkAll = true;
      let back = false;
      let after = null;
      for (let i = 0; i < 60; i++) {
        await util.sleep(300);
        try {
          const s = await api('/__admin/api/session');
          if (s.status !== 200) { adminOkAll = false; continue; }
          const d = (s.json || {}).data || {};
          if (d.registry && d.registry.reachable === true) { after = d; back = true; break; }
        } catch { adminOkAll = false; }
      }
      check('重启镜像源服务后 registry 自动恢复，且管理界面全程可用（页面不需要刷新）',
        back && adminOkAll, back ? (adminOkAll ? '' : '管理界面在镜像源重启期间出现过不可用') : '18 秒内未恢复');
      if (after) {
        check('重启镜像源服务不会重建管理界面（管理界面实例标记不变）',
          String(after.pid) === String(before.pid) &&
          String(((after.admin || {}).startedAt) || '') === String(((before.admin || {}).startedAt) || ''),
          `pid=${before.pid}→${after.pid} admin=${(before.admin || {}).startedAt}→${(after.admin || {}).startedAt}`);
      }
      const ping = await fetch(REG_BASE + '/-/ping', { signal: AbortSignal.timeout(5000) });
      check('重启镜像源服务后镜像源 /-/ping 直接可用', ping.status === 200, `status=${ping.status}`);

      // 「重启管理界面」= 只重建管理界面监听：registry 不受影响，管理界面实例标记变化
      const beforeAdmin = ((await api('/__admin/api/session')).json || {}).data || {};
      const ra = await api('/__admin/api/service/restart-admin', { method: 'POST' });
      check('POST /service/restart-admin 返回重启中（target=admin）',
        ra.status === 200 && ra.json && ra.json.data && ra.json.data.restarting === true && ra.json.data.target === 'admin',
        `status=${ra.status} ${ra.text.slice(0, 120)}`);
      let adminBack = false;
      let adminAfter = null;
      for (let i = 0; i < 60; i++) {
        await util.sleep(300);
        try {
          const s = await api('/__admin/api/session');
          if (s.status === 200) { adminAfter = (s.json || {}).data || {}; adminBack = true; break; }
        } catch { /* 管理界面重启中 */ }
      }
      check('重启管理界面后管理接口自动恢复（前端据此断连恢复后刷新界面）', adminBack, adminBack ? '' : '18 秒内未恢复');
      if (adminAfter) {
        check('管理界面实例标记已变化（pid@admin.startedAt，前端刷新判据）',
          String(((adminAfter.admin || {}).startedAt) || '') !== String(((beforeAdmin.admin || {}).startedAt) || ''),
          `${(beforeAdmin.admin || {}).startedAt} → ${(adminAfter.admin || {}).startedAt}`);
        check('重启管理界面不影响镜像源服务（registry 仍可达，进程不变）',
          !!adminAfter.registry && adminAfter.registry.reachable === true && String(adminAfter.pid) === String(beforeAdmin.pid),
          `registry=${JSON.stringify(adminAfter.registry)} pid=${beforeAdmin.pid}→${adminAfter.pid}`);
      }
      const ping2 = await fetch(REG_BASE + '/-/ping', { signal: AbortSignal.timeout(5000) });
      check('重启管理界面后镜像源 /-/ping 仍可用', ping2.status === 200, `status=${ping2.status}`);
    }
  }
  {
    if (!DESTRUCTIVE) {
      // 日志是用户排查现场的证据，默认不删；显式 SKIP，加 --destructive 才执行
      skip('DELETE /logs 清空日志', '破坏性用例未执行：加 --destructive 开启');
    } else {
      // 日志清空后无法从服务找回：先把当前日志整体备份到临时目录，并在输出里打印路径备查
      let backupPath = '';
      try {
        const cur = await api('/__admin/api/logs?lines=2000');
        // 放在 tmpDir 之外：收尾会删掉 tmpDir，备份若在里面就白备了
        backupPath = path.join(os.tmpdir(), `mirror-logs-backup-${util.stamp()}.json`);
        fs.writeFileSync(backupPath, cur.text || JSON.stringify(cur.json || {}), 'utf8');
        console.log(`  日志已备份到：${backupPath}（DELETE /logs 无法自动回写，需要时请手工恢复）`);
      } catch { console.log('  ⚠ 日志备份失败，继续执行清空（原日志将无法找回）'); }
      const r = await api('/__admin/api/logs', { method: 'DELETE' });
      check('DELETE /logs 清空日志', r.status === 200, `status=${r.status}${backupPath ? ' 备份=' + backupPath : ''}`);
    }
  }

  // ---------------------------------------------------------------- 安全回归
  section('十、安全回归（路径穿越 / 来源校验 / 配置校验 / 版本范围）');
  {
    // tarball 路由不能借路径穿越读到 data/config.json（里面有 security.token）
    const traversal = [
      '/ms/-/..%5C..%5C..%5Cdata%5Cconfig.json',
      '/ms/-/..%2F..%2F..%2Fdata%2Fconfig.json',
    ];
    for (const p of traversal) {
      const r = await rawReq(p, { base: REG_BASE });
      check(`GET ${p} 返回 400/404 且不泄露配置`,
        (r.status === 400 || r.status === 404) && !r.text.includes(TOKEN) && !r.text.includes('"security"'),
        `status=${r.status} body=${String(r.text).slice(0, 120)}`);
    }
  }
  {
    // 管理接口的包名参数同样要校验：非法名不能 500，更不能被当成路径操作
    const bad = '/__admin/api/packages/..%5C..%5Csrc';
    const auth = { 'X-Mirror-Token': TOKEN };
    const g = await rawReq(bad, { headers: auth });
    check('GET 管理 API 非法包名（..\\..\\src）返回 400', g.status === 400, `status=${g.status} ${String(g.text).slice(0, 120)}`);
    const d = await rawReq(bad, { method: 'DELETE', headers: auth });
    check('DELETE 管理 API 非法包名（..\\..\\src）返回 400', d.status === 400, `status=${d.status} ${String(d.text).slice(0, 120)}`);
  }
  {
    // 带 Origin: null 的写请求（跨站页面/沙箱 iframe 的典型特征）必须被拒绝；
    // 本机命令行/npm 客户端不带 Origin，不受影响（登录用例见第一节）。
    const authJson = { 'X-Mirror-Token': TOKEN, 'Content-Type': 'application/json', Origin: 'null' };
    const o1 = await rawReq('/__admin/api/packages', { method: 'POST', headers: authJson, body: JSON.stringify({ names: [] }) });
    check('POST /__admin/api/packages 带 Origin: null 被拒绝（403）', o1.status === 403, `status=${o1.status} ${String(o1.text).slice(0, 120)}`);
    const o2 = await rawReq('/__admin/api/config', { method: 'PUT', headers: authJson, body: '{}' });
    check('PUT /__admin/api/config 带 Origin: null 被拒绝（403）', o2.status === 403, `status=${o2.status} ${String(o2.text).slice(0, 120)}`);
  }
  {
    // 坏配置必须整体拒绝：不能把 security 写成 null 导致令牌/鉴权被破坏。
    // 放在本节最后：万一后端还没修，先把原配置写回，避免一条负向用例把正在跑的服务带崩。
    const origCfg = (((await api('/__admin/api/config?reveal=1')).json || {}).data || {}).config;
    const badCfg = await api('/__admin/api/config', { method: 'PUT', body: { config: { security: null } } });
    if (badCfg.status !== 400 && origCfg) {
      try { await api('/__admin/api/config', { method: 'PUT', body: { config: origCfg } }); } catch { /* 尽力而为 */ }
    }
    check('PUT /__admin/api/config {security:null} 返回 400（不允许清空安全配置）',
      badCfg.status === 400, `status=${badCfg.status} ${badCfg.text.slice(0, 140)}`);
    const sess = await api('/__admin/api/session', { auth: false });
    const reveal = await api('/__admin/api/config?reveal=1');
    const security = (((reveal.json || {}).data || {}).config || {}).security;
    check('非法配置被拒后服务仍可用、令牌未被破坏',
      sess.status === 200 && reveal.status === 200 && !!security && security.token === TOKEN,
      `session=${sess.status} reveal=${reveal.status} hasSecurity=${!!security}`);
  }
  {
    // 版本范围（纯函数回归）：~1 / 带预发布的 ^范围 / 预发布号按数值比较
    check('satisfies: ~1 匹配 1.5.0、不匹配 2.0.0',
      util.satisfies('1.5.0', '~1') === true && util.satisfies('2.0.0', '~1') === false,
      `1.5.0=${util.satisfies('1.5.0', '~1')} 2.0.0=${util.satisfies('2.0.0', '~1')}`);
    check('satisfies: ^1.0.0-beta.1 匹配 1.0.0-beta.2 与 1.1.0',
      util.satisfies('1.0.0-beta.2', '^1.0.0-beta.1') === true && util.satisfies('1.1.0', '^1.0.0-beta.1') === true,
      `beta.2=${util.satisfies('1.0.0-beta.2', '^1.0.0-beta.1')} 1.1.0=${util.satisfies('1.1.0', '^1.0.0-beta.1')}`);
    check('compareVersions: 1.0.0-beta.10 > 1.0.0-beta.9',
      util.compareVersions('1.0.0-beta.10', '1.0.0-beta.9') > 0,
      `result=${util.compareVersions('1.0.0-beta.10', '1.0.0-beta.9')}`);
  }

  // ---------------------------------------------------------------- 收尾清理
  section('十一、收尾：清除本次自检产生的数据');
  {
    // mirror-selftest-* 是本脚本自建包，收尾删掉，避免长期占用存储空间
    for (const n of [PRIVATE, PRIVATE2, 'mirror-selftest-upload', 'mirror-selftest-json', 'mirror-selftest-autodeps-fail', 'mirror-selftest-autodeps-ok']) {
      try { await api(`/__admin/api/packages/${encodeURIComponent(n)}`, { method: 'DELETE' }); } catch { /* 忽略 */ }
    }
    const gone = await api(`/__admin/api/packages/${encodeURIComponent(PRIVATE)}`);
    check('收尾：自检包 mirror-selftest-* 已清除', gone.status === 404, `status=${gone.status}`);
    if (!msExistedBefore) {
      await api('/__admin/api/packages/ms', { method: 'DELETE' });
      const msGone = await api('/__admin/api/packages/ms');
      check('收尾：删除测试新建的 ms（原本不存在，恢复原状）', msGone.status === 404, `status=${msGone.status}`);
    } else {
      skip('收尾：ms 原本就存在，保留用户数据（测试只做增量补齐，不删除整包）');
    }
  }

  // ---------------------------------------------------------------- 汇总
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`\n\x1b[1m结果：${results.length - failures - skips}/${results.length} 通过，跳过 ${skips} 项，耗时 ${dt}s\x1b[0m\n`);
  if (failures) {
    process.stdout.write('\n失败项：\n');
    for (const r of results.filter((x) => !x.ok)) process.stdout.write(`  ✗ ${r.name}  ${r.detail}\n`);
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  finish(failures ? 1 : 0);
})().catch((e) => {
  process.stdout.write(`\n\x1b[31m自检异常中断：${e && (e.stack || e.message)}\x1b[0m\n`);
  finish(1);
});

/*
 * 退出方式说明：Node 24（Windows）下，fetch（undici）的 keep-alive 句柄正在关闭时直接调用
 * process.exit() 会触发 libuv 断言：
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
 * 退出码会变成 0xC0000409（-1073740791），让本来通过的验收看起来像崩溃。
 * 这里改为「先设退出码 → 等句柄关闭 → 再退出」。
 */
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 400);
}

