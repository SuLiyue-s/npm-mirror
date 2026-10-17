@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 私人 npm 镜像源 - 状态
node "%~dp0cli.js" status
echo.
pause
