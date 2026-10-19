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
    5. 复制产物到 dist/npm-mirror-desktop-<version>.exe，并生成 SHA256SUMS.txt。

.PARAMETER NodeExe
  指定用于内嵌的 node.exe 路径；默认取 PATH 中的 node。

.PARAMETER ForceIcon
  强制重新合成图标（默认仅在图标缺失时合成）。

.PARAMETER DebugBuild
  构建 debug 版本（产物放 dist 但不带版本号，仅调试用）。

.PARAMETER NoOffline
  不使用仓库内 cargo 缓存，走本机默认 CARGO_HOME（需要网络）。

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
  [switch]$NoOffline
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
$hash = (Get-FileHash -LiteralPath $distExe -Algorithm SHA256).Hash.ToLowerInvariant()
$sumFile = Join-Path $distDir 'SHA256SUMS.txt'
$sumLine = $hash + '  ' + $exeName
if (Test-Path -LiteralPath $sumFile) {
  $others = Get-Content -LiteralPath $sumFile | Where-Object { $_ -and ($_ -notmatch [regex]::Escape($exeName)) }
  $lines = @($others) + @($sumLine) | Where-Object { $_ }
  Set-Content -LiteralPath $sumFile -Value ($lines -join "`n") -Encoding utf8
} else {
  Set-Content -LiteralPath $sumFile -Value $sumLine -Encoding utf8
}

$cost = [math]::Round(((Get-Date) - $startAll).TotalMinutes, 1)
Write-Host ''
Write-Host '[构建成功]' -ForegroundColor Green
Write-Host ('  产物   ：' + $distExe)
Write-Host ('  大小   ：' + $sizeMB + ' MB')
Write-Host ('  SHA256 ：' + $hash)
Write-Host ('  校验文件：' + $sumFile)
Write-Host ('  耗时   ：' + $cost + ' 分钟')
exit 0
