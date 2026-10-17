@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 私人 npm 镜像源 - 环境自检
node "%~dp0cli.js" doctor
echo.
pause
