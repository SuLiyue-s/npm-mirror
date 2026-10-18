'use strict';
/*
 * 批量补 tarball 引擎：把「哪些版本需要下载」与「并发下载 + 进度回调」集中在这里，
 * 供 HTTP 异步任务接口（POST /__admin/api/packages/pull）复用。
 * 关键点：跨包并发下载是安全的 —— registry.ensureTarball 内部用 store.withLock(name) 串行化同一包的 packument 写入。
 */
const fs = require('node:fs');
const path = require('node:path');
const { clamp, mapLimit } = require('./util');

/** 规划时默认的读盘并发（data/config.json 的 storage.localScanConcurrency 会覆盖它） */
const DEFAULT_PLAN_CONCURRENCY = 8;

/** 规划并发归一化：1-64 的整数，非法值回退默认值 */
function planConcurrency(v) {
  return clamp(Math.floor(Number(v)) || DEFAULT_PLAN_CONCURRENCY, 1, 64);
}

/**
 * 用「这一次读到的 packument」计算缺失 tarball 的版本。
 * 不再调用 store.missingTarballs(name)——那会为了同一份数据再读一次 packument.json。
 */
function missingTarballsFrom(store, name, rec) {
  const versions = Object.keys((rec.packument && rec.packument.versions) || {});
  const dir = store.tarballDir(name);
  return versions.filter((v) => {
    const file = store.tarballFileName(name, v);
    return !file || !fs.existsSync(path.join(dir, file));
  });
}

/**
 * 规划：返回每个包要补哪些版本。
 * - mode='tags'：只补 dist-tags 指向且本地缺失的版本
 * - mode='latest'：只补 dist-tags.latest 指向且本地缺失的那一个版本
 * - mode='all'：补全部本地缺失的版本
 * - mode='selected'：只补 selected（[{name,version}]）里点名且本地缺失的版本
 *
 * 并发实现：读 packument 改用 store.getAsync（await IO），并用 mapLimit 同时读多个包
 * （并发数取 storage.localScanConcurrency，默认 8，1-64）。此前是同步循环读 1500+ 个包，
 * 会让服务整整卡住 9~15 秒，连 /-/ping、/session 都来不及响应，
 * 托盘健康检查因此误判「服务已停止」并连控制台一起关掉。
 * @param {object} [opts] {
 *   concurrency?: number,                  规划读盘并发
 *   onProgress?: (done,total,name)=>void,  每规划完一个包回调一次（已节流，供任务快照显示「已统计 N / M 个包」）
 *   shouldStop?: ()=>boolean,              返回 true 时尽快停下（任务被取消）
 * }
 */
async function planTargets(store, names, mode, selected, opts = {}) {
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
  const limit = planConcurrency(opts.concurrency);
  const total = list.length;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : null;
  let done = 0;
  let stopped = false;
  let lastEmit = 0;
  const plan = await mapLimit(list, limit, async (name) => {
    // 取消后不再读盘，把剩余包快速标记为「已取消」返回，让任务快照停在取消时的进度
    if (shouldStop && shouldStop()) {
      stopped = true;
      return { name, target: [], missingCount: 0, missingVersions: 0, error: '已取消' };
    }
    const rec = await store.getAsync(name);
    if (!rec) return { name, target: [], missingCount: 0, missingVersions: 0, error: '本地没有这个包' };
    const missing = missingTarballsFrom(store, name, rec);   // 已缓存元数据但没有 tarball 的版本
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
    // 统计进度：每规划完一个包就上报一次（按 150ms / 20 个包节流，最后一项必发），
    // 让任务快照能在耗时较长的「读 1500+ 份 packument」阶段显示「已统计 N / M 个包」，
    // 前端据此画进度条，不再是一动不动的静态文案。
    done++;
    if (onProgress) {
      const now = Date.now();
      if (done === total || done % 20 === 0 || now - lastEmit >= 150) {
        lastEmit = now;
        try { onProgress(done, total, name); } catch { /* 进度回调异常不影响规划结果 */ }
      }
    }
    return {
      name, target, missingCount: missing.length, missingVersions: missing.length, totalVersions,
      selectedCount: pick ? (byName.get(name) || new Set()).size : 0,
      latest: (rec.packument['dist-tags'] || {}).latest || '',
    };
  });
  // 被取消：不把「已取消」当成正常的空规划结果返回，抛 ECANCELED 让上层任务标记为 canceled
  if (stopped || (shouldStop && shouldStop())) {
    const err = new Error('已取消');
    err.code = 'ECANCELED';
    throw err;
  }
  // mapLimit 把单个包抛出的异常收成 {__error}：转成与「本地没有这个包」一致的失败行，不中断整批规划
  return plan.map((row, i) => (row && !row.__error ? row : {
    name: list[i], target: [], missingCount: 0, missingVersions: 0,
    error: (row && row.__error) || '规划失败',
  }));
}

