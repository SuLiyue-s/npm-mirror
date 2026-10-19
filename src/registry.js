'use strict';
/* npm 注册表协议实现：安装/发布/取消发布/搜索/审计等，兼容 npm / pnpm / yarn 的标准请求 */
const fs = require('node:fs');
const path = require('node:path');
const {
  ok, fail, readJson, readBody, sendJson, streamFile, baseFor, hostAllowed,
} = require('./http-util');
const { nowIso, compareVersions, maxSatisfying, pkgBaseName, dataPath, isSafeVersion } = require('./util');
const packumentView = require('./packument');
const upstreamUtil = require('./upstream');

const NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

/** 同一包同一版本正在下载中的 Promise 表：并发请求共享同一次下载，避免重复回源与并发写文件 */
const tarballInflight = new Map();
/** 同一包首次回源 inflight 去重：并发请求共享同一次上游元数据拉取 */
const packumentInflight = new Map();
const fullPackumentInflight = new Map();

function sharedFetch(map, key, fn) {
  const inflight = map.get(key);
  if (inflight) return inflight;
  const p = Promise.resolve().then(fn);
  map.set(key, p);
  const done = () => { if (map.get(key) === p) map.delete(key); };
  p.then(done, done);
  return p;
}

/** 把 URL 路径拆成 { name, rest }，兼容 /@scope/name 与 /@scope%2fname */
function parsePkgPath(pathname) {
  const segs = pathname.split('/').filter(Boolean);
  if (!segs.length) return null;
  if (segs[0].startsWith('@') && !segs[0].includes('/')) {
    if (segs.length < 2) return null;
    return { name: `${segs[0]}/${segs[1]}`, rest: segs.slice(2) };
  }
  return { name: segs[0], rest: segs.slice(1) };
}

function validName(name) { return !!name && name.length <= 214 && NAME_RE.test(name); }

const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** dist-tag 名：必须是普通标识符，并拒绝原型链上的保留键（避免 __proto__ 之类污染） */
function validTag(tag) {
  if (typeof tag !== 'string' || !tag || tag.length > 214) return false;
  if (!TAG_RE.test(tag)) return false;
  const lower = tag.toLowerCase();
  return lower !== '__proto__' && lower !== 'constructor' && lower !== 'prototype';
}

/** 统一取（并按需初始化）packument 的 dist-tags，避免 rec.packument['dist-tags'] 为 undefined 时抛 500 */
function tagsOf(packument) {
  if (!packument['dist-tags'] || typeof packument['dist-tags'] !== 'object') {
    packument['dist-tags'] = Object.create(null);
  }
  return packument['dist-tags'];
}

function parseLevelLine(line) {
  const m = /^\[([^\]]+)\]\s+\[(\w+)\]\s+(.*)$/.exec(line);
  return m ? { time: m[1], level: m[2].toLowerCase(), msg: m[3] } : { time: null, level: 'info', msg: line };
}

/** 元数据是否超过 TTL（proxy 模式下用来决定是否回源刷新） */
function isStale(rec, ttlMs) {
  return isStaleMeta(rec && rec.meta, ttlMs);
}

/** 同上，但直接收 meta 对象：早期 304 快路径只有内存 meta，不需要读盘 */
function isStaleMeta(meta, ttlMs) {
  const last = meta && meta.lastFetchAt ? Date.parse(meta.lastFetchAt) : 0;
  if (!last) return true;
  return (Date.now() - last) > ttlMs;
}

/**
 * 真实发布时间只存在完整元数据的 `time` 字段里（精简格式 install-v1 通常没有）。
 * 这里判断拿到的元数据是否已经有可用的 time 映射。
 */
function hasPublishTimes(doc) {
  return !!(doc && doc.time && Object.keys(doc.time).length > 0);
}

/**
 * `time` 对版本列表的覆盖情况。精简格式即使带 `time` 也常常只覆盖最近若干版本
 * （实测 npmmirror：`npm` 精简 36 条 vs 完整 613 条，`typescript` 208 vs 3857），
 * 所以「有没有 time」不够，还要看**有多少版本真的能查到发布时间**。
 */
function publishTimeCoverage(doc) {
  const versions = (doc && doc.versions) ? Object.keys(doc.versions) : [];
  const times = (doc && doc.time) || {};
  let covered = 0;
  for (const v of versions) if (times[v]) covered++;
  return { covered, total: versions.length };
}

/**
 * 确保本地有该包的元数据：
 * - cache 模式：本地优先，未命中才回源并缓存（已缓存不再自动回源）
 * - proxy 模式：超过 metadataTtlSec 就回源刷新
 * - offline 模式：只读本地
 *
 * @param {{force?:boolean, full?:boolean, publishTime?:boolean}} opts
 *   force=true 强制回源；full=true 额外拉一次完整元数据，用来补齐每个版本的**真实发布时间**
 *   （`time`）、`description` 等只有完整文档才有的字段。npm install 这类懒加载路径不传 full，
 *   但只要精简元数据的 `time` 覆盖不全（实测 npmmirror 的精简格式常常只覆盖极少版本），
 *   也会自动补一次完整元数据；补过一次就记 `meta.publishTimeFull`，之后不再重复下载。
 *   publishTime=false 表示「这次调用完全不需要发布时间」——递归解析依赖树时会用，
 *   避免给几十个依赖各下一份完整文档（完整文档可达几十 MB）。
 */
