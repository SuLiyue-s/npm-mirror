'use strict';
/* 离线迁移包：整库/按范围导出为单个 .tgz，或从 .tgz 导入（合并式，可重复导入） */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  ensureDir, readJson, rootPath, stamp, safePkgDir, pkgBaseName, sha1hex, integrityOf, nowIso, compareVersions,
  isSafePkgName, isSafeVersion,
} = require('./util');
const tar = require('./tar');
const deps = require('./deps');

const FORMAT = 'npm-private-mirror-bundle';
const FORMAT_VERSION = 1;

/** 连带导出依赖时最多纳入多少个包（防止误点「全部包」把整个镜像拖进来） */
const DEPS_MAX_PACKAGES = 3000;

function bundleDir() { return rootPath('data', 'bundles'); }
function tmpRoot() { return rootPath('data', 'tmp'); }

function safeFileName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '-').slice(0, 80);
}

/** 包名/版本号来自 tarball 或 bundle 内的 JSON，属于不可信输入；会参与磁盘路径拼接，必须严格校验 */
function badNameError(name) {
  const err = new Error(`不合法的包名：${String(name)}`);
  err.code = 'EBADNAME';
  return err;
}
function badVersionError(name, version) {
  const err = new Error(`不合法的版本号：${String(name)}@${String(version)}`);
  err.code = 'EBADVERSION';
  return err;
}

/** bundle 结构/格式错误：统一标记 400（上层 import 路由已按 400 返回，/upload 等也据此归类） */
function bundleFormatError(message, code = 'EBADFORMAT') {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
}

