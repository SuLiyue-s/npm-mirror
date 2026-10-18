#!/usr/bin/env node
'use strict';
/*
 * Windows 托盘自检（对应需求：启动脚本注册托盘项目图标、启动后隐藏命令行窗口、
 * 左键打开控制台、右键菜单 = 按窗口状态显示「打开/隐藏控制台」+「打开管理界面」+「退出镜像源」）：
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
    check('左键单击 = 打开管理界面（MouseClick + Left + Open-ManagementUi）',
      /add_MouseClick/.test(tray) && /MouseButtons\]::Left/.test(tray) &&
      /MouseButtons\]::Left\) \{ \[void\]\(Open-ManagementUi\) \}/.test(tray));
    check('右键菜单每次弹出都按窗口当前状态重建（ContextMenuStrip + Opening + Rebuild-Menu）',
      /ContextMenuStrip/.test(tray) && /add_Opening\(\{\s*Rebuild-Menu\s*\}\)/.test(tray));
    check('菜单文案：窗口显示中给「隐藏控制台」，隐藏中给「打开控制台」；「打开管理界面」「重启镜像源」「退出镜像源」始终在',
      /function Get-MenuLabels/.test(tray) &&
      /\$toggle = if \(\$ConsoleVisible\) \{ '隐藏控制台' \} else \{ '打开控制台' \}/.test(tray) &&
      /return @\(\$toggle, '打开管理界面', '重启镜像源', '退出镜像源'\)/.test(tray));
    check('右键菜单有「打开管理界面」，点击时用默认浏览器打开网页端管理页面（Start-Process + 服务地址）',
      /function Open-ManagementUi/.test(tray) && /'打开管理界面'/.test(tray) &&
      /Start-Process -FilePath \$url/.test(tray) && /Get-ServiceUrl '\/'/.test(tray) &&
      /openUi\.add_Click\(\{\s*\[void\]\(Open-ManagementUi\)\s*\}\)/.test(tray));
    check('右键菜单有「重启镜像源」（Restart-MirrorService + 调 /service/restart 接口 + token）',
      /function Restart-MirrorService/.test(tray) && /'重启镜像源'/.test(tray) &&
      /add_Click\(\{\s*Restart-MirrorService\s*\}\)/.test(tray) &&
      /__admin\/api\/service\/restart/.test(tray) && /X-Mirror-Token/.test(tray));
    check('重启期间健康检查跳过、不会被误判成「服务已停止」而退出托盘（$script:Restarting）',
      /\$script:Restarting = \$false/.test(tray) && /if \(\$script:Restarting\) \{ return \}/.test(tray) &&
      /if \(\$script:Restarting\) \{ Write-TrayLog '正在重启中/.test(tray));
    check('重启完成/失败都有托盘气泡提示与结果日志',
      /ShowBalloonTip\(3000, '镜像源已重启'/.test(tray) && /重启完成，服务已恢复/.test(tray) &&
      /重启镜像源失败/.test(tray));
    check('显示/隐藏窗口走 Win32（GetConsoleWindow / ShowWindow / IsWindowVisible）',
      /GetConsoleWindow/.test(tray) && /ShowWindow/.test(tray) && /IsWindowVisible/.test(tray));
    check('「退出镜像源」= 调管理接口优雅停服务（/__admin/api/service/shutdown + token）后再关窗口',
      /__admin\/api\/service\/shutdown/.test(tray) && /X-Mirror-Token/.test(tray) && /WM_CLOSE/.test(tray));
    check('服务被外部停止（如双击「停止镜像源.cmd」）时托盘自动退出',
      /HealthFail/.test(tray) && /检测到服务已停止/.test(tray));
    check('健康检查带「进程存活」保护：服务忙/大任务时只记日志继续等待，绝不关控制台（避免误判把 node 一起杀掉）',
      /function Get-MirrorPid/.test(tray) && /function Test-MirrorProcessAlive/.test(tray) &&
      /继续等待，不关闭窗口/.test(tray) && /HealthFail -ge 5/.test(tray) &&
      /检测到服务已停止（进程已退出）/.test(tray));
    check('等镜像源就绪后才隐藏窗口（启动失败时保留命令行报错）',
      /WaitSeconds/.test(tray) && /Test-Service/.test(tray) && /命令行窗口已隐藏/.test(tray));
    check('顺便把命令行窗口本身的图标也换成项目图标（WM_SETICON）',
      /WM_SETICON/.test(tray) && /ICON_BIG/.test(tray) && /ICON_SMALL/.test(tray));
    check('自检参数 -SelfTest / -SelfTestOut 可用（供本脚本调用）',
      /\[switch\]\$SelfTest/.test(tray) && /\[string\]\$SelfTestOut/.test(tray));
    check('隐藏后点「打开控制台」显示窗口时带 SW_RESTORE 兜底（开机自启的窗口是「启动即隐藏」创建的）',
      /\$SW_RESTORE = 9/.test(tray) &&
      /if \(-not \[MirrorTrayNative\]::IsWindowVisible\(\$script:ConsoleHwnd\)\)/.test(tray) &&
      /ShowWindow\(\$script:ConsoleHwnd, \$SW_RESTORE\)/.test(tray));
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
    check('启动脚本提示托盘操作（左键打开管理界面 / 右键菜单含重启镜像源与退出镜像源）',
      /左键单击托盘图标 = 打开管理界面/.test(cmdSrc) && /右键单击托盘图标 = .*重启镜像源/.test(cmdSrc));
    check('找不到 PowerShell 时回退为普通窗口（托盘不可用但不影响启动）',
      /where powershell\.exe/.test(cmdSrc) && /托盘图标不可用/.test(cmdSrc));
    check('启动脚本支持参数透传 + 开机自启模式（输出写 data\\logs\\autostart.log，失败不停住）',
      /node "%~dp0cli\.js" start %\*/.test(cmdSrc) &&
      /if defined MIRROR_AUTOSTART/.test(cmdSrc) &&
      /data\\logs\\autostart\.log/.test(cmdSrc));
    check('启动脚本先跑 cli.js prestart 做启动前检查（服务已在运行就不再抢同一个端口）',
      /cli\.js" prestart/.test(cmdSrc) && /PRESTART_CODE/.test(cmdSrc));
    check('启动脚本：已在同端口运行（退出码 10）直接结束——不启动第二份、不注册第二个托盘',
      /"%PRESTART_CODE%"=="10"/.test(cmdSrc) && /本次没有重复启动/.test(cmdSrc) && /exit \/b 0/.test(cmdSrc));
    check('启动脚本：已在其它端口运行（退出码 11）提示先停止，不强行启动第二份',
      /"%PRESTART_CODE%"=="11"/.test(cmdSrc) && /已经在其它端口运行/.test(cmdSrc) && /exit \/b 1/.test(cmdSrc));
    check('开机自启模式下检测到已在运行只写 data\\logs\\autostart.log（隐藏窗口不弹窗、不 pause）',
      /开机自启检测到镜像源已在运行，跳过本次启动/.test(cmdSrc));
  }

  // ---------- 三之二、开机自启 ----------
  console.log('\x1b[1m三之二、开机自启 Startup 文件夹\x1b[0m');
  const cliPath = path.join(ROOT, 'cli.js');
  const cliSrc = fs.readFileSync(cliPath, 'utf8');
  check('cli.js 的 autostart 写 .vbs 启动项（UTF-16LE 带 BOM，避免中文路径被 WSH 按 ANSI 误读）',
    /私人npm镜像源\.vbs/.test(cliSrc) && /'utf16le'/.test(cliSrc) && /\\uFEFF/.test(cliSrc));
  check('自启的 VBS 走「启动镜像源.cmd --no-open」并置 MIRROR_AUTOSTART=1（窗口完全隐藏、同一条托盘路径）',
    /MIRROR_AUTOSTART/.test(cliSrc) && /--no-open/.test(cliSrc) &&
    /启动镜像源\.cmd/.test(cliSrc) && /, 0, False/.test(cliSrc));
  check('开启时清理旧版 .cmd 启动项（升级用户不会登录时同时起来两份）',
    /legacyStartupFile/.test(cliSrc) && /已移除旧版/.test(cliSrc));
  check('cli.js 提供 prestart 启动前预检查（退出码 0/10/11 + --json，供启动脚本与开机自启判断）',
    /commands\.prestart = async function/.test(cliSrc) && /process\.exitCode = samePort \? 10 : 11/.test(cliSrc) &&
    /flags\.json/.test(cliSrc) && /samePort/.test(cliSrc));
  // 真跑一遍：隔离到临时 Startup 目录，不碰用户真正的「启动」文件夹
  const startupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-mirror-startup-'));
  const legacyFile = path.join(startupDir, '私人npm镜像源.cmd');
  const vbsFile = path.join(startupDir, '私人npm镜像源.vbs');
  const runCli = (args) => spawnSync(process.execPath, [cliPath, ...args], {
    cwd: ROOT,
    env: { ...process.env, MIRROR_STARTUP_DIR: startupDir },
    stdio: 'ignore',
    timeout: 60000,
    windowsHide: true,
  });
  try {
    fs.writeFileSync(legacyFile, '@echo off\r\nrem 旧版启动项\r\n', 'utf8');
    const rOn = runCli(['autostart', 'on']);
    check('autostart on 成功退出（写入 Startup 目录）', rOn.status === 0, `exit=${rOn.status}`);
    const hasVbs = fs.existsSync(vbsFile);
    check('生成 .vbs 启动项', hasVbs);
    if (hasVbs) {
      const vb = fs.readFileSync(vbsFile);
      check('启动项是 UTF-16LE 带 BOM（前 2 字节 FF FE）',
        vb.length > 2 && vb[0] === 0xff && vb[1] === 0xfe, `前2字节=${[...vb.slice(0, 2)].join(',')}`);
      let vbsText = '';
      try { vbsText = vb.toString('utf16le').replace(/^\uFEFF/, ''); } catch { /* 忽略 */ }
      check('启动项内容：隐藏启动「启动镜像源.cmd --no-open」+ MIRROR_AUTOSTART=1 + 窗口样式 0',
        /MIRROR_AUTOSTART"\) = "1"/.test(vbsText) && /启动镜像源\.cmd/.test(vbsText) &&
        /--no-open", 0, False/.test(vbsText) && /WScript\.Shell/.test(vbsText));
    }
    check('旧版 .cmd 启动项已被清理（升级不会登录起来两份）', !fs.existsSync(legacyFile));
    const rOff = runCli(['autostart', 'off']);
    check('autostart off 删除 .vbs 启动项', rOff.status === 0 && !fs.existsSync(vbsFile));
    const rOff2 = runCli(['autostart', 'off']);
    check('autostart off 幂等（本来就关闭时也不报错）', rOff2.status === 0);
    const rSt = runCli(['autostart', 'status']);
    check('autostart status 正常可用', rSt.status === 0);
  } finally {
    try { fs.rmSync(startupDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
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
        check('自检菜单文案：显示中=隐藏控制台+打开管理界面+重启镜像源+退出镜像源',
          Array.isArray(data.visibleMenu) && data.visibleMenu.length === 4 &&
          data.visibleMenu[0] === '隐藏控制台' && data.visibleMenu[1] === '打开管理界面' &&
          data.visibleMenu[2] === '重启镜像源' && data.visibleMenu[3] === '退出镜像源',
          JSON.stringify(data.visibleMenu));
        check('自检菜单文案：隐藏中=打开控制台+打开管理界面+重启镜像源+退出镜像源',
          Array.isArray(data.hiddenMenu) && data.hiddenMenu.length === 4 &&
          data.hiddenMenu[0] === '打开控制台' && data.hiddenMenu[1] === '打开管理界面' &&
          data.hiddenMenu[2] === '重启镜像源' && data.hiddenMenu[3] === '退出镜像源',
          JSON.stringify(data.hiddenMenu));
        check('自检给出管理界面地址（与当前端口一致）',
          typeof data.managementUrl === 'string' && data.managementUrl === `http://127.0.0.1:${data.servicePort}/`,
          String(data.managementUrl));
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
