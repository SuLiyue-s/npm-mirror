#Requires -Version 5.1
<#
.SYNOPSIS
  桌面版发版流水线：升版本号 -> 构建单 exe -> 提交并打 tag -> 推送 GitHub -> 发布 Releases。

.DESCRIPTION
  默认每次发版小版本 +1（patch）。流程：
    1. node tools/version.js --bump <patch|minor|major>，同步 package.json / Cargo.toml /
       Cargo.lock / tauri.conf.json 版本；
    2. tools/build-desktop.ps1 构建 dist/npm-mirror-desktop-<ver>.exe（release）；
    3. git add/commit/tag v<ver>；
    4. 推送 master 与 tag（SSH 失败时自动回退 https + token）；
    5. tools/publish-release.ps1 创建/更新 GitHub Release 并上传 exe。

.PARAMETER Bump
  版本递增方式，默认 patch（即 0.0.1 -> 0.0.2）。

.PARAMETER NoBump
  不升级版本号，直接使用当前版本（用于「版本号已提前升好、构建已提前完成」的重跑场景）。

.PARAMETER NoBuild
  跳过构建（复用已有 dist 产物，仅提交流水线用，慎用）。

.PARAMETER NoPush
  只本地提交与打 tag，不推送、不发 Release。

.PARAMETER SkipRelease
  推送代码/tag，但不在 GitHub 创建 Release（例如网络受限时手动补发）。

.PARAMETER Draft
  Release 创建为草稿。

.PARAMETER NotesFile
  自定义 Release 说明 markdown 文件。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1 -Bump minor
#>
[CmdletBinding()]
param(
  [string]$Bump = 'patch',
  [switch]$NoBump,
  [switch]$NoBuild,
  [switch]$NoPush,
  [switch]$SkipRelease,
  [switch]$Draft,
  [string]$NotesFile = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
. (Join-Path $PSScriptRoot 'gh-token.ps1')

function Step([string]$Text) {
  Write-Host ''
  Write-Host ('=== ' + $Text + ' ===') -ForegroundColor Cyan
}
function Fail([string]$Text) {
  Write-Host ('[发版失败] ' + $Text) -ForegroundColor Red
  exit 1
}

Step '检查工作区'
$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
Write-Host ('当前分支：' + $branch)
$status = @(& git status --porcelain)
if ($status.Count -gt 0) {
  Write-Host ('待提交改动 ' + $status.Count + ' 项（将随本次发版一起提交）：')
  $status | Select-Object -First 30 | ForEach-Object { Write-Host ('  ' + $_) }
  if ($status.Count -gt 30) { Write-Host ('  … 另有 ' + ($status.Count - 30) + ' 项') }
} else {
  Write-Host '工作区干净。'
}

Step '升级版本号'
if ($NoBump) {
  $ver = (& node -e "console.log(require('./package.json').version)").Trim()
  if ($LASTEXITCODE -ne 0 -or -not ($ver -match '^\d+\.\d+\.\d+$')) { Fail '无法读取当前版本号。' }
  Write-Host ('-NoBump：使用当前版本 v' + $ver)
} else {
  & node tools\version.js --bump $Bump
  if ($LASTEXITCODE -ne 0) { Fail '版本号升级失败。' }
  $ver = (& node -e "console.log(require('./package.json').version)").Trim()
  if ($LASTEXITCODE -ne 0 -or -not ($ver -match '^\d+\.\d+\.\d+$')) { Fail '无法读取新版本号。' }
  Write-Host ('新版本：v' + $ver)
}
$tag = 'v' + $ver

Step '构建桌面版单 exe'
if ($NoBuild) {
  $exePath = Join-Path $Root ('dist\npm-mirror-desktop-' + $ver + '.exe')
  if (-not (Test-Path -LiteralPath $exePath)) { Fail ('-NoBuild 但产物不存在：' + $exePath) }
  Write-Host ('跳过构建，复用：' + $exePath)
} else {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-desktop.ps1')
  if ($LASTEXITCODE -ne 0) { Fail '构建失败，已中止发版（未提交/未打 tag）。' }
}

Step '提交代码并打 tag'
& git add -A
& git commit -m ('release: v' + $ver + ' 桌面版单 exe')
if ($LASTEXITCODE -ne 0) {
  # 没有可提交内容时继续（例如仅重发）
  Write-Host '没有需要提交的改动（可能已提交），继续打 tag。'
}
& git tag -d $tag 2>$null | Out-Null
& git tag -a $tag -m ('桌面版 v' + $ver)
if ($LASTEXITCODE -ne 0) { Fail '创建 tag 失败：' + $tag }

if ($NoPush) {
  Write-Host '[完成] -NoPush：已本地提交并打 tag，未推送。'
  exit 0
}

Step '推送 master 与 tag'
$pushed = $false
$remoteUrl = (& git remote get-url origin).Trim()
$branchesToPush = @(($branch + ':refs/heads/' + $branch), ('refs/tags/' + $tag + ':refs/tags/' + $tag))

Write-Host ('直接推送 origin（' + $remoteUrl + '）…')
& git push origin @branchesToPush
if ($LASTEXITCODE -eq 0) {
  $pushed = $true
} else {
  Write-Host '直接推送失败，尝试 https + token 回退…' -ForegroundColor Yellow
  $cred = Get-GitHubToken
  if (-not $cred) { Fail '推送失败，且未找到 GitHub token 可用于 https 回退。' }
  $pair = 'x-access-token:' + $cred.Token
  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($pair))
  $repo = 'SuLiyue-s/npm-mirror'
  $httpsUrl = 'https://github.com/' + $repo + '.git'
  $attempts = @(
    @{ Name = 'https(openssl,带代理配置)'; Args = @('-c', 'http.sslBackend=openssl') },
    @{ Name = 'https(openssl,直连)'; Args = @('-c', 'http.sslBackend=openssl', '-c', 'http.proxy=', '-c', 'https.proxy=') }
  )
  foreach ($attempt in $attempts) {
    Write-Host ('  尝试 ' + $attempt.Name + ' …')
    $gitArgs = @($attempt.Args) + @('-c', ('http.extraHeader=AUTHORIZATION: basic ' + $b64), 'push', $httpsUrl) + $branchesToPush
    & git @gitArgs
    if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
  }
}
if (-not $pushed) {
  Fail @'
推送失败。可手动执行（在能访问 GitHub 的网络环境）：
  git push origin <branch> && git push origin v<ver>
或使用 token 通过 https 推送后，再运行 tools/publish-release.ps1 补发 Release。
'@
}
Write-Host ('已推送分支 ' + $branch + ' 与 tag ' + $tag)

if ($SkipRelease) {
  Write-Host '[完成] -SkipRelease：代码与 tag 已推送，未创建 GitHub Release。'
  exit 0
}

Step '发布 GitHub Release'
$releaseArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'publish-release.ps1'), '-Version', $ver)
if ($NotesFile) { $releaseArgs += @('-NotesFile', $NotesFile) }
if ($Draft) { $releaseArgs += '-Draft' }
& powershell @releaseArgs
if ($LASTEXITCODE -ne 0) { Fail 'Release 发布失败（代码已推送成功，可重跑 tools/publish-release.ps1 补发）。' }

Write-Host ''
Write-Host '[发版成功]' -ForegroundColor Green
Write-Host ('  版本：v' + $ver)
Write-Host ('  产物：dist\npm-mirror-desktop-' + $ver + '.exe')
Write-Host ('  仓库：https://github.com/SuLiyue-s/npm-mirror/releases')
exit 0
