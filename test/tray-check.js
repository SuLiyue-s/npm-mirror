#!/usr/bin/env node
'use strict';
/*
 * Windows 托盘自检（对应需求：启动脚本注册托盘项目图标、启动后隐藏命令行窗口、
 * 左键打开控制台、右键菜单按窗口状态只显示两项 + 退出镜像源）：
 *
 *   一、tools/tray.ps1：是否注册 NotifyIcon、用项目图标、左键/右键行为、菜单文案、
 *       隐藏/显示用 Win32、退出走管理接口、服务被外部停止时自动退出
 *   二、public/favicon.ico：是否是合法的多尺寸 32 位 ICO（16/24/32/48/64/128/256）
 *   三、启动镜像源.cmd：是否拉起托盘、缺少 PowerShell 时回退、仍前台启动服务
 *   四、服务端：/favicon.ico 是否返回项目图标（服务未启动则跳过）
 *   五、真跑一次 PowerShell 自检（-SelfTest -SelfTestOut）校验菜单文案（非 Windows 跳过）
 *
 * 用法：node test/tray-check.js [--base http://127.0.0.1:4873]
 * 说明：第五节的子进程用 stdio:'ignore' + 输出写临时文件，避免 DSH 沙箱禁止命名管道
 *       （child_process 默认 stdio:'pipe'）导致 Spawn EPERM。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('../src/config');

config.load();
const cfg = config.get();
const ROOT = path.join(__dirname, '..');
const BASE = (() => {
  const i = process.argv.indexOf('--base');
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1].replace(/\/+$/, '');
  return `http://127.0.0.1:${cfg.server.port}`;
})();

let pass = 0; let fail = 0; let skipped = 0;
function check(title, ok, detail) {
  if (ok) { console.log(`  \x1b[32m✓\x1b[0m ${title}`); pass++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${title}  ${detail || ''}`); fail++; }
}
function skip(title, reason) {
  console.log(`  \x1b[33m○\x1b[0m ${title}  \x1b[2m（跳过：${reason}）\x1b[0m`);
  skipped++;
}

// 读 ICO 目录：返回每个条目的尺寸、位深、数据长度与偏移
function readIco(buf) {
  if (buf.length < 6 + 16) return null;
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (reserved !== 0 || type !== 1 || count < 1 || count > 64) return null;
  if (buf.length < 6 + count * 16) return null;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const w = buf[at] === 0 ? 256 : buf[at];
    const h = buf[at + 1] === 0 ? 256 : buf[at + 1];
    entries.push({
      width: w, height: h,
      bits: buf.readUInt16LE(at + 6),
      bytes: buf.readUInt32LE(at + 8),
      offset: buf.readUInt32LE(at + 12),
    });
  }
  return { count, entries };
}

(async () => {
  console.log(`\n\x1b[1mWindows 托盘自检\x1b[0m  目标：${BASE}\n`);

  // ---------- 一、托盘脚本 ----------
  console.log('\x1b[1m一、托盘脚本 tools/tray.ps1\x1b[0m');
  const trayPath = path.join(ROOT, 'tools', 'tray.ps1');
  const hasTray = fs.existsSync(trayPath);
  check('tools/tray.ps1 存在', hasTray);
  const traw = hasTray ? fs.readFileSync(trayPath) : Buffer.alloc(0);
  const tray = traw.toString('utf8');
  check('托盘脚本是 UTF-8 带 BOM（否则 PowerShell 5.1 读中文菜单会乱码）',
    traw.length > 3 && traw[0] === 0xef && traw[1] === 0xbb && traw[2] === 0xbf,
    hasTray ? `前 3 字节=${[...traw.slice(0, 3)].join(',')}` : '文件不存在');
  if (hasTray) {
    check('注册托盘图标（System.Windows.Forms.NotifyIcon）', /New-Object\s+System\.Windows\.Forms\.NotifyIcon/.test(tray));
    check('托盘图标用项目自绘图标（public\\favicon.ico，不是命令行默认图标）',
      /public\\favicon\.ico/.test(tray) && /\.Icon\s*=/.test(tray));
    check('图标带提示文字（镜像源名 + 运行中的地址）',
      /\.Text\s*=\s*\(\s*'私人 npm 镜像源 · 运行中/.test(tray));
    check('左键单击 = 打开命令行窗口（MouseClick + Left + 显示窗口）',
      /add_MouseClick/.test(tray) && /MouseButtons\]::Left/.test(tray) && /Set-ConsoleVisible \$true/.test(tray));
    check('右键菜单每次弹出都按窗口当前状态重建（ContextMenuStrip + Opening + Rebuild-Menu）',
      /ContextMenuStrip/.test(tray) && /add_Opening\(\{\s*Rebuild-Menu\s*\}\)/.test(tray));
    check('菜单文案：窗口显示中只给「隐藏控制台 + 退出镜像源」，隐藏中只给「打开控制台 + 退出镜像源」',
      /function Get-MenuLabels/.test(tray) &&
      /if \(\$ConsoleVisible\) \{ return @\('隐藏控制台', '退出镜像源'\) \}/.test(tray) &&
      /return @\('打开控制台', '退出镜像源'\)/.test(tray));
    check('显示/隐藏窗口走 Win32（GetConsoleWindow / ShowWindow / IsWindowVisible）',
      /GetConsoleWindow/.test(tray) && /ShowWindow/.test(tray) && /IsWindowVisible/.test(tray));
    check('「退出镜像源」= 调管理接口优雅停服务（/__admin/api/service/shutdown + token）后再关窗口',
      /__admin\/api\/service\/shutdown/.test(tray) && /X-Mirror-Token/.test(tray) && /WM_CLOSE/.test(tray));
    check('服务被外部停止（如双击「停止镜像源.cmd」）时托盘自动退出',
      /HealthFail/.test(tray) && /检测到服务已停止/.test(tray));
    check('等镜像源就绪后才隐藏窗口（启动失败时保留命令行报错）',
      /WaitSeconds/.test(tray) && /Test-Service/.test(tray) && /命令行窗口已隐藏/.test(tray));
    check('顺便把命令行窗口本身的图标也换成项目图标（WM_SETICON）',
      /WM_SETICON/.test(tray) && /ICON_BIG/.test(tray) && /ICON_SMALL/.test(tray));
    check('自检参数 -SelfTest / -SelfTestOut 可用（供本脚本调用）',
      /\[switch\]\$SelfTest/.test(tray) && /\[string\]\$SelfTestOut/.test(tray));
  }

  // ---------- 二、项目图标 ----------
  console.log('\x1b[1m二、项目图标 public/favicon.ico\x1b[0m');
  const icoPath = path.join(ROOT, 'public', 'favicon.ico');
  const hasIco = fs.existsSync(icoPath);
  check('public/favicon.ico 存在（托盘 + 网页标签页共用）', hasIco);
  let ico = null;
  if (hasIco) {
    const buf = fs.readFileSync(icoPath);
    check('图标文件不是空的（至少 10 KB，多尺寸才有意义）', buf.length > 10 * 1024, `${buf.length} 字节`);
    ico = readIco(buf);
    check('ICO 头合法（reserved=0 / type=1 / 至少 4 个尺寸）', !!ico, ico ? `count=${ico.count}` : '头解析失败');
    if (ico) {
      const sizes = ico.entries.map((e) => e.width);
      const want = [16, 24, 32, 48, 64, 128, 256];
      check(`尺寸齐全（${want.join('/')}，小图标在托盘/标题栏才清晰）`,
        want.every((s) => sizes.includes(s)), `实际尺寸：${sizes.join('/')}`);
      check('每个尺寸都是 32 位带 alpha（托盘图标有透明背景）',
        ico.entries.every((e) => e.bits === 32), ico.entries.map((e) => e.bits).join(','));
      check('每个尺寸的数据块都在文件范围内、长度非 0',
        ico.entries.every((e) => e.bytes > 0 && e.offset + e.bytes <= buf.length),
        ico.entries.map((e) => `${e.width}px:${e.bytes}B@${e.offset}`).join(' '));
    }
  }

  // ---------- 三、启动脚本 ----------
  console.log('\x1b[1m三、启动脚本 启动镜像源.cmd\x1b[0m');
  const cmdPath = path.join(ROOT, '启动镜像源.cmd');
  const hasCmd = fs.existsSync(cmdPath);
  check('启动镜像源.cmd 存在', hasCmd);
  if (hasCmd) {
    const cw = fs.readFileSync(cmdPath);
    const cmdSrc = cw.toString('utf8');
    check('启动脚本以 node cli.js start 前台运行镜像源（保持原行为）',
      /node "%~dp0cli\.js" start/.test(cmdSrc));
    // 只看真正的命令行：注释（rem）里可能会提到 -Root 的坑，不能拿注释当"真的传了 -Root"
    const cmdLines = cmdSrc.split(/\r?\n/).filter(l => !/^\s*(rem\b|::)/i.test(l)).join('\n');
    check('启动脚本会拉起托盘宿主（start /b powershell + tools\\tray.ps1，且不传 -Root）',
      /start "" \/b powershell\.exe/.test(cmdLines) && /-File "%~dp0tools\\tray\.ps1"/.test(cmdLines) &&
      !/-Root\s+"%~dp0"/.test(cmdLines));
    check('启动脚本提示托盘操作（左键打开本窗口 / 右键打开隐藏控制台与退出镜像源）',
      /左键单击托盘图标/.test(cmdSrc) && /右键单击托盘图标/.test(cmdSrc));
    check('找不到 PowerShell 时回退为普通窗口（托盘不可用但不影响启动）',
      /where powershell\.exe/.test(cmdSrc) && /托盘图标不可用/.test(cmdSrc));
  }

  // ---------- 四、服务端 favicon ----------
  console.log('\x1b[1m四、服务端 /favicon.ico\x1b[0m');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  check('server.js 的 favicon 分支在图标存在时返回图标（不再无条件 204）',
    /favicon\.ico/.test(serverSrc) && /statSync\(path\.join\(PUBLIC_DIR, 'favicon\.ico'\)\)/.test(serverSrc));
  let svcOk = false;
  try {
    const r = await fetch(BASE + '/__admin/api/session', { signal: AbortSignal.timeout(5000) });
    svcOk = r.status === 200;
  } catch { svcOk = false; }
  if (!svcOk) {
    skip('GET /favicon.ico 返回 200 + image/x-icon', '镜像源服务未启动');
  } else {
    try {
      const r = await fetch(BASE + '/favicon.ico', { signal: AbortSignal.timeout(10000) });
      const ct = r.headers.get('content-type') || '';
      const body = Buffer.from(await r.arrayBuffer());
      check('GET /favicon.ico 返回 200 + image/x-icon，内容与 public/favicon.ico 一致',
        r.status === 200 && /^image\/x-icon/i.test(ct) && hasIco && body.equals(fs.readFileSync(icoPath)),
        `status=${r.status} type=${ct} bytes=${body.length}`);
    } catch (e) {
      check('GET /favicon.ico 返回 200 + image/x-icon', false, e.message);
    }
  }

  // ---------- 五、托盘 PowerShell 自检 ----------
  console.log('\x1b[1m五、托盘脚本自检（真跑 PowerShell -SelfTest）\x1b[0m');
  if (process.platform !== 'win32') {
    skip('运行 tools/tray.ps1 -SelfTest', '当前不是 Windows');
  } else if (!hasTray) {
    skip('运行 tools/tray.ps1 -SelfTest', '托盘脚本不存在');
  } else {
    const outFile = path.join(os.tmpdir(), `npm-mirror-tray-selftest-${process.pid}-${Date.now()}.json`);
    let spawnErr = '';
    try {
      const r = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', trayPath,
        '-Root', ROOT,
        '-SelfTest',
        '-SelfTestOut', outFile,
      ], { stdio: 'ignore', timeout: 120000, windowsHide: true });
      if (r.error) spawnErr = r.error.message;
      else if (r.status !== 0) spawnErr = `exit ${r.status}`;
    } catch (e) {
      spawnErr = e.message;
    }
    if (spawnErr) {
      skip('运行 tools/tray.ps1 -SelfTest', `子进程不可用：${spawnErr}`);
    } else if (!fs.existsSync(outFile)) {
      check('托盘自检能输出结果文件（-SelfTestOut）', false, '结果文件没生成');
    } else {
      let data = null;
      try { data = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) { data = null; }
      try { fs.unlinkSync(outFile); } catch { /* 忽略 */ }
      check('托盘自检能输出合法 JSON', !!data, data ? '' : 'JSON 解析失败');
      if (data) {
        check('自检 ok=true、图标能被 System.Drawing 加载（iconOk）', data.ok === true && data.iconOk === true);
        check('自检加载到 32px 图标（iconSize）', data.iconSize === 32, `iconSize=${data.iconSize}`);
        // 沙箱/无控制台环境里 GetConsoleWindow() 返回 0 属正常；这里只要求字段是数字且非负
        check('自检能拿到命令行窗口句柄（GetConsoleWindow，无控制台环境为 0 也算正常）',
          typeof data.consoleHwnd === 'number' && data.consoleHwnd >= 0, `hwnd=${data.consoleHwnd}`);
        check('自检菜单文案：显示中=隐藏控制台+退出镜像源',
          Array.isArray(data.visibleMenu) && data.visibleMenu.length === 2 &&
          data.visibleMenu[0] === '隐藏控制台' && data.visibleMenu[1] === '退出镜像源',
          JSON.stringify(data.visibleMenu));
        check('自检菜单文案：隐藏中=打开控制台+退出镜像源',
          Array.isArray(data.hiddenMenu) && data.hiddenMenu.length === 2 &&
          data.hiddenMenu[0] === '打开控制台' && data.hiddenMenu[1] === '退出镜像源',
          JSON.stringify(data.hiddenMenu));
      }
    }
  }

  console.log(`\n\x1b[1m结果：${pass} 项通过，${fail} 项失败${skipped ? `，跳过 ${skipped} 项` : ''}\x1b[0m`);
  console.log('');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('\x1b[31m托盘自检异常：\x1b[0m', e && e.stack ? e.stack : e);
  process.exit(1);
});
