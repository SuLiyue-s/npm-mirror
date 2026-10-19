#Requires -Version 5.1
<#
.SYNOPSIS
  为「离月私人 npm 镜像源」桌面版 exe 做自签数字签名（Authenticode / PowerShell Set-AuthenticodeSignature）。

.DESCRIPTION
  本项目使用「项目内自签证书」解决未签名 exe 被 Windows SmartScreen 直接拦截的问题：
    - 首次运行本脚本时在 .signing/ 下生成自签代码签名证书（CN=suliyue，含私钥 PFX）；
    - 用该证书对 dist\ 下的桌面版 exe 做 SHA256 Authenticode 签名，并把公钥证书复制为 dist\codesign-suliyue.cer；
    - 用户双击根目录「安装签名证书.cmd」把证书导入「当前用户」的受信任根 + 受信任发布者后，
      exe 属性即可显示「数字签名已验证」。

  边界（如实告知）：
    - 自签证书只在本机导入后受信任，不具备公开信用；
    - 首次下载运行的 SmartScreen 仍可能提示「未知发布者」（信誉需要正式 CA / EV 证书）；
    - .signing/ 含私钥，已在 .gitignore 中排除，请勿提交或外传。

.PARAMETER Exe
  要签名的 exe 路径；缺省取 dist\npm-mirror-desktop-*.exe 中最新且非 debug 的产物。

.PARAMETER PfxPath
  签名证书 PFX 路径；缺省 .signing\suliyue-codesign.pfx。

.PARAMETER CerPath
  公钥证书 CER 路径；缺省 .signing\suliyue-codesign.cer。

.PARAMETER PasswordFile
  PFX 密码文件路径；缺省 .signing\pfx-password.txt。

.PARAMETER Subject
  自签证书主题；缺省 CN=suliyue。

.PARAMETER ForceNewCert
  强制重新生成自签证书（旧证书作废，已发布的 exe 需重新签名）。

.PARAMETER GenerateCertOnly
  只确保证书素材存在并导出 dist\codesign-suliyue.cer，不签名。

.PARAMETER AllowResign
  允许对已签名文件重新签名（默认同一证书会跳过，其他证书会报错）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/sign-desktop.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/sign-desktop.ps1 -Exe dist/npm-mirror-desktop-0.0.8.exe
#>
[CmdletBinding()]
param(
  [string]$Exe = '',
  [string]$PfxPath = '',
  [string]$CerPath = '',
  [string]$PasswordFile = '',
  [string]$Subject = 'CN=suliyue',
  [switch]$ForceNewCert,
  [switch]$GenerateCertOnly,
  [switch]$AllowResign
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$Root = Split-Path -Parent $PSScriptRoot
$SigningDir = Join-Path $Root '.signing'
if (-not $PfxPath) { $PfxPath = Join-Path $SigningDir 'suliyue-codesign.pfx' }
if (-not $CerPath) { $CerPath = Join-Path $SigningDir 'suliyue-codesign.cer' }
if (-not $PasswordFile) { $PasswordFile = Join-Path $SigningDir 'pfx-password.txt' }
$DistDir = Join-Path $Root 'dist'

function Say([string]$Text) { Write-Host $Text }
function Warn([string]$Text) { Write-Host $Text -ForegroundColor Yellow }
function Fail([string]$Text) {
  Write-Host ('[签名失败] ' + $Text) -ForegroundColor Red
  exit 1
}

function Get-CertMaker {
  $type = 'SuliyueCodeSignCertMaker' -as [type]
  if (-not $type) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

public static class SuliyueCodeSignCertMaker
{
    // 生成自签代码签名证书：RSA2048 + SHA256，EKU=Code Signing，有效期 years 年。
    public static string Create(string subject, string pfxPath, string cerPath, string password, int years)
    {
        using (RSA rsa = RSA.Create(2048))
        {
            var req = new CertificateRequest(subject, rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            req.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, false));
            req.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, false));
            var oids = new OidCollection();
            oids.Add(new Oid("1.3.6.1.5.5.7.3.3"));
            req.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(oids, false));
            using (var cert = req.CreateSelfSigned(DateTimeOffset.Now.AddDays(-1), DateTimeOffset.Now.AddYears(years)))
            {
                File.WriteAllBytes(pfxPath, cert.Export(X509ContentType.Pfx, password));
                File.WriteAllBytes(cerPath, cert.Export(X509ContentType.Cert));
                return cert.Thumbprint;
            }
        }
    }
}
'@
    $type = 'SuliyueCodeSignCertMaker' -as [type]
  }
  if (-not $type) { Fail '无法加载证书生成器（Add-Type 失败）。' }
  return $type
}

