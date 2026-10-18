'use strict';
/* 包存储：data/storage/<包名>/{packument.json, meta.json, tarballs/*.tgz}
   全部落在项目目录内，删除/迁移只需拷走 data 目录 */
const fs = require('node:fs');
const path = require('node:path');
const {
  ensureDir, readJson, writeJsonAtomic, writeFileAtomic,
  safePkgDir, pkgBaseName, integrityOf, sha1hex, nowIso, compareVersions,
  isSafePkgName, isSafeVersion,
} = require('./util');

/** 判断 child 是否位于 base 目录内（同盘、规范化后比较，用于杜绝路径穿越） */
function isInside(base, child) {
  const b = path.resolve(base);
  const c = path.resolve(child);
  return c === b || c.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** tarball 文件名 → 版本号 的内存反查缓存：键是 meta 对象（save() 换新对象后旧缓存自动释放） */
const tarballRevCache = new WeakMap();

class Store {
  constructor({ dir, logger }) {
    this.dir = dir;
    this.log = logger;
    this.index = new Map();      // name -> meta
    this.locks = new Map();
    this.dirty = new Set();
    this.flushTimer = null;
  }

  init() {
    ensureDir(this.dir);
    this.reloadIndex();
    this.flushTimer = setInterval(() => this.flushDirty(), 5000);
    if (this.flushTimer.unref) this.flushTimer.unref();
    return this.index.size;
  }

  close() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushDirty();
  }

  reloadIndex() {
    this.index.clear();
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    } catch { dirs = []; }
    for (const d of dirs) {
      const meta = readJson(path.join(this.dir, d, 'meta.json'), null);
      if (meta && meta.name) this.index.set(meta.name, meta);
    }
    return this.index.size;
  }

  /** 包名 -> 包目录；非法包名或越界路径直接抛错（EBADNAME/EBADPATH） */
  pkgDir(name) {
    if (!isSafePkgName(name)) {
      const err = new Error(`不合法的包名：${String(name)}`);
      err.code = 'EBADNAME';
      throw err;
    }
    const dir = path.join(this.dir, safePkgDir(name));
    if (!isInside(this.dir, dir)) {
      const err = new Error(`包目录越界：${String(name)}`);
      err.code = 'EBADPATH';
      throw err;
    }
    return dir;
  }
  metaPath(name) { return path.join(this.pkgDir(name), 'meta.json'); }
  packumentPath(name) { return path.join(this.pkgDir(name), 'packument.json'); }
  tarballDir(name) { return path.join(this.pkgDir(name), 'tarballs'); }

  /** 同名包的写操作串行化，避免并发 publish 互相覆盖 */
  withLock(name, fn) {
    const prev = this.locks.get(name) || Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.then(() => undefined, () => undefined);
    this.locks.set(name, settled);
    // 锁链结算后清理，避免长期运行时 locks Map 无限增长
    settled.then(() => { if (this.locks.get(name) === settled) this.locks.delete(name); });
    return next;
  }

  has(name) { return isSafePkgName(name) && fs.existsSync(this.packumentPath(name)); }

  /**
   * 只读内存索引里的 meta（不读盘）。
   * 给「早期 304」「tarball 文件名反查版本」这类只需要少量元信息的快速路径用，
   * 避免为了一个字节判断去 readFile + JSON.parse 几十 MB 的 packument.json。
   */
  metaOf(name) {
    if (!isSafePkgName(name)) return null;
    return this.index.get(name) || null;
  }

  get(name) {
    if (!isSafePkgName(name)) return null;
    const packument = readJson(this.packumentPath(name), null);
    if (!packument) return null;
    const meta = this.index.get(name) || readJson(this.metaPath(name), null);
    return { packument, meta: meta || this.buildMeta(name, packument) };
  }

  buildMeta(name, packument, patch = {}) {
    const versions = Object.keys((packument && packument.versions) || {});
    const latest = (packument && packument['dist-tags'] && packument['dist-tags'].latest) || versions[versions.length - 1] || null;
    return {
      name,
      source: patch.source || 'upstream',
      description: (packument && (packument.description || (latest && packument.versions[latest] && packument.versions[latest].description))) || '',
      latest,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      downloads: 0,
      byVersion: {},
      files: {},
      sizes: {},
      origins: {},
      deprecated: {},
      private: false,
      upstream: null,
      lastFetchAt: null,
      ...patch,
    };
  }

  save(name, packument, patch = {}) {
    const dir = this.pkgDir(name);
    ensureDir(this.tarballDir(name));
    // 同一目录名可能对应不同包名（历史上的 '/'→'__' 映射有歧义）：检测到冲突时拒绝覆盖，
    // 避免包 A 的写操作把包 B 的 packument/meta 覆盖掉。
    const prev = readJson(this.metaPath(name), null) || this.index.get(name) || null;
    if (prev && prev.name && prev.name !== name) {
      const err = new Error(`存储目录被其它包占用：${name}（现有 ${prev.name}）`);
      err.code = 'ECONFLICT';
      throw err;
    }
    if (!packument || typeof packument !== 'object') {
      const err = new Error('packument 必须是对象');
      err.code = 'EBADPAYLOAD';
      throw err;
    }
    if (!packument['dist-tags'] || typeof packument['dist-tags'] !== 'object' || Array.isArray(packument['dist-tags'])) {
      packument['dist-tags'] = {};
    }
    const base = prev || this.buildMeta(name, packument);
    const versions = Object.keys(packument.versions || {});
    const latest = (packument['dist-tags'] && packument['dist-tags'].latest) || base.latest || versions[versions.length - 1] || null;
    const meta = {
      ...base,
      ...patch,
      name,
      latest,
      description: packument.description || base.description || '',
      updatedAt: nowIso(),
      files: { ...(base.files || {}), ...(patch.files || {}) },
      sizes: { ...(base.sizes || {}), ...(patch.sizes || {}) },
      origins: { ...(base.origins || {}), ...(patch.origins || {}) },
      deprecated: { ...(base.deprecated || {}), ...(patch.deprecated || {}) },
      private: patch.private !== undefined ? patch.private : (base.private || false),
    };
    // 清理已不存在的版本记录；deprecated 里被显式置空('' / null)的版本视为「取消弃用」并删除
    for (const key of ['files', 'sizes', 'origins', 'deprecated']) {
      const map = meta[key] || {};
      for (const v of Object.keys(map)) {
        if (!versions.includes(v)) { delete map[v]; continue; }
        if (key === 'deprecated' && (map[v] === null || map[v] === undefined || map[v] === '')) delete map[v];
      }
    }
    meta.sizeBytes = Object.values(meta.sizes || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    meta.versionCount = versions.length;
    writeJsonAtomic(this.packumentPath(name), packument);
    writeJsonAtomic(this.metaPath(name), meta);
    this.index.set(name, meta);
    return meta;
  }

  /** 写入 tarball，返回文件信息 */
  putTarball(name, version, buffer) {
    if (!isSafeVersion(version)) {
      const err = new Error(`不合法的版本号：${String(name)}@${String(version)}`);
      err.code = 'EBADVERSION';
      throw err;
    }
    const file = `${pkgBaseName(name)}-${version}.tgz`;
    const dir = this.tarballDir(name);
    const dest = path.join(dir, file);
    if (!isInside(dir, dest)) {
      const err = new Error(`tarball 路径越界：${String(name)}@${String(version)}`);
      err.code = 'EBADPATH';
      throw err;
    }
    writeFileAtomic(dest, buffer);
    return { file, sizeBytes: buffer.length, shasum: sha1hex(buffer), integrity: integrityOf(buffer), path: dest };
  }

  /** 从磁盘文件登记为某个版本的 tarball（拷贝） */
  putTarballFromFile(name, version, srcFile) {
    const buf = fs.readFileSync(srcFile);
    return this.putTarball(name, version, buf);
  }

  tarballFileName(name, version) {
    if (!isSafeVersion(version)) return null;
    const meta = this.index.get(name);
    const known = meta && meta.files && meta.files[version];
    // 只接受「纯文件名」：meta 里的记录也可能来自不可信元数据，必须再校验一次
    if (known && path.basename(known) === known && !known.includes('\\') && !known.includes('/')) return known;
    return `${pkgBaseName(name)}-${version}.tgz`;
  }

  /**
   * tarball 文件名 → 版本号 的反查表（内存缓存）。
   * registry 的 tarball 路由需要从 URL 里的文件名反推版本，以前遍历 packument.versions，
   * 等于每下载一个 tarball 就要读一次完整 packument.json（大包 10MB+）。
   * 这里用内存 meta.files（save() 时维护）建表，键用 meta 对象本身：save() 会生成新 meta，旧表随 GC 释放。
   */
  tarballVersionMap(name) {
    const meta = this.metaOf(name);
    if (!meta) return null;
    const cached = tarballRevCache.get(meta);
    if (cached) return cached;
    const map = new Map();
    for (const [v, f] of Object.entries(meta.files || {})) {
      if (typeof f !== 'string' || !f) continue;
      if (path.basename(f) !== f || f.includes('\\') || f.includes('/')) continue;
      if (!map.has(f)) map.set(f, v);
    }
    tarballRevCache.set(meta, map);
    return map;
  }

  tarballPath(name, version) {
    const fileName = this.tarballFileName(name, version);
    if (!fileName) return null;
    const dir = this.tarballDir(name);
    const p = path.join(dir, fileName);
    if (!isInside(dir, p)) return null;
    return fs.existsSync(p) ? p : null;
  }

  hasTarball(name, version) { return !!this.tarballPath(name, version); }

  missingTarballs(name) {
    const rec = this.get(name);
    if (!rec) return [];
    return Object.keys(rec.packument.versions || {}).filter(v => !this.hasTarball(name, v));
  }

  /** 删除单个版本（同步执行，Node 单线程下不会被同进程的其它请求交错） */
  deleteVersion(name, version) {
    return this._deleteVersionUnlocked(name, version);
  }

  _deleteVersionUnlocked(name, version) {
    if (!isSafeVersion(version)) return false;
    const rec = this.get(name);
    if (!rec || !rec.packument.versions || !rec.packument.versions[version]) return false;
    const file = this.tarballPath(name, version);
    if (file) { try { fs.unlinkSync(file); } catch { /* 忽略 */ } }
    delete rec.packument.versions[version];
    const tags = rec.packument['dist-tags'] || (rec.packument['dist-tags'] = {});
    for (const tag of Object.keys(tags)) {
      if (tags[tag] === version) delete tags[tag];
    }
    const remaining = Object.keys(rec.packument.versions);
    if (remaining.length === 0) return this._deletePackageUnlocked(name);
    if (!tags.latest || !rec.packument.versions[tags.latest]) {
      tags.latest = remaining.sort(compareVersions).pop();
    }
    // save() 会统一清掉 files/sizes/origins/deprecated 里已不存在版本的记录
    this.save(name, rec.packument, {});
    return true;
  }

  deletePackage(name) {
    return this._deletePackageUnlocked(name);
  }

  _deletePackageUnlocked(name) {
    const dir = this.pkgDir(name);   // 非法包名/越界路径会直接抛错，绝不会 rmSync 到 storage 之外
    let realDir = dir;
    let realRoot = this.dir;
    try { realDir = fs.realpathSync(dir); } catch { /* 目录不存在时用解析后的路径 */ }
    try { realRoot = fs.realpathSync(this.dir); } catch { /* 忽略 */ }
    // 防御性再校验一次：storage.dir 本身可能被配置成符号链接/junction，realpath 后必须仍在存储根内
    if (realDir === realRoot || !isInside(realRoot, realDir)) {
      const err = new Error(`拒绝删除存储根目录或越界目录：${String(name)}`);
      err.code = 'EBADPATH';
      throw err;
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { this.log && this.log.warn(`删除包目录失败 ${name}: ${e.message}`); }
    this.index.delete(name);
    this.dirty.delete(name);
    return true;
  }

  bumpDownload(name, version) {
    const meta = this.index.get(name);
    if (!meta) return;
    meta.downloads = (meta.downloads || 0) + 1;
    if (version) {
      meta.byVersion = meta.byVersion || {};
      meta.byVersion[version] = (meta.byVersion[version] || 0) + 1;
    }
    this.dirty.add(name);
  }

  flushDirty() {
    for (const name of Array.from(this.dirty)) {
      const meta = this.index.get(name);
      if (!meta) { this.dirty.delete(name); continue; }
      try { writeJsonAtomic(this.metaPath(name), meta); this.dirty.delete(name); } catch { /* 下轮重试 */ }
    }
  }

  /* 镜像里全部包名（按名称排序）：给「全部包补 tarball」这类批量操作取名单用。
   * 注意 list() 的 size 上限是 200，取全量名单不能用它翻页。 */
  names() {
    return Array.from(this.index.keys()).sort((a, b) => a.localeCompare(b));
  }

  list({ q = '', source = 'all', tarballs = 'all', sort = '-updated', page = 1, size = 20 } = {}) {
    const kw = String(q || '').trim().toLowerCase();
    let items = [];
    for (const [name, meta] of this.index) {
      if (source && source !== 'all' && meta.source !== source) continue;
      if (kw && !(name.toLowerCase().includes(kw) || String(meta.description || '').toLowerCase().includes(kw))) continue;
      const fileCount = Object.keys(meta.files || {}).length;
      const versionCount = Number.isFinite(meta.versionCount) ? meta.versionCount : fileCount;
      // 用「版本数 - 已缓存 tarball 数」估算缺失，避免逐个包读磁盘
      const missing = Math.max(0, versionCount - fileCount);
      // 「缺 tarball / tarball 齐全」快捷筛选：missing 与 complete 互补，未知取值一律当全部（向后兼容）
      if (tarballs === 'missing' && missing === 0) continue;
      if (tarballs === 'complete' && missing > 0) continue;
      items.push({
        name,
        description: meta.description || '',
        source: meta.source || 'upstream',
        latest: meta.latest || null,
        versionCount,
        cachedVersions: fileCount,
        downloads: meta.downloads || 0,
        sizeBytes: meta.sizeBytes || 0,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        private: !!meta.private,
        deprecated: !!(meta.latest && meta.deprecated && meta.deprecated[meta.latest]),
        hasAllTarballs: missing === 0,
        missingVersions: missing,
        lastFetchAt: meta.lastFetchAt || null,
      });
    }
    const dir = String(sort || '').startsWith('-') ? -1 : 1;
    const key = String(sort || '').replace(/^-/, '');
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name),
      updated: (a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)),
      size: (a, b) => (a.sizeBytes || 0) - (b.sizeBytes || 0),
      downloads: (a, b) => (a.downloads || 0) - (b.downloads || 0),
      versions: (a, b) => (a.versionCount || 0) - (b.versionCount || 0),
    }[key] || ((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    items.sort((a, b) => dir * cmp(a, b) || a.name.localeCompare(b.name));
    const total = items.length;
    const pageNum = Math.max(1, Number(page) || 1);
    const pageSize = Math.max(1, Math.min(200, Number(size) || 20));
    return { total, page: pageNum, size: pageSize, items: items.slice((pageNum - 1) * pageSize, pageNum * pageSize) };
  }

  stats() {
    let packages = 0, versions = 0, tarballs = 0, storageBytes = 0, downloads = 0;
    const bySource = { upstream: 0, private: 0, upload: 0, cache: 0 };
    for (const [, meta] of this.index) {
      packages++;
      versions += Number.isFinite(meta.versionCount) ? meta.versionCount : Object.keys(meta.files || {}).length;
      tarballs += Object.keys(meta.files || {}).length;
      storageBytes += meta.sizeBytes || 0;
      downloads += meta.downloads || 0;
      bySource[meta.source] = (bySource[meta.source] || 0) + 1;
    }
    return { packages, versions, tarballs, storageBytes, downloads, bySource };
  }

  /** 把 packument 中所有 tarball 地址改写成本机镜像地址 */
  rewriteTarballs(name, packument, base) {
    const out = { ...packument, versions: {} };
    for (const [v, manifest] of Object.entries(packument.versions || {})) {
      const file = this.tarballFileName(name, v);
      out.versions[v] = {
        ...manifest,
        dist: {
          ...(manifest.dist || {}),
          tarball: `${base}/${name}/-/${file}`,
        },
      };
    }
    delete out._attachments;
    delete out._rev;
    return out;
  }

  /** 生成单个版本的 manifest（供 /pkg/version 查询） */
  versionManifest(name, version, base) {
    const rec = this.get(name);
    if (!rec || !rec.packument.versions[version]) return null;
    const m = rec.packument.versions[version];
    return { ...m, dist: { ...(m.dist || {}), tarball: `${base}/${name}/-/${this.tarballFileName(name, version)}` } };
  }
}

module.exports = { Store };
