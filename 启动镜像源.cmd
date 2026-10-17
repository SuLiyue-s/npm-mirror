@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 私人 npm 镜像源 - 运行中
echo ============================================================
echo   正在启动 私人 npm 镜像源（离线版）
echo   启动成功后本窗口会自动隐藏到右下角托盘（项目图标）
echo     左键单击托盘图标 = 打开本窗口（命令行窗口）
echo     右键单击托盘图标 = 打开/隐藏控制台、打开管理界面、退出镜像源
echo   托盘不可用时本窗口会保持显示；关闭窗口或按 Ctrl+C 即停止
echo   管理界面会自动在浏览器打开（如不需要：node cli.js start --no-open）
echo ============================================================
if defined MIRROR_AUTOSTART echo   [开机自启] 本次由登录启动，窗口本来就隐藏；服务输出与启动错误见 data\logs\autostart.log
echo.
rem 托盘宿主：等镜像源就绪后隐藏本窗口、注册托盘图标（没有 PowerShell 就退回普通窗口）
rem 注意：这里不要传 -Root "%~dp0"——cmd 把结尾反斜杠原样交给 PowerShell 会把参数引号吃掉，
rem       导致托盘拿错目录直接退出。tray.ps1 内部默认用自己所在目录的上一级作为项目根目录。
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo [提示] 没有找到 PowerShell，托盘图标不可用，本窗口保持显示。
) else (
  start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\tray.ps1"
)
if defined MIRROR_AUTOSTART (
  rem 开机自启是隐藏窗口：把服务输出写进日志，服务没起来时便于排查
  if not exist "%~dp0data\logs" mkdir "%~dp0data\logs"
  node "%~dp0cli.js" start %* >"%~dp0data\logs\autostart.log" 2>&1
) else (
  node "%~dp0cli.js" start %*
)
if errorlevel 1 (
  if defined MIRROR_AUTOSTART (
    rem 隐藏窗口里不能 pause（会一直挂着看不见），失败原因已经写进 data\logs\autostart.log
    if not exist "%~dp0data\logs" mkdir "%~dp0data\logs"
    echo [%date% %time%] 开机自启启动失败，详见 data\logs\autostart.log>>"%~dp0data\logs\autostart.log"
  ) else (
    echo.
    echo [启动失败] 请把上面的错误信息截图反馈，或运行「环境自检.cmd」排查。
    pause
  )
)
