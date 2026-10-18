'use strict';
/* 上游公共源客户端：拉取元数据、下载 tarball、搜索。纯离线模式下全部拒绝外网 */
const net = require('node:net');
const crypto = require('node:crypto');
const { integrityOf, sha1hex, sleep } = require('./util');

const UA = 'npm-private-mirror/1.0 (+local offline mirror)';
const MAX_REDIRECTS = 5;
const DEFAULT_METADATA_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_ERROR_BODY_MAX_BYTES = 64 * 1024;
const DEFAULT_TARBALL_MAX_BYTES = 512 * 1024 * 1024;

function normalizeHost(h) {
  return String(h || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function ipv4IsPrivate(host) {
  const parts = String(host).split('.');
  if (parts.length !== 4) return true;
  const o = parts.map(Number);
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o;
  // 0/8、10/8、127/8、169.254/16、172.16/12、192.168/16、100.64/10、组播/保留
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function ipv6IsPrivate(host) {
  const h = normalizeHost(host);
  if (h === '::' || h === '::1') return true;
  if (h.startsWith('::ffff:')) {
    const rest = h.slice(7);
    if (net.isIP(rest) === 4) return ipv4IsPrivate(rest);
    const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (m) {
      const hi = parseInt(m[1], 16);
      const lo = parseInt(m[2], 16);
      return ipv4IsPrivate(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return true;
  }
  const firstHex = h.split(':')[0] || '0';
  const first = parseInt(firstHex, 16);
  if (!Number.isFinite(first)) return true;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地地址
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 组播
  return false;
}

/** 判断主机名是否指向本机/内网/链路本地（IP 字面量按网段判定，域名按后缀判定） */
function isPrivateHost(h) {
  const host = normalizeHost(h);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    return true;
  }
  const kind = net.isIP(host);
  if (kind === 4) return ipv4IsPrivate(host);
  if (kind === 6) return ipv6IsPrivate(host);
  return false;
}

/**
 * 上游 tarball / 重定向目标只允许来自配置的上游源（含其 CDN 子域），防止元数据里的恶意 URL 把
 * 服务端引去访问内网（SSRF）。公共源常把 tarball 重定向到 CDN（registry.npmmirror.com →
 * cdn.npmmirror.com），因此允许「同一主域名下的子域」，同时拒绝本机/内网地址。
 * denyPrivate=true 时即使目标与上游同主机，也拒绝私网/回环地址（用于重定向目标）。
 */
function assertSameHost(registry, url, { denyPrivate = false } = {}) {
  let u = null;
  let r = null;
  try { u = new URL(url); } catch { u = null; }
  try { r = new URL(registry); } catch { r = null; }
  const deny = (why) => {
    const err = new Error(`拒绝访问该地址（${why}）：${url}`);
    err.code = 'EREMOTEHOST';
    throw err;
  };
  if (!u || !r || !u.hostname) return deny('地址不合法');
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return deny('仅支持 http/https');
  const host = normalizeHost(u.hostname);
  const rhost = normalizeHost(r.hostname);
  if (denyPrivate && isPrivateHost(host)) return deny('指向本机或内网地址');
  if (host === rhost) return;
  // 配置的上游是 IP 时只允许完全相同的主机，避免把任意域名当作 CDN
  const registryIsIp = net.isIP(rhost) !== 0;
  const rootOf = (h) => { const p = h.split('.'); return p.length >= 2 ? p.slice(-2).join('.') : h; };
  const sameSite = !registryIsIp && rootOf(host) === rootOf(rhost);
  if (!sameSite) return deny('与上游源不是同一主域名');
  if (isPrivateHost(host)) return deny('指向本机或内网地址');
}

/**
 * 上游源本身是公网地址时才禁止访问私网（防 SSRF）；
 * 用户故意把 registry 配成本机/内网地址（局域网私有源）时不能反过来把自己拦死。
 */
function registryIsPublic(registryUrl) {
  try { return !isPrivateHost(new URL(registryUrl).hostname); } catch { return true; }
}

function cancelBody(res) {
  if (!res) return;
  try {
    if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
  } catch { /* 忽略 */ }
}

function disposeResponse(res) {
  if (!res || typeof res.__mirrorDispose !== 'function') return;
  try { res.__mirrorDispose(); } catch { /* 忽略 */ }
  res.__mirrorDispose = null;
}

/**
 * 读取响应体：超时覆盖整个 body 读取过程，并且限制最大字节数。
 * 超限时主动取消 body；超时时通过 __mirrorAbort 中断底层请求。
 */
async function readBodyBuffer(res, { timeoutMs, maxBytes = DEFAULT_METADATA_MAX_BYTES, label = '上游响应读取超时', onProgress = null } = {}) {
  let timer = null;
  let reader = null;
  let timedOut = false;
  const limit = Math.max(1, Number(maxBytes) || DEFAULT_METADATA_MAX_BYTES);
  const chunks = [];
  let total = 0;
  try {
    const declared = res.headers && typeof res.headers.get === 'function'
      ? Number(res.headers.get('content-length'))
      : NaN;
    if (Number.isFinite(declared) && declared > limit) {
      const err = new Error(`上游响应体超过大小上限（Content-Length ${declared} > ${limit} 字节）: ${label}`);
      err.code = 'ETOOLARGE';
      throw err;
    }
    if (!res.body) return Buffer.alloc(0);
    reader = res.body.getReader();
    timer = setTimeout(() => {
      timedOut = true;
      try { if (typeof res.__mirrorAbort === 'function') res.__mirrorAbort(); } catch { /* 忽略 */ }
      try { reader.cancel().catch(() => {}); } catch { /* 忽略 */ }
    }, Math.max(1, Number(timeoutMs) || 30000));
    if (typeof timer.unref === 'function') timer.unref();
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      const value = step.value;
      if (!value || !value.length) continue;
      total += value.length;
      if (total > limit) {
        const err = new Error(`上游响应体超过大小上限（> ${limit} 字节）: ${label}`);
        err.code = 'ETOOLARGE';
        try { await reader.cancel(); } catch { /* 忽略 */ }
        throw err;
      }
      chunks.push(Buffer.from(value));
      // 实时字节进度：给「正在下载的每个版本」显示收到多少 / 总共多少（declared 缺失时为 0）
      if (typeof onProgress === 'function') {
        try { onProgress(total, Number.isFinite(declared) ? declared : 0); } catch { /* 进度回调异常不影响下载 */ }
      }
    }
    if (timedOut) {
      const err = new Error(label);
      err.code = 'ETIMEDOUT';
      throw err;
    }
    return Buffer.concat(chunks, total);
  } catch (e) {
    if (timedOut || (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR'))) {
      const err = new Error(label);
      err.code = 'ETIMEDOUT';
      throw err;
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    disposeResponse(res);
  }
}

/** 读取并解析 JSON（响应体读取受 timeoutMs / maxBytes 约束） */
async function readJsonBody(res, { url, timeoutMs, maxBytes = DEFAULT_METADATA_MAX_BYTES }) {
  const buf = await readBodyBuffer(res, {
    timeoutMs,
    maxBytes,
    label: `上游响应读取超时: ${url}`,
  });
  if (!buf.length) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    const err = new Error(`上游返回的 JSON 无法解析: ${url}`);
    err.code = 'EBADJSON';
    throw err;
  }
}

/**
 * 校验 SRI：expectedIntegrity 允许 `sha512-<b64> sha1-<hex>` 这类多哈希（空格分隔），
 * 识别 sha512/sha256/sha1，任意一个匹配即通过。返回 true/false，无法识别时返回 null。
 */
function integrityMatches(expectedIntegrity, buf) {
  const tokens = String(expectedIntegrity).trim().split(/\s+/).filter(Boolean);
  const parsed = [];
  for (const tok of tokens) {
    const m = /^(sha512|sha256|sha1)-([A-Za-z0-9+/=_-]+)$/.exec(tok);
    if (m) parsed.push({ algorithm: m[1], digest: m[2] });
  }
  if (!parsed.length) return null;
  const cache = Object.create(null);
  const b64 = (alg) => {
    if (!cache[alg]) {
      cache[alg] = crypto.createHash(alg).update(buf).digest('base64').replace(/=+$/, '');
    }
    return cache[alg];
  };
  for (const t of parsed) {
    // npm 的 dist.shasum 形式：sha1-<40 位 hex>
    if (t.algorithm === 'sha1' && /^[0-9a-f]{40}$/i.test(t.digest)) {
      if (crypto.createHash('sha1').update(buf).digest('hex') === t.digest.toLowerCase()) return true;
      continue;
    }
    const expected = t.digest.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (b64(t.algorithm) === expected) return true;
  }
  return false;
}

/** 对照元数据里的 dist.integrity / dist.shasum 校验刚下载的 tarball，防止上游返回被篡改/串包的内容 */
function verifyDownload(buf, expectedIntegrity, expectedShasum, url, log) {
  if (expectedIntegrity) {
    const matched = integrityMatches(expectedIntegrity, buf);
    if (matched === true) return;
    if (matched === false) {
      const err = new Error(`tarball 完整性校验失败（integrity 不匹配）: ${url}`);
      err.code = 'EINTEGRITY';
      throw err;
    }
    // integrity 存在但格式无法识别：有 shasum 时退回 shasum，否则只能拒绝
    if (!expectedShasum) {
      if (log && typeof log.warn === 'function') {
        log.warn('upstream', `无法识别的 integrity 格式，拒绝校验: ${url}`);
      }
      const err = new Error(`tarball 完整性校验失败（integrity 格式不受支持）: ${url}`);
      err.code = 'EINTEGRITY';
      throw err;
    }
  }
  if (expectedShasum) {
    const got = sha1hex(buf);
    if (got !== String(expectedShasum).toLowerCase()) {
      const err = new Error(`tarball 完整性校验失败（shasum 不匹配）: ${url}`);
      err.code = 'EINTEGRITY';
      throw err;
    }
    return;
  }
  if (!expectedIntegrity) {
    // 元数据既没有 integrity 也没有 shasum：无法校验，但不能静默放过
    if (log && typeof log.warn === 'function') {
      log.warn('upstream', `上游元数据缺少 integrity/shasum，已跳过完整性校验: ${url}`);
    }
  }
}

function downloadTimeoutMs(upstreamCfg) {
  return Math.max(60000, Number((upstreamCfg && upstreamCfg.timeoutMs) || 30000) * 4);
}

function tarballMaxBytes(upstreamCfg, overrideBytes) {
  const o = Number(overrideBytes);
  if (Number.isFinite(o) && o > 0) return Math.floor(o);
  const mb = Number(upstreamCfg && upstreamCfg.maxTarballMB);
  if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * 1024 * 1024);
  return DEFAULT_TARBALL_MAX_BYTES;
}

function retryAfterMs(value) {
  if (!value) return 1000;
  const s = String(value).trim();
  const n = Number(s);
  if (Number.isFinite(n)) return Math.max(0, Math.min(n * 1000, 30000));
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.max(0, Math.min(t - Date.now(), 30000));
  return 1000;
}

/** 取 URL 的 pathname（tarball 相对路径），非法 URL 返回空串 */
function tarballPathOf(tarballUrl) {
  try {
    const p = new URL(String(tarballUrl)).pathname;
    return p && p !== '/' ? p : '';
  } catch {
    return '';
  }
}

/** URL 的主机名（带端口），用于日志/镜像标签 */
function hostOfUrl(url) {
  try { return new URL(String(url)).host; } catch { return ''; }
}

/**
 * 根据上游元数据里的 dist.tarball 地址，算出每个加速镜像源上同一 tarball 的下载地址。
 * 直接复用原始 pathname（保留 @scope/name 与百分号编码），避免自己拼接包名时把 scoped 包拼错。
 * 配置的加速镜像源会先经过 config.sanitize 规整，这里再做一次兜底过滤。
 */
function buildMirrorCandidates(accelerators, tarballUrl) {
  const pathname = tarballPathOf(tarballUrl);
  if (!pathname) return [];
  const list = Array.isArray(accelerators) ? accelerators : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const base = String(raw == null ? '' : raw).trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/i.test(base)) continue;
    if (seen.has(base)) continue;
    seen.add(base);
    out.push({ url: base + pathname, registry: base, label: hostOfUrl(base) || base });
  }
  return out;
}

function isHeadUnsupported(err) {
  const status = Number(err && err.status);
  return status === 403 || status === 405 || status === 501;
}

class Upstream {
  constructor(cfgProvider, logger) {
    this.cfgProvider = cfgProvider;
    this.log = logger;
  }

  get cfg() { return this.cfgProvider().upstream; }
  get offline() { return this.cfgProvider().mode === 'offline'; }
  get registry() { return String(this.cfg.registry || '').replace(/\/+$/, ''); }
  get timeoutMs() { return Math.max(1, Number(this.cfg.timeoutMs || 30000)); }

  packageUrl(name) {
    return `${this.registry}/${encodeURIComponent(name).replace(/%40/g, '@')}`;
  }

  /**
   * 发起一次上游请求。
   * allowedRegistry：允许的重定向目标所属 registry（默认配置里的上游源；加速镜像源时传它自己的地址）。
   * allowPrivateRedirect：允许重定向到本机/内网（用户自己配置的加速镜像源可能是内网地址，默认只对加速镜像放开）。
   */
  async request(url, { accept, timeoutMs, retries, method = 'GET', body, headers = {}, allowedRegistry, allowPrivateRedirect = false } = {}) {
    if (this.offline) {
      const err = new Error('当前为纯离线模式，已禁止访问上游源');
      err.code = 'OFFLINE_MODE';
      throw err;
    }
    const timeout = Math.max(1, Number(timeoutMs || this.timeoutMs));
    const maxTries = (retries === undefined ? this.cfg.retries : retries) + 1;
    let attempt = 0;
    let rateRetries = 0;
    let lastErr = null;
    for (;;) {
      attempt++;
      const ac = new AbortController();
      const tid = setTimeout(() => ac.abort(), timeout);
      if (typeof tid.unref === 'function') tid.unref();
      let res = null;
      try {
        // 手动跟随重定向：每一跳都重新校验目标，避免 302 把请求带去内网
        let current = url;
        let hops = 0;
        for (;;) {
          res = await fetch(current, {
            method,
            body,
            signal: ac.signal,
            redirect: 'manual',
            headers: {
              'user-agent': UA,
              ...(accept ? { accept } : {}),
              ...(body ? { 'content-type': 'application/json' } : {}),
              ...headers,
            },
          });
          if (res.status >= 300 && res.status < 400 && res.status !== 304) {
            const loc = res.headers.get('location');
            cancelBody(res);
            if (!loc) {
              const err = new Error(`上游重定向缺少 Location: ${current}`);
              err.code = 'EREDIRECT';
              throw err;
            }
            if (hops >= MAX_REDIRECTS) {
              const err = new Error(`上游重定向超过 ${MAX_REDIRECTS} 跳: ${url}`);
              err.code = 'EREDIRECT';
              throw err;
            }
            let next = null;
            try { next = new URL(loc, current); } catch {
              const err = new Error(`上游重定向 Location 不合法: ${current}`);
              err.code = 'EREDIRECT';
              throw err;
            }
            if (next.protocol !== 'http:' && next.protocol !== 'https:') {
              const err = new Error(`上游重定向到不支持的协议（${next.protocol}）: ${current}`);
              err.code = 'EREDIRECT';
              throw err;
            }
            const redirectBase = allowedRegistry || this.registry;
            assertSameHost(redirectBase, next.href, {
              denyPrivate: !allowPrivateRedirect && registryIsPublic(redirectBase),
            });
            current = next.href;
            hops++;
            continue;
          }
          break;
        }
        // 超时与 body 读取绑定：由 readBodyBuffer 在读完/失败时调用 dispose
        res.__mirrorAbort = () => { try { ac.abort(); } catch { /* 忽略 */ } };
        res.__mirrorDispose = () => clearTimeout(tid);
        if (res.status === 404) {
          cancelBody(res);
          disposeResponse(res);
          return { notFound: true, status: 404 };
        }
        if (!res.ok) {
          const text = await readBodyBuffer(res, {
            timeoutMs: timeout,
            maxBytes: DEFAULT_ERROR_BODY_MAX_BYTES,
            label: `上游错误响应读取超时: ${url}`,
          }).catch(() => Buffer.alloc(0));
          const err = new Error(`上游返回 ${res.status}: ${text.toString('utf8').slice(0, 200)}`);
          err.status = res.status;
          if (res.status === 429) {
            // 429 按 Retry-After（缺省 1s）重试，最多 2 次；超过后不再走通用重试
            if (rateRetries < 2) {
              rateRetries++;
              lastErr = err;
              await sleep(retryAfterMs(res.headers.get('retry-after')));
              continue;
            }
            err.noRetry = true;
            throw err;
          }
          if ((res.status === 408 || res.status >= 500) && attempt < maxTries) {
            lastErr = err;
            await sleep(400 * attempt);
            continue;
          }
          throw err;
        }
        return { res };
      } catch (e) {
        disposeResponse(res);
        clearTimeout(tid);
        lastErr = e;
        if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) {
          lastErr = new Error(`上游请求超时（${timeout}ms）: ${url}`);
          lastErr.code = 'ETIMEDOUT';
        }
        // 4xx（404 已单独返回、408/429 已重试）属于确定的客户端/权限/资源问题，重试没有意义
        if (lastErr.noRetry) throw lastErr;
        if (lastErr.status && lastErr.status < 500 && lastErr.status !== 408 && lastErr.status !== 429) {
          throw lastErr;
        }
        if (attempt < maxTries) {
          await sleep(400 * attempt);
          continue;
        }
        throw lastErr;
      }
    }
  }

  /** 获取包元数据（默认精简格式，体积小速度快） */
  async getPackument(name) {
    const url = this.packageUrl(name);
    const accept = this.cfg.acceptAbbreviated === false
      ? 'application/json'
      : 'application/vnd.npm.install-v1+json, application/json;q=0.9';
    const { notFound, res } = await this.request(url, { accept });
    if (notFound) return null;
    const data = await readJsonBody(res, { url, timeoutMs: this.timeoutMs });
    if (!data || !data.versions) throw new Error(`上游返回的元数据不完整: ${name}`);
    return data;
  }

  /** 单个版本 manifest（含 description 等字段） */
  async getVersionManifest(name, version) {
    const url = `${this.packageUrl(name)}/${encodeURIComponent(version)}`;
    const { notFound, res } = await this.request(url, { accept: 'application/json' });
    if (notFound) return null;
    return readJsonBody(res, { url, timeoutMs: this.timeoutMs });
  }

  /**
   * 完整元数据（application/json）。
   * 精简格式（install-v1）通常**不含** `time`（每个版本的真实发布时间）与 description，
   * 所以需要展示真实发布时间/描述时得单独取一次完整文档（体积大得多，只在「添加/刷新」这类
   * 用户主动操作时调用，不放在 npm install 的懒加载路径上）。
   */
  async getFullPackument(name) {
    const url = this.packageUrl(name);
    const { notFound, res } = await this.request(url, {
      accept: 'application/json', retries: 1, timeoutMs: this.timeoutMs,
    });
    if (notFound) return null;
    const data = await readJsonBody(res, { url, timeoutMs: this.timeoutMs });
    if (!data || !data.versions) throw new Error(`上游返回的完整元数据不完整: ${name}`);
    return data;
  }

  /** 下载并返回 Buffer（小文件用）；带超时、大小上限与完整性校验；onProgress(received, total) 用于实时字节进度 */
  async downloadTarball(url, { expectedIntegrity, expectedShasum, maxBytes, onProgress, allowedRegistry, allowPrivateRedirect = false } = {}) {
    const registryBase = allowedRegistry || this.registry;
    const denyPrivateRedirect = !allowPrivateRedirect && registryIsPublic(registryBase);
    assertSameHost(registryBase, url);
    const timeout = downloadTimeoutMs(this.cfg);
    const limit = tarballMaxBytes(this.cfg, maxBytes);
    const { notFound, res } = await this.request(url, {
      accept: '*/*', retries: 1, timeoutMs: timeout, allowedRegistry, allowPrivateRedirect,
    });
    if (notFound) throw new Error(`上游 tarball 不存在(404): ${url}`);
    // 手动重定向后 res.url 是最终地址，再校验一次（双保险）
    try { assertSameHost(registryBase, res.url || url, { denyPrivate: denyPrivateRedirect }); } catch (e) {
      cancelBody(res);
      disposeResponse(res);
      throw e;
    }
    const buf = await readBodyBuffer(res, {
      timeoutMs: timeout,
      maxBytes: limit,
      label: `上游 tarball 下载超时: ${url}`,
      onProgress,
    });
    if (buf.length === 0) {
      const err = new Error(`上游 tarball 为空: ${url}`);
      err.code = 'EEMPTY';
      throw err;
    }
    verifyDownload(buf, expectedIntegrity, expectedShasum, url, this.log);
    return buf;
  }

  /**
   * 探测一个 tarball 地址是否可用、以及响应快慢（用于在多个加速镜像源里挑最快的）。
   * 优先 HEAD（只拿响应头、不下载 body）；若对方不支持 HEAD（403/405/501），退回 Range GET。
   * 返回 { ok, status, ms, error? }，永不抛异常。
   */
  async probeTarball(url, { allowedRegistry, allowPrivateRedirect = true, timeoutMs } = {}) {
    const started = Date.now();
    const probeTimeout = Math.max(1000, Number(timeoutMs) || 4000);
    try {
      const { notFound, res } = await this.request(url, {
        method: 'HEAD', accept: '*/*', retries: 0, timeoutMs: probeTimeout, allowedRegistry, allowPrivateRedirect,
      });
      if (notFound) return { ok: false, status: 404, ms: Date.now() - started };
      cancelBody(res);
      disposeResponse(res);
      return { ok: true, status: res.status, ms: Date.now() - started };
    } catch (e) {
      if (!isHeadUnsupported(e)) {
        return { ok: false, status: (e && e.status) || 0, ms: Date.now() - started, error: (e && e.message) || String(e) };
      }
      // HEAD 不被支持：用 GET + Range 只要响应头，不读 body
      try {
        const { notFound, res } = await this.request(url, {
          method: 'GET', headers: { range: 'bytes=0-0' }, accept: '*/*', retries: 0, timeoutMs: probeTimeout, allowedRegistry, allowPrivateRedirect,
        });
        if (notFound) return { ok: false, status: 404, ms: Date.now() - started };
        cancelBody(res);
        disposeResponse(res);
        return { ok: true, status: res.status, ms: Date.now() - started };
      } catch (e2) {
        return { ok: false, status: (e2 && e2.status) || 0, ms: Date.now() - started, error: (e2 && e2.message) || String(e2) };
      }
    }
  }

  /**
   * 下载 tarball：优先走加速镜像源，最后一个都不可用再回配置的上游源。
   * mirrors：buildMirrorCandidates() 生成（每项 { url, registry, label }）。
   * 策略：并行探测所有镜像 → 按耗时升序 → 依次尝试下载（失败自动换下一个）→ 全失败回上游。
   * 完整性校验始终执行（用上游元数据里的 integrity/shasum），不会因为换源而降低安全性。
   * 返回 { buf, source: 'mirror'|'upstream', mirror?, url, probeMs?, ms? }。
   */
  async downloadTarballPreferred(primaryUrl, mirrors = [], opts = {}) {
    const list = (Array.isArray(mirrors) ? mirrors : []).filter(m => m && m.url);
    if (!this.offline && list.length) {
      const probes = await Promise.all(list.map(m => this.probeTarball(m.url, {
        allowedRegistry: m.registry, allowPrivateRedirect: true,
      }).then(p => Object.assign({}, p, m))));
      const usable = probes.filter(p => p.ok).sort((a, b) => a.ms - b.ms);
      if (this.log && this.log.debug) {
        this.log.debug(`加速镜像探测：${probes.map(p => `${p.label}=${p.ok ? p.ms + 'ms' : '不可用'}`).join('，') || '无候选'}`);
      }
      for (const m of usable) {
        try {
          const started = Date.now();
          const buf = await this.downloadTarball(m.url, {
            expectedIntegrity: opts.expectedIntegrity,
            expectedShasum: opts.expectedShasum,
            maxBytes: opts.maxBytes,
            onProgress: opts.onProgress,
            allowedRegistry: m.registry,
            allowPrivateRedirect: true,
          });
          return { buf, source: 'mirror', mirror: m.label, url: m.url, probeMs: m.ms, ms: Date.now() - started };
        } catch (e) {
          if (this.log && this.log.debug) this.log.debug(`加速镜像下载失败（${m.url}）：${e.message}`);
        }
      }
    }
    const started = Date.now();
    const buf = await this.downloadTarball(primaryUrl, {
      expectedIntegrity: opts.expectedIntegrity,
      expectedShasum: opts.expectedShasum,
      maxBytes: opts.maxBytes,
      onProgress: opts.onProgress,
    });
    return { buf, source: 'upstream', url: primaryUrl, ms: Date.now() - started };
  }

  async search(text, size = 20) {
    const url = `${this.registry}/-/v1/search?text=${encodeURIComponent(text)}&size=${size}`;
    const { notFound, res } = await this.request(url, { accept: 'application/json', retries: 0 });
    if (notFound) return [];
    const data = await readJsonBody(res, { url, timeoutMs: this.timeoutMs });
    return (data.objects || []).map(o => ({
      name: o.package && o.package.name,
      version: o.package && o.package.version,
      description: o.package && o.package.description,
      date: o.package && o.package.date,
    })).filter(x => x.name);
  }

  async ping() {
    if (this.offline) return { reachable: false, reason: '纯离线模式' };
    try {
      const { res } = await this.request(`${this.registry}/is-number`, {
        accept: 'application/vnd.npm.install-v1+json', timeoutMs: 8000, retries: 0,
      });
      cancelBody(res);
      disposeResponse(res);
      return { reachable: !!res, reason: '' };
    } catch (e) {
      return { reachable: false, reason: e.message };
    }
  }
}

module.exports = { Upstream, integrityOf, buildMirrorCandidates, tarballPathOf, hostOfUrl };
