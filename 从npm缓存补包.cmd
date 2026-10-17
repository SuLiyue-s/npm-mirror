@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 私人 npm 镜像源 - 从本机 npm 缓存离线补包
echo 本功能会扫描本机 npm 缓存（_cacache），把里面已经下载过的包搬进镜像源，
echo 用于「没有网络、但本机 npm 缓存里还有包」的场景。
echo.
node "%~dp0cli.js" scan-cache
echo.
echo 开始导入（只导入带 tarball 的包）……
node "%~dp0cli.js" import-cache --all
echo.
pause
