@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title 离月私人 npm 镜像源 - 修复桌面版启动限制

rem 参数：
rem   （无参数）  检查并在需要时请求管理员权限（UAC），把 exe 的完整性标签重置为 Medium
rem   check       只检查、不修改（退出码 0=正常，2=带低完整性标签）
rem   repair      内部使用：提权后的实例执行实际修复

set "MODE=%~1"

set "TARGET="
for /f "delims=" %%F in ('dir /b /a-d /o-d "%~dp0dist\npm-mirror-desktop-*.exe" 2^>nul') do (
  if not defined TARGET set "TARGET=%~dp0dist\%%F"
)
if not defined TARGET (
  echo [错误] 未在 dist 目录找到 npm-mirror-desktop-*.exe，请先编译桌面版。
  if /i not "%MODE%"=="check" pause
  exit /b 1
)

echo 目标程序：%TARGET%
echo.

set "ISLOW="
for /f "delims=" %%L in ('icacls "%TARGET%" 2^>nul ^| findstr /i "Low Mandatory"') do set "ISLOW=1"
if not defined ISLOW (
  echo 当前程序文件不带「低完整性」标签，无需修复。
  if /i not "%MODE%"=="check" if /i not "%MODE%"=="repair" pause
  exit /b 0
)

if /i "%MODE%"=="check" (
  echo [检查] 程序文件带有「低完整性（Low）」标签。
  echo        系统会把进程强制降级为低完整性运行：无法写用户配置目录、无法注册托盘图标。
  echo        运行本脚本（不带参数）或双击 启动桌面版.cmd 可一键修复。
  exit /b 2
)

net session >nul 2>&1
if errorlevel 1 (
  echo 需要管理员权限来修改该 exe 的完整性标签（只改这一个文件，不动其它设置）。
  echo 正在请求 UAC 提权...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs -Wait -ArgumentList 'repair'"
  echo.
  set "FIXED="
  for /f "delims=" %%L in ('icacls "%TARGET%" 2^>nul ^| findstr /i "Medium Mandatory"') do set "FIXED=1"
  if defined FIXED (
    echo [完成] 修复成功：完整性标签已重置为 Medium。
    echo        现在双击 dist 下的 exe，或双击 启动桌面版.cmd 即可正常运行。
  ) else (
    echo [提示] 标签仍是 Low（可能取消了 UAC 提权）。请重新运行本脚本并同意 UAC。
    echo        若仍失败，请用「以管理员身份运行」的 PowerShell 执行：
    echo          icacls "%TARGET%" /setintegritylevel Medium
  )
  pause
  exit /b 0
)

echo 正在把完整性标签重置为 Medium ...
icacls "%TARGET%" /setintegritylevel Medium
if errorlevel 1 (
  echo.
  echo [失败] 重置标签失败。请手动用「以管理员身份运行」的 PowerShell 执行：
  echo   icacls "%TARGET%" /setintegritylevel Medium
  if /i not "%MODE%"=="repair" pause
  exit /b 1
)
echo.
icacls "%TARGET%" | findstr /i "Mandatory"
echo.
echo [完成] 修复成功。现在双击该 exe 或 启动桌面版.cmd 即可正常运行（托盘图标会正常显示）。
echo 注意：每次重新编译桌面版后，新 exe 会再次继承 Low 标签，需要再运行一次本脚本。
if /i not "%MODE%"=="repair" pause
exit /b 0
