#!/usr/bin/env node
'use strict';
/*
 * 一键跑完所有自检：
 *   1. 先确认镜像源在运行（不在运行会给出提示）
 *   2. 执行 test/api-test.js（注册表协议 + 管理 API + 发布/删除 + 离线包导入导出 + 安全回归 共 153 项，默认执行 150 项 + 3 项显式跳过；环境不足 / 破坏性用例会显式 SKIP）
 * 用法：node test/run-all.js [--base http://127.0.0.1:4873]
 * 说明：真实 npm 客户端的验收（install/publish/dist-tag/deprecate/unpublish）由
 *       test/acceptance-npm.ps1 负责，需要本机有 npm。
 */
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('../src/config');

config.load();
const cfg = config.get();
const BASE = (() => {
  const i = process.argv.indexOf('--base');
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1].replace(/\/+$/, '');
  return `http://127.0.0.1:${cfg.server.port}`;
})();

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

  const child = spawn(process.execPath, [path.join(__dirname, 'api-test.js'), '--base', BASE], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
})();
