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
rem 启动前检查：服务已经在跑（且端口与本次启动端口一致）时不要再启动第二份——
rem 否则会去抢同一个端口（必然失败），还会重复注册一个托盘图标。
node "%~dp0cli.js" prestart %*
set "PRESTART_CODE=%errorlevel%"
if "%PRESTART_CODE%"=="10" (
  rem 已经在本次端口上运行：prestart 已经（在允许时）打开了管理界面，这里直接结束
  if defined MIRROR_AUTOSTART (
    if not exist "%~dp0data\logs" mkdir "%~dp0data\logs"
    echo [%date% %time%] 开机自启检测到镜像源已在运行，跳过本次启动>>"%~dp0data\logs\autostart.log"
  ) else (
    echo.
    echo [已在运行] 镜像源服务已经在运行，本次没有重复启动。
    timeout /t 2 >nul
  )
  exit /b 0
)
if "%PRESTART_CODE%"=="11" (
  rem 已经在其它端口运行：共用同一个 data 目录不能同时起两个实例
  if defined MIRROR_AUTOSTART (
    if not exist "%~dp0data\logs" mkdir "%~dp0data\logs"
    echo [%date% %time%] 开机自启失败：镜像源已在其它端口运行，请先停止现有服务>>"%~dp0data\logs\autostart.log"
  ) else (
    echo.
    echo [无法启动] 镜像源已经在其它端口运行。请先执行「停止镜像源.cmd」，或把 data\config.json 的 server.port 改成与正在运行的端口一致。
    pause
  )
  exit /b 1
)
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
