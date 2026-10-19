'use strict';
/**
 * 桌面版一键脚本（DESIGN 4.7）：只允许白名单脚本，用独立的 cli.js 子进程执行，
 * stdout/stderr 按行写进运行控制台（source=script），完成后追加结果行。
 * 脚本与 Node 主进程完全隔离：脚本失败/被杀不会影响镜像源服务。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const util = require('./util');
const consoleMod = require('./console');

function coded(code, message) { const e = new Error(message); e.code = code; return e; }

/** 校验要导入的离线包：必须是存在的绝对路径、.tgz / .tar.gz、大小 > 0 */
function validateBundleFile(file) {
  const raw = String(file == null ? '' : file).trim();
  if (!raw) throw coded('EBADFILE', '请先选择离线包文件（.tgz / .tar.gz）');
  if (raw.includes('\0')) throw coded('EBADFILE', '离线包路径不能包含空字节');
  if (!path.isAbsolute(raw)) throw coded('EBADFILE', `离线包必须是绝对路径：${raw}`);
  const abs = path.resolve(raw);
  if (!/\.(tgz|tar\.gz)$/i.test(abs)) throw coded('EBADFILE', '离线包必须是 .tgz 或 .tar.gz 文件');
  let st = null;
  try { st = fs.statSync(abs); } catch { st = null; }
  if (!st) throw coded('EBADFILE', `离线包不存在：${abs}`);
  if (!st.isFile()) throw coded('EBADFILE', `不是文件：${abs}`);
  if (!st.size) throw coded('EBADFILE', `离线包是空文件：${abs}`);
  return abs;
}

/** 白名单：名称 → 固定参数（顺序与参数都不允许外部指定） */
const SCRIPTS = {
  doctor: {
    label: '环境自检',
    steps: () => [{ label: '环境自检', args: ['doctor'] }],
  },
  status: {
    label: '运行状态',
    steps: () => [{ label: '运行状态', args: ['status'] }],
  },
  'export-all': {
    label: '导出全部离线包',
    steps: () => [{ label: '导出全部离线包', args: ['export', '--scope', 'all'] }],
  },
  'cache-scan-import': {
    label: '扫描并导入 npm 缓存',
    steps: () => [
      { label: '扫描 npm 缓存', args: ['scan-cache'] },
      { label: '导入缓存到镜像源', args: ['import-cache', '--all'] },
    ],
  },
  'import-bundle': {
    label: '导入离线包',
    steps: (params = {}) => [{ label: `导入离线包 ${path.basename(String(params.file || ''))}`, args: ['import', validateBundleFile(params.file), '--overwrite'] }],
  },
};

const tasks = new Map();   // taskId → task（含已结束的最近记录，用于取消校验/排错）
let last = null;           // 最近一次结束的任务
let taskSeq = 0;
const MAX_KEPT_TASKS = 50;

function pushConsole(level, text) {
  try { consoleMod.get().push({ source: 'script', level, text }); } catch { /* 忽略 */ }
}

function runningTasks() { return [...tasks.values()].filter(t => t.state === 'running'); }

function isRunning(name) { return runningTasks().some(t => t.name === name); }

/** 启动一个白名单脚本；返回 {taskId,name}，参数非法/重复运行会抛带 code 的错误 */
function run(name, params = {}) {
  const key = String(name == null ? '' : name).trim();
  const def = SCRIPTS[key];
  if (!def) throw coded('EBADSCRIPT', `未知的一键脚本：${key || '(空)'}（可用：${Object.keys(SCRIPTS).join('、')}）`);
  if (isRunning(key)) throw coded('EBUSY', `脚本「${key}」正在运行，请等待结束后再试`);
  const steps = def.steps(params || {});        // import-bundle 在这里校验文件，非法直接抛 400
  const id = `script-${Date.now()}-${++taskSeq}`;
  const task = {
    id, name: key, label: def.label, state: 'running',
    startedAt: new Date().toISOString(), endedAt: null, exitCode: null,
    canceled: false, steps, stepIndex: 0, child: null, childPid: 0,
  };
  tasks.set(id, task);
  pushConsole('info', `[${key}] 开始执行：${def.label}`);
  _runTask(task).catch(() => {});
  return { taskId: id, name: key };
}