async function ensurePackument(ctx, name, { force = false, full = false, publishTime = true } = {}) {
  const cfg = ctx.cfg();
  const mode = cfg.mode || 'cache';
  const local = ctx.store.get(name);
  // 私有包（本机发布/导入）绝不回源合并：否则公开上游的同名包版本、dist-tags 会混进私有包，
  // 让 npm install 拉到攻击者发布的 tarball（依赖混淆）；只有本地不存在的包才允许从上游补。
  const localPrivate = !!(local && local.meta && (local.meta.source === 'private' || local.meta.private));
  const ttlMs = Math.max(0, Number(cfg.upstream.metadataTtlSec || 300) * 1000);
  const wantFetch = mode !== 'offline' && !localPrivate
    && (force || !local || (mode === 'proxy' && isStale(local, ttlMs)));

  let fetched = null; let fetchError = null;
  if (wantFetch) {
    try { fetched = await sharedFetch(packumentInflight, name, () => ctx.upstream.getPackument(name)); }
    catch (e) { fetchError = e; }
  }

  // 需要真实发布时间却还没有 → 单独取一次完整元数据（失败不影响主流程，只是没有时间）。
  // `publishTimeFull` 记住「这个包已经拉过完整元数据」，避免每次 ensure 都多下一次（完整文档可达几十 MB）。
  let detail = null;
  const alreadyFull = !!(local && local.meta && local.meta.publishTimeFull);
  if (fetched && mode !== 'offline' && publishTime !== false && cfg.upstream.fetchPublishTime !== false) {
    const covFetched = publishTimeCoverage(fetched);
    const covLocal = publishTimeCoverage(local && local.packument);
    const incomplete = !hasPublishTimes(fetched) || !hasPublishTimes(local && local.packument)
      || (covFetched.total > 0 && covFetched.covered < covFetched.total)
      || (covLocal.total > 0 && covLocal.covered < covLocal.total);
    if (full || (!alreadyFull && incomplete)) {
      try { detail = await sharedFetch(fullPackumentInflight, name, () => ctx.upstream.getFullPackument(name)); }
      catch (e) { if (ctx.log) ctx.log.debug(`完整元数据获取失败 ${name}：${e.message}`); }
    }
  }

  if (fetched && fetched.versions) {
    await ctx.store.withLock(name, async () => {
      const cur = ctx.store.get(name);
      // 防御性再判一次：等待锁期间该包可能刚被发布成本地私有包，此时不能把上游数据合并进来
      if (cur && cur.meta && (cur.meta.source === 'private' || cur.meta.private)) return;
      const packument = cur
        ? cur.packument
        : { _id: name, name, description: fetched.description || '', 'dist-tags': {}, versions: {}, readme: '' };
      packument.versions = packument.versions || {};
      const tags = tagsOf(packument);
      const prevMeta = (cur && cur.meta) || {};
      const prevSizes = prevMeta.sizes || {};
      const files = {}; const sizes = {};
      for (const [v, m] of Object.entries(fetched.versions)) {
        if (!m || typeof m !== 'object') continue;
        const prev = packument.versions[v] || null;
        const prevDist = (prev && prev.dist) || {};
        const merged = { ...(prev || {}), ...m };
        // 本地已保存的 integrity/shasum 来自实际落盘的 tarball，优先于上游声明，避免被覆盖后失真
        const dist = { ...prevDist, ...((m && m.dist) || {}) };
        if (prevDist.integrity) dist.integrity = prevDist.integrity;
        if (prevDist.shasum) dist.shasum = prevDist.shasum;
        merged.dist = dist;
        packument.versions[v] = merged;
        const prevFile = prevMeta.files && prevMeta.files[v];
        if (prevFile && ctx.store.hasTarball(name, v)) {
          files[v] = prevFile;
          sizes[v] = Math.max(0, Number(prevSizes[v]) || 0);
        } else {
          const p = ctx.store.tarballPath(name, v);
          if (p) {
            files[v] = path.basename(p);
            try { sizes[v] = fs.statSync(p).size || 0; } catch { sizes[v] = 0; }
          } else {
            sizes[v] = 0;
          }
        }
      }
      // 上游 tag 必须合法且指向已存在的版本，才允许并入本地
      for (const [tag, v] of Object.entries(fetched['dist-tags'] || {})) {
        if (!validTag(tag) || typeof v !== 'string' || !packument.versions[v]) continue;
        tags[tag] = v;
      }
      if (!tags.latest) {
        const vs = Object.keys(packument.versions);
        if (vs.length) tags.latest = vs.sort(compareVersions).pop();
      }
      if (!packument.description && fetched.description) packument.description = fetched.description;
      // `time` 做并集合并（新的覆盖旧的），这样新版本也会拿到发布时间
      const times = Object.assign({}, (cur && cur.packument && cur.packument.time) || {}, fetched.time || {}, (detail && detail.time) || {});
      if (Object.keys(times).length) packument.time = times;
      // 描述性字段：只在本地还没有时补（readme 故意不取，完整文档里的 readme 可能有几 MB）
      for (const f of ['homepage', 'repository', 'license', 'keywords', 'maintainers', 'author', 'bugs', 'readme']) {
        if (fetched[f] !== undefined && packument[f] === undefined) packument[f] = fetched[f];
      }
      for (const f of ['homepage', 'repository', 'license', 'keywords', 'maintainers', 'author', 'bugs', 'description']) {
        if (detail && detail[f] !== undefined && (packument[f] === undefined || packument[f] === '')) packument[f] = detail[f];
      }
      const origins = {};
      for (const v of Object.keys(packument.versions)) {
        origins[v] = (cur && cur.meta && cur.meta.origins && cur.meta.origins[v]) || 'upstream';
      }
      ctx.store.save(name, packument, {
        source: (cur && cur.meta && cur.meta.source) || 'upstream',
        description: packument.description || '',
        lastFetchAt: nowIso(),
        files, sizes, origins,
        publishTimeCount: Object.keys(packument.time || {}).length,
        upstreamCreated: (packument.time && packument.time.created) || null,
        upstreamModified: (packument.time && packument.time.modified) || null,
        // 成功拉过完整元数据就记下来：之后不再为「发布时间」重复下整份文档
        publishTimeFull: detail ? true : alreadyFull,
      });
      if (ctx.log) {
        const cov = publishTimeCoverage(packument);
        ctx.log.debug(`已缓存元数据 ${name}（${Object.keys(fetched.versions).length} 个版本，`
          + `发布时间 ${cov.covered}/${cov.total} 个版本${detail ? '，已取完整元数据' : ''}）`);
      }
    });
    return ctx.store.get(name);
  }

  if (local) return local;
  if (fetchError) {
    if (fetchError.code === 'OFFLINE_MODE') return null;
    throw fetchError;
  }
  return null;
}

