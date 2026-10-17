'use strict';
/* HTTP 公共工具：统一响应格式、请求体读取、文件流、Host 校验、局域网地址 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isLoopback } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (!res.headersSent) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
  }
  res.end(body);
}

function ok(res, data) { sendJson(res, 200, { ok: true, data: data === undefined ? null : data }); }

function fail(res, status, error, code, extra) {
  const body = { ok: false, error: String(error || '未知错误') };
  if (code) body.code = code;
  if (extra) Object.assign(body, extra);
  sendJson(res, status, body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(String(text), 'utf8');
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store' });
  }
  res.end(body);
}

function readBody(req, maxBytes = 8 * 1024 * 1024, opts = {}) {
  const idleMs = Number(opts.idleMs || 30000);
  const totalMs = Number(opts.totalMs || 300000);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    let idleTimer = null;
    let totalTimer = null;
    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };
    const settle = (err, buf) => {
      if (done) return;
      done = true;
      cleanup();
      // 出错时不要把 socket 直接 destroy（否则客户端只看到连接重置，收不到 413/408），
      // 交给调用方回响应并带 Connection: close；这里暂停读取，避免继续缓冲垃圾数据。
      if (err) { try { req.pause(); } catch { /* 忽略 */ } reject(err); return; }
      resolve(buf);
    };
    const tooLarge = () => {
      const err = new Error(`请求体过大（上限 ${Math.max(1, Math.round(maxBytes / 1048576))} MB）`);
      err.status = 413; err.code = 'ETOOLARGE';
      settle(err);
    };
    const onData = (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) { tooLarge(); return; }
      chunks.push(c);
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = setTimeout(onTimeout, idleMs); }
    };
    const onTimeout = (kind) => {
      const secs = Math.round((kind === 'idle' ? idleMs : totalMs) / 1000);
      const err = new Error(kind === 'idle' ? `请求体接收超时（${secs} 秒没有新数据）` : `请求体读取总时长超时（${secs} 秒）`);
      err.status = 408; err.code = 'ETIMEDOUT';
      settle(err);
    };
    const onEnd = () => { if (!done) settle(null, Buffer.concat(chunks)); };
    const onError = (e) => { if (!done) settle(e); };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    idleTimer = setTimeout(() => onTimeout('idle'), idleMs);
    totalTimer = setTimeout(() => onTimeout('total'), totalMs);
  });
}

async function readJson(req, maxBytes, opts) {
  const buf = await readBody(req, maxBytes, opts);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { const err = new Error('请求体不是合法 JSON'); err.status = 400; err.code = 'EBADJSON'; throw err; }
}

/** 把请求体保存为临时文件，返回路径（调用方负责删除） */
function bodyToTempFile(buf, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`);
  fs.writeFileSync(file, buf);
  return file;
}

function streamFile(res, file, opts = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return fail(res, 404, '文件不存在或已被删除', 'ENOENT'); }
  if (!st.isFile()) return fail(res, 404, '不是文件', 'ENOENT');
  const req = res.req;
  const method = (req && req.method) || 'GET';
  const headers = {
    'content-type': opts.contentType || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'last-modified': st.mtime.toUTCString(),
    'accept-ranges': 'bytes',
  };
  if (opts.download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
  if (opts.cache) headers['cache-control'] = opts.cache;
  // HEAD：只回头部，不打开文件流（避免白白读完整个 tarball）
  if (method === 'HEAD') {
    headers['content-length'] = st.size;
    res.writeHead(200, headers);
    return res.end();
  }
  // 0 字节文件：createReadStream 在 size-1 = -1 时会抛 ERR_OUT_OF_RANGE，必须提前返回空响应
  if (st.size === 0) {
    headers['content-length'] = 0;
    res.writeHead(200, headers);
    return res.end();
  }
  // Range 请求：支持单段断点续传（npm / 下载器断点续传会用到）
  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const range = opts.allowRange === false ? '' : String((req && req.headers.range) || '');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') {
        const suffix = Math.min(Number(m[2]) || 0, st.size);
        start = st.size - suffix;
      } else {
        start = Number(m[1]) || 0;
        end = m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
    }
  }
  headers['content-length'] = end - start + 1;
  res.writeHead(status, headers);
  const rs = fs.createReadStream(file, { start, end });
  let closed = false;
  const destroy = () => { if (!closed) { closed = true; rs.destroy(); } };
  res.on('close', destroy);
  rs.on('error', () => { try { res.destroy(); } catch { /* 忽略 */ } });
  rs.on('end', () => { closed = true; });
  rs.pipe(res);
  return true;
}

/** 依据请求头还原访问地址，例如 http://127.0.0.1:4873。
 *  Host 头不可信任（可能被伪造成任意字符串/域名），只接受合法 host[:port] 形式，否则回退到配置地址。 */
function baseFor(req, fallback) {
  const host = String((req && req.headers && req.headers.host) || '').trim();
  if (host && host.length <= 255 && /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return `http://${host}`;
  return fallback || '';
}

function clientIp(req) {
  return (req.socket && (req.socket.remoteAddress || '')) || '';
}

/** 列出本机局域网 IPv4 地址 */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function lanUrls(port) {
  return lanAddresses().map(ip => `http://${ip}:${port}`);
}

/** 访问地址（0.0.0.0 时用回环地址展示） */
function registryUrl(cfg) {
  const ip = !cfg.server.ip || cfg.server.ip === '0.0.0.0' || cfg.server.ip === '::' ? '127.0.0.1' : cfg.server.ip;
  return `http://${ip}:${cfg.server.port}`;
}

function hostName(hostHeader) {
  let h = String(hostHeader || '').trim();
  if (!h) return '';
  if (h.startsWith('[')) { const i = h.indexOf(']'); return i > 0 ? h.slice(1, i) : h; }
  return h.split(':')[0];
}

/**
 * 管理接口的 Host 白名单校验：防止「DNS 重绑定」把本机管理接口暴露给恶意网页。
 * 允许：本机回环、localhost、配置的绑定 IP、本机所有网卡地址。
 * 若带了 Origin 头，还要求 Origin 的主机与 Host 一致（同源）。
 */
function hostAllowed(req, cfg) {
  const host = hostName(req.headers.host);
  if (!host) return false;
  if (host === 'localhost' || isLoopback(host)) return true;
  if (host === String(cfg.server.ip || '')) return true;
  if (lanAddresses().includes(host)) return true;
  // 允许本机名访问（例如 http://my-pc:4873），但拒绝任意外部域名，防 DNS 重绑定
  try { if (os.hostname && host.toLowerCase() === String(os.hostname()).toLowerCase()) return true; } catch { /* 忽略 */ }
  return false;
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;              // npm / curl / 测试脚本等非浏览器客户端不带 Origin
  if (String(origin) === 'null') return false;   // 沙箱 iframe / file:// 页面的不透明来源：拒绝，防 CSRF
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const o = `${u.hostname.toLowerCase()}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
    const h = new URL(`http://${req.headers.host}`);
    const r = `${h.hostname.toLowerCase()}:${h.port || '80'}`;
    return o === r;
  } catch { return false; }
}

module.exports = {
  MIME, sendJson, ok, fail, sendText, readBody, readJson, bodyToTempFile,
  streamFile, baseFor, clientIp, lanAddresses, lanUrls, registryUrl, hostName, hostAllowed, originAllowed,
};
