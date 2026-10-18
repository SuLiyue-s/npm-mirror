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
  for (const n of [PRIVATE, PRIVATE2, 'mirror-selftest-upload', 'mirror-selftest-json', 'mirror-selftest-autodeps-fail', 'mirror-selftest-autodeps-ok', 'mirror-selftest-chunkpkg-a', 'mirror-selftest-chunkpkg-b']) {
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
  section('五之八、全部包补 tarball（包管理页「全部包补 dist-tag 版本 / 全部包补最新版本 / 全部包补全部版本」，不用勾选）');
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

    // planTargets 自本轮起是 async（每 8 个包让出一次事件循环，避免全量规划把服务卡住几秒），调用处要 await
    const planLatest = await pullMod.planTargets(roStore, names, 'latest');
    const planTags = await pullMod.planTargets(roStore, names, 'tags');
    const planAll = await pullMod.planTargets(roStore, names, 'all');
    const sum = (plan) => plan.reduce((a, p) => a + p.target.length, 0);
    check('planTargets(全部包, latest / tags) 每个包一行，latest 的目标数不超过 tags',
      planLatest.length === totalPkgs && planTags.length === totalPkgs && sum(planLatest) <= sum(planTags),
      `有目标的包：latest=${planLatest.filter(p => p.target.length).length} / tags=${planTags.filter(p => p.target.length).length}`);
    // 「全部包补全部版本」= 每个包把所有缺失版本都规划进去：目标总数应等于各包「缺 tarball 的版本数」之和，且不小于 tags 模式
    const missTotal = names.reduce((a, n) => a + roStore.missingTarballs(n).length, 0);
    check('planTargets(全部包, all) 规划每一个缺失版本（目标数 = 各包缺失 tarball 之和，且不少于 tags 模式）',
      planAll.length === totalPkgs && sum(planAll) === missTotal && sum(planAll) >= sum(planTags),
      `all=${sum(planAll)} tags=${sum(planTags)} missing=${missTotal}`);

    // ---- 版本级实时下载进度：进度弹窗右侧「正在下载 · 版本进度」栏的数据来源 ----
    // 用假 store / registry 验证：onProgress 里能看到每个并发下载的版本各自 received/total（像普通下载器看单个文件），
    // 下载完成即从 downloads 列表移除；400ms 节流不会把最终数据吞掉。
    {
      const fsM = require('node:fs');
      const osM = require('node:os');
      const pathM = require('node:path');
      const tarFile = pathM.join(osM.tmpdir(), `pull-progress-${process.pid}-${Date.now()}.tgz`);
      fsM.writeFileSync(tarFile, Buffer.alloc(1024));
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // 规划改成 async 后走 store.getAsync + store.tarballDir/tarballFileName（同一份 packument 只读一次）
      const fakeStore = {
        get() { return { packument: { 'dist-tags': { latest: '1.0.1' }, versions: { '1.0.0': {}, '1.0.1': {} } } }; },
        async getAsync() { return this.get(); },
        tarballDir() { return osM.tmpdir(); },
        tarballFileName(name, version) { return `${name}-${version}.tgz`; },
        missingTarballs() { return ['1.0.0', '1.0.1']; },
      };
      const seen = [];
      const fakeCtx = {
        cfg: () => ({ mode: 'cache', upstream: { concurrency: 2 } }),
        store: fakeStore,
        log: quiet,
        registry: {
          TARBALL_REASON_TEXT: {},
          async ensureTarballEx(c, pkgName, version, o) {
            // 模拟真实下载：先报到 30%，过一会儿到 70%，再返回本地文件
            if (o && o.onProgress) o.onProgress(30, 100);
            await sleep(430);                 // 超过 400ms 节流窗口，确保这个中间值会被推出去
            if (o && o.onProgress) o.onProgress(70, 100);
            await sleep(430);
            return { path: tarFile, reason: 'downloaded' };
          },
        },
      };
      const pr = await pullMod.pullTarballs(fakeCtx, {
        names: ['fake-progress-pkg'], mode: 'all', concurrency: 2,
        onProgress: (info) => seen.push((info.downloads || []).map((d) => ({
          name: d.name, version: d.version, received: d.received, total: d.total,
        }))),
      });
      const flat = seen.flat();
      const got30 = flat.find((d) => d.received === 30 && d.total === 100);
      const got70 = flat.find((d) => d.received === 70 && d.total === 100);
      check('版本级进度：每个正在下载的版本都带「已收到 / 总共」字节数（received=30/70, total=100）',
        !!got30 && !!got70 && flat.every((d) => d.name === 'fake-progress-pkg'),
        `snapshots=${seen.length} 30=${JSON.stringify(got30)} 70=${JSON.stringify(got70)}`);
      check('版本级进度：并发时同时列出多个版本的下载（concurrency=2 → 快照里出现 2 条）',
        seen.some((list) => list.length === 2 && new Set(list.map((d) => d.version)).size === 2),
        `max=${Math.max(0, ...seen.map((l) => l.length))}`);
      check('版本级进度：下载完成后从 downloads 里移除（结束时列表为空）',
        pr.ok === 2 && pr.total === 2 && Array.isArray(pr.downloads) && pr.downloads.length === 0,
        `ok=${pr.ok} total=${pr.total} downloads=${pr.downloads && pr.downloads.length}`);
      try { fsM.unlinkSync(tarFile); } catch { /* 忽略 */ }
    }

    // 走真接口：scope=all 的 all 任务（全部包补全部版本）
    // 名单很长（1500+ 包），服务端现在把「统计缺哪些版本」放进后台任务：先返回 async:true + taskId，
    // 任务快照 phase='plan' 期间带 currentDone/currentTotal（界面据此显示「已统计 N / M 个包」）。
    // 这里验证统计进度与统计结果，随后立刻取消，只验证规划/标题/可取消，不把镜像真的补全。
    const pullAll = await api('/__admin/api/packages/pull', {
      method: 'POST', body: { all: true, mode: 'all', concurrency: 1 }, timeoutMs: 60000,
    });
    const pjAll = (pullAll.json && pullAll.json.data) || {};
    check('POST /packages/pull {all:true, mode:"all"} 立即返回 async:true + taskId（大名单的统计放进后台任务，不再同步阻塞）',
      pullAll.status === 200 && pjAll.async === true && !!pjAll.taskId && pjAll.scope === 'all' && pjAll.mode === 'all'
        && Number(pjAll.planTotal) + Number(pjAll.skippedLocal) === totalPkgs,
      `status=${pullAll.status} async=${pjAll.async} scope=${pjAll.scope} mode=${pjAll.mode} planTotal=${pjAll.planTotal} skipped=${pjAll.skippedLocal} totalPkgs=${totalPkgs}`);
    let planSnapshot = null;
    let planSawPhase = false;
    let planSawProgress = false;
    if (pjAll.taskId) {
      // 等统计阶段结束（phase=plan → download）：期间采样任务快照，验证「已统计 N / M 个包」的进度在动
      for (let i = 0; i < 900; i++) {
        await new Promise((r) => setTimeout(r, 120));
        const g = await api('/__admin/api/tasks/' + pjAll.taskId);
        const t = (g.json && g.json.data) || {};
        if (t.phase === 'plan' && t.status === 'running') {
          planSawPhase = true;
          if (Number(t.currentDone) >= 1 && Number(t.currentTotal) >= 100) planSawProgress = true;
          continue;
        }
        planSnapshot = t;
        break;
      }
      check('统计阶段任务快照带 phase=plan 与「已统计 N / M 个包」进度（currentDone 在递增、currentTotal=可补包数）',
        planSawPhase && planSawProgress,
        `phase=${planSawPhase} progress=${planSawProgress} snapDone=${planSnapshot && planSnapshot.currentDone}`);
      const ps = planSnapshot || {};
      const planPkgs = ps.packages || [];
      const sumTarget = planPkgs.reduce((a, p) => a + Number(p.target || 0), 0);
      check('统计完成后任务快照带 total 与逐包明细（各行 target 合计 = total，覆盖全部可补的包）',
        Number(ps.total) >= 0 && planPkgs.length + Number(pjAll.skippedLocal || 0) === totalPkgs
          && sumTarget === Number(ps.total || 0)
          // 镜像被「全部包补全部版本」补满后，剩下的缺失版本可能只在「上传/私有」包里（全部包模式会跳过），
          // 这时 total=0 是合理的；只要不超过本地逐包扫描出的缺失版本总数即可。
          && (Number(ps.total) === 0 || Number(ps.total) <= sum(planAll)),
        `total=${ps.total} packages=${planPkgs.length} sum=${sumTarget} planAll=${sum(planAll)} planTags=${sum(planTags)}`);
      check(`「补全部版本」任务标题写明「全部包补 全部版本」（${ps.title || ''}）`,
        /全部包补/.test(String(ps.title || '')) && /全部版本/.test(String(ps.title || '')), ps.title);
      await api('/__admin/api/tasks/' + pjAll.taskId + '/cancel', { method: 'POST' });
      let finAll = null;
      for (let i = 0; i < 240; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const g = await api('/__admin/api/tasks/' + pjAll.taskId);
        const t = (g.json && g.json.data) || {};
        if (t.status !== 'running') { finAll = t; break; }
      }
      check('「补全部版本」任务能取消并正常收尾（取消不报错，也不会顺手把镜像补全）',
        !!finAll && finAll.status !== 'running' && finAll.status !== 'error',
        `status=${finAll && finAll.status} message=${finAll && finAll.message}`);
    }

    // 走真接口：scope=all 的 latest 任务（随后立刻取消，只验证作用域/规划/可取消，不把镜像真的补全）
    const pull = await api('/__admin/api/packages/pull', {
      method: 'POST', body: { all: true, mode: 'latest', concurrency: 1 }, timeoutMs: 60000,
    });
    const pj = (pull.json && pull.json.data) || {};
    check('POST /packages/pull {all:true} 不传名单也能建任务，响应带 scope=all 与 async:true',
      pull.status === 200 && pj.scope === 'all' && !!pj.taskId && pj.async === true,
      `status=${pull.status} scope=${pj.scope} async=${pj.async} taskId=${pj.taskId}`);

    // 等统计阶段结束，从任务快照里拿规划结果（响应本身不再同步返回 packages）
    let latestSnap = null;
    for (let i = 0; i < 900; i++) {
      await new Promise((r) => setTimeout(r, 120));
      const g = await api('/__admin/api/tasks/' + pj.taskId);
      const t = (g.json && g.json.data) || {};
      if (t.phase === 'plan' && t.status === 'running') continue;
      latestSnap = t;
      break;
    }
    const pk = (latestSnap && latestSnap.packages) || [];
    const sumTarget = pk.reduce((a, p) => a + Number(p.target || 0), 0);
    const locals = names.filter((n) => {                       // 上传包 / 私有包：不可能从上游补，全部包模式应跳过
      const rec = roStore.get(n);
      const src = rec && rec.meta && rec.meta.source;
      return src === 'upload' || src === 'private';
    });
    const skipOk = locals.length
      ? (pj.skippedLocal === locals.length || (locals.length === totalPkgs && pj.skippedLocal === 0))
      : pj.skippedLocal === 0;
    check(`任务规划覆盖全部 ${totalPkgs} 个包（任务快照 ${pk.length} 行 + 跳过 ${pj.skippedLocal} 个仅本地的包，各行 target 合计 ${sumTarget} = total ${latestSnap && latestSnap.total}）`,
      pk.length + Number(pj.skippedLocal || 0) === totalPkgs && sumTarget === Number((latestSnap && latestSnap.total) || 0) && skipOk,
      `packages=${pk.length} skipped=${pj.skippedLocal} locals=${locals.length} sum=${sumTarget} total=${latestSnap && latestSnap.total}`);
    check('全部包模式跳过仅本地的包（上传/私有），规划里不再出现它们',
      locals.every((n) => !pk.some((p) => p.name === n)), `locals=${locals.join('、') || '（无）'}`);

    check(`任务标题写明「全部包」（${latestSnap && latestSnap.title}）`,
      /全部包/.test(String((latestSnap && latestSnap.title) || '')), latestSnap && latestSnap.title);

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

    check('任务快照带 downloads 字段（版本级实时字节进度；任务结束后清空）',
      Array.isArray(fin && fin.downloads) && fin.downloads.length === 0,
      `downloads=${JSON.stringify((fin && fin.downloads) || null)}`);

    const res = (fin && fin.result) || {};
    check('任务结果带 scope=all 与逐包明细（前端「全部包」模式据此渲染每一行）',
      res.scope === 'all' && Array.isArray(res.packages)
        && res.packages.length + Number(res.skippedLocal || 0) === totalPkgs,
      `scope=${res.scope} packages=${res.packages && res.packages.length} skipped=${res.skippedLocal}`);

    await roStore.close();
  }

  // ---------------------------------------------------------------- 本轮修复回归：全量规划不阻塞 / 启动脚本预检查 / 回环地址免鉴权
  section('五之八之二、全量规划不阻塞服务 / 启动脚本预检查 / 回环地址免鉴权（新）');
  {
    const { spawnSync } = require('node:child_process');
    const ROOT = path.join(__dirname, '..');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 1) 全量规划期间服务必须还能响应：修复前规划在请求处理里同步跑完要 9~15 秒，
    //    /session 等健康检查会超时，托盘因此误判「服务已停止」并把控制台窗口一起关掉（连带杀掉 node）。
    const lat = [];
    let stopProbe = false;
    const probe = (async () => {
      while (!stopProbe) {
        const st = Date.now();
        try { await api('/-/ping', { timeoutMs: 20000 }); } catch { /* 超时也记一笔延迟 */ }
        lat.push(Date.now() - st);
        await sleep(120);
      }
    })();
    const tPull = Date.now();
    const pullAll = await api('/__admin/api/packages/pull', { method: 'POST', body: { all: true, mode: 'tags' }, timeoutMs: 180000 });
    const pullRespMs = Date.now() - tPull;
    const pjAll = (pullAll.json && pullAll.json.data) || {};
    // 大名单的统计现在放进后台任务（响应立即返回 async:true），保持探针运行到统计阶段结束，
    // 才能量到「1500+ 个包的读盘统计进行期间，服务仍能及时响应健康检查」。
    if (pjAll.taskId) {
      for (let i = 0; i < 900; i++) {
        await sleep(120);
        const g = await api('/__admin/api/tasks/' + pjAll.taskId);
        const t = (g.json && g.json.data) || {};
        if (t.phase !== 'plan' || t.status !== 'running') break;
      }
    }
    stopProbe = true;
    await probe;
    const maxLat = lat.length ? Math.max(...lat) : 0;
    check(`大名单补 tarball 立即返回（${pullRespMs}ms，async:true），统计期间 /-/ping 仍及时响应（${lat.length} 次采样，最大 ${maxLat}ms）`,
      pullAll.status === 200 && pjAll.async === true && pullRespMs < 3000 && lat.length >= 2 && maxLat < 5000,
      `status=${pullAll.status} async=${pjAll.async} resp=${pullRespMs}ms samples=${lat.length} max=${maxLat}ms`);
    if (pjAll.taskId) {
      await api('/__admin/api/tasks/' + pjAll.taskId + '/cancel', { method: 'POST' });
      for (let i = 0; i < 120; i++) {
        await sleep(250);
        const g = await api('/__admin/api/tasks/' + pjAll.taskId);
        if (((g.json && g.json.data) || {}).status !== 'running') break;
      }
    }

    // 2) planTargets 内部每 8 个包让出一次事件循环：同步实现期间定时器几乎跑不动，可直接对比出差异
    {
      const { Store } = require('../src/store');
      const pullMod = require('../src/pull');
      const cfgMod = require('../src/config');
      const quiet = { info() {}, warn() {}, error() {}, debug() {} };
      const roStore2 = new Store({ dir: cfgMod.storageDir(), logger: quiet });
      await roStore2.init();
      const allNames = roStore2.names();
      let ticks = 0;
      const ticker = setInterval(() => { ticks++; }, 5);
      const ts = Date.now();
      let planOk = false;
      let planCount = 0;
      try {
        const p = await pullMod.planTargets(roStore2, allNames, 'tags');
        planOk = Array.isArray(p) && p.length === allNames.length;
        planCount = p.length;
      } catch { planOk = false; }
      clearInterval(ticker);
      const cost = Date.now() - ts;
      check(`planTargets 是异步规划：${planCount} 个包耗时 ${cost}ms，期间事件循环执行了 ${ticks} 次定时器（同步实现会接近 0）`,
        planOk && ticks >= 3, `plan=${planCount} cost=${cost}ms ticks=${ticks}`);
      await roStore2.close();
    }

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
    try { pidRec = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'mirror.pid'), 'utf8')); } catch { pidRec = null; }
    const pidPort = pidRec ? Number(pidRec.port) || 0 : 0;
    const expectSame = pidPort && pidPort !== BASE_PORT ? 11 : 10;
    const same = runCli(['prestart', '--port', String(BASE_PORT), '--json', '--no-open']);
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
      !!sj && sj.running === true && sj.samePort === (expectSame === 10) && Number(sj.wantPort) === BASE_PORT,
      JSON.stringify(sj || {}).slice(0, 160));
    const other = runCli(['prestart', '--port', String(BASE_PORT + 7), '--json', '--no-open']);
    check('cli.js prestart：已有实例运行在其它端口 → 退出码 11（不硬抢端口，提示先停止）',
      other.status === 11, `exit=${other.status} out=${String(other.text || '').trim().slice(0, 160)}`);
    const human = runCli(['prestart', '--port', String(BASE_PORT), '--no-open']);
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
    // data\tmp 里可能本来就有其他临时文件，先快照，只判断本次上传有没有新增残留
    const tmpDir = path.join(__dirname, '..', 'data', 'tmp');
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
        const tmpDir3 = path.join(__dirname, '..', 'data', 'tmp');
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
                  tarball: `${BASE}/${nameFd}/-/${fileFd}`,
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
              dist: { tarball: `${BASE}/${name}/-/${put.file}`, integrity: put.integrity, shasum: put.shasum },
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
        try { fs.unlinkSync(path.join(util.rootPath('data', 'bundles'), f)); } catch { /* 忽略 */ }
      }
      try { fs.rmSync(workAdd, { recursive: true, force: true }); } catch { /* 忽略 */ }
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
          dist: { tarball: `${BASE}/${oddName}/-/${oddFile}`, integrity, shasum },
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
    const gotOdd = await api(`/${encodeURIComponent(oddName)}`);
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
            tarball: `${BASE}/${fmtName}/-/${fmtFile}`,
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
    const gotFmt = await api(`/${encodeURIComponent(fmtName)}`);
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
      const gotA = await api('/' + PKG_A);
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
      const tmpDirNew = path.join(__dirname, '..', 'data', 'tmp');
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
    const tmpRoot = path.join(__dirname, '..', 'data', 'tmp');
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
    // progress=1：缓存扫描也改成长任务，前端据此显示「已检查 N / M 个索引文件、发现 X 个包」而不是干等
    const scanTask = await api('/__admin/api/npmcache/scan?refresh=1&progress=1', { timeoutMs: 60000 });
    const st = (scanTask.json && scanTask.json.data) || {};
    check('POST /npmcache/scan?refresh=1&progress=1 立即返回 async:true + taskId',
      scanTask.status === 200 && st.async === true && !!st.taskId, `status=${scanTask.status} taskId=${st.taskId}`);
    let stFin = null;
    let sawScanPhase = false;
    let sawScanMsg = false;
    if (st.taskId) {
      for (let i = 0; i < 1800; i++) {
        await new Promise((r) => setTimeout(r, 120));
        const g = await api('/__admin/api/tasks/' + st.taskId);
        const t = (g.json && g.json.data) || {};
        if (t.status === 'running') {
          if (t.phase === 'scan' || t.phase === 'verify') sawScanPhase = true;
          if (/正在扫描本机 npm 缓存|正在校验 tarball 完整性/.test(String(t.message || ''))) sawScanMsg = true;
          continue;
        }
        stFin = t;
        break;
      }
      check('缓存扫描任务快照带扫描/校验阶段与中文进度文案（phase=scan/verify + message）',
        sawScanPhase && sawScanMsg, `phase=${sawScanPhase} msg=${sawScanMsg} last=${stFin && stFin.message}`);
      const scanRes = (stFin && stFin.result && stFin.result.scan) || null;
      check('缓存扫描任务完成后 result.scan 带 packages 数组（前端直接渲染候选包列表）',
        !!stFin && stFin.status === 'done' && !!scanRes && Array.isArray(scanRes.packages) && typeof scanRes.total === 'number',
        `status=${stFin && stFin.status} total=${scanRes && scanRes.total}`);
    }

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