async function _runTask(task) {
  try {
    for (let i = 0; i < task.steps.length; i++) {
      if (task.canceled) return _finish(task, 'canceled');
      task.stepIndex = i;
      const step = task.steps[i];
      if (task.steps.length > 1) pushConsole('info', `[${task.name}] 阶段 ${i + 1}/${task.steps.length}：${step.label}`);
      const code = await _runStep(task, step.args);
      task.exitCode = code;
      if (task.canceled) return _finish(task, 'canceled');
      if (code !== 0) return _finish(task, 'failed');
      if (task.steps.length > 1) pushConsole('info', `[${task.name}] 阶段完成：${step.label}`);
    }
    return _finish(task, 'ok');
  } catch (e) {
    pushConsole('error', `[${task.name}] 执行异常：${(e && e.message) || e}`);
    return _finish(task, 'failed');
  }
}

/** 跑一步：返回退出码（spawn 失败/被杀也折算成非 0）
 *
 * 输出采集方式：把子进程 stdout/stderr 直接重定向到数据目录 tmp 下的日志文件（父进程 spawn 时传 fd 继承），
 * 再按 120ms 轮询增量读取、按行写入运行控制台。相比 stdio:'pipe'：
 *   - 在受限环境（如桌面版内嵌/沙箱）里 pipe 可能被拒绝（EPERM），继承文件句柄始终可用；
 *   - 输出不会因为控制台缓冲而丢失，脚本结束后再读一次剩余内容。
 */
let stepSeq = 0;
const OUT_POLL_MS = 120;

function _ensureTmpDir() {
  const dir = util.dataPath('tmp');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  return dir;
}

/** 从 offset 起增量读文件，按行写入控制台；返回是否还有未处理内容 */
function _drainFile(state, level, prefix) {
  try {
    if (fs.statSync(state.file).size <= state.offset) return;
    const fh = fs.openSync(state.file, 'r');
    try {
      const size = fs.fstatSync(fh).size;
      while (state.offset < size) {
        const len = Math.min(size - state.offset, 1024 * 1024);
        const buf = Buffer.allocUnsafe(len);
        const read = fs.readSync(fh, buf, 0, len, state.offset);
        if (read <= 0) break;
        state.offset += read;
        state.buf += buf.slice(0, read).toString('utf8');
      }
    } finally {
      fs.closeSync(fh);
    }
  } catch {
    return;
  }
  let idx;
  while ((idx = state.buf.indexOf('\n')) >= 0) {
    const line = state.buf.slice(0, idx).replace(/\r$/, '');
    state.buf = state.buf.slice(idx + 1);
    if (line) pushConsole(level, prefix + line);
  }
  if (state.buf.length > 64 * 1024) { pushConsole(level, prefix + state.buf); state.buf = ''; }
}

/** 收尾：读剩余内容、吐出未换行的尾行、删除临时文件 */
function _flushFile(state, level, prefix) {
  if (!state) return;
  _drainFile(state, level, prefix);
  const tail = state.buf.replace(/\r$/, '');
  if (tail) pushConsole(level, prefix + tail);
  state.buf = '';
  try { fs.unlinkSync(state.file); } catch { /* 忽略 */ }
}