function sameDigest(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** 按 packument 里 dist.integrity（缺失时用 dist.shasum）校验 tarball 实际字节；返回 null 表示通过 */
function verifyTarballBytes(buf, dist) {
  const d = dist && typeof dist === 'object' ? dist : {};
  const integrity = typeof d.integrity === 'string' ? d.integrity.trim() : '';
  if (integrity) {
    const m = /^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(integrity);
    if (!m) return `dist.integrity 格式非法：${integrity.slice(0, 40)}`;
    const actual = crypto.createHash(m[1]).update(buf).digest('base64');
    if (!sameDigest(actual, m[2])) return 'integrity 与 tarball 实际字节不一致（可能被篡改）';
    return null;
  }
  const shasum = typeof d.shasum === 'string' ? d.shasum.trim().toLowerCase() : '';
  if (shasum) {
    const actual = crypto.createHash('sha1').update(buf).digest('hex');
    if (!sameDigest(actual, shasum)) return 'shasum 与 tarball 实际字节不一致（可能被篡改）';
    return null;
  }
  // 两者都没有时无法证明字节未被替换，按不可信处理，避免被篡改的 bundle 静默导入
  return '缺少 dist.integrity / dist.shasum，无法校验 tarball';
}

/**
 * 把一个依赖声明解析成「真正需要导出的包名」。
 * - `npm:` 别名（`alias: npm:real@^1.0.0`）→ 真实包名 real
 * - file:/link:/git/http 等镜像拿不到的依赖 → null（跳过）
 */
function depTargetName(alias, range) {
  const r = String(range == null ? '' : range).trim();
  if (/^npm:/i.test(r)) {
    const a = deps.parseNpmAlias(r);
    return a ? a.name : null;
  }
  return deps.isRegistryRange(r) ? alias : null;
}

/**
 * 求「这批包 + 它们（递归）依赖的包」的闭包。
 * 只纳入镜像里真实存在的包；镜像里没有的放进 missing，回报给前端提示用户先补。
 * 每条依赖都从 packument 的每个版本里收集（导出本来就是整包全部版本，依赖也按全部版本取并集）。
 */
function collectDepClosure(store, roots, { max = DEPS_MAX_PACKAGES } = {}) {
  const visited = new Set(roots);
  const queue = roots.map(n => n);
  const missing = new Map();
  let added = 0;
  while (queue.length) {
    const cur = queue.shift();
    const rec = store.get(cur);
    const versions = (rec && rec.packument && rec.packument.versions) || {};
    for (const v of Object.keys(versions)) {
      const map = versions[v] && versions[v].dependencies;
      if (!map || typeof map !== 'object') continue;
      for (const alias of Object.keys(map)) {
        const real = depTargetName(alias, map[alias]);
        if (!real || visited.has(real)) continue;
        if (store.index.has(real)) {
          if (visited.size >= max) {
            if (!missing.has(real)) missing.set(real, { name: real, range: String(map[alias]), parent: cur, reason: `超过连带导出上限（${max} 个包），未纳入` });
            continue;
          }
          visited.add(real);
          added++;
          queue.push(real);
        } else if (!missing.has(real)) {
          missing.set(real, { name: real, range: String(map[alias]), parent: cur });
        }
      }
    }
  }
  const out = Array.from(visited).filter(n => !roots.includes(n));
  return { names: out, added, missing: Array.from(missing.values()) };
}

/**
 * 导出 bundle
 * @param {object} o
 * @param {boolean} [o.withDeps] scope='selected' 时把被选包的（递归）依赖也一起导出
 */
async function exportBundle({ store, scope = 'all', names = [], fileName, withDeps = false, logger }) {
  const all = Array.from(store.index.keys());
  let targets = all;
  if (scope === 'private') targets = all.filter(n => { const m = store.index.get(n); return m.source === 'private' || m.private; });
  else if (scope === 'upstream') targets = all.filter(n => { const m = store.index.get(n); return m.source !== 'private' && !m.private; });
  else if (scope === 'selected') targets = names.filter(n => store.index.has(n));
  targets = Array.from(new Set(targets)).sort();

  const roots = targets.slice();
  let depsAdded = 0;
  let missingDeps = [];
  if (withDeps && scope === 'selected' && roots.length) {
    const closure = collectDepClosure(store, roots);
    depsAdded = closure.added;
    missingDeps = closure.missing;
    targets = Array.from(new Set([...roots, ...closure.names])).sort();
  }

  if (!targets.length) {
    const err = new Error('没有符合条件的包可以导出');
    err.code = 'EMPTY';
    throw err;
  }

  const entries = [];
  const manifestPackages = [];
  let versions = 0, tarballs = 0, bytes = 0;
  for (const name of targets) {
    const rec = store.get(name);
    if (!rec) continue;
    let dir;
    try { dir = safePkgDir(name); }
    catch (e) {
      // 历史遗留的非法包名（例如早期被写入的可疑目录）不参与导出，跳过并提示，避免整个导出失败
      if (logger) logger.warn(`导出跳过非法包名：${String(name)}（${e.message}）`);
      continue;
    }
    const meta = rec.meta || {};
    const pkgVersions = [];
    for (const v of Object.keys(rec.packument.versions || {})) {
      const file = store.tarballFileName(name, v);
      const abs = store.tarballPath(name, v);
      const entryName = `storage/${dir}/tarballs/${file}`;
      if (abs) {
        const st = fs.statSync(abs);
        entries.push({ name: entryName, source: abs, size: st.size, mtime: st.mtimeMs / 1000 });
        bytes += st.size;
        tarballs++;
        pkgVersions.push({ version: v, file, sizeBytes: st.size, cached: true });
      } else {
        pkgVersions.push({ version: v, file: null, sizeBytes: 0, cached: false });
      }
      versions++;
    }
    entries.push({ name: `storage/${dir}/packument.json`, source: store.packumentPath(name) });
    if (fs.existsSync(store.metaPath(name))) entries.push({ name: `storage/${dir}/meta.json`, source: store.metaPath(name) });
    manifestPackages.push({
      name,
      source: meta.source || 'upstream',
      latest: meta.latest || null,
      versionCount: pkgVersions.length,
      private: !!meta.private,
      versions: pkgVersions,
    });
  }

  const manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    createdAt: nowIso(),
    host: process.env.COMPUTERNAME || 'unknown',
    scope,
    withDeps: !!withDeps,
    roots,
    stats: { packages: manifestPackages.length, versions, tarballs, tarballBytes: bytes, depsAdded, depsMissing: missingDeps.length },
    missingDeps: missingDeps.slice(0, 200),
    packages: manifestPackages,
  };
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });

  ensureDir(bundleDir());
  const base = safeFileName(fileName) || `npm-mirror-${scope}-${stamp()}`;
  let finalName = base.endsWith('.tgz') ? base : `${base}.tgz`;
  let finalPath = path.join(bundleDir(), finalName);
  if (fs.existsSync(finalPath)) {
    // 同名离线包已存在时不覆盖：追加时间戳（必要时再加序号），避免误删用户上次导出的文件
    const stem = finalName.slice(0, -4);
    const suffix = stamp();
    let n = 0;
    do {
      finalName = `${stem}-${suffix}${n ? `-${n}` : ''}.tgz`;
      finalPath = path.join(bundleDir(), finalName);
      n++;
    } while (fs.existsSync(finalPath));
    if (logger) logger.warn(`离线包同名已存在，改名保存为 ${finalName}`);
  }
  const tmpPath = path.join(bundleDir(), `.${finalName}.part`);
  const res = await tar.packTarGz(tmpPath, entries, { gzip: true });
  fs.renameSync(tmpPath, finalPath);
  if (logger) logger.info(`导出离线包完成: ${finalName} (${manifestPackages.length} 个包 / ${tarballs} 个 tarball${depsAdded ? ` / 含依赖 ${depsAdded} 个` : ''})`);
  return {
    file: finalName,
    path: finalPath,
    sizeBytes: res.sizeBytes,
    packages: manifestPackages.length,
    versions,
    tarballs,
    scope,
    withDeps: !!withDeps,
    roots: roots.length,
    depsAdded,
    missingDeps,
  };
}

