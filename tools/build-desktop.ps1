#Requires -Version 5.1
<#
.SYNOPSIS
  构建「离月私人 npm 镜像源」桌面版单 exe（Tauri）。

.DESCRIPTION
  流程：
    1. 校验 package.json / Cargo.toml / tauri.conf.json / Cargo.lock 版本一致；
    2. 把本机 node.exe 复制到 src-tauri/embed/node.exe（构建时内嵌）；
    3. 校验桌面图标（缺失时调用 tools/compose-desktop-icon.ps1 合成）；
    4. 使用仓库内离线 cargo 缓存（tmp/cargo-home）执行 cargo build --release；
    5. 复制产物到 dist/npm-mirror-desktop-<version>.exe；
    6. 用项目自签证书做数字签名并导出 dist/codesign-suliyue.cer（-NoSign 可跳过）；
    7. 校验版本信息并生成 SHA256SUMS.txt（哈希为签名后的文件）。

.PARAMETER NodeExe
  指定用于内嵌的 node.exe 路径；默认取 PATH 中的 node。

.PARAMETER ForceIcon
  强制重新合成图标（默认仅在图标缺失时合成）。

.PARAMETER DebugBuild
  构建 debug 版本（产物放 dist 但不带版本号，仅调试用）。

.PARAMETER NoOffline
  不使用仓库内 cargo 缓存，走本机默认 CARGO_HOME（需要网络）。

.PARAMETER NoSign
  跳过数字签名（默认使用 tools/sign-desktop.ps1 的自签证书签名；debug 构建总是跳过）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-desktop.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-desktop.ps1 -ForceIcon
#>
[CmdletBinding()]
param(
  [string]$NodeExe = '',
  [switch]$ForceIcon,
  [switch]$DebugBuild,
  [switch]$NoOffline,
  [switch]$NoSign
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step([string]$Text) {
  Write-Host ''
  Write-Host ('=== ' + $Text + ' ===') -ForegroundColor Cyan
}
function Fail([string]$Text) {
  Write-Host ('[构建失败] ' + $Text) -ForegroundColor Red
  exit 1
}

function Get-Sha256Hex([string]$Path) {
  # 不依赖 Get-FileHash（受限/嵌套 PowerShell 上下文里 Utility 模块自动加载可能失败），直接用 .NET。
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $bytes = $sha.ComputeHash($fs)
    } finally {
      $fs.Dispose()
    }
  } finally {
    $sha.Dispose()
  }
  return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

$startAll = Get-Date
Write-Host ('项目目录：' + $Root)

# ---------------------------------------------------------------- 1. 版本一致
Step '校验版本号'
& node tools\version.js --check
if ($LASTEXITCODE -ne 0) { Fail '版本号不一致，请先运行 node tools/version.js <x.y.z> 统一版本。' }
$Version = (& node -e "console.log(require('./package.json').version)").Trim()
if ($LASTEXITCODE -ne 0 -or -not $Version) { Fail '无法读取 package.json 版本号。' }
Write-Host ('版本：' + $Version)

# ---------------------------------------------------------------- 2. node.exe
Step '准备内嵌 Node 运行时'
if (-not $NodeExe) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { Fail '未找到 node.exe，请安装 Node.js 18+ 或用 -NodeExe 指定完整路径。' }
  $NodeExe = $cmd.Source
}
if (-not (Test-Path -LiteralPath $NodeExe)) { Fail ('node.exe 不存在：' + $NodeExe) }
$nodeSrc = (Resolve-Path -LiteralPath $NodeExe).Path
$embedDir = Join-Path $Root 'src-tauri\embed'
New-Item -ItemType Directory -Force -Path $embedDir | Out-Null
$nodeDst = Join-Path $embedDir 'node.exe'
$needCopy = $true
if (Test-Path -LiteralPath $nodeDst) {
  $a = (Get-Item -LiteralPath $nodeSrc).Length
  $b = (Get-Item -LiteralPath $nodeDst).Length
  if ($a -eq $b) { $needCopy = $false }
}
if ($needCopy) {
  Copy-Item -LiteralPath $nodeSrc -Destination $nodeDst -Force
  Write-Host ('已复制 node.exe：' + $nodeSrc + ' -> ' + $nodeDst)
} else {
  Write-Host ('复用已有内嵌 node.exe（' + [math]::Round((Get-Item -LiteralPath $nodeDst).Length / 1MB, 1) + ' MB）')
}