function New-RandomPassword {
  $bytes = New-Object byte[] 18
  $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return ([Convert]::ToBase64String($bytes)).Replace('/', '_').Replace('+', '-').TrimEnd('=')
}

# ---------------------------------------------------------------- 1. 证书素材
$needCert = $ForceNewCert -or (-not ((Test-Path -LiteralPath $PfxPath) -and (Test-Path -LiteralPath $CerPath) -and (Test-Path -LiteralPath $PasswordFile)))
if ($needCert) {
  if ($ForceNewCert) { Warn '按 -ForceNewCert 重新生成自签证书（旧证书将作废）。' }
  New-Item -ItemType Directory -Force -Path $SigningDir | Out-Null
  Say '生成项目自签代码签名证书…'
  $maker = Get-CertMaker
  $pw = New-RandomPassword
  $thumb = $maker::Create($Subject, $PfxPath, $CerPath, $pw, 5)
  [System.IO.File]::WriteAllText($PasswordFile, $pw, (New-Object System.Text.UTF8Encoding($false)))
  Say ('  主题  ：' + $Subject)
  Say ('  指纹  ：' + $thumb)
  Say ('  PFX   ：' + $PfxPath + '（含私钥，已 gitignore，勿外传）')
  Say ('  CER   ：' + $CerPath)
}
if (-not ((Test-Path -LiteralPath $PfxPath) -and (Test-Path -LiteralPath $CerPath))) {
  Fail '签名证书素材缺失（.signing 下应有 .pfx/.cer/pfx-password.txt）。'
}
if (-not (Test-Path -LiteralPath $PasswordFile)) { Fail ('缺少签名密码文件：' + $PasswordFile) }
$password = (Get-Content -LiteralPath $PasswordFile -Raw).Trim()
if (-not $password) { Fail '签名密码文件为空（可删除 .signing 后重跑本脚本重新生成）。' }

# 公钥证书始终复制到 dist，便于用户随程序拿到并安装。
if (Test-Path -LiteralPath $DistDir) {
  try {
    Copy-Item -LiteralPath $CerPath -Destination (Join-Path $DistDir 'codesign-suliyue.cer') -Force
    Say ('已导出公钥证书：' + (Join-Path $DistDir 'codesign-suliyue.cer'))
  } catch {
    Warn ('复制公钥证书到 dist 失败（不影响签名）：' + $_.Exception.Message)
  }
}

if ($GenerateCertOnly) {
  Say ''
  Say '已确保证书素材存在（-GenerateCertOnly）。'
  Say '安装方法：双击根目录「安装签名证书.cmd」，或把 dist\codesign-suliyue.cer 双击导入「受信任的根证书颁发机构」。'
  exit 0
}

# ---------------------------------------------------------------- 2. 目标 exe
if (-not $Exe) {
  $candidates = @()
  if (Test-Path -LiteralPath $DistDir) {
    $candidates = @(Get-ChildItem -LiteralPath $DistDir -Filter 'npm-mirror-desktop-*.exe' |
      Where-Object { $_.Name -notmatch 'debug' } | Sort-Object LastWriteTime -Descending)
  }
  if ($candidates.Count -eq 0) { Fail '未找到 dist\npm-mirror-desktop-*.exe，请先构建或用 -Exe 指定文件。' }
  $Exe = $candidates[0].FullName
}
if (-not (Test-Path -LiteralPath $Exe)) { Fail ('exe 不存在：' + $Exe) }
$Exe = (Resolve-Path -LiteralPath $Exe).Path

