@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal
title 离月私人 npm 镜像源 - 桌面版启动器
set "EXE="
for /f "delims=" %%F in ('dir /b /o-d "dist\npm-mirror-desktop-*.exe" 2^>nul') do (
  if not defined EXE set "EXE=%~dp0dist\%%F"
)
if not defined EXE (
  echo [错误] 未找到 dist\npm-mirror-desktop-*.exe
  echo        请先运行 tools\build-desktop.ps1 构建桌面版，或把下载的 exe 放入 dist 目录。
  echo.
  pause
  exit /b 1
)
echo ============================================================
echo   正在启动 离月私人 npm 镜像源 桌面版
echo   程序：%EXE%
echo.
echo   启动后主窗口会自动出现；关闭窗口只隐藏，程序继续在托盘运行。
echo   托盘左键单击 = 打开窗口；右键菜单 = 打开/关闭窗口、重启管理界面、
echo   重启镜像源服务、退出程序。
echo   网页版管理界面默认关闭，可在「配置 - 桌面 / 网页管理」中开启。
echo   注意：请用资源管理器双击本脚本或 exe 启动，不要从受限终端/沙盒启动。
echo ============================================================
start "" "%EXE%" %*
if errorlevel 1 (
  echo [错误] 启动失败，请检查 dist 目录与系统环境。
  pause
  exit /b 1
)
exit /b 0