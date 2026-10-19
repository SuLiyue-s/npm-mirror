'use strict';
/* 桌面版路径解析单测（DESIGN 4.2）
 *
 * 覆盖：
 *   - dataRoot 解析优先级：--data-dir 参数 > MIRROR_DATA_DIR > <程序目录>/data
 *   - 路径穿越（../x、..\x、a/../../x）必须抛 EPATH
 *   - 绝对路径、盘符相对（C:foo）、NUL、空串、非字符串必须抛 EPATH
 *   - 旧配置兼容：data/storage、data\storage 前缀视为相对数据目录
 *   - dataPath()/setDataRoot() 的校验
 *
 * 运行：node test/desktop-path-test.js
 * 退出码 0=全部通过，1=有失败（打印失败明细）。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    failures.push({ name, error: (e && e.message) || String(e) });
    process.stdout.write(`  ✗ ${name}\n      ${(e && e.message) || e}\n`);
  }
}

function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label || '值'}不相等：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function expectPathError(fn, label) {
  try {
    fn();
  } catch (e) {
    if (e && e.code === 'EPATH') return e;
    throw new Error(`${label || 'resolveWithinDataRoot'} 抛出的错误码应为 EPATH，实际：${e && (e.code || e.message)}`);
  }
  throw new Error(`${label || 'resolveWithinDataRoot'} 应当抛出 EPATH，但没有抛错`);
}

// ---------------------------------------------------------------------------
// 子进程场景：验证 dataRoot 解析优先级（util 在 require 时解析，必须独立进程）
// 注意：DSH 沙箱内 child_process 的 stdio:'pipe' 会 EPERM（Windows 命名管道限制），
//       所以用 stdio:'ignore' 启动子进程，结果通过临时文件回传。
// ---------------------------------------------------------------------------
const probeDir = path.join(ROOT, 'tmp', 'desktop-path-test');
const probeScriptFile = path.join(probeDir, 'probe-run.js');
const probeOutFile = path.join(probeDir, 'probe-out.json');

function probeDataRoot({ env = process.env, args = [] } = {}) {
  fs.mkdirSync(probeDir, { recursive: true });
  if (!fs.existsSync(probeScriptFile)) {
    fs.writeFileSync(probeScriptFile, [
      "'use strict';",
      "const fs = require('node:fs');",
      "const u = require(process.env.DESKTOP_PATH_PROBE_UTIL);",
      "fs.writeFileSync(process.env.DESKTOP_PATH_PROBE_OUT, JSON.stringify({ dataRoot: u.dataRoot(), appRoot: u.appRoot(), desktop: u.isDesktop() }));",
    ].join('\n'));
  }
  fs.rmSync(probeOutFile, { force: true });
  const r = spawnSync(NODE, [probeScriptFile, ...args], {
    cwd: ROOT,
    env: {
      ...env,
      DESKTOP_PATH_PROBE_UTIL: path.join(ROOT, 'src', 'util.js'),
      DESKTOP_PATH_PROBE_OUT: probeOutFile,
    },
    stdio: 'ignore',
    timeout: 30000,
    windowsHide: true,
  });
  if (r.error) throw new Error(`子进程启动失败：${r.error.code || r.error.message}`);
  if (r.status !== 0) throw new Error(`子进程退出码 ${r.status}`);
  if (!fs.existsSync(probeOutFile)) throw new Error('子进程没有写出结果文件');
  return JSON.parse(fs.readFileSync(probeOutFile, 'utf8'));
}

const tmpRoot = path.join(ROOT, 'tmp', 'desktop-path-test');
fs.rmSync(tmpRoot, { recursive: true, force: true });
fs.mkdirSync(tmpRoot, { recursive: true });
const customData = path.join(tmpRoot, 'custom-data');
fs.mkdirSync(customData, { recursive: true });
const customData2 = path.join(tmpRoot, 'custom-data-2');
fs.mkdirSync(customData2, { recursive: true });

const cleanEnv = { ...process.env };
delete cleanEnv.MIRROR_DATA_DIR;
delete cleanEnv.MIRROR_APP_ROOT;
delete cleanEnv.MIRROR_DESKTOP;

process.stdout.write('desktop-path-test：dataRoot 解析优先级\n');

check('默认 = <程序目录>/data', () => {
  const r = probeDataRoot({ env: cleanEnv });
  eq(r.appRoot, ROOT, 'appRoot');
  eq(r.dataRoot, path.join(ROOT, 'data'), 'dataRoot');
  eq(r.desktop, false, 'desktop');
});

check('MIRROR_DATA_DIR 优先于默认目录', () => {
  const r = probeDataRoot({ env: { ...cleanEnv, MIRROR_DATA_DIR: customData } });
  eq(r.dataRoot, customData, 'dataRoot');
});

check('--data-dir 参数优先于 MIRROR_DATA_DIR', () => {
  const r = probeDataRoot({
    env: { ...cleanEnv, MIRROR_DATA_DIR: customData },
    args: ['--data-dir', customData2],
  });
  eq(r.dataRoot, customData2, 'dataRoot');
});

check('--data-dir=<目录> 等号写法同样生效', () => {
  const r = probeDataRoot({ env: cleanEnv, args: [`--data-dir=${customData2}`] });
  eq(r.dataRoot, customData2, 'dataRoot');
});

check('--desktop 参数等价于 MIRROR_DESKTOP=1', () => {
  const r = probeDataRoot({ env: cleanEnv, args: ['--desktop'] });
  eq(r.desktop, true, 'desktop');
});

check('MIRROR_APP_ROOT 覆盖程序目录', () => {
  const r = probeDataRoot({ env: { ...cleanEnv, MIRROR_APP_ROOT: customData } });
  eq(r.appRoot, customData, 'appRoot');
});

// ---------------------------------------------------------------------------
// 进程内：resolveWithinDataRoot / dataPath / setDataRoot
// ---------------------------------------------------------------------------
const util = require('../src/util');
const dataRoot = util.dataRoot();

process.stdout.write('desktop-path-test：resolveWithinDataRoot\n');

check('普通相对路径 = 数据目录下', () => {
  eq(util.resolveWithinDataRoot('storage'), path.join(dataRoot, 'storage'));
  eq(util.resolveWithinDataRoot('a/b'), path.join(dataRoot, 'a', 'b'));
  eq(util.resolveWithinDataRoot('a/b/'), path.join(dataRoot, 'a', 'b'));
});

check('反斜杠相对路径归一化为 /', () => {
  eq(util.resolveWithinDataRoot('a\\b'), path.join(dataRoot, 'a', 'b'));
});

check('单点段 . 被归一化（允许）', () => {
  eq(util.resolveWithinDataRoot('./a/./b'), path.join(dataRoot, 'a', 'b'));
});

check('旧配置 data/ 前缀兼容：data/storage', () => {
  eq(util.resolveWithinDataRoot('data/storage'), path.join(dataRoot, 'storage'));
  eq(util.resolveWithinDataRoot('data\\storage'), path.join(dataRoot, 'storage'));
});

check('旧配置 data 本身不允许（等价于数据目录根，EPATH）', () => {
  expectPathError(() => util.resolveWithinDataRoot('data'), 'data');
  expectPathError(() => util.resolveWithinDataRoot('data/'), 'data/');
});

check('.. 跳出数据目录 → EPATH', () => {
  expectPathError(() => util.resolveWithinDataRoot('..'), '..');
  expectPathError(() => util.resolveWithinDataRoot('../x'), '../x');
});

check('..\\x 跳出数据目录 → EPATH', () => {
  expectPathError(() => util.resolveWithinDataRoot('..\\x'), '..\\x');
});

check('a/../../x 跳出数据目录 → EPATH', () => {
  expectPathError(() => util.resolveWithinDataRoot('a/../../x'), 'a/../../x');
  expectPathError(() => util.resolveWithinDataRoot('a\\..\\..\\x'), 'a\\..\\..\\x');
});

check('旧前缀 + 穿越仍会被拦下（data/../x）', () => {
  expectPathError(() => util.resolveWithinDataRoot('data/../x'), 'data/../x');
});

check('绝对路径 → EPATH（相对路径接口不允许绝对路径）', () => {
  expectPathError(() => util.resolveWithinDataRoot(path.join(dataRoot, 'x')), '绝对路径');
  expectPathError(() => util.resolveWithinDataRoot('C:\\Windows'), 'C:\\Windows');
});

check('盘符相对路径（C:foo）→ EPATH', () => {
  expectPathError(() => util.resolveWithinDataRoot('C:foo'), 'C:foo');
});

check('NUL 字符 → EPATH', () => {
  expectPathError(() => util.resolveWithinDataRoot('a\0b'), 'NUL');
});

check('空串 / 纯空白 → EPATH', () => {
  expectPathError(() => util.resolveWithinDataRoot(''), '空串');
  expectPathError(() => util.resolveWithinDataRoot('   '), '空白串');
});

check('非字符串 → EPATH', () => {
  expectPathError(() => util.resolveWithinDataRoot(null), 'null');
  expectPathError(() => util.resolveWithinDataRoot(undefined), 'undefined');
  expectPathError(() => util.resolveWithinDataRoot(123), '数字');
  expectPathError(() => util.resolveWithinDataRoot({}), '对象');
});

process.stdout.write('desktop-path-test：dataPath / setDataRoot\n');

check('dataPath(...parts) 拼接在数据目录下', () => {
  eq(util.dataPath(), dataRoot, 'dataPath()');
  eq(util.dataPath('config.json'), path.join(dataRoot, 'config.json'));
  eq(util.dataPath('bundles', 'a.tgz'), path.join(dataRoot, 'bundles', 'a.tgz'));
});

check('dataPath 拒绝穿越段', () => {
  expectPathError(() => util.dataPath('..'), 'dataPath(..)');
  expectPathError(() => util.dataPath('a', '..', '..', 'x'), 'dataPath(a,..,..,x)');
});

check('setDataRoot 拒绝非绝对路径 / 不存在目录 / 文件', () => {
  const before = util.dataRoot();
  const expectBadDataDir = (fn, label) => {
    try { fn(); } catch (e) {
      const code = e && e.code;
      if (code !== 'EBADDATADIR' && code !== 'EPATH') throw new Error(`${label} 错误码应为 EBADDATADIR，实际 ${code}`);
      return;
    }
    throw new Error(`${label} 应当抛错`);
  };
  expectBadDataDir(() => util.setDataRoot('relative/dir'), '相对路径');
  expectBadDataDir(() => util.setDataRoot(path.join(tmpRoot, 'not-exist')), '不存在目录');
  const file = path.join(tmpRoot, 'a-file');
  fs.writeFileSync(file, 'x');
  expectBadDataDir(() => util.setDataRoot(file), '文件路径');
  eq(util.dataRoot(), before, '失败后 dataRoot 不变');
});

check('setDataRoot 合法目录生效并可还原', () => {
  const before = util.dataRoot();
  const next = util.setDataRoot(customData2);
  eq(next, customData2, '返回值');
  eq(util.dataRoot(), customData2, 'dataRoot');
  eq(util.resolveWithinDataRoot('x'), path.join(customData2, 'x'), '解析基准同步切换');
  util.setDataRoot(before);
  eq(util.dataRoot(), before, '已还原');
});

// ---------------------------------------------------------------------------
process.stdout.write(`\ndesktop-path-test：${pass} 个用例通过，${failures.length} 个失败\n`);
if (failures.length) {
  for (const f of failures) process.stdout.write(`  ✗ ${f.name}\n      ${f.error}\n`);
  process.exit(1);
}
process.exit(0);
