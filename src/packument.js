'use strict';
/*
 * npm 元数据响应加速（按 npm 客户端惯例做优化）：
 *
 * 1. 内容协商：npm/pnpm/yarn 请求 packument 时会带
 *    `Accept: application/vnd.npm.install-v1+json`（简称 install-v1 / 精简格式 / corgi）。
 *    它们**只需要安装用字段**，但完整文档里还带着 readme、time、维护者、全部版本详情等，
 *    大包能到 10MB 以上（实测本机 typescript 的 packument.json 有 10.9MB）。
 *    这里为精简请求生成「只保留安装字段」的文档，极大减少 CPU（JSON.stringify）与网络字节。
 *
 * 2. 压缩：npm 默认接受 gzip。JSON 元数据压缩率很高（通常 10%~25%），
 *    大包从 10.9MB 降到 1MB 左右，内网/回环也能明显减少传输时间。
 *
 * 3. 内存缓存：同一个包（同一个版本状态，用 meta.updatedAt 区分）的序列化结果缓存在内存中，
 *    后续请求直接复用 Buffer（gzip 结果也懒加载缓存），不再反复 readFile+JSON.parse+JSON.stringify。
 *
 * 4. ETag：按「包名 + updatedAt + 格式」生成。npm 每次安装都会发 If-None-Match 重新验证，
 *    命中时直接 304，连 packument.json 都不用读（registry.js 的早期 304 分支配合使用）。
 */
const zlib = require('node:zlib');

/**
 * zlib.gzip 的 Promise 封装。
 * 注意：Node 的 zlib 回调式 API 中 callback 是必填参数，`zlib.gzip(buf, {level:6})`
 * 不带回调会直接抛 ERR_INVALID_ARG_TYPE（不同 Node 版本行为不一致，这里显式封装最稳）。
 */
