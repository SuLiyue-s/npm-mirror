'use strict';
/*
 * desktop-cancel-test.js —— 离线包导入「取消」回归测试（v0.0.3 / task-7）
 *
 * 背景（用户反馈）：导入离线包时在「解包过程」点取消，界面卡在「解包完成后、写入本地存储前」，
 * 进度弹窗一直显示「等待开始…」，任务永不结束。根因在 src/bundle.js 的 importBundle：
 *   - 解包 / 扫描阶段没有取消检查，取消后要等整包处理完才响应；
 *   - laneLoop 取消后不再开新包，终止条件 `nextPkg >= pkgDirs.length && states.every(finalized)`
 *     永远不成立，掉进 waitForWork 的 250ms 兜底定时器空转 → 任务一直 running。
 *
 * 本测试零依赖、只写仓库 tmp/desktop-cancel-test/，不碰真实 data/，不监听任何端口。
 * 覆盖：
 *   1) 正常导入（无取消）仍完整成功（防止修复把正常流程改坏）；
 *   2) 解包阶段取消：≤2s 内返回 canceled=true，不卡死，临时目录清理；
 *   3) 解包完成后（用户反馈的卡死点）取消：≤2s 内返回 canceled=true；
 *   4) 写入存储阶段取消：≤2s 内返回 canceled=true；
 *   5) 取消后 store 不留半成品、正常包数据未被破坏。
 *
 * 运行：node test/desktop-cancel-test.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tmp', 'desktop-cancel-test');
const BUILD_DIR = path.join(TMP, 'build');
const BUNDLE_DIR = path.join(TMP, 'bundles');
const STORE_DIR = path.join(TMP, 'storage');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (e) {
    failures.push({ name, error: e });
    process.stdout.write(`  FAIL ${name}：${(e && e.message) || e}\n`);
  }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || '值'}不匹配：实际 ${a}，期望 ${b}`);
}
function ok(cond, what) { if (!cond) throw new Error(what || '断言失败'); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 忽略 */ } }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

// ── 把数据目录重定向到临时目录：bundle 的 tmpRoot() 调用时读 util.dataRoot()，不会碰真实 data/ ──
rmrf(TMP);
mkdirp(TMP);
const util = require(path.join(ROOT, 'src', 'util'));
util.setDataRoot(TMP);
const tar = require(path.join(ROOT, 'src', 'tar'));
const bundle = require(path.join(ROOT, 'src', 'bundle'));
const { Store } = require(path.join(ROOT, 'src', 'store'));

/** bundle 解包临时目录（data/tmp）里残留的 import-* 目录 */
function importTmpLeftovers() {
  const dir = path.join(TMP, 'tmp');
  try {
    return fs.readdirSync(dir).filter(f => f.startsWith('import-'));
  } catch {
    return [];
  }
}

/** 造一个最小但合法的 npm tarball（根级一层目录 + package.json，可选大 payload 撑解包耗时） */
async function makeTarball(name, version, payloadBytes) {
  const file = path.join(BUILD_DIR, `${name}-${version}.tgz`);
  const entries = [{
    name: 'package/package.json',
    data: Buffer.from(JSON.stringify({ name, version, description: 'desktop-cancel-test' })),
  }];
  if (payloadBytes > 0) entries.push({ name: 'package/payload.bin', data: Buffer.alloc(payloadBytes, 0x61) });
  await tar.packTarGz(file, entries, { concurrency: 1 });
  const buf = fs.readFileSync(file);
  return { buf, size: buf.length, integrity: util.integrityOf(buf), filename: `${name}-${version}.tgz` };
}

/** 造离线包：结构 storage/<包名>/packument.json + meta.json + tarballs/<文件>.tgz + manifest.json */
async function buildBundle(file, { prefix, packages, versionsPerPkg = 1, payloadBytes = 1024 }) {
  mkdirp(BUILD_DIR);
  const entries = [];
  let tarballBytes = 0;
  let versionCount = 0;
  for (let i = 0; i < packages; i++) {
    const name = `${prefix}${i}`;
    const packument = { _id: name, name, description: 'desktop-cancel-test', 'dist-tags': {}, versions: {} };
    const meta = { source: 'cache', description: 'desktop-cancel-test', files: {}, sizes: {}, origins: {}, deprecated: {} };
    for (let vi = 0; vi < versionsPerPkg; vi++) {
      const version = `${1 + vi}.0.0`;
      const t = await makeTarball(name, version, payloadBytes);
      versionCount++;
      tarballBytes += t.size;
      const latest = packument['dist-tags'].latest;
      if (!latest || util.compareVersions(version, latest) > 0) packument['dist-tags'].latest = version;
      packument.versions[version] = {
        name, version, _id: `${name}@${version}`,
        dist: { integrity: t.integrity, tarball: `${name}/-/${t.filename}` },
      };
      meta.files[version] = t.filename;
      meta.sizes[version] = t.size;
      meta.origins[version] = 'bundle';
      entries.push({ name: `storage/${name}/tarballs/${t.filename}`, data: t.buf });
    }
    entries.push({ name: `storage/${name}/packument.json`, data: Buffer.from(JSON.stringify(packument)) });
    entries.push({ name: `storage/${name}/meta.json`, data: Buffer.from(JSON.stringify(meta)) });
  }
  const manifest = {
    format: bundle.FORMAT,
    formatVersion: bundle.FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    stats: { packages, versions: versionCount, tarballs: versionCount, tarballBytes },
  };
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
  mkdirp(path.dirname(file));
  await tar.packTarGz(file, entries, { concurrency: 2 });
  return { file, packages, versionCount };
}