# ---------------------------------------------------------------- 3. 图标
Step '检查桌面图标'
$iconIco = Join-Path $Root 'src-tauri\icons\icon.ico'
$iconWin = Join-Path $Root 'src-tauri\icons\window-256.rgba'
$iconTray = Join-Path $Root 'src-tauri\icons\tray-32.rgba'
$iconOk = (Test-Path -LiteralPath $iconIco) -and (Test-Path -LiteralPath $iconWin) -and (Test-Path -LiteralPath $iconTray)
if ($ForceIcon -or -not $iconOk) {
  $iconScript = Join-Path $Root 'tools\compose-desktop-icon.ps1'
  if (-not (Test-Path -LiteralPath $iconScript)) {
    Fail '缺少 tools/compose-desktop-icon.ps1，无法合成图标（该脚本由 rust-tauri 负责人提供）。'
  }
  Write-Host '调用图标合成脚本…'
  & powershell -NoProfile -ExecutionPolicy Bypass -File $iconScript
  if ($LASTEXITCODE -ne 0) { Fail '图标合成失败。' }
  if (-not ((Test-Path -LiteralPath $iconIco) -and (Test-Path -LiteralPath $iconWin) -and (Test-Path -LiteralPath $iconTray))) {
    Fail '图标合成后仍缺少输出文件，请检查 tools/compose-desktop-icon.ps1。'
  }
} else {
  Write-Host '图标已存在，跳过合成（-ForceIcon 可强制重建）。'
}

# ---------------------------------------------------------------- 4. 离线 cargo
Step '准备 Rust 构建环境'
$cargoHome = Join-Path $Root 'tmp\cargo-home'
$useOffline = (-not $NoOffline) -and (Test-Path -LiteralPath (Join-Path $cargoHome 'registry'))
if ($useOffline) {
  $env:CARGO_HOME = $cargoHome
  $env:CARGO_NET_OFFLINE = 'true'
  Write-Host ('使用仓库内离线 cargo 缓存：' + $cargoHome)
} else {
  Write-Host '使用本机默认 cargo 环境（需要网络，首次构建会下载依赖）。'
}
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) { Fail '未找到 cargo，请安装 Rust 工具链（rustup）并确保 cargo 在 PATH 中。' }
Write-Host (& cargo --version)

# ---------------------------------------------------------------- 5. 构建
Step 'cargo build（release）'
$profileArg = @()
if ($DebugBuild) { $profileArg = @() } else { $profileArg = @('--release') }
Push-Location (Join-Path $Root 'src-tauri')
try {
  $cargoArgs = @('build') + $profileArg
  if ($useOffline) { $cargoArgs += '--offline' }
  Write-Host ('cargo ' + ($cargoArgs -join ' '))
  & cargo @cargoArgs
  if ($LASTEXITCODE -ne 0) { Fail ('cargo 构建失败（exit ' + $LASTEXITCODE + '）。') }
} finally {
  Pop-Location
}
$profileDir = if ($DebugBuild) { 'debug' } else { 'release' }
$builtExe = Join-Path $Root ('src-tauri\target\' + $profileDir + '\npm-mirror-desktop.exe')
if (-not (Test-Path -LiteralPath $builtExe)) { Fail ('未找到构建产物：' + $builtExe) }

# ---------------------------------------------------------------- 6. 产出 dist
Step '生成 dist 产物'
$distDir = Join-Path $Root 'dist'
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$exeName = if ($DebugBuild) { 'npm-mirror-desktop-debug.exe' } else { 'npm-mirror-desktop-' + $Version + '.exe' }
$distExe = Join-Path $distDir $exeName
Copy-Item -LiteralPath $builtExe -Destination $distExe -Force
$sizeMB = [math]::Round((Get-Item -LiteralPath $distExe).Length / 1MB, 2)
if ($sizeMB -lt 20) { Fail ('产物仅 ' + $sizeMB + ' MB，明显小于预期（应内嵌 node.exe 约 90MB），构建异常。') }

# 数字签名（自签证书）：必须在计算 SHA256 之前完成，校验文件哈希才是最终交付文件的哈希。
if ($DebugBuild -or $NoSign) {
  Step '数字签名'
  Write-Host '已跳过数字签名（-NoSign / debug 构建）。' -ForegroundColor Yellow
} else {
  Step '数字签名（自签证书）'
  $signScript = Join-Path $Root 'tools\sign-desktop.ps1'
  if (-not (Test-Path -LiteralPath $signScript)) {
    Fail '缺少 tools/sign-desktop.ps1，无法签名（可用 -NoSign 跳过签名）。'
  }
  $signed = $false
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $signScript -Exe $distExe
    if ($LASTEXITCODE -eq 0) { $signed = $true; break }
    Write-Host ('数字签名第 ' + $attempt + ' 次尝试失败（退出码 ' + $LASTEXITCODE + '），2 秒后重试…') -ForegroundColor Yellow
    Start-Sleep -Seconds 2
  }
  if (-not $signed) { Fail '数字签名失败（可用 -NoSign 跳过签名）。' }
}

