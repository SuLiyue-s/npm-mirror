@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
set "CER=%~dp0dist\codesign-suliyue.cer"
echo.
echo  ==================================================
echo    安装「离月私人 npm 镜像源」自签代码签名证书
echo  ==================================================
echo.
if not exist "%CER%" (
  echo  [错误] 未找到证书文件：
  echo         %CER%
  echo.
  echo  请先编译桌面版（tools\build-desktop.ps1），
  echo  或运行 tools\sign-desktop.ps1 -GenerateCertOnly 生成证书素材。
  echo.
  pause
  exit /b 1
)
echo  证书文件：%CER%
echo.
echo  将把该证书导入到「当前用户」的：
echo    1）受信任的根证书颁发机构（Root）
echo    2）受信任的发布者（TrustedPublisher）
echo  导入后，本机 exe 属性中的「数字签名」应显示为已验证。
echo.
echo  说明：这是本机自签证书，只对本机生效、不具备公开信用；
echo        首次运行 SmartScreen 仍可能提示「未知发布者」。
echo.
set /p CONFIRM=确认导入请输入 Y 后回车（直接回车取消）：
if /i not "%CONFIRM%"=="Y" (
  echo.
  echo 已取消，未做任何修改。
  pause
  exit /b 0
)
echo.
certutil -user -addstore -f Root "%CER%"
if errorlevel 1 goto fail
certutil -user -addstore -f TrustedPublisher "%CER%"
if errorlevel 1 goto fail
echo.
echo  [成功] 证书已导入当前用户。
echo  验证：右键 exe →「属性」→「数字签名」应显示「已验证的发布者」。
echo  卸载：certmgr.msc →「受信任的根证书颁发机构」和「受信任的发布者」
echo        中找到 CN=suliyue 的证书并删除即可。
echo.
pause
exit /b 0

:fail
echo.
echo  [失败] 证书导入失败。可尝试：双击证书文件手动安装，
echo         或检查当前用户是否有权限修改证书存储。
echo.
pause
exit /b 1