/** 读取 bundle 的 manifest（不完整解包） */
async function readBundleManifest(file) {
  const buf = await tar.readTarEntry(file, 'manifest.json');
  if (!buf) throw bundleFormatError('不是有效的镜像离线包：缺少 manifest.json', 'EMANIFEST');
  let manifest;
  try {
    manifest = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    // 损坏的 manifest 属于用户输入错误（400），不是服务端 500
    throw bundleFormatError(`离线包 manifest.json 不是合法 JSON：${e.message}`, 'EBADMANIFEST');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw bundleFormatError('离线包 manifest.json 结构非法（应为对象）', 'EBADMANIFEST');
  }
  if (manifest.format !== FORMAT) throw bundleFormatError('不是本工具导出的离线包（format 不匹配）');
  if (manifest.formatVersion !== FORMAT_VERSION) {
    throw bundleFormatError(`离线包格式版本不受支持：${String(manifest.formatVersion)}（当前支持 ${FORMAT_VERSION}）`, 'EBADFORMAT');
  }
  return manifest;
}

/** 从 bundle 导入（合并式） */
async function importBundle({ store, file, overwrite = false, metadataOnly = false, onProgress, logger }) {
  await readBundleManifest(file); // 先校验格式与 manifest 是否可读
  const tmp = path.join(tmpRoot(), `import-${stamp()}-${Math.random().toString(36).slice(2, 8)}`);
  ensureDir(tmp);
  const result = {
    file: path.basename(file), packages: 0, versions: 0, tarballs: 0, skipped: 0, overwritten: 0,
    metadataOnly: 0, failed: [],
  };
  try {
    // 完整镜像包（scope=all）解压后可能有数 GB，默认 2GB 上限会误伤；按包体积放宽，同时仍防解压炸弹
    let bundleSize = 0;
    try { bundleSize = fs.statSync(file).size; } catch { bundleSize = 0; }
    await tar.extractTarGz(file, tmp, {
      filter: rel => rel === 'manifest.json' || rel.startsWith('storage/'),
      onEntry: onProgress,
      maxTotalBytes: Math.max(2 * 1024 * 1024 * 1024, bundleSize * 4),
      maxEntries: 2000000,
    });
    const dirs = fs.existsSync(path.join(tmp, 'storage')) ? fs.readdirSync(path.join(tmp, 'storage')) : [];

    for (const dir of dirs) {
      const pkgDir = path.join(tmp, 'storage', dir);
      if (!fs.statSync(pkgDir).isDirectory()) continue;
      const incomingPackument = readJson(path.join(pkgDir, 'packument.json'), null);
      if (!incomingPackument || !incomingPackument.versions) continue;
      const name = incomingPackument.name || dir.replace(/__/g, '/');
      if (!isSafePkgName(name)) {
        const error = `非法包名，已跳过导入：${String(name)}`;
        result.failed.push({ name: String(name), error });
        if (logger) logger.warn(`导入离线包跳过：${error}`);
        continue;
      }
      const incomingMeta = readJson(path.join(pkgDir, 'meta.json'), {}) || {};
      try {
        await store.withLock(name, async () => {
          const local = store.get(name);
          // 新建 packument 时清空 dist-tags，避免把包内可能悬空的 tag 原样带进来
          const packument = local ? local.packument : { ...incomingPackument, versions: {}, 'dist-tags': {} };
          const files = {}; const sizes = {}; const origins = {}; const deprecated = {};
          let added = 0;
          let invalidVersions = 0;
          let metadataOnlySkipped = 0;
          for (const [v, manifestV] of Object.entries(incomingPackument.versions)) {
            if (!isSafeVersion(v)) { invalidVersions++; continue; }
            if (packument.versions[v] && !overwrite) { result.skipped++; continue; }
            const srcFile = path.join(pkgDir, 'tarballs', `${pkgBaseName(name)}-${v}.tgz`);
            const altName = incomingMeta.files && typeof incomingMeta.files[v] === 'string' ? incomingMeta.files[v] : '';
            // files 映射来自包内 meta.json，可能被构造成 ../ 路径；只接受纯文件名
            const altFile = altName && altName === path.basename(altName) ? path.join(pkgDir, 'tarballs', altName) : null;
            const useFile = fs.existsSync(srcFile) ? srcFile : (altFile && fs.existsSync(altFile) ? altFile : null);
            if (!useFile) {
              // 默认只导入带 tarball 的版本，否则会写出「元数据有、下载 tarball 404」的幻影版本。
              // metadataOnly=true 时保留旧行为（仍写入元数据），并在结果里单独计数。
              if (!metadataOnly) { metadataOnlySkipped++; continue; }
              if (packument.versions[v] && overwrite) result.overwritten++;
              packument.versions[v] = manifestV;
              if (incomingMeta.sizes && Number.isFinite(incomingMeta.sizes[v])) sizes[v] = incomingMeta.sizes[v];
              if (incomingMeta.deprecated && incomingMeta.deprecated[v]) deprecated[v] = incomingMeta.deprecated[v];
              added++;
              continue;
            }
            // 篡改校验 1：tarball 实际字节必须与 packument 的 dist.integrity（缺失则 shasum）一致
            const buf = fs.readFileSync(useFile);
            const badBytes = verifyTarballBytes(buf, manifestV && manifestV.dist);
            if (badBytes) {
              result.failed.push({ name, version: v, error: `${name}@${v}：${badBytes}` });
              if (logger) logger.warn(`导入离线包跳过 ${name}@${v}：${badBytes}`);
              continue;
            }
            // 篡改校验 2：tarball 内 package/package.json 的 name/version 必须与 packument 的键一致
            let innerPkg = null;
            try {
              const pj = await tar.readTarEntry(useFile, 'package/package.json');
              innerPkg = pj ? JSON.parse(pj.toString('utf8')) : null;
            } catch { innerPkg = null; }
            if (!innerPkg || innerPkg.name !== name || innerPkg.version !== v) {
              const got = innerPkg ? `${String(innerPkg.name)}@${String(innerPkg.version)}` : '无法解析 package/package.json';
              const error = `${name}@${v}：tarball 内 package.json 与 packument 不一致（实际 ${got}）`;
              result.failed.push({ name, version: v, error });
              if (logger) logger.warn(`导入离线包跳过：${error}`);
              continue;
            }
            if (packument.versions[v] && overwrite) result.overwritten++;
            // 用刚校验过的字节直接写入，避免校验后再按路径读一次造成 TOCTOU；dist 以实际写入结果为准
            const saved = store.putTarball(name, v, buf);
            packument.versions[v] = {
              ...manifestV,
              name,
              version: v,
              _id: `${name}@${v}`,
              dist: {
                ...(manifestV && manifestV.dist),
                integrity: saved.integrity,
                shasum: saved.shasum,
                tarball: `${name}/-/${saved.file}`,
              },
            };
            files[v] = saved.file; sizes[v] = saved.sizeBytes; origins[v] = 'bundle';
            result.tarballs++;
            if (incomingMeta.deprecated && incomingMeta.deprecated[v]) deprecated[v] = incomingMeta.deprecated[v];
            added++;
          }
          result.metadataOnly += metadataOnlySkipped;
          if (metadataOnlySkipped > 0 && logger) {
            logger.warn(`导入 ${name}：跳过 ${metadataOnlySkipped} 个 bundle 内没有 tarball 的版本`);
          }
          if (invalidVersions > 0) {
            result.failed.push({ name, error: `跳过 ${invalidVersions} 个非法版本号` });
            if (logger) logger.warn(`导入 ${name} 时跳过 ${invalidVersions} 个非法版本号`);
          }
          for (const [tag, v] of Object.entries(incomingPackument['dist-tags'] || {})) {
            if (!packument.versions[v]) {
              if (logger) logger.warn(`导入 ${name}：丢弃悬空 dist-tag ${tag} -> ${String(v)}`);
              continue;
            }
            packument['dist-tags'] = packument['dist-tags'] || {};
            if (!packument['dist-tags'][tag] || overwrite) packument['dist-tags'][tag] = v;
          }
          const latest = packument['dist-tags'] && packument['dist-tags'].latest;
          if (!latest) {
            const vs = Object.keys(packument.versions);
            if (vs.length) { packument['dist-tags'] = packument['dist-tags'] || {}; packument['dist-tags'].latest = vs.sort(compareVersions).pop(); }
          }
          // 一个版本都没导入时不要新建空 packument（否则会留下没有任何版本的包条目）
          if (added > 0 || local) {
            store.save(name, packument, {
              source: (local && local.meta && local.meta.source) || incomingMeta.source || 'cache',
              description: packument.description || incomingMeta.description || '',
              private: (local && local.meta && local.meta.private) || !!incomingMeta.private,
              files, sizes, origins, deprecated,
            });
          }
          if (added > 0) result.packages++;
          result.versions += added;
        });
      } catch (e) {
        result.failed.push({ name, error: e.message });
      }
    }
    if (logger) logger.info(`导入离线包完成: ${result.file} → ${result.packages} 个包 / ${result.versions} 个版本 / ${result.tarballs} 个 tarball`);
    return result;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/** 导入单个 npm tarball（.tgz）：解析 package.json 后登记为一个版本 */
async function importTarballFile({ store, file, overwrite = false, source = 'upload' }) {
  const pkgJsonBuf = await tar.readTarEntry(file, 'package/package.json');
  if (!pkgJsonBuf) throw new Error('不是有效的 npm 包 tarball（缺少 package/package.json）');
  const pkg = JSON.parse(pkgJsonBuf.toString('utf8'));
  const name = pkg.name;
  const version = pkg.version;
  if (!name || !version) throw new Error('tarball 里的 package.json 缺少 name 或 version');
  // 包内 package.json 不可信：name/version 会参与磁盘路径拼接，必须先做严格校验再写盘
  if (!isSafePkgName(name)) throw badNameError(name);
  if (!isSafeVersion(version)) throw badVersionError(name, version);
  const buf = fs.readFileSync(file);
  const info = { file: path.basename(file), sizeBytes: buf.length, shasum: sha1hex(buf), integrity: integrityOf(buf) };
  await store.withLock(name, async () => {
    const local = store.get(name);
    const packument = local
      ? local.packument
      : { _id: name, name, description: pkg.description || '', 'dist-tags': {}, versions: {}, readme: '' };
    if (packument.versions[version] && !overwrite) {
      const err = new Error(`版本 ${name}@${version} 已存在（未覆盖）`);
      err.code = 'EEXIST';
      throw err;
    }
    const saved = store.putTarball(name, version, buf);
    packument.versions[version] = {
      ...pkg,
      name,
      version,
      _id: `${name}@${version}`,
      dist: {
        ...(packument.versions[version] && packument.versions[version].dist),
        integrity: saved.integrity,
        shasum: saved.shasum,
        tarball: `${name}/-/${saved.file}`,
      },
    };
    const isLatest = !packument['dist-tags'].latest || compareVersions(version, packument['dist-tags'].latest) > 0;
    if (isLatest) packument['dist-tags'].latest = version;
    store.save(name, packument, {
      source,
      private: true,
      description: packument.description || pkg.description || '',
      files: { [version]: saved.file },
      sizes: { [version]: saved.sizeBytes },
      origins: { [version]: 'upload' },
    });
  });
  return { name, version, sizeBytes: info.sizeBytes, shasum: info.shasum, integrity: info.integrity };
}

/** 导入 packument JSON（只有元数据，没有 tarball） */
async function importPackumentJson({ store, json, overwrite = false, source = 'upload' }) {
  const name = json.name;
  if (!name || !json.versions) throw new Error('不是有效的 packument JSON（缺少 name/versions）');
  if (!isSafePkgName(name)) throw badNameError(name);
  let invalidVersions = 0;
  const versions = {};
  for (const [v, m] of Object.entries(json.versions)) {
    // 版本号后续会被用于 tarball 文件名拼接，非法版本号直接丢弃
    if (!isSafeVersion(v)) { invalidVersions++; continue; }
    versions[v] = m;
  }
  await store.withLock(name, async () => {
    const local = store.get(name);
    // 新建 packument 时清空 dist-tags，下面只写入指向真实存在版本号的 tag
    const packument = local ? local.packument : { ...json, versions: {}, 'dist-tags': {} };
    let added = 0;
    for (const [v, m] of Object.entries(versions)) {
      if (packument.versions[v] && !overwrite) continue;
      packument.versions[v] = m;
      added++;
    }
    for (const [tag, v] of Object.entries(json['dist-tags'] || {})) {
      if (!packument.versions[v]) continue; // 悬空 dist-tag 直接丢弃
      packument['dist-tags'] = packument['dist-tags'] || {};
      if (!packument['dist-tags'][tag] || overwrite) packument['dist-tags'][tag] = v;
    }
    store.save(name, packument, { source, description: json.description || '' });
    return added;
  });
  return { name, versions: Object.keys(versions).length, skippedInvalidVersions: invalidVersions };
}

function listBundles() {
  const dir = bundleDir();
  ensureDir(dir);
  const items = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.toLowerCase().endsWith('.tgz') || f.startsWith('.')) continue;
    const full = path.join(dir, f);
    let st = null;
    try { st = fs.statSync(full); } catch { continue; }
    items.push({ file: f, path: full, sizeBytes: st.size, createdAt: st.mtime.toISOString(), packages: null, scope: null });
  }
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { items };
}

module.exports = {
  FORMAT, FORMAT_VERSION, bundleDir, exportBundle, importBundle, importTarballFile,
  importPackumentJson, readBundleManifest, listBundles, safeFileName,
  depTargetName, collectDepClosure, DEPS_MAX_PACKAGES,
};
