@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal EnableExtensions
title 离月私人 npm 镜像源 - 桌面版启动器

set "EXE="
for /f "delims=" %%F in ('dir /b /a-d /o-d "dist\npm-mirror-desktop-*.exe" 2^>nul') do (
  if not defined EXE set "EXE=%~dp0dist\%%F"
)
if not defined EXE (
  echo [错误] 未找到 dist\npm-mirror-desktop-*.exe
  echo        请先运行 tools\build-desktop.ps1 构建桌面版，或把下载的 exe 放入 dist 目录。
  echo.
  pause
  exit /b 1
)

rem ------------------------------------------------------------------
rem 低完整性标签检查：
rem 若本目录被开发/沙箱环境标记为低完整性（Low Mandatory Level），
rem exe 会继承该标签；Windows 会把用该 exe 启动的进程强制降级为低完整性，
rem 表现为：无法写 %LOCALAPPDATA%、系统拒绝托盘图标注册。
rem 这里自动请求一次 UAC 把该 exe 的标签重置为 Medium。
rem ------------------------------------------------------------------
set "ISLOW="
for /f "delims=" %%L in ('icacls "%EXE%" 2^>nul ^| findstr /i "Low Mandatory"') do set "ISLOW=1"
if defined ISLOW (
  echo [提示] 检测到程序文件带有「低完整性（Low）」标签（开发/沙箱工作区会继承该标签）。
  echo        直接运行会被系统降级：无法写配置目录，托盘图标也不会显示。
  echo        现在请求一次管理员授权（UAC）把该 exe 的完整性标签重置为 Medium ...
  echo.
  if defined MIRROR_LAUNCH_DRYRUN (
    echo [DRYRUN] 将执行：修复-桌面版启动限制.cmd repair（提权）
    exit /b 2
  )
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~dp0修复-桌面版启动限制.cmd' -Verb RunAs -Wait -ArgumentList 'repair'"
  echo.
  set "FIXED="
  for /f "delims=" %%L in ('icacls "%EXE%" 2^>nul ^| findstr /i "Medium Mandatory"') do set "FIXED=1"
  if defined FIXED (
    echo [完成] 完整性标签已修复为 Medium，继续启动。
  ) else (
    echo [提示] 标签未修复（可能取消了 UAC）。程序将以受限模式启动，托盘图标可能不显示。
    echo        可稍后双击 修复-桌面版启动限制.cmd 手动修复。
  )
  echo.
)

echo ============================================================
echo   正在启动 离月私人 npm 镜像源 桌面版
echo   程序：%EXE%
echo.
echo   启动后主窗口会自动出现；关闭窗口只隐藏，程序继续在托盘运行。
echo   托盘左键单击 = 打开窗口；右键菜单 = 打开/关闭窗口、打开管理界面、
echo   重启管理界面、重启镜像源服务、退出程序。
echo   网页版管理界面默认关闭，可在「配置 - 桌面 / 网页管理」中开启。
echo   注意：请用资源管理器双击本脚本或 exe 启动，不要从受限终端/沙盒启动。
echo ============================================================
if defined MIRROR_LAUNCH_DRYRUN (
  echo [DRYRUN] 将执行：start "" "%EXE%" %*
  exit /b 0
)
start "" "%EXE%" %*
if errorlevel 1 (
  echo [错误] 启动失败，请检查 dist 目录与系统环境。
  pause
  exit /b 1
)
exit /b 0
