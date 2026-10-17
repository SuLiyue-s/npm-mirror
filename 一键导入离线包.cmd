@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title 私人 npm 镜像源 - 导入离线包
set "FILE=%~1"
if not defined FILE (
  echo 用法一：把导出的离线包 .tgz 文件直接拖到本文件的图标上松开。
  echo 用法二：在下面输入离线包 .tgz 的完整路径后回车。
  echo.
)
if not defined FILE set /p FILE=离线包路径: 
if defined FILE set FILE=!FILE:"=!
if not defined FILE (
  echo 没有提供文件，已取消。
  pause
  endlocal
  exit /b 1
)
echo.
echo 正在导入："!FILE!"
echo.
node "%~dp0cli.js" import "!FILE!" --overwrite
if errorlevel 1 (
  echo.
  echo 导入失败：请检查上面的错误信息（常见原因：路径写错、离线包损坏、磁盘/存储空间不足）。
)
echo.
pause
endlocal
