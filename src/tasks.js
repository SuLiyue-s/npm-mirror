'use strict';
/*
 * 后台任务登记表（内存态）：给「补 tarball」这类长任务提供进度查询与取消。
 * 只保存最近 MAX 条，服务重启后清空（前端遇到 404 会提示任务已结束）。
 */
const MAX_TASKS = 40;
let lastOverflowWarn = 0;

let seq = 0;
const tasks = new Map();

function nowMs() { return Date.now(); }

function brief(t) {
  const elapsedMs = (t.finishedAt || nowMs()) - t.startedAt;
  const sec = Math.max(1, elapsedMs / 1000);
  const percent = t.total > 0 ? Math.min(100, Math.round((t.done / t.total) * 100)) : (t.status === 'running' ? 0 : 100);
  const rate = t.ok / sec;                                    // 个/秒：只算真正下到的，失败的不计入速度
  const etaSec = t.status === 'running' && rate > 0 ? Math.max(0, Math.round((t.total - t.done) / rate)) : 0;
  return {
    id: t.id, type: t.type, title: t.title, status: t.status,
    total: t.total, done: t.done, ok: t.ok, failed: t.failed, bytes: t.bytes,
    bytesTotal: t.bytesTotal || 0,
    skipped: t.skipped || 0,
    versions: t.versions || 0, tarballs: t.tarballs || 0,
    current: t.current || '', currentDone: t.currentDone || 0, currentTotal: t.currentTotal || 0,
    /* 正在并发下载的每个版本（tarball）的实时字节进度：{name,version,received,total}[] */
    downloads: t.downloads || [],
    /* 并行打包/导入时同时在处理的包：{name,done,total}[]（导出 done/total = 已写/总文件数）
     * 注意这是白名单字段：不加进来，/tasks/<id> 快照里就看不到 */
    inFlight: t.inFlight || [],
    percent, elapsedMs, ratePerSec: Number(rate.toFixed(2)),
    bytesPerSec: Math.round(t.bytes / sec), etaSec,
    concurrency: t.concurrency,
    phase: t.phase || '',
    startedAt: t.startedAt, finishedAt: t.finishedAt,
    message: t.message, cancelRequested: t.cancelRequested,
  };
}

function create(init = {}) {
  const id = 't' + nowMs().toString(36) + (++seq).toString(36);
  const t = {
    id,
    type: init.type || 'task',
    title: init.title || '',
    status: 'running',
    phase: init.phase || '',
    total: Number(init.total) || 0,
    done: 0, ok: 0, failed: 0, bytes: 0,
    concurrency: Number(init.concurrency) || 1,
    packages: init.packages || [],
    errors: [],
    result: null,
    message: '',
    cancelRequested: false,
    startedAt: nowMs(),
    finishedAt: null,
  };
  tasks.set(id, t);
  prune();
  return t;
}

function get(id) { return tasks.get(id) || null; }

function snapshot(id) {
  const t = tasks.get(id);
  if (!t) return null;
  return { ...brief(t), packages: t.packages, errors: t.errors.slice(0, 50), result: t.result };
}

function list() {
  return Array.from(tasks.values()).map(brief).sort((a, b) => b.startedAt - a.startedAt);
}

function update(id, patch) {
  const t = tasks.get(id);
  if (!t) return null;
  Object.assign(t, patch);
  return t;
}

function finish(id, { status = 'done', message = '', result = null } = {}) {
  const t = tasks.get(id);
  if (!t) return null;
  t.status = status;
  if (message) t.message = message;
  if (result !== null) t.result = result;
  if (t.finishedAt === null) t.finishedAt = nowMs();
  return t;
}

function cancel(id) {
  const t = tasks.get(id);
  if (!t) return null;
  // 标志位是"粘性"的：即使任务已被误标为终态，也允许再按一次取消把仍在跑的下载循环停掉
  t.cancelRequested = true;
  if (t.status === 'running') t.message = '正在停止…';
  return brief(t);
}

function prune() {
  const all = Array.from(tasks.values()).sort((a, b) => a.startedAt - b.startedAt);
  const overflow = all.length - MAX_TASKS;
  if (overflow <= 0) return;
  let removed = 0;
  for (const t of all) {
    if (removed >= overflow) break;
    // running 不参与淘汰，但不能 break：继续扫描，把更旧的终态任务淘汰掉
    if (t.status === 'running') continue;
    tasks.delete(t.id);
    removed++;
  }
  if (removed < overflow && Date.now() - lastOverflowWarn > 60000) {
    lastOverflowWarn = Date.now();
    // running 太多时允许超出上限，但记录下来便于排查
    try { console.warn(`[tasks] 运行中任务过多（${all.length - removed} > ${MAX_TASKS}），暂不淘汰 running 任务`); } catch { /* 忽略 */ }
  }
}

module.exports = { create, get, list, snapshot, brief, update, finish, cancel, prune, MAX_TASKS };