# ---------------------------------------------------------------- 3. 证书装载
$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
try {
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($PfxPath, $password, $flags)
} catch {
  Fail ('加载签名证书失败（密码文件与 PFX 可能不匹配，可删除 .signing 后重新生成）：' + $_.Exception.Message)
}
if (-not $cert.HasPrivateKey) { Fail '签名证书不含私钥，无法签名。' }
if (([string]$cert.Subject) -notlike ('*' + $Subject + '*')) {
  Fail ('签名证书主题不符：' + [string]$cert.Subject + '（期望包含 ' + $Subject + '）。')
}
$ce = $cert.NotAfter
Say ''
Say ('签名证书：' + $cert.Subject + ' / ' + $cert.Thumbprint)
Say ('证书有效期至：' + $ce.ToString('yyyy-MM-dd') + '（过期后需 -ForceNewCert 重新生成并重签）')

# ---------------------------------------------------------------- 4. 已签名检查
$existing = Get-AuthenticodeSignature -FilePath $Exe
if (($existing.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) -and $existing.SignerCertificate) {
  if (([string]$existing.SignerCertificate.Thumbprint) -eq ([string]$cert.Thumbprint) -and (-not $AllowResign)) {
    Say ''
    Say '该文件已由本证书签名，跳过重复签名（-AllowResign 可强制重签）。'
    Say ('当前签名状态：' + [string]$existing.Status)
    exit 0
  }
  if (-not $AllowResign) {
    Fail ('该文件已被其他证书签名（' + [string]$existing.SignerCertificate.Subject + '），确认要覆盖请加 -AllowResign。')
  }
}

# ---------------------------------------------------------------- 5. 签名
Say ''
Say ('正在签名：' + $Exe)
$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
  Set-AuthenticodeSignature -FilePath $Exe -Certificate $cert -HashAlgorithm SHA256 -ErrorAction Stop | Out-Null
} catch {
  Fail ('写入数字签名失败：' + $_.Exception.Message + '（若文件只读或目录 ACL 受限，请重新构建或手动删除该 exe 后再试）。')
}
$sw.Stop()
$after = Get-AuthenticodeSignature -FilePath $Exe
if (-not $after.SignerCertificate) { Fail '签名执行后仍检测不到签名信息。' }
if (([string]$after.SignerCertificate.Thumbprint) -ne ([string]$cert.Thumbprint)) {
  Fail ('签名校验失败：文件签名指纹与证书不一致。')
}

# ---------------------------------------------------------------- 6. 结果
$sizeMB = [math]::Round((Get-Item -LiteralPath $Exe).Length / 1MB, 2)
$sha = (Get-FileHash -LiteralPath $Exe -Algorithm SHA256).Hash.ToLowerInvariant()
$statusText = [string]$after.Status
Say ''
Say '[签名完成]'
Say ('  文件   ：' + $Exe)
Say ('  大小   ：' + $sizeMB + ' MB')
Say ('  SHA256 ：' + $sha + '（签名后）')
Say ('  签名者 ：' + [string]$after.SignerCertificate.Subject)
Say ('  指纹   ：' + [string]$after.SignerCertificate.Thumbprint)
Say ('  状态   ：' + $statusText + '（耗时 ' + $sw.ElapsedMilliseconds + ' ms）')
Say ('  公钥证书：' + (Join-Path $DistDir 'codesign-suliyue.cer'))
Say ''
if ($statusText -eq 'Valid') {
  Say '本机已信任该自签证书：资源管理器属性 →「数字签名」显示「已验证的发布者」。'
} else {
  Say '签名已写入；本机尚未信任该自签证书，属性里会显示「状态：' + $statusText + '」。'
  Say '请双击根目录「安装签名证书.cmd」把证书导入当前用户的「受信任的根证书 + 受信任的发布者」，'
  Say '然后重新打开 exe 属性即可看到「数字签名已验证」。'
  Say '提示：自签证书没有公开信用，首次下载运行时 SmartScreen 仍可能提示「未知发布者」；UAC 发布者名称在导入后一般会显示。'
}
exit 0