/** 取消控制器：isCanceled 给 importBundle，request() 记下首次取消时刻与所在阶段 */
function makeCancelController() {
  let canceled = false;
  let tCancel = 0;
  let phase = '';
  return {
    isCanceled: () => canceled,
    request(p) {
      if (canceled) return;
      canceled = true;
      tCancel = Date.now();
      phase = p || '';
    },
    get canceled() { return canceled; },
    get tCancel() { return tCancel; },
    get phase() { return phase; },
  };
}

/** 带硬超时的 importBundle：取消后若仍卡死，测试会在 timeoutMs 后失败而不是一直挂着 */
async function runImport(opts, timeoutMs = 8000) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`importBundle 超过 ${timeoutMs}ms 未结束（取消后卡死的回归）`)), timeoutMs);
    if (timer.unref) timer.unref();
  });
  try {
    return await Promise.race([bundle.importBundle(opts), guard]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const store = new Store({ dir: STORE_DIR });
  await store.initAsync();

  // ── 1) 正常导入：不取消，必须完整成功 ──
  process.stdout.write('\n[1] 正常导入（无取消）\n');
  const normalFile = path.join(BUNDLE_DIR, 'normal.tgz');
  const normalMeta = await buildBundle(normalFile, { prefix: 'normal-pkg-', packages: 6, versionsPerPkg: 2, payloadBytes: 4096 });
  {
    const phases = new Set();
    const started = Date.now();
    const r = await runImport({
      store, file: normalFile, overwrite: true,
      isCanceled: () => false,
      onProgress: (ev) => { if (ev && ev.phase) phases.add(ev.phase); },
    });
    const elapsed = Date.now() - started;
    check(`正常导入完成（${elapsed}ms）`, () => {
      ok(r && !r.canceled, '正常导入不应被标记为 canceled');
      eq(r.packages, normalMeta.packages, '导入包数');
      eq(r.versions, normalMeta.versionCount, '导入版本数');
      eq(r.tarballs, normalMeta.versionCount, '导入 tarball 数');
      ok(phases.has('extract') && phases.has('extract-done') && phases.has('scan') && phases.has('scan-done') && phases.has('package-start'),
        `进度阶段不完整：${Array.from(phases).join(',')}`);
    });
    check('正常导入后临时目录已清理', () => eq(importTmpLeftovers(), [], 'import-* 残留'));
    check('正常导入后 store 里有完整数据', () => {
      const local = store.get('normal-pkg-0');
      ok(local && local.packument && local.packument.versions, 'store 里找不到 normal-pkg-0');
      eq(Object.keys(local.packument.versions).sort(), ['1.0.0', '2.0.0'], 'normal-pkg-0 版本');
    });
  }

  // ── 2) 解包阶段取消：必须 ≤2s 终止（旧实现要等整包解完） ──
  process.stdout.write('\n[2] 解包阶段取消\n');
  const extractFile = path.join(BUNDLE_DIR, 'cancel-extract.tgz');
  // 40 个包 × 2MB payload：解包数据量足够大，保证取消发生在解包过程中
  await buildBundle(extractFile, { prefix: 'excancel-pkg-', packages: 40, versionsPerPkg: 1, payloadBytes: 2 * 1024 * 1024 });
  {
    const ctl = makeCancelController();
    let extractEvents = 0;
    let started = 0;
    let r = null;
    let err = null;
    started = Date.now();
    try {
      r = await runImport({
        store, file: extractFile, overwrite: true,
        isCanceled: ctl.isCanceled,
        onProgress: (ev) => {
          if (!ev) return;
          if (ev.phase === 'extract') {
            extractEvents++;
            // 前几个条目解出后立刻点取消，对应「解包过程」点取消
            if (extractEvents >= 3) ctl.request('extract');
          }
        },
      });
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - started;
    check(`解包阶段取消能在 2s 内终止（实际 ${elapsed}ms）`, () => {
      ok(!err, `importBundle 抛错：${(err && err.message) || err}`);
      ok(ctl.canceled, '取消未被触发（测试自身前置未满足）');
      ok(r && r.canceled === true, '结果应带 canceled=true');
      ok(Date.now() - ctl.tCancel < 2000, `取消到结束耗时 ${Date.now() - ctl.tCancel}ms 超过 2s`);
      eq(ctl.phase, 'extract', '取消应发生在解包阶段');
      eq(r.packages, 0, '取消后不应有包被导入');
    });
    check('解包取消后临时目录已清理', () => eq(importTmpLeftovers(), [], 'import-* 残留'));
    check('解包取消后 store 没有写入该包', () => {
      ok(!store.get('excancel-pkg-0'), 'excancel-pkg-0 不应被写入 store');
    });
  }

  // ── 3) 「解包完成后、写入本地存储前」取消：用户反馈的卡死点 ──
  process.stdout.write('\n[3] 解包完成、写入存储前取消（用户反馈卡死点）\n');
  const scanFile = path.join(BUNDLE_DIR, 'cancel-after-extract.tgz');
  // 包目录多（解包快、扫描有活干），payload 小
  await buildBundle(scanFile, { prefix: 'scancel-pkg-', packages: 200, versionsPerPkg: 1, payloadBytes: 512 });
  {
    const ctl = makeCancelController();
    const started = Date.now();
    let err = null;
    let r = null;
    try {
      r = await runImport({
        store, file: scanFile, overwrite: true,
        isCanceled: ctl.isCanceled,
        onProgress: (ev) => {
          if (ev && ev.phase === 'extract-done') ctl.request('extract-done');
        },
      });
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - started;
    check(`解包完成后取消能在 2s 内终止、任务不永久 running（实际 ${elapsed}ms）`, () => {
      ok(!err, `importBundle 抛错：${(err && err.message) || err}`);
      ok(ctl.canceled, '取消未被触发（测试自身前置未满足）');
      ok(r && r.canceled === true, '结果应带 canceled=true');
      ok(Date.now() - ctl.tCancel < 2000, `取消到结束耗时 ${Date.now() - ctl.tCancel}ms 超过 2s`);
      eq(ctl.phase, 'extract-done', '取消应正好发生在解包完成后');
      eq(r.packages, 0, '取消后不应有包被导入');
    });
    check('解包后取消：临时目录已清理', () => eq(importTmpLeftovers(), [], 'import-* 残留'));
    check('解包后取消：store 没有写入该包', () => {
      ok(!store.get('scancel-pkg-0'), 'scancel-pkg-0 不应被写入 store');
    });
  }

  // ── 4) 写入存储阶段取消：正在导入时点取消，也要 ≤2s 终止 ──
  process.stdout.write('\n[4] 写入存储阶段取消\n');
  const laneFile = path.join(BUNDLE_DIR, 'cancel-importing.tgz');
  await buildBundle(laneFile, { prefix: 'lcancel-pkg-', packages: 20, versionsPerPkg: 2, payloadBytes: 64 * 1024 });
  {
    const ctl = makeCancelController();
    const started = Date.now();
    let err = null;
    let r = null;
    try {
      r = await runImport({
        store, file: laneFile, overwrite: true,
        isCanceled: ctl.isCanceled,
        onProgress: (ev) => {
          if (ev && ev.phase === 'package-start') ctl.request('package-start');
        },
      });
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - started;
    check(`导入阶段取消能在 2s 内终止（实际 ${elapsed}ms）`, () => {
      ok(!err, `importBundle 抛错：${(err && err.message) || err}`);
      ok(ctl.canceled, '取消未被触发（测试自身前置未满足）');
      ok(r && r.canceled === true, '结果应带 canceled=true');
      ok(Date.now() - ctl.tCancel < 2000, `取消到结束耗时 ${Date.now() - ctl.tCancel}ms 超过 2s`);
      eq(ctl.phase, 'package-start', '取消应发生在写入本地存储阶段');
    });
    check('导入阶段取消：临时目录已清理', () => eq(importTmpLeftovers(), [], 'import-* 残留'));
  }

  // ── 5) 取消不影响已导入数据与 store 索引 ──
  process.stdout.write('\n[5] 取消后的数据完整性\n');
  check('已正常导入的包数据未被取消破坏', () => {
    const local = store.get('normal-pkg-1');
    ok(local && local.packument && local.packument.versions['1.0.0'], 'normal-pkg-1@1.0.0 丢失');
    ok(local.meta && local.meta.files && local.meta.files['1.0.0'], 'normal-pkg-1 的 meta.files 丢失');
  });
  check('取消的包没有留下空条目', () => {
    for (const n of ['excancel-pkg-0', 'scancel-pkg-0']) ok(!store.get(n), `${n} 不应存在`);
  });

  // ── 汇总 ──
  process.stdout.write(`\n${passed} 项通过，${failures.length} 项失败\n`);
  if (failures.length) {
    for (const f of failures) process.stdout.write(`  ✗ ${f.name}：${(f.error && f.error.message) || f.error}\n`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`\n测试异常：${(e && e.stack) || e}\n`);
  process.exit(1);
});