/**
 * 确保某个版本的 tarball 已在本地。
 * 返回 { path, reason }：path 非空=已可用；
 * path 为空时 reason 说明原因（cached/downloaded/offline/not-found/no-url），供调用方区分「下载失败」与「本来就没得下」。
 */
async function ensureTarballEx(ctx, name, version, opts) {
  const existing = ctx.store.tarballPath(name, version);
  if (existing) return { path: existing, reason: 'cached' };
  const cfg = ctx.cfg();
  if ((cfg.mode || 'cache') === 'offline') return { path: null, reason: 'offline' };
  const onProgress = opts && typeof opts.onProgress === 'function' ? opts.onProgress : null;

  // 同一个包同一版本并发请求时只下载一次，避免多个 npm install 同时触发重复下载与并发写同一文件
  const key = `${name}@${version}`;
  const now = tarballInflight.get(key);
  if (now) return now;
  const p = (async () => {
    try {
      let rec = ctx.store.get(name);
      if (!rec || !rec.packument.versions[version]) {
        await ensurePackument(ctx, name);
        rec = ctx.store.get(name);
      }
      if (!rec || !rec.packument.versions[version]) return { path: null, reason: 'not-found' };
      const manifest = rec.packument.versions[version];
      const url = manifest.dist && manifest.dist.tarball;
      if (!url || !/^https?:\/\//i.test(url)) return { path: null, reason: 'no-url' };
      // 加速镜像源：用上游元数据里的 dist.tarball 路径，换上每个加速镜像的地址。
      // 下载时并行探测各镜像速度，优先走「有该版本且响应最快」的镜像；全部不可用再回配置的上游源。
      const mirrors = upstreamUtil.buildMirrorCandidates(cfg.upstream && cfg.upstream.accelerators, url);
      // 校验上游元数据里声明的 integrity/shasum，拒绝内容与元数据不符的 tarball
      const got = await ctx.upstream.downloadTarballPreferred(url, mirrors, {
        expectedIntegrity: manifest.dist.integrity,
        expectedShasum: manifest.dist.shasum,
        onProgress,
      });
      const buf = got.buf;
      if (got.source === 'mirror' && ctx.log && typeof ctx.log.debug === 'function') {
        ctx.log.debug(`tarball ${name}@${version} 来自加速镜像 ${got.mirror}（探测 ${got.probeMs}ms，下载 ${got.ms}ms）`);
      }
      const info = ctx.store.putTarball(name, version, buf);
      await ctx.store.withLock(name, async () => {
        const r2 = ctx.store.get(name);
        if (!r2 || !r2.packument.versions[version]) return;
        const m = r2.packument.versions[version];
        r2.packument.versions[version] = {
          ...m,
          dist: { ...(m.dist || {}), integrity: info.integrity, shasum: info.shasum },
        };
        ctx.store.save(name, r2.packument, {
          files: { [version]: info.file },
          sizes: { [version]: info.sizeBytes },
          origins: { [version]: (r2.meta.origins && r2.meta.origins[version]) || 'upstream' },
        });
      });
      if (ctx.log) ctx.log.info(`按需缓存 tarball ${name}@${version} (${info.sizeBytes} 字节)`);
      return { path: info.path, reason: 'downloaded' };
    } finally {
      tarballInflight.delete(key);
    }
  })();
  tarballInflight.set(key, p);
  return p;
}

/** 确保某个版本的 tarball 已在本地；返回本地文件路径或 null */
async function ensureTarball(ctx, name, version) {
  const r = await ensureTarballEx(ctx, name, version);
  return r.path;
}

/** 把 reason 翻成人话（补 tarball 的任务结果里用） */
const TARBALL_REASON_TEXT = {
  offline: '当前是离线模式，不会访问上游',
  'not-found': '本地没有这个包/版本，上游也取不到元数据',
  'no-url': '元数据里没有 tarball 下载地址（只上传了 packument 的包或私有包，无法从上游补下载）',
};


/** 发布：_attachments 里带 tarball 的 PUT */
async function handlePublish(ctx, name) {
  const { req, res, url, store, log } = ctx;
  if (!ctx.auth.canWrite(req, url)) return fail(res, 401, '发布/修改需要访问令牌（X-Mirror-Token 或 Authorization: Bearer）', 'EAUTH');
  const maxBytes = Math.max(1, Number(ctx.cfg().storage.maxUploadMB || 500)) * 1024 * 1024;
  let body;
  try { body = await readJson(req, maxBytes); }
  catch (e) {
    const status = (e && e.status) || 400;
    return fail(res, status, `发布报文读取失败：${e.message}`, status === 413 ? 'ETOOLARGE' : 'EBADPAYLOAD');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(res, 400, '发布报文必须是 JSON 对象', 'EBADPAYLOAD');
  }

  const attachments = body._attachments || {};
  const attKeys = Object.keys(attachments);
  if (attachments && typeof attachments !== 'object') return fail(res, 400, '_attachments 必须是对象', 'EBADPAYLOAD');
  const bodyName = body.name || body._id;
  if (bodyName && bodyName !== name) return fail(res, 400, `发布报文中的包名(${bodyName})与地址(${name})不一致`, 'ENAME');

  if (!attKeys.length) {
    // 没有附件：视为元数据更新（npm deprecate / dist-tag / unstar 等）
    const local = store.get(name);
    if (!local) return fail(res, 404, `包 ${name} 不存在`, 'ENOTFOUND');
    let changed = 0;
    const deprecated = {};
    for (const [v, m] of Object.entries(body.versions || {})) {
      if (!local.packument.versions[v]) continue;
      if (m && typeof m === 'object' && m.deprecated !== undefined) {
        if (m.deprecated) {
          local.packument.versions[v].deprecated = m.deprecated;
          deprecated[v] = String(m.deprecated);
        } else {
          // 取消弃用：空字符串既清掉 packument 字段，也覆盖 meta.deprecated（store.save 的合并语义）
          delete local.packument.versions[v].deprecated;
          deprecated[v] = '';
        }
        changed++;
      }
    }
    for (const [tag, v] of Object.entries(body['dist-tags'] || {})) {
      if (!validTag(tag)) return fail(res, 400, `不合法的 dist-tag：${tag}`, 'ETAG');
      if (typeof v !== 'string' || !local.packument.versions[v]) continue;
      tagsOf(local.packument)[tag] = v;
      changed++;
    }
    if (body.description !== undefined) {
      if (typeof body.description !== 'string') return fail(res, 400, 'description 必须是字符串', 'EBADPAYLOAD');
      local.packument.description = body.description;
    }
    store.save(name, local.packument, { deprecated, description: local.packument.description || '' });
    log && log.info(`元数据更新 ${name}（${changed} 处变更）`);
    return sendJson(res, 201, { ok: true, id: name, rev: '1-0' });
  }

  // 真正的发布：逐个附件导入
  const tmpDir = dataPath('tmp');
  const published = [];
  try {
    for (const key of attKeys) {
      const att = attachments[key] || {};
      if (!att || typeof att !== 'object') return fail(res, 400, `附件 ${key} 格式不正确`, 'EBADATTACH');
      if (typeof att.data !== 'string' || !att.data) return fail(res, 400, `附件 ${key} 缺少 data 字段`, 'EBADATTACH');
      if (typeof att.length === 'number' && att.length > maxBytes) {
        return fail(res, 413, `附件 ${key} 过大（上限 ${Math.round(maxBytes / 1048576)} MB）`, 'ETOOLARGE');
      }
      const buf = Buffer.from(att.data, 'base64');
      if (!buf.length) return fail(res, 400, `附件 ${key} 不是有效的 base64 数据`, 'EBADATTACH');
      if (typeof att.length === 'number' && att.length !== buf.length) {
        return fail(res, 400, `附件 ${key} 长度校验失败（声明 ${att.length}，实际 ${buf.length}）`, 'EBADATTACH');
      }
      const tag = buf.toString('utf8');
      if (/^\s*\{\s*"error"/.test(tag)) return fail(res, 400, `附件 ${key} 不是有效的 tarball 数据`, 'EBADATTACH');
      const file = path.join(tmpDir, `publish-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tgz`);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(file, buf);
      try {
        const r = await ctx.bundle.importTarballFile({ store, file, overwrite: false, source: 'private' });
        if (r.name !== name) {
          // 报文包名与内容不符：回滚该版本
          store.deleteVersion(r.name, r.version);
          return fail(res, 400, `tarball 内的包名(${r.name})与地址(${name})不一致`, 'ENAME');
        }
        published.push(r);
      } catch (e) {
        if (e.code === 'EEXIST') return fail(res, 403, `版本已存在，不能覆盖发布：${name}（如需覆盖请先在界面删除该版本）`, 'EEXIST');
        return fail(res, 400, `发布失败：${e.message}`, e.code || 'EPUBLISH');
      } finally {
        try { fs.unlinkSync(file); } catch { /* 忽略 */ }
      }
    }
    // 应用报文里的 dist-tags
    const tags = body['dist-tags'] || {};
    if (Object.keys(tags).length) {
      const rec = store.get(name);
      if (rec) {
        for (const [t, v] of Object.entries(tags)) {
          if (!validTag(t)) continue;
          if (rec.packument.versions[v]) tagsOf(rec.packument)[t] = v;
        }
        store.save(name, rec.packument, { private: true, source: 'private' });
      }
    }
    log && log.info(`发布成功 ${name}@${published.map(p => p.version).join(',')}`);
    return sendJson(res, 201, { ok: true, id: name, rev: '1-0', versions: published.map(p => p.version) });
  } catch (e) {
    return fail(res, 500, `发布失败：${e.message}`, e.code || 'EPUBLISH');
  }
}

/** 版本解析：支持精确版本、dist-tag、semver 范围 */
function resolveVersion(packument, spec) {
  if (!packument || !packument.versions) return null;
  const tags = packument['dist-tags'] || {};
  if (tags[spec] && packument.versions[tags[spec]]) return tags[spec];
  if (packument.versions[spec]) return spec;
  const all = Object.keys(packument.versions);
  const best = maxSatisfying(all, spec);
  return best || null;
}

/** 由更新时间派生一个稳定的 _rev（形如 1-1750000000000），仅用于让客户端回传 */
function revisionOf(name, meta) {
  const digits = String((meta && meta.updatedAt) || '').replace(/\D/g, '');
  return `1-${digits.slice(-13) || '0'}`;
}

/** 统一写 packument 响应头（含 content-encoding / vary / etag） */
function writePackument(res, payload, { head = false } = {}) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.body.length,
    'cache-control': 'no-cache',
    vary: 'accept, accept-encoding',
  };
  if (payload.encoding) headers['content-encoding'] = payload.encoding;
  res.writeHead(200, headers);
  return res.end(head ? undefined : payload.body);
}

