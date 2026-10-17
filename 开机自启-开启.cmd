@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 私人 npm 镜像源 - 开启开机自启
echo 开启后：每次登录 Windows 会自动隐藏启动镜像源，右下角出现托盘图标；
echo   左键单击托盘图标 = 打开控制台，右键 = 打开管理界面 / 退出镜像源。
echo.
node "%~dp0cli.js" autostart on
echo.
pause
