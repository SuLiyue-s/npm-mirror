#!/usr/bin/env node
'use strict';
/*
 * 一键跑完所有自检：
 *   1. 先确认镜像源在运行（不在运行会给出提示）
 *   2. Windows 下先跑 test/tray-check.js（托盘项目图标 / 启动脚本 / 左键右键行为 / favicon，
 *      非 Windows 或沙箱禁止子进程时其中需真跑 PowerShell 的几项会自动跳过）
 *   3. 再跑 test/api-test.js（注册表协议 + 管理 API + 发布/删除 + 离线包导入导出 + 安全回归；
 *      环境不足 / 破坏性用例会显式 SKIP）
 * 用法：node test/run-all.js [--base http://127.0.0.1:4873]
 * 说明：真实 npm 客户端的验收（install/publish/dist-tag/deprecate/unpublish）由
 *       test/acceptance-npm.ps1 负责，需要本机有 npm。
 */
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const config = require('../src/config');

config.load();
const cfg = config.get();
const BASE = (() => {
  const i = process.argv.indexOf('--base');
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1].replace(/\/+$/, '');
  return `http://127.0.0.1:${cfg.server.port}`;
})();

function runNode(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script), ...args], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === null ? 1 : code));
  });
}

(async () => {
  process.stdout.write(`检查镜像源是否在运行：${BASE}\n`);
  let up = false;
  try {
    const r = await fetch(`${BASE}/-/ping`, { signal: AbortSignal.timeout(5000) });
    up = r.status === 200;
  } catch { up = false; }
  if (!up) {
    process.stdout.write(`\x1b[31m镜像源没有在运行。\x1b[0m\n请先另开一个窗口执行：node cli.js start --no-open\n或直接双击「启动镜像源.cmd」。\n`);
    process.exit(1);
  }
  process.stdout.write('镜像源在线，开始自检。\n');

  if (process.platform === 'win32' && fs.existsSync(path.join(__dirname, 'tray-check.js'))) {
    process.stdout.write('\n===== 托盘 / 图标 / 启动脚本自检（test/tray-check.js）=====\n');
    const trayCode = await runNode('tray-check.js', ['--base', BASE]);
    if (trayCode !== 0) process.exit(trayCode);
  }

  process.stdout.write('\n===== 接口与功能自检（test/api-test.js）=====\n');
  process.exit(await runNode('api-test.js', ['--base', BASE]));
})();