async function servePackument(ctx, name, { head = false } = {}) {
  const { req, res, url } = ctx;
  if (!ctx.auth.canRead(req, url)) return fail(res, 401, '读取需要访问令牌', 'EAUTH');
  const cfg = ctx.cfg();
  const mode = cfg.mode || 'cache';
  const store = ctx.store;
  /* npm 安装时带 `Accept: application/vnd.npm.install-v1+json`：返回精简格式（只含安装字段）。
   * 完整格式保留给网页/调试等其它客户端。两种格式的缓存与 ETag 相互独立。 */
  const variant = packumentView.wantsAbbreviated(req) ? 'abbrev' : 'full';
  const base = baseFor(req, ctx.registryUrl);

  /* 无回源需求时的快路径（npm install 的绝大多数请求都走这里）：
   *  1) If-None-Match 命中 → 直接 304，连 packument.json 都不读；
   *  2) 内存里已有相同 updatedAt 的序列化结果 → 直接回 Buffer（大包省掉 readFile+JSON.parse+stringify 的 60ms+）。
   * 以前这两种情况都要先 ensurePackument（读盘+解析几十 MB）再序列化，命中 304 也要白算一遍。 */
  const localMeta = store.metaOf(name);
  if (localMeta && !head && fs.existsSync(store.packumentPath(name))) {
    const ttlMs = Math.max(0, Number(cfg.upstream.metadataTtlSec || 300) * 1000);
    const localPrivate = localMeta.source === 'private' || !!localMeta.private;
    // 与 ensurePackument 的 wantFetch 判断保持一致：cache/offline 模式不会自动回源
    const fetchNeeded = mode !== 'offline' && !localPrivate
      && (mode === 'proxy' && isStaleMeta(localMeta, ttlMs));
    if (!fetchNeeded) {
      const fastEtag = packumentView.etagFor(name, localMeta.updatedAt, variant);
      if (packumentView.etagMatches(req.headers['if-none-match'], fastEtag)) {
        res.writeHead(304, { etag: fastEtag, 'cache-control': 'no-cache', vary: 'accept, accept-encoding' });
        return res.end();
      }
      const cachedEntry = packumentView.lookup({ name, updatedAt: localMeta.updatedAt, variant, base });
      if (cachedEntry) {
        res.setHeader && res.setHeader('etag', fastEtag);
        const payload = await packumentView.encode(cachedEntry, req);
        return writePackument(res, payload, { head: false });
      }
    }
  }

  let rec = null;
  try { rec = await ensurePackument(ctx, name); }
  catch (e) {
    const offline = e.code === 'OFFLINE_MODE';
    return fail(res, offline ? 404 : 502,
      offline ? `离线模式下本地没有包 ${name}` : `回源失败：${e.message}`,
      offline ? 'ENOTFOUND' : 'EUPSTREAM');
  }
  if (!rec) {
    const offline = (mode || 'cache') === 'offline';
    return fail(res, 404, offline
      ? `离线模式下本地没有包 ${name}（请先用「添加公共包」或在有网环境下导入）`
      : `包 ${name} 不存在（上游也没有找到）`, 'ENOTFOUND');
  }
  const meta = rec.meta || {};
  const rev = revisionOf(name, meta);
  const etag = packumentView.etagFor(name, meta.updatedAt, variant);
  if (!head) {
    if (packumentView.etagMatches(req.headers['if-none-match'], etag)) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache', vary: 'accept, accept-encoding' });
      return res.end();
    }
    res.setHeader && res.setHeader('etag', etag);
  }
  let payload;
  try {
    payload = await packumentView.render({ name, rec, base, variant, store, rev, req });
  } catch (e) {
    return fail(res, 500, `元数据序列化失败：${e.message}`, 'EMETA');
  }
  return writePackument(res, payload, { head });
}

