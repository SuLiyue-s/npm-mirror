'use strict';
/*
 * 依赖闭包解析：给「只输入一个包名，把它的依赖、依赖的依赖也一起加进来」用。
 * 只读上游元数据 + 挑版本，不下载 tarball（下载交给 pull.js）。
 *
 * 几条刻意的取舍：
 * 1. 只认「能联网下载的依赖」：`npm:` 别名（`别名@npm:真实包名@范围`）会解析到真实包并正常下载，
 *    落盘按**真实包名**（npm 客户端装别名依赖时也是去取真实包的 packument）；
 *    `file:`/`link:`/`workspace:` 本地路径、`git+…`/`github:` git 依赖、直接指向远程 tarball 的 URL、
 *    GitHub 简写一律记进 unresolved（不是失败，只是这些确实没法从注册表回源下载，得手工处理）；
 * 2. 同一棵树里允许一个包出现多个版本（npm 本来就这样）：已有版本能满足新范围就直接复用，
 *    否则再挑一个满足范围的最高版本，保证每个父包的依赖要求都能被满足；
 * 3. 循环依赖靠「name@version 已展开」集合天然截断，另加 maxDepth / maxPackages 双保险；
 * 4. 默认只挑正式版：范围里没有预发布标记时，不会因为 1.2.0-rc.1 恰好排最后就选它；
 * 5. persist=false 时纯读（不落盘）：本地 → 内存缓存 → 上游，给「先看看有多大」这类场景用。
 */
const { parsePkgSpec, satisfies, compareVersions, maxSatisfying } = require('./util');

const DEFAULT_DEPTH = 8;
const DEFAULT_LIMIT = 300;
const HARD_DEPTH = 50;
const HARD_LIMIT = 5000;
const RESOLVE_CONCURRENCY = 8;

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * 解析 `npm:` 别名依赖：`npm:真实包名@范围`。
 * 例：`npm:@sxzz/popperjs-es@^2.11.8` → { name:'@sxzz/popperjs-es', range:'^2.11.8' }
 *     `npm:lodash` / `npm:lodash@latest` → { name:'lodash', range:'' / 'latest' }
 * 返回 null 表示不是（或不是合法的）别名写法。
 */
function parseNpmAlias(range) {
  const r = String(range == null ? '' : range).trim();
  if (!/^npm:/i.test(r)) return null;
  const rest = r.slice(4).trim();
  if (!rest) return null;
  const parsed = parsePkgSpec(rest);
  if (!parsed || !parsed.name) return null;
  if (parsed.version && /^npm:/i.test(parsed.version)) return null;   // 别名的别名，不认
  return { name: parsed.name, range: parsed.version || '' };
}

/**
 * 根 spec 也支持别名写法：`别名@npm:真实包名@范围`（npm i 的写法）或 `npm:真实包名@范围`。
 * 统一归一成 { name: 对外名字, range: 'npm:…' }，后面的解析路径只有一条。
 */
function splitRootSpec(spec) {
  const s = String(spec == null ? '' : spec).trim();
  if (!s) return null;
  if (/^npm:/i.test(s)) {
    const alias = parseNpmAlias(s);
    return alias ? { name: alias.name, range: s } : null;
  }
  const m = /^(.*?)@npm:(.+)$/i.exec(s);
  if (m && m[1]) {
    const alias = parseNpmAlias('npm:' + m[2]);
    if (alias) return { name: m[1], range: 'npm:' + m[2] };
  }
  const parsed = parsePkgSpec(s);
  return parsed && parsed.name ? { name: parsed.name, range: parsed.version || '' } : null;
}

/** 不是「注册表里能下到的版本范围」时，给一句能指导手工处理的原因 */
function nonRegistryReason(range) {
  const r = String(range == null ? '' : range).trim();
  const scheme = (/^([a-z]+):/i.exec(r) || [])[1] || '';
  if (/^npm:/i.test(r)) return `npm: 别名写法不正确：「${r}」，应为 「npm:真实包名@范围」`;
  if (/^(file|link|portal|workspace|patch):/i.test(r)) {
    return `本地路径/工作区依赖（${scheme}:），镜像没法联网获取，需要手工处理`;
  }
  if (/^https?:/i.test(r)) return '直接指向远程 tarball 的依赖，镜像按包名回源拿不到，需要手工处理';
  if (/^(git|github|gitlab|bitbucket)[:+@]/i.test(r)) return 'git 依赖，镜像没法联网获取，需要手工处理';
  if (r.includes('/') && !r.startsWith('@')) return 'GitHub 简写依赖（user/repo），镜像没法联网获取，需要手工处理';
  return '非注册表依赖，需要手工处理';
}

