#!/usr/bin/env node
'use strict';
/*
 * 一键跑完所有自检：
 *   1. 先确认镜像源在运行（不在运行会给出提示）
 *   2. Windows 下先跑 test/tray-check.js（托盘项目图标 / 启动脚本 / 左键右键行为 / favicon，
 *      非 Windows 或沙箱禁止子进程时其中需真跑 PowerShell 的几项会自动跳过）
 *   3. 再跑 test/api-test.js（注册表协议 + 管理 API + 发布/删除 + 离线包导入导出 + 安全回归；
 *      环境不足 / 破坏性用例会显式 SKIP）
 * 用法：node test/run-all.js [--base 管理界面地址] [--registry-base 镜像源地址] [--full] [--destructive]
 *   --base           管理界面监听地址（管理 API + 网页控制台，默认 config.admin.ip:admin.port）
 *   --registry-base  镜像源监听地址（npm 客户端 registry 协议，默认 config.server.ip:server.port）
 *   --full           完整回归：包含会大量导包 / 全部包补 tarball / 本机 npm 缓存导入等耗时用例
 *                    （日常改 UI/后端/文档用默认快速模式即可，不必每次跑耗时导包）
 *   --destructive    额外包含重启服务、清空日志等破坏性用例（默认不跑）
 * 说明：真实 npm 客户端的验收（install/publish/dist-tag/deprecate/unpublish）由
 *       test/acceptance-npm.ps1 负责，需要本机有 npm。
 */
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const config = require('../src/config');

config.load();
const cfg = config.get();
function argBase(flag, fallbackPort) {
  const i = process.argv.indexOf(flag);
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1].replace(/\/+$/, '');
  return `http://127.0.0.1:${fallbackPort}`;
}
const ADMIN = cfg.admin || {};
const BASE = argBase('--base', ADMIN.port || cfg.server.port); // 管理界面
const REG_BASE = argBase('--registry-base', cfg.server.port); // 镜像源
const FULL = process.argv.includes('--full');
const DESTRUCTIVE = process.argv.includes('--destructive');

function runNode(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script), ...args], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === null ? 1 : code));
  });
}

(async () => {
  process.stdout.write(`检查服务是否在运行：管理界面 ${BASE}，镜像源 ${REG_BASE}\n`);
  let adminUp = false;
  let registryUp = false;
  try {
    const r = await fetch(`${BASE}/__admin/api/session`, { signal: AbortSignal.timeout(5000) });
    adminUp = r.status === 200;
  } catch { adminUp = false; }
  try {
    const r = await fetch(`${REG_BASE}/-/ping`, { signal: AbortSignal.timeout(5000) });
    registryUp = r.status === 200;
  } catch { registryUp = false; }
  if (!adminUp && !registryUp) {
    process.stdout.write(`\x1b[31m镜像源没有在运行。\x1b[0m\n请先另开一个窗口执行：node cli.js start --no-open\n或直接双击「启动镜像源.cmd」。\n`);
    process.exit(1);
  }
  if (!adminUp) {
    process.stdout.write(`\x1b[33m管理界面没有在监听（${BASE}），但镜像源仍可用。\x1b[0m\n接口自检需要管理界面，请检查 data/config.json 的 admin 段或执行：node cli.js restart-admin\n`);
    process.exit(1);
  }
  if (!registryUp) {
    process.stdout.write(`\x1b[33m镜像源监听没有响应（${REG_BASE}）。\x1b[0m\n可执行：node cli.js restart（只重启镜像源服务）\n`);
    process.exit(1);
  }
  process.stdout.write('服务在线，开始自检。\n');
  process.stdout.write(FULL
    ? '\x1b[2m自检模式：完整回归（--full，包含耗时导包用例）\x1b[0m\n'
    : '\x1b[2m自检模式：快速（默认跳过耗时导包用例；需要完整回归时加 --full）\x1b[0m\n');

  if (process.platform === 'win32' && fs.existsSync(path.join(__dirname, 'tray-check.js'))) {
    process.stdout.write('\n===== 托盘 / 图标 / 启动脚本自检（test/tray-check.js）=====\n');
    const trayCode = await runNode('tray-check.js', ['--base', BASE, '--registry-base', REG_BASE]);
    if (trayCode !== 0) process.exit(trayCode);
  }

  process.stdout.write('\n===== 接口与功能自检（test/api-test.js）=====\n');
  const apiArgs = ['--base', BASE, '--registry-base', REG_BASE];
  if (FULL) apiArgs.push('--full');
  if (DESTRUCTIVE) apiArgs.push('--destructive');
  process.exit(await runNode('api-test.js', apiArgs));
})();