async function handleRegistry(ctx) {
  const { req, res, url, method, store, log } = ctx;
  // 解码后再校验「上跳段」：编码分隔符（%2F/%5C）会把 .. 藏进单独一段里，
  // 让整体解码后的路径出现 /../ 或 \..\，这类请求不可能是合法 registry 请求。
  const pathname = safeDecode(url.pathname);
  if (/(^|[\\/])\.\.([\\/]|$)/.test(pathname) || /[\\/]\.\.$/.test(pathname)) {
    return fail(res, 400, '请求路径不合法（不允许上级目录）', 'EPATH');
  }
  const cfg = ctx.cfg();

  // ---------- 无包名的 /-/ 端点 ----------
  if (pathname === '/-/ping' || pathname === '/-/ping/') {
    return sendJson(res, 200, {});
  }
  if (pathname === '/-/whoami') {
    const r = ctx.auth.check(req, url);
    // 匿名（未带令牌）不允许探测发布用户名；本机回环/带令牌的请求才返回真实用户名
    if (!r.ok || r.anonymous) return fail(res, 401, '未认证', 'EAUTH');
    return sendJson(res, 200, { username: cfg.security.username || 'admin' });
  }
  if (pathname.startsWith('/-/user/org.couchdb.user:')) {
    // npm login --auth-type=legacy 走这里；本工具使用固定令牌。
    // 这是「令牌下发」接口，不能匿名开放：否则任何能连上 4873 端口的人都能拿走发布令牌。
    if (!hostAllowed(req, cfg)) return fail(res, 403, 'Host 不在允许范围内', 'EHOST');
    if (method !== 'PUT' && method !== 'POST') {
      return fail(res, 405, '登录接口仅支持 PUT/POST', 'EMETHOD');
    }
    const r = ctx.auth.check(req, url);
    if (!r.ok || r.anonymous || (!r.viaLocalhost && !r.token)) {
      return fail(res, 401, '登录接口只对本机或已携带有效令牌的请求开放；请在 .npmrc 中直接配置 _authToken', 'EAUTH');
    }
    const body = await readJson(req).catch(() => ({}));
    const username = body.name || safeDecode(pathname.split(':').slice(1).join(':'));
    log && log.info(`登录请求：${username}（返回固定令牌）`);
    return sendJson(res, 201, { ok: true, id: `org.couchdb.user:${username}`, token: cfg.security.token, username });
  }
  // ---------- npm dist-tag 的 /-/package/<名>/dist-tags 系列 ----------
  // npm dist-tag ls / add / rm 在新版客户端上走这些地址
  const tagRoute = /^\/-\/package\/(.+?)\/dist-tags(?:\/([^/]+))?\/?$/.exec(pathname);
  if (tagRoute) {
    if (!ctx.auth.canRead(req, url)) return fail(res, 401, '读取需要访问令牌', 'EAUTH');
    let tname = tagRoute[1];
    try { tname = decodeURIComponent(tname); } catch { /* 保持原样 */ }
    if (!validName(tname)) return fail(res, 400, `不合法的包名：${tname}`, 'ENAME');
    const tag = tagRoute[2] ? safeDecode(tagRoute[2]) : null;
    if (tag && !validTag(tag)) return fail(res, 400, `不合法的 dist-tag：${tag}`, 'ETAG');
    const rec = store.get(tname);
    if (!rec) return fail(res, 404, `包 ${tname} 不存在`, 'ENOTFOUND');
    if (method === 'GET' && !tag) return sendJson(res, 200, tagsOf(rec.packument));
    if (method === 'PUT' && tag) {
      if (!ctx.auth.canWrite(req, url)) return fail(res, 401, '需要访问令牌', 'EAUTH');
      const raw = (await readBody(req)).toString('utf8').trim();
      let version = null;
      try { const j = JSON.parse(raw); version = typeof j === 'string' ? j : (j && j.version); } catch { version = raw.replace(/^"|"$/g, ''); }
      if (typeof version === 'string') version = version.trim().replace(/^"|"$/g, '');
      if (!version || !rec.packument.versions[version]) return fail(res, 404, `版本 ${tname}@${version} 不存在`, 'ENOTFOUND');
      tagsOf(rec.packument)[tag] = version;
      store.save(tname, rec.packument, {});
      log && log.info(`dist-tag 设置 ${tname}@${tag}=${version}`);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'DELETE' && tag) {
      if (!ctx.auth.canWrite(req, url)) return fail(res, 401, '需要访问令牌', 'EAUTH');
      delete tagsOf(rec.packument)[tag];
      store.save(tname, rec.packument, {});
      log && log.info(`dist-tag 删除 ${tname}@${tag}`);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && !tag) {
      if (!ctx.auth.canWrite(req, url)) return fail(res, 401, '需要访问令牌', 'EAUTH');
      const body = await readJson(req).catch(() => ({}));
      const tags = body && typeof body === 'object' ? body : {};
      const current = tagsOf(rec.packument);
      // 合并语义：未提交的既有 tag 保留，只覆盖/新增本次提交的 tag
      for (const [t, v] of Object.entries(tags)) {
        if (!validTag(t)) return fail(res, 400, `不合法的 dist-tag：${t}`, 'ETAG');
        if (typeof v !== 'string' || !rec.packument.versions[v]) return fail(res, 400, `版本 ${tname}@${v} 不存在，不能指向该 tag`, 'ENOTFOUND');
        current[t] = v;
      }
      store.save(tname, rec.packument, {});
      return sendJson(res, 200, { ok: true });
    }
    return fail(res, 405, `不支持的请求：${method} ${pathname}`, 'EMETHOD');
  }
  if (pathname.startsWith('/-/package/') && pathname.endsWith('/collaborators')) {
    if (!ctx.auth.canRead(req, url)) return fail(res, 401, '读取需要访问令牌', 'EAUTH');
    return sendJson(res, 200, {});
  }

  if (pathname === '/-/v1/login' || pathname === '/-/v1/login/') {
    // 不支持浏览器网页登录流程，提示改用令牌
    return fail(res, 404, '本镜像源不支持网页登录，请在 .npmrc 里配置 _authToken（界面「配置」页可一键生成）', 'ENOWEBLOGIN');
  }
  if (pathname === '/-/v1/search' || pathname === '/-/v1/search/') {
    const text = url.searchParams.get('text') || url.searchParams.get('q') || '';
    const size = Math.min(250, Math.max(1, Number(url.searchParams.get('size')) || 20));
    if (!ctx.auth.canRead(req, url)) return fail(res, 401, '读取需要访问令牌', 'EAUTH');
    const local = store.list({ q: text, size, sort: '-downloads' }).items;
    const objects = local.map(it => toSearchObject(it, true));
    const seen = new Set(local.map(i => i.name));
    if ((cfg.mode || 'cache') !== 'offline' && text) {
      try {
        const remote = await ctx.upstream.search(text, size);
        for (const r of remote) {
          if (seen.has(r.name) || objects.length >= size) continue;
          objects.push({
            package: { name: r.name, version: r.version, description: r.description || '', date: r.date || null, links: {} },
            score: { final: 0, detail: { quality: 0, popularity: 0, maintenance: 0 } },
            searchScore: 0,
            local: false,
          });
          seen.add(r.name);
        }
      } catch { /* 上游不可用则只返回本地结果 */ }
    }
    return sendJson(res, 200, { objects, total: objects.length, time: nowIso() });
  }
  if (pathname === '/-/npm/v1/security/audits/quick' || pathname === '/-/npm/v1/security/audits') {
    await readBody(req).catch(() => Buffer.alloc(0));
    // requireRead=true 时审计接口同样要求读权限；默认 false 时保持匿名可用
    if (!ctx.auth.canRead(req, url)) return fail(res, 401, '读取需要访问令牌', 'EAUTH');
    return sendJson(res, 200, {
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
        dependencies: 0, devDependencies: 0, optionalDependencies: 0, totalDependencies: 0,
      },
    });
  }
  if (pathname === '/-/npm/v1/security/advisories/bulk' || pathname === '/-/npm/v1/security/advisories') {
    await readBody(req).catch(() => Buffer.alloc(0));
    return sendJson(res, 200, {});
  }

  // ---------- 包相关 ----------
  const parsed = parsePkgPath(pathname);
  if (!parsed) return fail(res, 404, `未知路径：${pathname}`, 'ENOTFOUND');
  const { name, rest } = parsed;
  if (!validName(name)) return fail(res, 400, `不合法的包名：${name}`, 'ENAME');

  // GET /pkg/-/file.tgz
  if (rest.length === 2 && rest[0] === '-') {
    if (!ctx.auth.canRead(req, url)) return fail(res, 401, '读取需要访问令牌', 'EAUTH');
    const file = rest[1];
    // 只允许纯文件名：任何带分隔符/上跳的名字都直接拒绝，绝不能再拼任意磁盘路径
    if (typeof file !== 'string' || !file || file.includes('/') || file.includes('\\') || file.includes('..')) {
      return fail(res, 400, `不合法的 tarball 文件名：${file}`, 'EPATH');
    }
    /* 快路径：文件名 → 版本 用内存 meta.files 反查（不读 packument）。
     * 以前每下载一个 tarball 都要先读一次完整 packument.json 来找版本，大包 10MB+，
     * 安装大量包时这部分纯属浪费：meta.files 里本来就记着 tarball 文件名。 */
    let version = null;
    const meta = store.metaOf(name);
    if (meta) {
      const revMap = store.tarballVersionMap(name);
      if (revMap && revMap.has(file)) version = revMap.get(file);
    }
    if (!version) {
      // 兜底：历史数据里 meta.files 可能缺少记录，仍按旧逻辑读一次 packument 逐个比对
      const rec = meta ? store.get(name) : null;
      if (rec) {
        for (const v of Object.keys(rec.packument.versions || {})) {
          if (store.tarballFileName(name, v) === file) { version = v; break; }
        }
      }
      if (!version) {
        const m = new RegExp(`^${pkgBaseName(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-([0-9A-Za-z][0-9A-Za-z.+-]*)\\.tgz$`, 'i').exec(file);
        if (m) version = m[1];
      }
    }
    if (!version || !isSafeVersion(version)) {
      return fail(res, 404, `本地未缓存该 tarball：${name}/${file}`, 'ENOTFOUND');
    }
    let target = store.tarballPath(name, version);
    if (!target) {
      try { target = await ensureTarball(ctx, name, version); }
      catch (e) { return fail(res, 502, `下载 tarball 失败：${e.message}`, 'EUPSTREAM'); }
    }
    if (!target) {
      const offline = (cfg.mode || 'cache') === 'offline';
      return fail(res, 404, offline ? `本地未缓存该 tarball：${name}/${file}` : `无法获取 tarball：${name}/${file}`, 'ENOTFOUND');
    }
    if (version) store.bumpDownload(name, version);
    log && log.info(`下载 ${name}@${version || ''} ← ${ctx.clientIp(req)}`);
    return streamFile(res, target, {
      contentType: 'application/octet-stream',
      cache: 'public, max-age=31536000, immutable',
    });
  }

  // DELETE /pkg/-rev/:rev  → 删除整个包
  if (method === 'DELETE' && rest.length === 2 && rest[0] === '-rev') {
    if (!ctx.auth.canWrite(req, url)) return fail(res, 401, '删除需要访问令牌', 'EAUTH');
    if (!store.has(name)) return fail(res, 404, `包 ${name} 不存在`, 'ENOTFOUND');
    store.deletePackage(name);
    log && log.warn(`取消发布（整包删除）${name}`);
    return sendJson(res, 200, { ok: true });
  }

  // DELETE /pkg/:version/-rev/:rev → 删除单个版本
  if (method === 'DELETE' && rest.length === 3 && rest[1] === '-rev') {
    if (!ctx.auth.canWrite(req, url)) return fail(res, 401, '删除需要访问令牌', 'EAUTH');
    const version = rest[0];
    if (!store.has(name)) return fail(res, 404, `包 ${name} 不存在`, 'ENOTFOUND');
    const done = store.deleteVersion(name, version);
    if (!done) return fail(res, 404, `版本 ${name}@${version} 不存在`, 'ENOTFOUND');
    log && log.warn(`取消发布版本 ${name}@${version}`);
    return sendJson(res, 200, { ok: true });
  }

  // DELETE /pkg/dist-tags/:tag
  if (method === 'DELETE' && rest.length === 2 && rest[0] === 'dist-tags') {
    if (!ctx.auth.canWrite(req, url)) return fail(res, 401, '需要访问令牌', 'EAUTH');
    const rec = store.get(name);
    if (!rec) return fail(res, 404, `包 ${name} 不存在`, 'ENOTFOUND');
    if (!validTag(rest[1])) return fail(res, 400, `不合法的 dist-tag：${rest[1]}`, 'ETAG');
    delete tagsOf(rec.packument)[rest[1]];
    store.save(name, rec.packument, {});
    return sendJson(res, 200, { ok: true });
  }

  // PUT /pkg  → 发布 / 元数据更新
  if (method === 'PUT' && rest.length === 0) {
    return handlePublish(ctx, name);
  }

  // PUT /pkg/:tag  → npm dist-tag add（body 是 JSON 字符串形式的版本号）
  if (method === 'PUT' && rest.length === 1) {
    if (!ctx.auth.canWrite(req, url)) return fail(res, 401, '需要访问令牌', 'EAUTH');
    if (!validTag(rest[0])) return fail(res, 400, `不合法的 dist-tag：${rest[0]}`, 'ETAG');
    const raw = (await readBody(req)).toString('utf8').trim();
    let version = null;
    try { const j = JSON.parse(raw); version = typeof j === 'string' ? j : (j && j.version); } catch { version = raw.replace(/^"|"$/g, ''); }
    // 容错：客户端可能把版本号多包了一层引号（形如 "1.0.0"）
    if (typeof version === 'string') version = version.trim().replace(/^"|"$/g, '');
    const rec = store.get(name);
    if (!rec) return fail(res, 404, `包 ${name} 不存在`, 'ENOTFOUND');
    if (!version || !rec.packument.versions[version]) return fail(res, 404, `版本 ${name}@${version} 不存在`, 'ENOTFOUND');
    tagsOf(rec.packument)[rest[0]] = version;
    store.save(name, rec.packument, {});
    log && log.info(`设置 dist-tag ${name}@${rest[0]} → ${version}`);
    return sendJson(res, 201, { ok: true });
  }

  // GET /pkg/:version
  if ((method === 'GET' || method === 'HEAD') && rest.length === 1) {
    if (!ctx.auth.canRead(req, url)) return fail(res, 401, '读取需要访问令牌', 'EAUTH');
    let rec = null;
    try { rec = await ensurePackument(ctx, name); }
    catch (e) { return fail(res, 502, `回源失败：${e.message}`, 'EUPSTREAM'); }
    if (!rec) return fail(res, 404, `包 ${name} 不存在`, 'ENOTFOUND');
    const version = resolveVersion(rec.packument, rest[0]);
    if (!version) return fail(res, 404, `找不到匹配的版本：${name}@${rest[0]}`, 'ENOTFOUND');
    rec = store.get(name) || rec;
    const base = baseFor(req, ctx.registryUrl);
    const manifest = store.versionManifest(name, version, base);
    if (!manifest) return fail(res, 404, `版本 ${name}@${version} 不存在`, 'ENOTFOUND');
    const body = Buffer.from(JSON.stringify(manifest), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-cache' });
    return res.end(body);
  }

  // GET /pkg
  if ((method === 'GET' || method === 'HEAD') && rest.length === 0) {
    return servePackument(ctx, name, { head: method === 'HEAD' });
  }

  return fail(res, 405, `不支持的请求：${method} ${pathname}`, 'EMETHOD');
}

function toSearchObject(it, local) {
  return {
    package: {
      name: it.name,
      version: it.latest,
      description: it.description || '',
      date: it.updatedAt || null,
      links: {},
    },
    score: { final: 0, detail: { quality: 0, popularity: it.downloads || 0, maintenance: 0 } },
    searchScore: 0,
    local: !!local,
    source: it.source,
  };
}

module.exports = {
  handleRegistry, ensurePackument, ensureTarball, ensureTarballEx, TARBALL_REASON_TEXT, parsePkgPath, validName,
  resolveVersion, parseLevelLine, toSearchObject, isStale, safeDecode,
};