/** 是不是「注册表里的版本范围」（含 `npm:` 别名，别名能解析到真实包并联网下载） */
function isRegistryRange(range) {
  const r = String(range == null ? '' : range).trim();
  if (!r || r === '*' || r === 'x' || r === 'latest') return true;
  if (/^npm:/i.test(r)) return !!parseNpmAlias(r);          // npm:别名@版本 —— 能联网下载
  if (/^(file|link|portal|workspace|patch):/i.test(r)) return false;
  if (/^(git|github|gitlab|bitbucket)[:+@]/i.test(r)) return false;
  if (/^https?:/i.test(r)) return false;
  if (r.startsWith('.') || r.startsWith('/')) return false;
  if (/^[A-Za-z]:[\\/]/.test(r)) return false;              // Windows 绝对路径
  if (r.includes('/') && !r.startsWith('@')) return false;  // GitHub 简写 user/repo
  return true;
}

/** 范围里自己带了预发布标记（如 ^1.0.0-beta.1）才允许挑预发布版本 */
function allowsPrerelease(range) {
  return /-[0-9A-Za-z]/.test(String(range || ''));
}

/** 满足范围、且尽量是正式版的最高版本；找不到正式版再退一步允许预发布 */
function stableMax(versions, range) {
  const allowPre = allowsPrerelease(range);
  const strict = versions.filter(v => satisfies(v, range) && (allowPre || !/-/.test(v)));
  if (strict.length) return strict.sort(compareVersions).pop();
  return null;
}

/**
 * 从 packument 里挑一个满足 range 的版本：
 * dist-tag → 精确版本 → 满足范围的最高正式版 → 退一步允许预发布版。
 * 依赖里写 `latest`/空/`*` 时跟随 dist-tags.latest（与 npm 一致）。
 */
function pickVersion(packument, range) {
  const versions = Object.keys((packument && packument.versions) || {});
  if (!versions.length) return null;
  const r = String(range == null ? '' : range).trim();
  const tags = (packument && packument['dist-tags']) || {};
  if (r && tags[r] && packument.versions[tags[r]]) return tags[r];   // 依赖写 dist-tag（少见但合法）
  if (r && packument.versions[r]) return r;                          // 精确版本
  if (!r || r === '*' || r === 'x' || r === 'latest') {
    if (tags.latest && packument.versions[tags.latest]) return tags.latest;
    return stableMax(versions, '*') || versions.sort(compareVersions).pop();
  }
  const best = stableMax(versions, r);
  if (best) return best;
  // 兜底：范围本身带预发布（如 `^1.0.0-beta.1`）时，自带的极简 semver 判不出 `1.0.0-beta.2` 满足它，
  // 于是先按「去掉预发布后缀」的宽松范围找（npm 里 `^1.0.0-beta.1` 也确实能匹配到 1.1.0 这类正式版），
  // 再退到「同一个 x.y.z 发布线上的最高版本」。
  if (allowsPrerelease(r)) {
    const loose = r.replace(/-[0-9A-Za-z.-]+/g, '');
    if (loose && loose !== r) {
      const hit = maxSatisfying(versions, loose);
      if (hit) return hit;
      const baseNum = (/(\d+\.\d+\.\d+)/.exec(r) || [])[1];
      if (baseNum) {
        const line = versions.filter(v => v.split('-')[0] === baseNum);
        if (line.length) return line.sort(compareVersions).pop();
      }
    }
  }
  return maxSatisfying(versions, r);
}

/** 已选版本里有没有能满足 range 的（同一棵树复用，避免同一个包被塞进一堆版本） */
function chosenFor(chosen, name, range) {
  const m = chosen.get(name);
  if (!m) return null;
  for (const [v] of m) if (satisfies(v, range)) return v;
  return null;
}

/** 已选版本里的任意一个（依赖写空范围/`*` 时用来复用，不再多塞一个版本） */
function chosenAny(chosen, name) {
  const m = chosen.get(name);
  if (!m) return null;
  return m.keys().next().value || null;
}

/** 取元数据：persist=true 落盘（走 registry，后续下载要用），false 纯读 */
async function loadPackument(ctx, name, { persist, cache }) {
  const local = await ctx.store.getAsync(name);
  const hadPkg = !!local;
  const hadVersions = new Set(local && local.packument && local.packument.versions
    ? Object.keys(local.packument.versions) : []);
  if (persist) {
    // publishTime:false —— 递归解析一个依赖树可能碰上几十个包，不能每个都去多下一份完整元数据
    const rec = await ctx.registry.ensurePackument(ctx, name, { publishTime: false });
    return { packument: (rec && rec.packument) || null, hadPkg, hadVersions };
  }
  if (local && local.packument && local.packument.versions) return { packument: local.packument, hadPkg, hadVersions };
  if (cache.has(name)) return { packument: cache.get(name), hadPkg, hadVersions };
  const doc = await ctx.upstream.getPackument(name);
  if (doc) cache.set(name, doc);
  return { packument: doc || null, hadPkg, hadVersions };
}