function gzipAsync(buf, opts) {
  return new Promise((resolve, reject) => {
    zlib.gzip(buf, opts, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

/** npm 的 install-v1 Accept 头 */
const ABBREV_ACCEPT_RE = /application\/vnd\.npm\.install-v1\+json/i;

/**
 * 精简格式每个版本保留的字段（对应 npm registry 的 corgi 文档）。
 * 安装时真正会被 npm/pnpm 用到的字段都在这里；devDependencies 故意不保留（安装第三方包时用不到，
 * 而它往往是版本对象里最大的字段之一）。
 */
const ABBREV_VERSION_KEYS = [
  'name', 'version', 'dist',
  'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
  'bundleDependencies', 'bundledDependencies',
  'bin', 'directories', 'engines', 'os', 'cpu', 'libc',
  'deprecated', '_hasShrinkwrap', 'hasInstallScript',
  'scripts', // 只保留 preinstall/install/postinstall 判断用，见 sanitizeVersionInAbbrev
];

/** 缓存上限：桌面工具场景下足够覆盖常用包；超过后按最久未使用淘汰 */
const CACHE_MAX_BYTES = 96 * 1024 * 1024;
const CACHE_MAX_ITEMS = 512;
/** 小于该长度的响应不压缩（gzip 头本身就有开销） */
const GZIP_MIN_BYTES = 1024;

const cache = new Map(); // key -> { body, gz, gzPromise, bytes }
let cacheBytes = 0;

function wantsAbbreviated(req) {
  const accept = String((req && req.headers && req.headers.accept) || '');
  return ABBREV_ACCEPT_RE.test(accept);
}

/** 客户端是否接受 gzip（忽略显式 q=0 的少数情况） */
function acceptsGzip(req) {
  const raw = String((req && req.headers && req.headers['accept-encoding']) || '');
  if (!raw) return false;
  if (!/\bgzip\b/i.test(raw)) return false;
  return !/\bgzip\s*;\s*q=0(?:[.,;]|$)/i.test(raw);
}

/** 稳定的弱 ETag：格式不同（精简/完整）etag 必须不同，否则客户端会拿精简响应去校验完整请求 */
function etagFor(name, updatedAt, variant) {
  const suffix = variant === 'abbrev' ? '-abbrev' : '';
  return `W/"${name}-${updatedAt || ''}${suffix}"`;
}

/** If-None-Match 容错比较：支持多值、W/ 弱前缀与 *（npm 回传的一般是完整 etag） */
function etagMatches(header, etag) {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(',') : String(header);
  const target = etag.replace(/^W\//, '');
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (!t) continue;
    if (t === '*') return true;
    if (t.replace(/^W\//, '') === target) return true;
  }
  return false;
}

/** 精简版本对象：只保留白名单字段，并把 scripts 裁成「是否有安装脚本」 */
function abbreviateVersion(manifest, name, version, base, file) {
  const out = {};
  for (const key of ABBREV_VERSION_KEYS) {
    const v = manifest[key];
    if (v === undefined) continue;
    out[key] = v;
  }
  out.name = manifest.name || name;
  out.version = manifest.version || version;
  out.dist = { ...(manifest.dist || {}), tarball: `${base}/${name}/-/${file}` };
  if (manifest.scripts && typeof manifest.scripts === 'object') {
    const s = manifest.scripts;
    if (s.preinstall || s.install || s.postinstall) {
      out.hasInstallScript = true;
      out.scripts = {};
      for (const k of ['preinstall', 'install', 'postinstall']) if (s[k]) out.scripts[k] = s[k];
    } else {
      delete out.scripts;
    }
  }
  return out;
}

/** 生成响应文档（不修改原 packument，避免并发请求互相污染） */
function buildDoc({ name, packument, base, variant, meta, rev, tarballFile }) {
  const versions = (packument && packument.versions) || {};
  if (variant === 'abbrev') {
    const outVersions = {};
    for (const [v, manifest] of Object.entries(versions)) {
      if (!manifest || typeof manifest !== 'object') continue;
      outVersions[v] = abbreviateVersion(manifest, name, v, base, tarballFile(v));
    }
    const tags = (packument && packument['dist-tags']) || {};
    const doc = {
      _id: name,
      name,
      'dist-tags': tags && typeof tags === 'object' ? { ...tags } : {},
      versions: outVersions,
    };
    if (meta && meta.updatedAt) doc.modified = meta.updatedAt;
    return doc;
  }
  const out = { ...(packument || {}), versions: {} };
  for (const [v, manifest] of Object.entries(versions)) {
    if (!manifest || typeof manifest !== 'object') continue;
    out.versions[v] = {
      ...manifest,
      dist: { ...(manifest.dist || {}), tarball: `${base}/${name}/-/${tarballFile(v)}` },
    };
  }
  delete out._attachments;
  delete out._rev;
  out._id = out._id || name;
  out._rev = rev;
  return out;
}

function cacheKey(name, updatedAt, variant, base) {
  return `${variant}\u0000${name}\u0000${updatedAt || ''}\u0000${base}`;
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  // LRU：命中后移到队尾（Map 保持插入顺序，淘汰时从队首取）
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function cacheSet(key, entry) {
  cache.set(key, entry);
  cacheBytes += entry.bytes;
  while (cache.size > CACHE_MAX_ITEMS || cacheBytes > CACHE_MAX_BYTES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    cacheBytes -= (oldest && oldest.bytes) || 0;
  }
}

function gzipEntry(entry) {
  if (entry.gz) return Promise.resolve(entry.gz);
  if (!entry.gzPromise) {
    entry.gzPromise = gzipAsync(entry.body, { level: 6 })
      .then((buf) => {
        entry.gz = buf;
        entry.bytes = entry.body.length + buf.length;
        cacheBytes += buf.length;
        // 追加 gzip 字节后可能超限：按当前缓存总量做一次淘汰（不影响正在返回的响应）
        while (cache.size > CACHE_MAX_ITEMS || cacheBytes > CACHE_MAX_BYTES) {
          const oldestKey = cache.keys().next().value;
          if (oldestKey === undefined) break;
          const oldest = cache.get(oldestKey);
          cache.delete(oldestKey);
          cacheBytes -= (oldest && oldest.bytes) || 0;
        }
        return buf;
      })
      .catch((e) => { entry.gzPromise = null; throw e; });
  }
  return entry.gzPromise;
}

/** 查询缓存条目（命中会刷新 LRU 次序）；未命中返回 null */
function lookup({ name, updatedAt, variant, base }) {
  return cacheGet(cacheKey(name, updatedAt, variant, base));
}

/** 把缓存条目编码成线上 payload（按需 gzip） */
async function encode(entry, req) {
  if (acceptsGzip(req) && entry.body.length >= GZIP_MIN_BYTES) {
    try {
      const gz = await gzipEntry(entry);
      return { body: gz, encoding: 'gzip' };
    } catch { /* 压缩失败就退化为明文，不影响安装 */ }
  }
  return { body: entry.body, encoding: null };
}

/**
 * 取/构建响应 payload。
 * @returns {Promise<{body:Buffer, encoding:null|'gzip'}>}
 */
async function render({ name, rec, base, variant, store, rev, req }) {
  const meta = (rec && rec.meta) || {};
  let entry = lookup({ name, updatedAt: meta.updatedAt, variant, base });
  if (!entry) {
    const tarballFile = (v) => (store && typeof store.tarballFileName === 'function' ? store.tarballFileName(name, v) : `${name.split('/').pop()}-${v}.tgz`);
    const doc = buildDoc({ name, packument: rec && rec.packument, base, variant, meta, rev, tarballFile });
    const body = Buffer.from(JSON.stringify(doc), 'utf8');
    entry = { body, gz: null, gzPromise: null, bytes: body.length };
    cacheSet(cacheKey(name, meta.updatedAt, variant, base), entry);
  }
  return encode(entry, req);
}

/** 测试/调试用：查看缓存状态；服务运行中不需要调用 */
function cacheStats() {
  return { items: cache.size, bytes: cacheBytes, maxBytes: CACHE_MAX_BYTES, maxItems: CACHE_MAX_ITEMS };
}

function clearCache() {
  cache.clear();
  cacheBytes = 0;
}

module.exports = {
  wantsAbbreviated, acceptsGzip, etagFor, etagMatches, lookup, encode, render, cacheStats, clearCache,
  ABBREV_VERSION_KEYS,
};
