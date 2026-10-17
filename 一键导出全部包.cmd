@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 私人 npm 镜像源 - 一键导出全部包（迁移用）
echo 正在把镜像源里的所有包打包成一个离线包（.tgz）……
echo 导出完成后，把整个文件夹拷贝到无网络的电脑，再用「一键导入离线包.cmd」恢复。
echo.
node "%~dp0cli.js" export --scope all
echo.
pause