/**
 * 递归解析依赖闭包（BFS，按层展开）。
 *
 * @param {object} ctx 伪上下文，需要 { cfg(), store, registry, upstream, log }
 * @param {string[]} roots 根包 spec（`name` 或 `name@range`）
 * @param {object} opts
 *   depth    最大层数（默认 8，硬上限 50）：根是 0 层，depth=1 表示「只再往里走一层」
 *   limit    最多解析多少个包（默认 300，硬上限 5000）
 *   optional/peer/dev 是否跟随对应的依赖段（默认都 false）
 *   persist  是否把元数据落盘（默认 true）
 *   shouldStop()/onProgress(info)
 * @returns {Promise<{roots,picks,unresolved,errors,bad,stats}>}
 */
async function resolveClosure(ctx, roots, opts = {}) {
  const startedAt = Date.now();
  const maxDepth = clampInt(opts.depth, 0, HARD_DEPTH, DEFAULT_DEPTH);
  const maxPackages = clampInt(opts.limit, 1, HARD_LIMIT, DEFAULT_LIMIT);
  const includeOptional = opts.optional === true;
  const includePeer = opts.peer === true;
  const includeDev = opts.dev === true;
  const persist = opts.persist !== false;
  const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : null;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  const bad = [];           // 输入就不合法的 spec
  const errors = [];        // 上游取不到 / 抛异常
  const unresolved = [];    // 拿到了依赖声明但没法自动加的
  const picks = [];         // 最终要加的（name/version/depth/kind/parents）
  const chosen = new Map(); // name -> Map(version -> pick)
  const expanded = new Set();  // name@version：依赖已展开过
  const seenReq = new Set();   // name\0range：同一个 (包,范围) 只入队一次
  const cache = new Map();     // 纯读模式的 packument 缓存
  const queue = [];
  let fetched = 0, reused = 0, canceled = false, truncated = false, depthUsed = 0, rootCount = 0;

  function enqueue(req) {
    const key = req.name + '\u0000' + req.range;
    if (seenReq.has(key)) return false;
    seenReq.add(key);
    queue.push(req);
    return true;
  }

  function snapshotStats() {
    return {
      requested: (roots || []).length,
      roots: rootCount,
      packages: new Set(picks.map(p => p.name)).size,
      versions: picks.length,
      aliases: picks.filter(p => p.alias).length,
      newPackages: picks.filter(p => p.newPackage).length,
      newVersions: picks.filter(p => p.newVersion).length,
      fetched, reused,
      unresolved: unresolved.length,
      errors: errors.length,
      bad: bad.length,
      queued: queue.length,
      depthUsed, depth: maxDepth, limit: maxPackages,
      truncated, canceled,
      ms: Date.now() - startedAt,
    };
  }

  function report() {
    if (!onProgress) return;
    try { onProgress({ picks, unresolved, errors, bad, stats: snapshotStats() }); } catch (e) { /* 进度回调异常不影响解析 */ }
  }

  for (const raw of (Array.isArray(roots) ? roots : [])) {
    const spec = String(raw == null ? '' : raw).trim();
    if (!spec) continue;
    const parsed = splitRootSpec(spec);          // 根也支持 `别名@npm:真实包名@范围`
    if (!parsed || !parsed.name) { bad.push({ name: spec, error: '包名格式不正确' }); continue; }
    rootCount++;
    enqueue({ name: parsed.name, range: parsed.range, kind: 'root', depth: 0, parent: '' });
  }
  report();

  while (queue.length) {
    if (shouldStop && shouldStop()) { canceled = true; break; }
    if (picks.length >= maxPackages) { truncated = true; break; }
    const batch = [];
    while (queue.length && batch.length < RESOLVE_CONCURRENCY) batch.push(queue.shift());

    await Promise.all(batch.map(async (req) => {
      // `npm:` 别名依赖（如 element-plus 的 `@popperjs/core: npm:@sxzz/popperjs-es@^2.11.8`）：
      // 真实包名拿去回源和下载，别名只在依赖树里显示（npm 客户端装别名时也是去取真实包的 packument）。
      let alias = null, realName = req.name, realRange = req.range;
      if (/^npm:/i.test(req.range)) {
        alias = parseNpmAlias(req.range);
        if (!alias) {
          unresolved.push({ name: req.name, range: req.range, parent: req.parent, error: `npm: 别名写法不正确：「${req.range}」，应为 「npm:真实包名@范围」` });
          return;
        }
        realName = alias.name;
        realRange = alias.range;
      }
      const label = alias ? req.name : realName;
      let doc = null, hadPkg = false, hadVersions = new Set();
      try {
        const r = await loadPackument(ctx, realName, { persist, cache });
        doc = r.packument; hadPkg = r.hadPkg; hadVersions = r.hadVersions;
      } catch (e) {
        errors.push({ name: label, range: req.range, parent: req.parent, aliasOf: alias ? realName : undefined, error: `回源失败：${(e && e.message) || e}` });
        return;
      }
      if (!doc || !doc.versions || !Object.keys(doc.versions).length) {
        errors.push({
          name: label, range: req.range, parent: req.parent, aliasOf: alias ? realName : undefined,
          error: alias ? `别名指向的包 ${realName} 在上游没有找到` : '上游没有找到这个包',
        });
        return;
      }
      fetched++;

      // `latest`/`*`/空范围/dist-tag 名要走 pickVersion 解析标签，不能拿 satisfies 去复用已选版本，
      // 否则 satisfies(v,'latest') 会把「已选的任意版本」当成满足而漏掉真正需要的版本
      const isTagRange = !realRange || realRange === '*' || (/^[A-Za-z][\w.-]*$/.test(realRange) && !/^v?\d/.test(realRange));
      const hasRange = !!realRange && !isTagRange;
      let version = hasRange ? chosenFor(chosen, realName, realRange)
        : (req.kind === 'root' ? null : chosenAny(chosen, realName));
      let pick;
      if (version) {                                  // 已经选过能满足要求的版本 → 复用
        reused++;
        pick = chosen.get(realName).get(version);
        if (pick && req.parent && pick.parents.indexOf(req.parent) < 0) pick.parents.push(req.parent);
        if (pick && alias && !pick.alias) pick.alias = { name: req.name, spec: req.range };
      } else {
        version = pickVersion(doc, realRange);
        if (!version) {
          unresolved.push({
            name: label, range: realRange || 'latest', parent: req.parent, aliasOf: alias ? realName : undefined,
            error: alias
              ? `别名指向的 ${realName} 里没有满足「${realRange || 'latest'}」的版本`
              : `没有满足「${realRange || 'latest'}」的版本`,
          });
          return;
        }
        const meta = doc.versions[version] || {};
        pick = {
          name: realName, version, range: realRange || '', depth: req.depth, kind: req.kind,
          parents: req.parent ? [req.parent] : [],
          deps: Object.keys(meta.dependencies || {}).length,
          newPackage: !hadPkg, newVersion: !hadVersions.has(version),
          tarball: !!ctx.store.hasTarball(realName, version),
        };
        if (alias) pick.alias = { name: req.name, spec: req.range };
        if (!chosen.has(realName)) chosen.set(realName, new Map());
        chosen.get(realName).set(version, pick);
        picks.push(pick);
        if (req.depth > depthUsed) depthUsed = req.depth;
      }

      // 别名的包可能同时被别的分支直接依赖：按「真实包@版本」判重，避免重复展开
      if (expanded.has(realName + '@' + version)) return;
      expanded.add(realName + '@' + version);
      const key = label + '@' + version;              // 依赖树里显示的名字（别名时是别名）
      if (req.depth >= maxDepth) return;              // 到层数上限：收下这个包，但不再往里展开

      const meta = doc.versions[version] || {};
      const bundles = new Set([].concat(meta.bundledDependencies || [], meta.bundleDependencies || []));
      const sections = [['dependencies', meta.dependencies]];
      if (includeOptional) sections.push(['optionalDependencies', meta.optionalDependencies]);
      if (includePeer) sections.push(['peerDependencies', meta.peerDependencies]);
      if (includeDev) sections.push(['devDependencies', meta.devDependencies]);
      for (const [, obj] of sections) {
        for (const [dn, drange] of Object.entries(obj || {})) {
          if (bundles.has(dn)) continue;              // 随 tarball 一起发布，不用单独加
          const range = String(drange == null ? '' : drange).trim();
          if (!isRegistryRange(range)) {
            unresolved.push({ name: dn, range, parent: key, error: nonRegistryReason(range) });
            continue;
          }
          if (picks.length + queue.length >= maxPackages) { truncated = true; continue; }
          if (shouldStop && shouldStop()) { canceled = true; continue; }
          enqueue({ name: dn, range, kind: 'dep', depth: req.depth + 1, parent: key });
        }
      }
    }));

    report();
  }

  for (const p of picks) {
    p.tarball = !!ctx.store.hasTarball(p.name, p.version);
  }
  report();
  return { roots: (roots || []).slice(), picks, unresolved, errors, bad, stats: snapshotStats() };
}

module.exports = {
  isRegistryRange, parseNpmAlias, splitRootSpec, nonRegistryReason, pickVersion, resolveClosure,
  DEFAULT_DEPTH, DEFAULT_LIMIT, HARD_DEPTH, HARD_LIMIT,
};
