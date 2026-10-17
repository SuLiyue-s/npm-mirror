#!/usr/bin/env node
'use strict';
/*
 * 端到端自检：注册表协议 + 可视化管理 API + 私有包发布/删除 + 离线包导出导入
 * 用法：先启动镜像源，再执行  node test/api-test.js [--base http://127.0.0.1:4873]
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
const BASE = (() => {
  const i = process.argv.indexOf('--base');
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1].replace(/\/+$/, '');
  return `http://127.0.0.1:${cfg.server.port}`;
})();
// 端口/主机统一从 BASE 推导：支持 --base 指向别的端口（npmrc、裸 http 用例都跟着走），
// 不再用本地 config 里的端口，避免「--base 指 5000、断言却打 4873」的错位。
const BASE_URL = new URL(BASE);
const BASE_HOST = BASE_URL.hostname.replace(/^\[|\]$/g, ''); // http.request 的 host 不能带 IPv6 方括号
const BASE_PORT = Number(BASE_URL.port || 80);

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
function rawReq(pathname, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  const httpMod = require('node:http');
  return new Promise((resolve) => {
    // agent: false = 每次开新连接。node:http 的全局 agent 默认 keep-alive，
    // 而本文件有用例故意「声明了很大的 Content-Length 却不发完」（验证服务端提前 413 并断连），
    // 那条连接会被服务端 close，若下一个请求恰好复用到它就会一直等不到响应（假超时）。
    const req = httpMod.request({ host: BASE_HOST, port: BASE_PORT, path: pathname, method, headers, agent: false }, (res) => {
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

  process.stdout.write(`\x1b[1m私人 npm 镜像源自检\x1b[0m  目标：${BASE}\n`);

  // 清理上一轮遗留的「自检专用」数据（mirror-selftest-* 只可能由本脚本创建，删掉是安全的）。
  // 注意：不在开头删 ms / lodash 等真实公共包——它们是用户镜像里的真实数据，
  // 旧版本这里会误删用户缓存的 tarball。需要临时造前置条件的用例改为「先快照、收尾恢复」。
  for (const n of [PRIVATE, PRIVATE2, 'mirror-selftest-upload', 'mirror-selftest-json']) {
    try { await api(`/__admin/api/packages/${encodeURIComponent(n)}`, { method: 'DELETE' }); } catch { /* 忽略 */ }
  }
  // ms 是本脚本要用到的真实公共包：记录测试前是否已存在，收尾时只在「原本不存在」时才删掉自己加的。
  const msExistedBefore = (await api('/__admin/api/packages/ms')).status === 200;

  // ---------------------------------------------------------------- 基础协议
  section('一、基础协议');
  {
    const r = await api('/-/ping');
    check('GET /-/ping 返回 {}', r.status === 200 && r.json && Object.keys(r.json).length === 0, `status=${r.status}`);
  }
  {
    const r = await api('/-/whoami');
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
    const r = await api('/-/user/org.couchdb.user:admin', { method: 'PUT', body: { name: 'admin', password: 'x' } });
    check('PUT /-/user/... 登录返回令牌', r.status === 201 && r.json && r.json.token === TOKEN, `status=${r.status}`);
  }
  {
    const r = await api('/-/v1/login');
    check('GET /-/v1/login 明确不支持网页登录', r.status === 404 && r.json && r.json.code === 'ENOWEBLOGIN', `status=${r.status}`);
  }
  {
    const r = await api('/-/npm/v1/security/audits/quick', { method: 'POST', body: {} });
    check('POST audits/quick 返回空报告', r.status === 200, `status=${r.status}`);
  }
  {
    const r = await api('/-/npm/v1/security/advisories/bulk', { method: 'POST', body: {} });
    check('POST advisories/bulk 返回 200', r.status === 200, `status=${r.status}`);
  }
  {
    const r = await api('/mirror-selftest-nonexistent-zzz');
    check('GET 不存在的包返回 404', r.status === 404, `status=${r.status}`);
  }
  {
    const r = await api('/%E4%B8%8D%E5%90%88%E6%B3%95%E7%9A%84%E5%8C%85%E5%90%8D');
    check('GET 非法包名返回 400', r.status === 400, `status=${r.status}`);
  }

  // ---------------------------------------------------------------- 管理 API
  section('二、可视化管理 API');
  {
    const r = await api('/__admin/api/session', { auth: false });
    check('GET /session 免鉴权且返回监听信息', r.status === 200 && r.json && r.json.data && !!r.json.data.registryUrl, `status=${r.status}`);
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
    const r = await api('/__admin/api/npmrc', { method: 'POST', body: { ip: BASE_HOST, port: BASE_PORT, token: true } });
    const d = r.json && r.json.data;
    check('POST /npmrc 生成 .npmrc（token:true 用服务端令牌）', r.status === 200 && d && d.npmrc.includes(`_authToken=${TOKEN}`) && d.npmrc.includes(`registry=http://${BASE_HOST}:${BASE_PORT}/`) && !d.npmrc.includes('_authToken=true'), d && d.registry);
  }
  {
    const r = await api('/__admin/api/logs?lines=10');
    check('GET /logs 返回日志', r.status === 200 && r.json && Array.isArray(r.json.data.lines), `status=${r.status}`);
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
    const r = await api('/ms', { headers: { Accept: 'application/vnd.npm.install-v1+json' } });
    const d = r.json;
    check('GET /ms 返回 packument（含 2.1.3）', r.status === 200 && d && d.versions && d.versions['2.1.3'], `status=${r.status}`);
    if (d && d.versions && d.versions['2.1.3']) {
      check('packument 的 tarball 地址指向本镜像', String(d.versions['2.1.3'].dist.tarball).startsWith(BASE), d.versions['2.1.3'].dist.tarball);
    }
  }
  {
    const r = await api('/ms/2.1.3');
    check('GET /ms/2.1.3 返回单版本元数据', r.status === 200 && r.json && r.json.version === '2.1.3', `status=${r.status}`);
  }
  {
    const r = await fetch(`${BASE}/ms/-/ms-2.1.3.tgz`, { signal: AbortSignal.timeout(60000) });
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
          dist: { shasum: util.sha1hex(pub.buffer), integrity: util.integrityOf(pub.buffer), tarball: `${BASE}/${PRIVATE}/-/${PRIVATE}-1.0.0.tgz` },
        },
      },
      _attachments: { [`${PRIVATE}-1.0.0.tgz`]: { content_type: 'application/octet-stream', data: pub.buffer.toString('base64'), length: pub.buffer.length } },
    };
    const r = await api(`/${PRIVATE}`, { method: 'PUT', body, timeoutMs: 60000 });
    check('PUT /<包名> 发布私有包', r.status === 201 || r.status === 200, `status=${r.status} ${r.text.slice(0, 120)}`);
  }
  {
    const r = await api(`/${PRIVATE}`);
    const d = r.json;
    const v = d && d.versions && d.versions['1.0.0'];
    check('发布后 GET 可读到版本', r.status === 200 && !!v, `status=${r.status}`);
    if (v) check('私有包 tarball 地址被改写为本镜像', String(v.dist.tarball).startsWith(BASE), v.dist.tarball);
  }
  {
    const r = await fetch(`${BASE}/${PRIVATE}/-/${PRIVATE}-1.0.0.tgz`, { signal: AbortSignal.timeout(30000) });
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
    const r = await api(`/${PRIVATE}`, { method: 'PUT', body });
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
    const r = await api(`/${encodeURIComponent(PRIVATE2)}`, { method: 'PUT', body });
    check('发布作用域包 @scope/name', r.status === 201 || r.status === 200, `status=${r.status} ${r.text.slice(0, 120)}`);
    const g = await api(`/${encodeURIComponent(PRIVATE2)}`);
    check('作用域包可通过编码路径读取', g.status === 200 && g.json && g.json.versions && g.json.versions['2.0.0'], `status=${g.status}`);
    const g2 = await api(`/${PRIVATE2}`);
    check('作用域包也可通过裸路径读取', g2.status === 200, `status=${g2.status}`);
  }
  {
    const r = await api(`/${PRIVATE}`, { method: 'PUT', body: { name: PRIVATE, versions: { '1.0.0': { deprecated: '测试弃用标记' } } } });
    const g = await api(`/${PRIVATE}`);
    const v = g.json && g.json.versions && g.json.versions['1.0.0'];
    check('PUT 元数据可设置 deprecated', (r.status === 200 || r.status === 201) && v && v.deprecated === '测试弃用标记', `status=${r.status} deprecated=${v && v.deprecated}`);
  }
  {
    const r = await api(`/${PRIVATE}/beta`, { method: 'PUT', body: '1.0.0', headers: { 'Content-Type': 'application/json' } });
    const g = await api(`/${PRIVATE}`);
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
    const g = await api('/mirror-selftest-json');
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
    // 详情接口要能给出「源服务器体积」，未缓存的版本也要有
    const r = await api('/__admin/api/packages/' + encodeURIComponent('ms'));
    const d = r.json && r.json.data;
    const vs = (d && d.versions) || [];
    check('详情每个版本都带 sourceSizeBytes（源服务器 tarball 体积）',
      vs.length > 0 && vs.every(v => Number.isFinite(v.sourceSizeBytes)),
      `versions=${vs.length} 首个=${JSON.stringify(vs[0] && { version: vs[0].version, src: vs[0].sourceSizeBytes })}`);
    check('源体积来自上游元数据（至少一个 > 0，未缓存版本也有）',
      vs.some(v => v.sourceSizeBytes > 0 && !v.cached),
      `未缓存且带源体积的版本数=${vs.filter(v => v.sourceSizeBytes > 0 && !v.cached).length}`);
    check('详情带 unpackedSizeBytes / fileCount（可为 0）',
      vs.every(v => Number.isFinite(v.unpackedSizeBytes) && Number.isFinite(v.fileCount)),
      `首个=${JSON.stringify(vs[0] && { un: vs[0].unpackedSizeBytes, fc: vs[0].fileCount })}`);

    // selected 模式：只补点名的、且本地缺失的版本；已缓存的不计入 total
    const cachedOne = vs.find(v => v.cached && v.sourceSizeBytes > 0);
    const uncachedOne = vs.find(v => !v.cached && v.sourceSizeBytes > 0);
    if (cachedOne && uncachedOne) {
      const rr = await api('/__admin/api/packages/pull', {
        method: 'POST',
        body: { mode: 'selected', targets: [{ name: 'ms', version: cachedOne.version }, { name: 'ms', version: uncachedOne.version }] },
      });
      const dd = rr.json && rr.json.data;
      check('selected 模式只统计「未缓存」的点名版本（已缓存的不计入 total）',
        rr.status === 200 && dd && dd.mode === 'selected' && dd.total === 1,
        `status=${rr.status} mode=${dd && dd.mode} total=${dd && dd.total}（点了 1 个已缓存 ${cachedOne.version} + 1 个未缓存 ${uncachedOne.version}）`);
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
      const after = (await api('/__admin/api/packages/' + encodeURIComponent('ms'))).json.data;
      const rec = (after.versions || []).find(v => v.version === uncachedOne.version);
      check('补充后该版本变为已缓存，且本地体积与源体积一致',
        !!rec && rec.cached === true && rec.sizeBytes === rec.sourceSizeBytes,
        `cached=${rec && rec.cached} 本地=${rec && rec.sizeBytes} 源=${rec && rec.sourceSizeBytes}`);
      const emp = await api('/__admin/api/packages/pull', { method: 'POST', body: { mode: 'selected', targets: [] } });
      check('selected 模式不给 targets 返回 400', emp.status === 400, `status=${emp.status} ${emp.text.slice(0, 120)}`);
    } else {
      // 不删除用户 ms 的已有缓存来硬造前置条件：环境不满足就显式跳过（SKIP 会单列，不算通过）
      skip('selected 模式（按版本补 tarball）', `ms 需要同时存在已缓存/未缓存版本，当前 cachedOne=${!!cachedOne} uncachedOne=${!!uncachedOne}`);
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

  // ---------------------------------------------------------------- 递归添加依赖
  section('五之七、递归添加依赖（依赖的依赖一起加）');
  {
    const deps = require('../src/deps');

    // ---- 纯离线单元断言（不联网）----
    const rangeCases = [['^1.0.0', true], ['*', true], [null, true], ['latest', true], ['~1.2.3', true],
      ['>=1.2.3 <2.0.0', true], ['file:../x', false], ['link:../x', false], ['workspace:*', false],
      ['git+https://x/y.git', false], ['github:user/repo', false],
      ['npm:alias@^1.0.0', true], ['npm:lodash', true], ['npm:', false],
      ['./local', false], ['user/repo', false]];
    const badRange = rangeCases.filter(([r, want]) => deps.isRegistryRange(r) !== want);
    check('isRegistryRange 正确区分「能联网下载」与 file/git 等非注册表依赖（npm: 别名算能下载）',
      badRange.length === 0, badRange.map(([r]) => JSON.stringify(r)).join(','));

    const fake = { versions: { '1.0.0': {}, '1.1.0': {}, '2.0.0-beta.1': {}, '2.0.0': {} }, 'dist-tags': { latest: '2.0.0' } };
    const pv = (r) => deps.pickVersion(fake, r);
    check('pickVersion：空范围跟随 latest、^ 取范围内最高正式版、精确版本原样、不误选预发布',
      pv('') === '2.0.0' && pv('*') === '2.0.0' && pv('^1.0.0') === '1.1.0'
      && pv('>=1.0.0') === '2.0.0' && pv('2.0.0-beta.1') === '2.0.0-beta.1',
      `空=${pv('')} ^1.0.0=${pv('^1.0.0')} >=1.0.0=${pv('>=1.0.0')} 精确=${pv('2.0.0-beta.1')}`);
    check('pickVersion：范围本身带预发布时能挑到预发布版本（^1.0.0-beta.1 → 1.0.0-beta.2）',
      deps.pickVersion({ versions: { '1.0.0-beta.1': {}, '1.0.0-beta.2': {} }, 'dist-tags': {} }, '^1.0.0-beta.1') === '1.0.0-beta.2',
      String(deps.pickVersion({ versions: { '1.0.0-beta.1': {}, '1.0.0-beta.2': {} }, 'dist-tags': {} }, '^1.0.0-beta.1')));

    // 回归：npm 上真实存在的「操作符与版本号之间带空格」的范围（safer-buffer@">= 2.1.2 < 3" 等）
    const util = require('../src/util');
    const spaced = [['2.1.2', '>= 2.1.2 < 3', true], ['2.1.3', '>= 2.1.2 < 3', true], ['3.0.0', '>= 2.1.2 < 3', false],
      ['1.5.1', '>= 1.5.0 < 2', true], ['1.43.0', '>= 1.43.0 < 2', true], ['3.1.1', '>= 3.1.0 < 4', true],
      ['1.2.3', '1.2.3 - 2.3.4', true], ['2.3.5', '1.2.3 - 2.3.4', false],
      ['2.5.0', '^1.0.0 || >= 2.0.0 < 3', true], ['3.0.0', '^1.0.0 || >= 2.0.0 < 3', false]];
    const badSpaced = spaced.filter(([v, r, want]) => util.satisfies(v, r) !== want);
    check('范围里「>= 2.1.2 < 3」这种带空格的写法能被正确匹配（曾经把结尾的 3 当成精确版本）',
      badSpaced.length === 0, badSpaced.map(([v, r]) => `${v} ~ ${JSON.stringify(r)}`).join('; '));
    check('真实依赖范围能选到版本（safer-buffer/statuses/mime-db/thenify 这类）',
      util.maxSatisfying(['2.1.0', '2.1.2', '2.1.3'], '>= 2.1.2 < 3') === '2.1.3'
      && util.maxSatisfying(['1.4.0', '1.5.0', '1.5.1'], '>= 1.5.0 < 2') === '1.5.1'
      && util.maxSatisfying(['1.43.0', '1.52.0', '2.0.0'], '>= 1.43.0 < 2') === '1.52.0'
      && util.maxSatisfying(['3.1.0', '3.1.1'], '>= 3.1.0 < 4') === '3.1.1',
      [util.maxSatisfying(['2.1.0', '2.1.2', '2.1.3'], '>= 2.1.2 < 3'),
        util.maxSatisfying(['1.4.0', '1.5.0', '1.5.1'], '>= 1.5.0 < 2'),
        util.maxSatisfying(['1.43.0', '1.52.0', '2.0.0'], '>= 1.43.0 < 2'),
        util.maxSatisfying(['3.1.0', '3.1.1'], '>= 3.1.0 < 4')].join(' / '));

    // 回归：npm: 别名依赖（element-plus@2.14.7 的 `@popperjs/core: npm:@sxzz/popperjs-es@^2.11.8`）
    // 以前一律被当成「非注册表依赖」丢进 unresolved，用户实测报的就是这条
    const aliasCases = [
      ['npm:@sxzz/popperjs-es@^2.11.8', { name: '@sxzz/popperjs-es', range: '^2.11.8' }],
      ['npm:lodash', { name: 'lodash', range: '' }],
      ['npm:@scope/name@latest', { name: '@scope/name', range: 'latest' }],
    ];
    const badAlias = aliasCases.filter(([r, want]) => {
      const got = deps.parseNpmAlias(r);
      return !got || got.name !== want.name || got.range !== want.range;
    });
    check('parseNpmAlias 能解析 npm: 别名的各种写法（作用域包 / 无范围 / dist-tag），非别名返回 null',
      badAlias.length === 0 && deps.parseNpmAlias('^1.0.0') === null && deps.parseNpmAlias('npm:') === null,
      badAlias.map(([r]) => r).join('; '));

    const rootAlias = deps.splitRootSpec('@popperjs/core@npm:@sxzz/popperjs-es@^2.11.8');
    check('别名也能当根 spec（npm i 的写法）：@popperjs/core@npm:@sxzz/popperjs-es@^2.11.8',
      !!rootAlias && rootAlias.name === '@popperjs/core' && rootAlias.range === 'npm:@sxzz/popperjs-es@^2.11.8',
      JSON.stringify(rootAlias));

    const reasonCases = ['file:../x', 'link:../y', 'workspace:*', 'git+https://github.com/a/b.git', 'https://x/y.tgz', 'a/b'];
    const badReason = reasonCases.filter(r => deps.isRegistryRange(r) || !/需要手工处理/.test(deps.nonRegistryReason(r)));
    check('确实没法联网下载的依赖（本地路径 / git / 远程 tarball / GitHub 简写）才进「需要手工处理」，且各自说明原因',
      badReason.length === 0, badReason.join('; '));

    // 记录测试前已有的包名：收尾时只删这次新加进来的
    // （/packages 每页最多 200 条，包里数超过一页时必须翻页，否则快照不全、会把已有包误删）
    const beforeNames = new Set();
    for (let page = 1; page <= 50; page++) {
      const r = await api('/__admin/api/packages?page=' + page + '&size=200');
      const items = (r.json && r.json.data && r.json.data.items) || [];
      items.forEach(p => beforeNames.add(p.name));
      if (items.length < 200) break;
    }

    // 本节要断言的「孙辈还不存在」「6 个 tarball 真的要下载」都依赖干净起点：
    // 先把这几个包清空，保证这节可重复运行。注意它们可能是别人依赖的公共包（chalk 等），
    // 所以先记下测试前各自缓存了哪些版本，收尾时原样补回来——不能为了自检把环境搞坏。
    const depsPrune = ['chalk', 'ansi-styles', 'supports-color', 'has-flag', 'color-convert', 'color-name'];
    // 数据安全兜底：这几个包可能被用户缓存过。剪之前先把整个包目录备份到临时目录，
    // 万一收尾时从上游恢复失败（离线 / 上游不可达 / 网络抖动），就用备份把 data/storage
    // 里的包目录原样拷回来——绝不把用户已有的缓存永久弄丢。
    const depsBackupDir = path.join(tmpDir, 'deps-prune-backup');
    const depsBackup = {};
    const prunedBefore = {};
    const createdNames = new Set();   // 本节新加的包：异常中断时也靠它清理，避免留在用户镜像里
    let depsRestoreDone = false;
    let depsSelftestDone = false;   // 只有走完正常收尾（含联网恢复）才置 true

    /**
     * 无条件从本地备份恢复被剪掉的六个包。同步实现、不依赖网络，所以异常路径和
     * SIGINT/SIGTERM 里都能调用；重复调用只执行一次，避免正常收尾时重复 cpSync。
     */
    function restorePrunedDepsSync() {
      if (depsRestoreDone) return;
      depsRestoreDone = true;
      for (const n of depsPrune) {
        try {
          const dir = path.join(config.storageDir(), util.safePkgDir(n));
          if (depsBackup[n]) {
            fs.rmSync(dir, { recursive: true, force: true });
            fs.cpSync(depsBackup[n], dir, { recursive: true });
          } else if (Array.isArray(prunedBefore[n]) && prunedBefore[n].length === 0) {
            // 测试前本来就没有这个包：把测试中途建出来的目录也清掉
            fs.rmSync(dir, { recursive: true, force: true });
          }
        } catch { /* 尽力而为：不能因为恢复失败掩盖原始错误 */ }
      }
      try { fs.rmSync(depsBackupDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    function onSelftestSignal(sig) {
      process.stdout.write(`\n收到 ${sig || '中断信号'}，正在从本地备份恢复被剪枝的依赖包（chalk 等）…\n`);
      restorePrunedDepsSync();
      if (createdNames.size) {
        process.stdout.write(`本节新建的包未清理，如需还原可手工执行：npm cache rm 或 DELETE /__admin/api/packages/<包名>\n`
          + `  ${Array.from(createdNames).join('、')}\n`);
      }
      process.stdout.write('已从备份恢复（临时备份目录已清理），退出。\n');
      process.exit(130);
    }
    process.once('SIGINT', () => onSelftestSignal('SIGINT'));
    process.once('SIGTERM', () => onSelftestSignal('SIGTERM'));

    try {
      for (const n of depsPrune) {
        try {
          const dir = path.join(config.storageDir(), util.safePkgDir(n));
          if (!fs.existsSync(path.join(dir, 'packument.json'))) continue;
          const dst = path.join(depsBackupDir, util.safePkgDir(n));
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.cpSync(dir, dst, { recursive: true });
          depsBackup[n] = dst;
        } catch { /* 备份失败不阻断测试，收尾仍会尝试联网恢复 */ }
      }
      for (const n of depsPrune) {
        const g = await api('/__admin/api/packages/' + encodeURIComponent(n));
        const d = g.json && g.json.data;
        prunedBefore[n] = (d && Array.isArray(d.versions)) ? d.versions.filter(v => v.cached).map(v => v.version) : [];
        if (g.status === 200) await api('/__admin/api/packages/' + encodeURIComponent(n), { method: 'DELETE' });
      }

    async function pollTask(id, timeoutMs = 180000) {
      const t0p = Date.now();
      while (Date.now() - t0p < timeoutMs) {
        const r = await api('/__admin/api/tasks/' + id);
        const d = r.json && r.json.data;
        if (d && d.status !== 'running') return d;
        await util.sleep(250);
      }
      return null;
    }
    // 每拿到一批 picks 就登记「本节新加的包」，这样即使后面断言抛异常，finally 里也能清干净
    const trackCreated = (picks) => (picks || []).forEach((p) => {
      if (!beforeNames.has(p.name) && depsPrune.indexOf(p.name) < 0) createdNames.add(p.name);
    });
    const depsAdd = async (body) => {
      const r = await api('/__admin/api/packages/deps-add', { method: 'POST', body });
      const id = r.json && r.json.data && r.json.data.taskId;
      if (!id) return { start: r, task: null };
      const task = await pollTask(id);
      // 任务一结束就登记，避免「任务成功但随后断言抛错」时包名没被记下来
      if (task && task.result) trackCreated(task.result.packages);
      return { start: r, task };
    };

    // ① 深度上限：depth=1 只加「根 + 直接依赖」（chalk@4.1.2 → ansi-styles、supports-color）
    const one = await depsAdd({ names: ['chalk@4.1.2'], depth: 1, prefetch: false });
    const picks1 = (one.task && one.task.result && one.task.result.packages) || [];
    const names1 = picks1.map(p => p.name).sort();
    const chalkPick = picks1.find(p => p.name === 'chalk');
    check('POST /packages/deps-add 立即返回任务并跑完（异步任务）',
      one.start.status === 200 && !!one.task && one.task.status === 'done',
      `status=${one.start.status} task=${one.task && one.task.status} ${one.start.text.slice(0, 120)}`);
    check('depth=1 只收「根 + 直接依赖」共 3 个包，不越级拉孙辈',
      names1.join(',') === 'ansi-styles,chalk,supports-color',
      `picks=${names1.join(',')} stats=${JSON.stringify(one.task && one.task.result && one.task.result.stats)}`);
    check('根包按点名版本解析（chalk@4.1.2，不是 latest 6.0.1）',
      !!chalkPick && chalkPick.version === '4.1.2', `chalk=${chalkPick && chalkPick.version}`);
    const ansiGet = await api('/__admin/api/packages/ansi-styles');
    const ccGet = await api('/__admin/api/packages/color-convert');
    check('依赖的元数据已落盘；孙辈（color-convert）确实没被加进来',
      ansiGet.status === 200 && ccGet.status === 404, `ansi-styles=${ansiGet.status} color-convert=${ccGet.status}`);

    // ② 完整闭包 + 下载 tarball：depth=5 应该补出 color-name（第 3 层），6 个包都能离线装
    const full = await depsAdd({ names: ['chalk@4.1.2'], depth: 5, prefetch: true });
    const res2 = (full.task && full.task.result) || {};
    const picks2 = res2.packages || [];
    const byName2 = {};
    picks2.forEach(p => { byName2[p.name] = p; });
    check('depth=5 解析出完整闭包 6 个包 / 6 个版本（含第 3 层的 color-name）',
      res2.stats && res2.stats.packages === 6 && res2.stats.versions === 6 && res2.stats.depthUsed === 3
      && !!byName2['color-name'] && byName2['color-name'].depth === 3,
      `stats=${JSON.stringify(res2.stats)} color-name=${byName2['color-name'] && byName2['color-name'].depth}`);
    check('递归添加会真的把 6 个 tarball 下载下来（prefetch 默认开启）',
      !!res2.tarballs && res2.tarballs.ok === 6 && res2.tarballs.failed === 0 && res2.tarballs.bytes > 0,
      `tarballs=${JSON.stringify(res2.tarballs)}`);
    const cdGet = await api('/__admin/api/packages/color-name');
    const cdVer = ((cdGet.json && cdGet.json.data && cdGet.json.data.versions) || []).find(v => v.version === '1.1.4');
    check('下载后的版本在详情里显示为已缓存（离线可用）',
      !!cdVer && cdVer.cached === true, `color-name@1.1.4 cached=${cdVer && cdVer.cached}`);
    check('任务标题/消息能说明这是递归添加',
      /递归添加依赖/.test((full.task && full.task.title) || '') && /解析/.test((full.task && full.task.message) || ''),
      `title=${full.task && full.task.title} message=${full.task && full.task.message}`);

    // ③ 同一个包的多个版本可以共存（npm 语义）：debug@2.6.9 → ms@2.0.0，debug@4.3.6 → ms@2.1.2
    const multi = await depsAdd({ names: ['debug@2.6.9', 'debug@4.3.6'], depth: 1, prefetch: false });
    const picks3 = (multi.task && multi.task.result && multi.task.result.packages) || [];
    const msVersions = picks3.filter(p => p.name === 'ms').map(p => p.version).sort();
    check('同一个包的两个版本可以共存（ms@2.0.0 + ms@2.1.2）',
      msVersions.join(',') === '2.0.0,2.1.2'
      && picks3.filter(p => p.name === 'debug').length === 2,
      `ms=${msVersions.join(',')} picks=${picks3.map(p => p.name + '@' + p.version).join(' ')}`);

    // ④ 参数校验
    const badReq = await api('/__admin/api/packages/deps-add', { method: 'POST', body: { names: [] } });
    check('deps-add 缺少包名时返回 400', badReq.status === 400 && badReq.json && badReq.json.code === 'EBADREQ',
      `status=${badReq.status} ${badReq.text.slice(0, 100)}`);

    // ⑤ 回归：npm 上真实存在的「>= 2.1.2 < 3」这类带空格范围以前解析不出来，
    //    会把这些依赖丢进 unresolved（用户实测报的就是 safer-buffer / statuses / mime-db / thenify）
    const tricky = await depsAdd({
      names: ['body-parser@1.20.2', 'compression@1.7.4', 'mz@2.7.0'],
      depth: 2, prefetch: false
    });
    const res5 = (tricky.task && tricky.task.result) || {};
    const picks5 = res5.packages || [];
    const pick5 = {};
    picks5.forEach(p => { if (!pick5[p.name]) pick5[p.name] = p; });
    check('带空格的范围（">= 2.1.2 < 3"）不再被误判为「没有满足的版本」',
      !!res5.unresolved && res5.unresolved.length === 0,
      `unresolved=${JSON.stringify((res5.unresolved || []).slice(0, 6))}`);
    check('这几个真实依赖都能解析出版本：safer-buffer / statuses / mime-db / thenify',
      tricky.task && tricky.task.status === 'done'
      && ['safer-buffer', 'statuses', 'mime-db', 'thenify'].every(n => !!pick5[n]),
      `safer-buffer=${pick5['safer-buffer'] && pick5['safer-buffer'].version} statuses=${pick5['statuses'] && pick5['statuses'].version} `
      + `mime-db=${pick5['mime-db'] && pick5['mime-db'].version} thenify=${pick5['thenify'] && pick5['thenify'].version}`);

    // ⑥ 回归：别名依赖能解析到真实包（只读解析，不往镜像里写东西）
    //    element-plus@2.14.7 的依赖里就有 `@popperjs/core: npm:@sxzz/popperjs-es@^2.11.8`
    const { Store } = require('../src/store');
    const { Upstream } = require('../src/upstream');
    const registryMod = require('../src/registry');
    const cfgMod = require('../src/config');
    const quiet = { info() { }, warn() { }, error() { }, debug() { } };
    const roStore = new Store({ dir: cfgMod.storageDir(), logger: quiet });
    await roStore.init();
    const roCtx = {
      cfg: () => cfgMod.get(), store: roStore, registry: registryMod,
      upstream: new Upstream(() => cfgMod.get(), quiet), log: quiet,
    };
    const ep = await deps.resolveClosure(roCtx, ['element-plus@2.14.7'], { depth: 1, persist: false });
    const epAlias = ep.picks.filter(p => p.alias);
    check('别名依赖（@popperjs/core → npm:@sxzz/popperjs-es@^2.11.8）不再进「需要手工处理」',
      ep.unresolved.length === 0 && epAlias.some(p => p.name === '@sxzz/popperjs-es' && p.version === '2.11.8' && p.alias.name === '@popperjs/core'),
      `unresolved=${JSON.stringify((ep.unresolved || []).slice(0, 4))} 别名=${JSON.stringify(epAlias.map(p => p.alias.name + '→' + p.name + '@' + p.version))}`);
    if (typeof roStore.close === 'function') roStore.close();

    // ⑦ 走一遍真接口：别名当根 spec → 把真实包的 tarball 缓存下来
    //    （npm 客户端装别名依赖时，去镜像里取的就是真实包的 packument 和 tarball）
    const aliasAdd = await depsAdd({ names: ['@popperjs/core@npm:@sxzz/popperjs-es@^2.11.8'], depth: 0, prefetch: true });
    const res7 = (aliasAdd.task && aliasAdd.task.result) || {};
    const picks7 = res7.packages || [];
    check('npm: 别名当根 spec 也能添加：解析到 @sxzz/popperjs-es@2.11.8（tarball 已缓存就不必再下）',
      !!(aliasAdd.task && aliasAdd.task.status === 'done') && picks7.length === 1
      && picks7[0].name === '@sxzz/popperjs-es' && picks7[0].version === '2.11.8'
      && !!picks7[0].alias && picks7[0].alias.name === '@popperjs/core'
      && !!res7.tarballs && res7.tarballs.failed === 0
      && (res7.tarballs.total === 0 || res7.tarballs.ok === 1),
      `status=${aliasAdd.task && aliasAdd.task.status} picks=${JSON.stringify(picks7.map(p => p.name + '@' + p.version))} `
      + `tarballs=${JSON.stringify(res7.tarballs)}`);
    const sxGet = await api('/__admin/api/packages/' + encodeURIComponent('@sxzz/popperjs-es'));
    const sxVer = ((sxGet.json && sxGet.json.data && sxGet.json.data.versions) || []).find(v => v.version === '2.11.8');
    check('别名指向的真实包在镜像里显示为已缓存（离线装别名依赖时取的就是它）',
      !!sxVer && sxVer.cached === true, `@sxzz/popperjs-es@2.11.8 cached=${sxVer && sxVer.cached}`);

    // ⑧ 收尾：删掉这次新加的包（保留测试前就有的），再把开头剪掉的包按原样恢复
    const created = Array.from(createdNames);
    const toDelete = Array.from(new Set(created.concat(depsPrune)));
    for (const n of toDelete) await api('/__admin/api/packages/' + encodeURIComponent(n), { method: 'DELETE' });
    const left = [];
    for (const n of toDelete) { const g = await api('/__admin/api/packages/' + encodeURIComponent(n)); if (g.status !== 404) left.push(n); }

    const restore = [];
    for (const n of depsPrune) for (const v of (prunedBefore[n] || [])) restore.push(`${n}@${v}`);
    let restored = null;
    for (let attempt = 1; attempt <= 3 && restore.length; attempt++) {
      restored = await api('/__admin/api/packages', { method: 'POST', body: { names: restore }, timeoutMs: 600000 });
      if (restored && restored.status === 200) break;
      await new Promise(r => setTimeout(r, 800));   // 连接偶发被回收时重试
    }
    const missingRestore = [];
    for (const n of depsPrune) {
      if (!(prunedBefore[n] || []).length) continue;
      const g = await api('/__admin/api/packages/' + encodeURIComponent(n));
      const d = g.json && g.json.data;
      const now = new Set(((d && d.versions) || []).filter(v => v.cached).map(v => v.version));
      for (const v of prunedBefore[n]) if (!now.has(v)) missingRestore.push(`${n}@${v}`);
    }

    // 兜底恢复：上游恢复失败（离线 / 上游不可达）时，直接把前面备份的包目录拷回 storage，
    // 不依赖网络。服务在第九节会重启并重建内存索引；这里先保证磁盘上的缓存数据恢复。
    const fallbackRestored = [];
    if (missingRestore.length && Object.keys(depsBackup).length) {
      for (const n of depsPrune) {
        if (!(prunedBefore[n] || []).length || !depsBackup[n]) continue;
        if (!missingRestore.some((s) => s.startsWith(n + '@'))) continue;
        try {
          const dir = path.join(config.storageDir(), util.safePkgDir(n));
          fs.rmSync(dir, { recursive: true, force: true });
          fs.cpSync(depsBackup[n], dir, { recursive: true });
          fallbackRestored.push(n);
        } catch { /* 忽略：下面会重新核对 */ }
      }
      missingRestore.length = 0;
      for (const n of depsPrune) {
        if (!(prunedBefore[n] || []).length) continue;
        const g = await api('/__admin/api/packages/' + encodeURIComponent(n));
        const d = g.json && g.json.data;
        const now = new Set(((d && d.versions) || []).filter(v => v.cached).map(v => v.version));
        for (const v of prunedBefore[n]) if (!now.has(v)) missingRestore.push(`${n}@${v}`);
      }
    }

    check(`收尾：清理本次新建/剪掉的 ${toDelete.length} 个包，并把剪掉的 ${restore.length} 个既有版本原样补回`,
      left.length === 0 && missingRestore.length === 0,
      `status=${restored && restored.status} 残留=${left.join('、') || '无'}；恢复 ${restore.length} 个 → 仍缺 ${missingRestore.join('、') || '无'}`
      + `；本地备份兜底=${fallbackRestored.join('、') || '未用到'}`);
    depsSelftestDone = true;
  } finally {
    process.removeListener('SIGINT', onSelftestSignal);
    process.removeListener('SIGTERM', onSelftestSignal);
    if (!depsSelftestDone) {
      // 自检中断 / 断言抛错：先删掉本节新建的包，再无条件用本地备份把被剪掉的六个包恢复回来。
      // 这段不依赖网络，而且恢复函数是幂等的，不会因为前面部分恢复过就出错。
      for (const n of createdNames) {
        try { await api('/__admin/api/packages/' + encodeURIComponent(n), { method: 'DELETE' }); } catch { /* 尽力而为 */ }
      }
      restorePrunedDepsSync();
      process.stdout.write('⚠ 第四节中途退出：已清理本节新建的包，并从本地备份恢复被剪枝的依赖包（chalk 等）。\n');
    } else {
      try { fs.rmSync(depsBackupDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }
  }

  // ---------------------------------------------------------------- 全部包补 tarball
  section('五之八、全部包补 tarball（包管理页「全部包补 dist-tag 版本 / 全部包补最新版本」，不用勾选）');
  {
    const { Store } = require('../src/store');
    const cfgMod = require('../src/config');
    const pullMod = require('../src/pull');
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    const roStore = new Store({ dir: cfgMod.storageDir(), logger: quiet });
    await roStore.init();

    const listAll = await api('/__admin/api/packages?size=1');
    const totalPkgs = Number((listAll.json && listAll.json.data && listAll.json.data.total) || 0);
    check('前置：镜像里有包可补', totalPkgs > 0, `total=${totalPkgs}`);

    const names = roStore.names();
    check(`store.names() 一次拿到全部 ${totalPkgs} 个包名（list() 的 size 上限是 200，不能拿来取全量名单）`,
      names.length === totalPkgs, `names=${names.length} total=${totalPkgs}`);

    const planLatest = pullMod.planTargets(roStore, names, 'latest');
    const planTags = pullMod.planTargets(roStore, names, 'tags');
    const sum = (plan) => plan.reduce((a, p) => a + p.target.length, 0);
    check('planTargets(全部包, latest / tags) 每个包一行，latest 的目标数不超过 tags',
      planLatest.length === totalPkgs && planTags.length === totalPkgs && sum(planLatest) <= sum(planTags),
      `有目标的包：latest=${planLatest.filter(p => p.target.length).length} / tags=${planTags.filter(p => p.target.length).length}`);

    // 走真接口：scope=all 的 latest 任务（随后立刻取消，只验证作用域/规划/可取消，不把镜像真的补全）
    const pull = await api('/__admin/api/packages/pull', {
      method: 'POST', body: { all: true, mode: 'latest', concurrency: 1 }, timeoutMs: 60000,
    });
    const pj = (pull.json && pull.json.data) || {};
    check('POST /packages/pull {all:true} 不传名单也能建任务，响应带 scope=all',
      pull.status === 200 && pj.scope === 'all' && !!pj.taskId, `status=${pull.status} scope=${pj.scope} taskId=${pj.taskId}`);

    const pk = pj.packages || [];
    const sumTarget = pk.reduce((a, p) => a + Number(p.target || 0), 0);
    const locals = names.filter((n) => {                       // 上传包 / 私有包：不可能从上游补，全部包模式应跳过
      const rec = roStore.get(n);
      const src = rec && rec.meta && rec.meta.source;
      return src === 'upload' || src === 'private';
    });
    const skipOk = locals.length
      ? (pj.skippedLocal === locals.length || (locals.length === totalPkgs && pj.skippedLocal === 0))
      : pj.skippedLocal === 0;
    check(`任务规划覆盖全部 ${totalPkgs} 个包（返回 ${pk.length} 行 + 跳过 ${pj.skippedLocal} 个仅本地的包，各行 target 合计 ${sumTarget} = total ${pj.total}）`,
      pk.length + Number(pj.skippedLocal || 0) === totalPkgs && sumTarget === Number(pj.total || 0) && skipOk,
      `packages=${pk.length} skipped=${pj.skippedLocal} locals=${locals.length} sum=${sumTarget} total=${pj.total}`);
    check('全部包模式跳过仅本地的包（上传/私有），规划里不再出现它们',
      locals.every((n) => !pk.some((p) => p.name === n)), `locals=${locals.join('、') || '（无）'}`);

    const brief = await api('/__admin/api/tasks/' + pj.taskId);
    const bj = (brief.json && brief.json.data) || {};
    check(`任务标题写明「全部包」（${bj.title || ''}）`, /全部包/.test(String(bj.title || '')), bj.title);

    await api('/__admin/api/tasks/' + pj.taskId + '/cancel', { method: 'POST' });
    let fin = null;
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const g = await api('/__admin/api/tasks/' + pj.taskId);
      const t = (g.json && g.json.data) || {};
      if (t.status !== 'running') { fin = t; break; }
    }
    // 计划为空时（缺失的只有被跳过的本地包）任务会瞬间正常收尾，取消命令还没到就已经结束了
    check('全部包任务能取消并正常收尾（不会顺手把镜像补全）',
      !!fin && fin.status !== 'running' && fin.status !== 'error',
      `status=${fin && fin.status} message=${fin && fin.message}`);

    const res = (fin && fin.result) || {};
    check('任务结果带 scope=all 与逐包明细（前端「全部包」模式据此渲染每一行）',
      res.scope === 'all' && Array.isArray(res.packages)
        && res.packages.length + Number(res.skippedLocal || 0) === totalPkgs,
      `scope=${res.scope} packages=${res.packages && res.packages.length} skipped=${res.skippedLocal}`);

    await roStore.close();
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
    const gone = await api(`/${PRIVATE}`);
    check('DELETE /packages/<名> 删除整包', del.status === 200 && gone.status === 404, `del=${del.status} get=${gone.status}`);
    const imp = await api('/__admin/api/bundles/import', { method: 'POST', body: { file: bundleFile, overwrite: true }, timeoutMs: 180000 });
    const back = await api(`/${PRIVATE}`);
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
    const src = path.join(__dirname, '..', 'data', 'bundles', rawUploadBundle);
    const buf = fs.readFileSync(src);
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
    const tmpDir = path.join(__dirname, '..', 'data', 'tmp');
    const left = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
    check('原始体上传后临时文件已清理（data\\tmp 无残留）', left.length === 0, `left=${left.join(',')}`);
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
    };
    const cls = bundleMod.collectDepClosure(fake, ['a']);
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
        method: 'POST', body: { scope: 'selected', names: [cand], withDeps: true }, timeoutMs: 300000,
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

  // ---------------------------------------------------------------- 版本删除
  section('七、单版本删除与取消发布');
  {
    const r = await api(`/__admin/api/packages/mirror-selftest-upload/3.1.4`, { method: 'DELETE' });
    const g = await api('/mirror-selftest-upload');
    const has = g.json && g.json.versions && g.json.versions['3.1.4'];
    check('DELETE /packages/<名>/<版本> 删除单版本', r.status === 200 && !has, `status=${r.status}`);
  }
  {
    const g = await api(`/${PRIVATE}`);
    const rev = (g.json && g.json._rev) || '1-0';
    const r = await api(`/${PRIVATE}/1.0.0/-rev/${rev}`, { method: 'DELETE' });
    const after = await api(`/${PRIVATE}`);
    const has = after.json && after.json.versions && after.json.versions['1.0.0'];
    check('DELETE /<包名>/<版本>/-rev/<rev> 取消发布单版本', (r.status === 200 || r.status === 201) && !has, `status=${r.status} rev=${rev}`);
  }

  // ---------------------------------------------------------------- 缓存导入
  section('八、从本机 npm 缓存导入（离线补包）');
  {
    const scan = await api('/__admin/api/npmcache/scan', { timeoutMs: 300000 });
    const d = scan.json && scan.json.data;
    check('GET /npmcache/scan 扫描本机 npm 缓存', scan.status === 200 && d && typeof d.total === 'number', `status=${scan.status} total=${d && d.total} dir=${d && d.cacheDir}`);
    if (d && d.total > 0 && d.packages && d.packages.length) {
      // 「本地已有」标记：缓存里的包是否已经在镜像里（前端据此显示徽标、也决定「仅导入不存在的包」导哪些）
      const localN = d.packages.filter((p) => p.local === true).length;
      check(`扫描结果标出「镜像里已有」的包（local 字段 + localCount=${d.localCount}，共 ${d.total} 个）`,
        typeof d.localCount === 'number' && localN === d.localCount
          && d.packages.every((p) => typeof p.local === 'boolean'),
        `local=${localN} localCount=${d.localCount}`);

      const name = d.packages[0].name;
      const imp = await api('/__admin/api/npmcache/import', { method: 'POST', body: { names: [name] }, timeoutMs: 180000 });
      check(`POST /npmcache/import 导入 ${name}`, imp.status === 200, `status=${imp.status} ${imp.text.slice(0, 120)}`);

      // 导入已存在的包：不再假报「成功」，而是走 skipped（前端提示据此显示跳过数）
      const localOne = (d.packages.find((p) => p.local === true) || {}).name;
      if (localOne) {
        const imp2 = await api('/__admin/api/npmcache/import', { method: 'POST', body: { names: [localOne] }, timeoutMs: 120000 });
        const dd = (imp2.json && imp2.json.data) || {};
        check(`已存在的包 ${localOne} 走 skipped（不重复导入，也不报错）`,
          imp2.status === 200 && (dd.imported || []).length === 0 && (dd.skipped || []).some((s) => s.name === localOne),
          `imported=${(dd.imported || []).length} skipped=${JSON.stringify((dd.skipped || []).slice(0, 2))}`);
      }

      // 参数校验：「全部导入」必须显式确认，避免误操作把整机缓存灌进镜像
      const noName = await api('/__admin/api/npmcache/import', { method: 'POST', body: {} });
      check('POST /npmcache/import 既没名单也没 all:true 时拒绝（400）', noName.status === 400, `status=${noName.status}`);
      const noConfirm = await api('/__admin/api/npmcache/import', { method: 'POST', body: { all: true } });
      check('POST /npmcache/import {all:true} 未确认时返回 409 ECONFIRM', noConfirm.status === 409 && /ECONFIRM/.test(noConfirm.text), `status=${noConfirm.status} ${noConfirm.text.slice(0, 120)}`);

      // 长任务模式（progress:true）：界面靠它显示「正在导入的包 + 导入进度 + 逐包明细」
      const t0 = Date.now();
      const st = await api('/__admin/api/npmcache/import', {
        method: 'POST',
        body: { names: [name], overwrite: true, progress: true },
        timeoutMs: 60000,
      });
      const sd = (st.json && st.json.data) || {};
      check(`POST /npmcache/import {progress:true} 立即返回 taskId（${Date.now() - t0}ms）`,
        st.status === 200 && typeof sd.taskId === 'string' && sd.async === true && sd.total === 1,
        `status=${st.status} body=${st.text.slice(0, 160)}`);
      let tt = null;
      for (let i = 0; i < 200; i++) {
        const q = await api('/__admin/api/tasks/' + sd.taskId);
        tt = (q.json && q.json.data) || {};
        if (tt.status !== 'running') break;
        await new Promise((res) => setTimeout(res, 50));
      }
      check('进度任务结束后 status=done，并回传逐包明细 packages[]（左栏导入详情的数据源）',
        !!(tt && tt.type === 'cache-import' && tt.status === 'done' && Array.isArray(tt.packages) && tt.packages.length === 1
          && tt.packages[0].name === name && typeof tt.packages[0].status === 'string'),
        `status=${tt && tt.status} done=${tt && tt.done}/${tt && tt.total} pkgs=${JSON.stringify((tt && tt.packages) || []).slice(0, 160)}`);
      check('进度任务回传计数与版本/tarball 明细（ok/failed/skipped/versions/tarballs/current）',
        !!(tt && typeof tt.ok === 'number' && typeof tt.failed === 'number' && typeof tt.skipped === 'number'
          && typeof tt.versions === 'number' && typeof tt.tarballs === 'number'
          && typeof tt.current === 'string' && tt.percent === 100),
        `ok=${tt && tt.ok} failed=${tt && tt.failed} skipped=${tt && tt.skipped} ver=${tt && tt.versions} tar=${tt && tt.tarballs} percent=${tt && tt.percent}`);
    } else {
      // 显式 SKIP：以前这里用 check(..., true) 恒真，缓存为空时看起来也「通过」，属于假通过
      skip('从本机 npm 缓存导入（八）', '本机 npm 缓存为空，没有可导入的包');
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
      skip('POST /service/restart 并验证自动恢复', '破坏性用例未执行：加 --destructive 开启');
    } else {
      const r = await api('/__admin/api/service/restart', { method: 'POST' });
      check('POST /service/restart 返回重启中', r.status === 200 && r.json && r.json.data && r.json.data.restarting === true, `status=${r.status}`);
      let back = false;
      for (let i = 0; i < 40; i++) {
        await util.sleep(500);
        try { const p = await api('/-/ping', { auth: false, timeoutMs: 3000 }); if (p.status === 200) { back = true; break; } } catch { /* 仍在重启 */ }
      }
      check('重启后服务自动恢复可用', back, back ? '' : '15 秒内未恢复');
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
      const r = await rawReq(p);
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
    for (const n of [PRIVATE, PRIVATE2, 'mirror-selftest-upload', 'mirror-selftest-json']) {
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
