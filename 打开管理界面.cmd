@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 私人 npm 镜像源 - 打开管理界面
node "%~dp0cli.js" open
echo 已尝试在浏览器中打开管理界面（如果没弹出，请手动访问上面日志里的地址）
timeout /t 3 >nul