/**
 * 并发下载计划内的所有 tarball。
 * @param {object} ctx 伪上下文，需要 { cfg(), store, registry, log }
 * @param {object} opts { names, mode, concurrency, onProgress(info), shouldStop(), task, plan? }
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

  // api.js 已经算好的规划直接复用：避免同一批包在请求处理与任务启动里各规划一次（大镜像会白卡两遍）
  const plan = Array.isArray(opts.plan)
    ? opts.plan
    : await planTargets(ctx.store, names, mode, selected, { concurrency: limit });
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
    downloads: [],
  };
  for (const p of plan) if (p.error) result.errors.push({ name: p.name, error: p.error });

  /* 正在下载的「版本」清单（不是包）：界面上要给每个并发下载显示它自己的实时字节进度，
   * 类似「一个 10 MB 的文件已经下了多少」。下完 / 失败 / 取消后从清单里移除。 */
  const active = new Map();            // key=name@version → { name, version, received, total, startedAt }
  const activeKey = (n, v) => `${n}@${v}`;
  let reportTimer = null;
  let lastReportAt = 0;
  const downloadsSnapshot = () => Array.from(active.values()).map(d => ({
    name: d.name, version: d.version, received: d.received, total: d.total, startedAt: d.startedAt,
  }));

  const emit = () => {
    result.downloads = downloadsSnapshot();
    if (typeof opts.onProgress === 'function') {
      try { opts.onProgress(result); } catch (e) { /* 进度回调异常不影响下载 */ }
    }
  };
  /* 每个数据块都推一次进度会让任务快照更新过于频繁（包清单本身很大），
   * 所以按 400ms 节流；结束 / 开始新下载时用 report(true) 立即推。 */
  function report(immediate) {
    const now = Date.now();
    if (!immediate && now - lastReportAt < 400) {
      if (!reportTimer) {
        reportTimer = setTimeout(() => { reportTimer = null; report(true); }, 400);
        if (typeof reportTimer.unref === 'function') reportTimer.unref();
      }
      return;
    }
    lastReportAt = now;
    if (reportTimer) { clearTimeout(reportTimer); reportTimer = null; }
    emit();
  }
  report(true);

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
        report(true);                    // 结束前把最终字节数推出去
        if (reportTimer) { clearTimeout(reportTimer); reportTimer = null; }
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
        const ak = activeKey(job.name, job.version);
        const ad = { name: job.name, version: job.version, received: 0, total: 0, startedAt: Date.now() };
        active.set(ak, ad);
        report(true);                    // 立刻让界面出现这条「正在下载的版本」
        Promise.resolve()
          .then(() => ctx.registry.ensureTarballEx(ctx, job.name, job.version, {
            onProgress: (received, total) => {
              ad.received = Number(received) || 0;
              if (total) ad.total = Number(total) || 0;
              report(false);             // 按 400ms 节流推给任务快照
            },
          }))
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
            active.delete(ak);           // 从「正在下载」清单里移除
            report(true);
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
        report(true);
        if (reportTimer) { clearTimeout(reportTimer); reportTimer = null; }
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

module.exports = { planTargets, pullTarballs, missingTarballsFrom };
