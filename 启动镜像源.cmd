@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 私人 npm 镜像源 - 启动
echo ============================================================
echo   正在启动 私人 npm 镜像源（离线版）
echo   启动后本窗口保持打开即为运行中；关闭窗口或按 Ctrl+C 即停止
echo   管理界面会自动在浏览器打开（如不需要：node cli.js start --no-open）
echo ============================================================
echo.
node "%~dp0cli.js" start
if errorlevel 1 (
  echo.
  echo [启动失败] 请把上面的错误信息截图反馈，或运行「环境自检.cmd」排查。
  pause
)
