@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 私人 npm 镜像源 - 停止
node "%~dp0cli.js" stop
echo.
pause