function _runStep(task, args) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (code) => { if (!settled) { settled = true; resolve(code); } };
    const prefix = `[${task.name}] `;
    const tmpDir = _ensureTmpDir();
    const stamp = `${Date.now()}-${++stepSeq}`;
    const outFile = path.join(tmpDir, `script-${task.id}-${stamp}.out.log`);
    const errFile = path.join(tmpDir, `script-${task.id}-${stamp}.err.log`);
    let child = null;
    let outFd = -1;
    let errFd = -1;
    try {
      outFd = fs.openSync(outFile, 'a');
      errFd = fs.openSync(errFile, 'a');
      child = spawn(process.execPath, [path.join(util.appRoot(), 'cli.js'), ...args], {
        cwd: util.appRoot(),
        env: { ...process.env, MIRROR_DATA_DIR: util.dataRoot(), MIRROR_DESKTOP: '1' },
        windowsHide: true,
        stdio: ['ignore', outFd, errFd],
      });
    } catch (e) {
      try { if (outFd >= 0) fs.closeSync(outFd); } catch { /* 忽略 */ }
      try { if (errFd >= 0) fs.closeSync(errFd); } catch { /* 忽略 */ }
      try { fs.unlinkSync(outFile); } catch { /* 忽略 */ }
      try { fs.unlinkSync(errFile); } catch { /* 忽略 */ }
      pushConsole('error', `${prefix}无法启动脚本进程：${(e && e.message) || e}`);
      return done(-1);
    }
    // 句柄已被子进程继承，父进程侧立即关闭
    try { fs.closeSync(outFd); } catch { /* 忽略 */ }
    try { fs.closeSync(errFd); } catch { /* 忽略 */ }
    task.child = child;
    task.childPid = child.pid || 0;
    const outState = { file: outFile, offset: 0, buf: '' };
    const errState = { file: errFile, offset: 0, buf: '' };
    const timer = setInterval(() => {
      _drainFile(outState, 'info', prefix);
      _drainFile(errState, 'warn', prefix);
    }, OUT_POLL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    const cleanup = () => {
      clearInterval(timer);
      _flushFile(outState, 'info', prefix);
      _flushFile(errState, 'warn', prefix);
    };
    child.on('error', (e) => {
      task.child = null;
      task.childPid = 0;
      cleanup();
      pushConsole('error', `${prefix}脚本进程出错：${(e && e.message) || e}`);
      done(-1);
    });
    child.on('close', (code, signal) => {
      task.child = null;
      task.childPid = 0;
      cleanup();
      if (code === null) {
        pushConsole('warn', `${prefix}脚本被信号终止（${signal || '未知'}）`);
        done(-1);
      } else {
        done(code);
      }
    });
  });
}

function _finish(task, state) {
  if (!task || task.state !== 'running') return;
  task.state = state;
  task.endedAt = new Date().toISOString();
  task.child = null;
  task.childPid = 0;
  const seconds = Math.max(0, (Date.parse(task.endedAt) - Date.parse(task.startedAt)) / 1000).toFixed(1);
  if (state === 'ok') pushConsole('info', `[${task.name}] 成功（耗时 ${seconds}s）`);
  else if (state === 'canceled') pushConsole('warn', `[${task.name}] 已取消（耗时 ${seconds}s）`);
  else pushConsole('error', `[${task.name}] 失败（退出码 ${task.exitCode == null ? '?' : task.exitCode}，耗时 ${seconds}s）`);
  last = {
    id: task.id, name: task.name, status: state,
    exitCode: task.exitCode == null ? (state === 'ok' ? 0 : -1) : task.exitCode,
    startedAt: task.startedAt, endedAt: task.endedAt,
  };
  // 只保留最近若干个已结束任务，避免长时间运行后 Map 无限增长
  if (tasks.size > MAX_KEPT_TASKS) {
    for (const [id, t] of tasks) {
      if (t.state !== 'running') tasks.delete(id);
      if (tasks.size <= MAX_KEPT_TASKS) break;
    }
  }
}

/** 杀掉子进程树：Windows 用 taskkill /T /F（Claude/Node 子进程常带孙进程），其它平台退回 SIGTERM */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => {});
      k.unref();
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch { /* 进程可能已退出 */ }
}

/** 取消正在运行的脚本：返回是否命中（taskId 未知/已结束 → false） */
function cancel(taskId) {
  const id = String(taskId == null ? '' : taskId);
  const task = tasks.get(id);
  if (!task || task.state !== 'running') return false;
  task.canceled = true;
  pushConsole('warn', `[${task.name}] 正在取消…`);
  killTree(task.childPid);
  return true;
}

/** 查询运行状态：running 列表 + 最近一次结束的任务 */
function status() {
  return {
    running: runningTasks().map(t => ({ id: t.id, name: t.name, startedAt: t.startedAt })),
    last: last ? { ...last } : null,
  };
}

/** 服务退出前取消所有脚本（不影响用户数据，只是不再让子进程活着） */
function cancelAll() {
  for (const task of runningTasks()) {
    task.canceled = true;
    killTree(task.childPid);
  }
}

function scriptNames() { return Object.keys(SCRIPTS); }
function scriptDefs() {
  return Object.entries(SCRIPTS).map(([name, def]) => ({ name, label: def.label }));
}

module.exports = { run, cancel, status, cancelAll, isRunning, scriptNames, scriptDefs, validateBundleFile, SCRIPTS };
