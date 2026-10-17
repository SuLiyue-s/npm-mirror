@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 私人 npm 镜像源 - 开启开机自启
node "%~dp0cli.js" autostart on
echo.
pause
