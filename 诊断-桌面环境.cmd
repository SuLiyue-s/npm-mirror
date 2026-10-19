@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  ============================================================
echo   桌面版启动环境诊断
echo   只做只读检查并写一份报告，不修改系统设置、不联网。
echo  ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\diagnose-desktop.ps1"
echo.
echo  报告文件：%~dp0tmp\desktop-diagnose.txt
echo.
pause