# 版本信息校验：发布者（CompanyName）与版本号必须正确写入 exe 资源。
# tauri-build 的 CompanyName 来源 = tauri.conf.json 的 bundle.publisher（未设置时回退取 identifier 第 2 段），
# 这里显式校验，避免发布者字段悄悄丢失或回退成其他值。
$vi = (Get-Item -LiteralPath $distExe).VersionInfo
$expectPublisher = 'suliyue'
if ([string]$vi.CompanyName -ne $expectPublisher) {
  Fail ('exe 发布者信息不正确：CompanyName=' + [string]$vi.CompanyName + '（期望 ' + $expectPublisher + '）。请检查 src-tauri/tauri.conf.json 的 bundle.publisher。')
}
if ([string]$vi.ProductVersion -ne [string]$Version -or [string]$vi.FileVersion -ne [string]$Version) {
  Fail ('exe 版本信息不正确：FileVersion=' + [string]$vi.FileVersion + '，ProductVersion=' + [string]$vi.ProductVersion + '（期望 ' + $Version + '）。')
}
Write-Host ('版本信息校验通过：FileVersion=' + $vi.FileVersion + ' / CompanyName=' + $vi.CompanyName + ' / ProductName=' + $vi.ProductName)
$hash = Get-Sha256Hex $distExe
$sumFile = Join-Path $distDir 'SHA256SUMS.txt'
$sumLine = $hash + '  ' + $exeName
# 校验清单写成「UTF-8 无 BOM + LF」：带 BOM 会让 sha256sum -c 把 BOM 当成哈希前缀而校验失败
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
if (Test-Path -LiteralPath $sumFile) {
  $others = Get-Content -LiteralPath $sumFile | Where-Object { $_ -and ($_ -notmatch [regex]::Escape($exeName)) }
  $lines = @(@($others) + @($sumLine) | Where-Object { $_ } | ForEach-Object { $_.TrimStart([char]0xFEFF) })
  [System.IO.File]::WriteAllText($sumFile, (($lines -join "`n") + "`n"), $utf8NoBom)
} else {
  [System.IO.File]::WriteAllText($sumFile, ($sumLine + "`n"), $utf8NoBom)
}

$cost = [math]::Round(((Get-Date) - $startAll).TotalMinutes, 1)
Write-Host ''
# 完整性标签检查：若当前开发/沙箱环境把项目目录标记为低完整性，dist 产物会继承 Low 标签，
# 双击运行时会被系统降级（无法写用户配置目录、托盘图标不显示）。
try {
  $labelOut = (& icacls.exe $distExe 2>$null | Out-String)
  if ($labelOut -match 'Low Mandatory') {
    Write-Host ''
    Write-Host '[注意] 产物继承了「低完整性(Low)」标签：直接双击会被系统降级运行（无法写用户配置目录、托盘图标不显示）。' -ForegroundColor Yellow
    Write-Host '       修复：双击 启动桌面版.cmd（会自动请求一次 UAC），或运行 修复-桌面版启动限制.cmd。' -ForegroundColor Yellow
    Write-Host '       每次重新编译后都需要重新修复一次。' -ForegroundColor Yellow
  }
} catch { }
Write-Host '[构建成功]' -ForegroundColor Green
Write-Host ('  产物   ：' + $distExe)
Write-Host ('  大小   ：' + $sizeMB + ' MB')
Write-Host ('  SHA256 ：' + $hash)
Write-Host ('  校验文件：' + $sumFile)
Write-Host ('  耗时   ：' + $cost + ' 分钟')
exit 0
