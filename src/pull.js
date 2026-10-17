'use strict';
/*
 * 批量补 tarball 引擎：把「哪些版本需要下载」与「并发下载 + 进度回调」集中在这里，
 * 供 HTTP 异步任务接口（POST /__admin/api/packages/pull）复用。
 * 关键点：跨包并发下载是安全的 —— registry.ensureTarball 内部用 store.withLock(name) 串行化同一包的 packument 写入。
 */
const fs = require('node:fs');

/**
 * 规划：返回每个包要补哪些版本。
 * - mode='tags'：只补 dist-tags 指向且本地缺失的版本
 * - mode='latest'：只补 dist-tags.latest 指向且本地缺失的那一个版本
 * - mode='all'：补全部本地缺失的版本
 * - mode='selected'：只补 selected（[{name,version}]）里点名且本地缺失的版本
 */
function planTargets(store, names, mode, selected) {
  const pick = mode === 'selected';
  const byName = new Map();
  if (pick) {
    for (const s of (selected || [])) {
      const n = String((s && s.name) || '').trim();
      const v = String((s && s.version) || '').trim();
      if (!n || !v) continue;
      if (!byName.has(n)) byName.set(n, new Set());
      byName.get(n).add(v);
    }
  }
  const list = pick ? Array.from(byName.keys()) : names;
  const plan = [];
  for (const name of list) {
    const rec = store.get(name);
    if (!rec) { plan.push({ name, target: [], missingCount: 0, missingVersions: 0, error: '本地没有这个包' }); continue; }
    const missing = store.missingTarballs(name);          // 已缓存元数据但没有 tarball 的版本
    const missingSet = new Set(missing);
    let target;
    if (pick) {
      const want = byName.get(name) || new Set();
      target = missing.filter(v => want.has(v));           // 选中的版本里，本地还没 tarball 的
    } else if (mode === 'all') {
      target = missing.slice();
    } else if (mode === 'latest') {
      const tags = rec.packument['dist-tags'] || {};
      const v = String(tags.latest || '');
      target = (v && missingSet.has(v)) ? [v] : [];
    } else {
      const tags = rec.packument['dist-tags'] || {};
      const set = new Set();
      for (const v of Object.values(tags)) if (missingSet.has(v)) set.add(v);
      target = Array.from(set);
    }
    const meta = rec.meta || {};
    const totalVersions = Number.isFinite(meta.versionCount) ? meta.versionCount : Object.keys(rec.packument.versions || {}).length;
    plan.push({
      name, target, missingCount: missing.length, missingVersions: missing.length, totalVersions,
      selectedCount: pick ? (byName.get(name) || new Set()).size : 0,
      latest: (rec.packument['dist-tags'] || {}).latest || '',
    });
  }
  return plan;
}

/**
 * 并发下载计划内的所有 tarball。
 * @param {object} ctx 伪上下文，需要 { cfg(), store, registry, log }
 * @param {object} opts { names, mode, concurrency, onProgress(info), shouldStop(), task }
 * @returns {Promise<object>} 汇总结果
 */
async function pullTarballs(ctx, opts) {
  const mode = opts.mode === 'all' ? 'all'
    : (opts.mode === 'selected' ? 'selected'
      : (opts.mode === 'latest' ? 'latest' : 'tags'));
  const selected = Array.isArray(opts.selected) ? opts.selected : [];
  const rawNames = (Array.isArray(opts.names) && opts.names.length)
    ? opts.names
    : selected.map(s => (s && s.name) || '');
  const names = Array.from(new Set(rawNames.map(n => String(n).trim()).filter(Boolean)));
  const cfg = ctx.cfg();
  const cfgConc = Number((cfg.upstream && cfg.upstream.concurrency) || 6);
  const limit = Math.max(1, Math.min(32, Number(opts.concurrency) || cfgConc || 6));

  const plan = planTargets(ctx.store, names, mode, selected);
  const pkgs = plan.map((p) => ({
    name: p.name, target: p.target.length, done: 0, ok: 0, failed: 0, bytes: 0,
    missing: p.missingCount, totalVersions: p.totalVersions || 0,
    latest: p.latest || '', error: p.error || '', status: 'pending',
  }));
  const byName = new Map(pkgs.map((p) => [p.name, p]));

  const jobs = [];
  for (const p of plan) for (const v of p.target) jobs.push({ name: p.name, version: v });

  const result = {
    mode, concurrency: limit, requested: names.length,
    total: jobs.length, done: 0, ok: 0, failed: 0, bytes: 0,
    packages: pkgs, errors: [], canceled: false,
  };
  for (const p of plan) if (p.error) result.errors.push({ name: p.name, error: p.error });

  const report = () => {
    if (typeof opts.onProgress === 'function') {
      try { opts.onProgress(result); } catch (e) { /* 进度回调异常不影响下载 */ }
    }
  };
  report();

  let guard = 0;                       // 正在跑的任务数
  let cursor = 0;                      // 下一个待取任务下标
  let canceled = false;

  const sizeOf = (file) => { try { return fs.statSync(file).size; } catch (e) { return 0; } };

  return await new Promise((resolve) => {
    if (!jobs.length) { resolve(result); return; }

    function done() {
      guard--;
      if (guard === 0) {
        // 收尾这一刻也要再看一眼取消标志：全部任务已派发、最后一个下载期间按下取消也必须生效
        if (!canceled && typeof opts.shouldStop === 'function' && opts.shouldStop()) canceled = true;
        if (canceled) result.canceled = true;
        resolve(result);
      }
    }

    function pump() {
      while (guard < limit && cursor < jobs.length) {
        if (typeof opts.shouldStop === 'function' && opts.shouldStop()) { canceled = true; break; }
        const job = jobs[cursor++];
        guard++;
        const pkg = byName.get(job.name);
        if (pkg) pkg.status = 'running';
        Promise.resolve()
          .then(() => ctx.registry.ensureTarballEx(ctx, job.name, job.version))
          .then((r) => {
            // 注意：ensureTarballEx 不抛异常时也可能"什么都没下到"（如元数据里没有 tarball 地址），
            // 这种情况必须算失败，否则会出现「新增 1 个 · 0 B」的假成功
            if (!r || !r.path) {
              const txt = (ctx.registry.TARBALL_REASON_TEXT || {})[r && r.reason] || '未能获取 tarball';
              const err = new Error(txt); err.code = 'ENOTARBALL'; err.reason = r && r.reason;
              throw err;
            }
            const size = sizeOf(r.path);
            result.done++; result.ok++; result.bytes += size;
            if (pkg) { pkg.done++; pkg.ok++; pkg.bytes += size; }
            if (ctx.log && ctx.log.debug) ctx.log.debug(`补 tarball ${job.name}@${job.version}（${size} 字节）`);
          })
          .catch((e) => {
            result.done++; result.failed++;
            if (pkg) { pkg.done++; pkg.failed++; }
            const msg = (e && e.message) || String(e);
            if (result.errors.length < 200) result.errors.push({ name: job.name, version: job.version, error: msg });
            if (ctx.log && ctx.log.warn) ctx.log.warn(`补 tarball 失败 ${job.name}@${job.version}：${msg}`);
          })
          .then(() => {
            report();
            done();
            // 已取消 / 已停止就绝不再取新任务（避免"取消后仍在后台悄悄下载"）
            if (!canceled && guard < limit && cursor < jobs.length && !(typeof opts.shouldStop === 'function' && opts.shouldStop())) pump();
          });
      }
      if (guard === 0 && (cursor >= jobs.length || canceled)) {
        if (!canceled && typeof opts.shouldStop === 'function' && opts.shouldStop()) {
          canceled = true;
          result.canceled = true;
        }
        resolve(result);
      }
    }

    pump();
  }).then((r) => {
    for (const p of pkgs) {
      if (p.error) p.status = 'error';
      else if (p.target === 0) p.status = 'done';
      else if (p.failed > 0) p.status = 'error';
      else if ((canceled || r.canceled) && p.done < p.target) p.status = 'canceled';
      else p.status = 'done';
    }
    return r;
  });
}

module.exports = { planTargets, pullTarballs };
