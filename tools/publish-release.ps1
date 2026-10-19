#Requires -Version 5.1
<#
.SYNOPSIS
  把 dist 下的桌面版单 exe 发布到 GitHub Releases。

.DESCRIPTION
  token 获取顺序：-Token 参数 > 环境变量 GITHUB_TOKEN / GH_TOKEN > Windows 凭据管理器
  （Git Credential Manager 保存的 GitHub token，见 tools/gh-token.ps1）。
  网络请求由 node tools/publish-release.js 完成（Node 自带 OpenSSL，不受系统 schannel 环境影响）。

.PARAMETER Version
  要发布的版本号（x.y.z），默认读取 package.json。

.PARAMETER CheckToken
  只校验 token 是否有效、是否有仓库推送权限，不做发布。

.PARAMETER Token
  显式传入 GitHub token（不推荐，建议用环境变量或凭据管理器）。

.PARAMETER Repo
  owner/repo，默认 SuLiyue-s/npm-mirror。

.PARAMETER NotesFile
  Release 说明正文文件（markdown）；默认自动生成。

.PARAMETER Draft
  创建为草稿 Release（不公开）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/publish-release.ps1 -CheckToken

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/publish-release.ps1
#>
[CmdletBinding()]
param(
  [string]$Version = '',
  [switch]$CheckToken,
  [string]$Token = '',
  [string]$Repo = 'SuLiyue-s/npm-mirror',
  [string]$NotesFile = '',
  [switch]$Draft
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

. (Join-Path $PSScriptRoot 'gh-token.ps1')

function Fail([string]$Text) {
  Write-Host ('[发布失败] ' + $Text) -ForegroundColor Red
  exit 1
}

if (-not $Version) {
  $Version = (& node -e "console.log(require('./package.json').version)").Trim()
}
if (-not $CheckToken -and -not ($Version -match '^\d+\.\d+\.\d+$')) {
  Fail '版本号非法：' + $Version
}

# ---------------------------------------------------------- 取得 token
$cred = Get-GitHubToken -Explicit $Token
if (-not $cred) {
  Fail @'
未找到 GitHub token。请任选一种方式提供：
  1) 设置环境变量：$env:GITHUB_TOKEN = 'ghp_xxx'（或在系统中配置）；
  2) 用 Git Credential Manager 登录过 GitHub（凭据管理器里存有 github.com 凭据）；
  3) 显式传参：-Token ghp_xxx。
若 token 是 Fine-grained token（非 ghp_ 开头）且存在凭据管理器里，请用环境变量方式提供。
'@
}
$Token = $cred.Token
Write-Host ('[发布] 使用 token 来源：' + $cred.Source)

# ---------------------------------------------------------- 调用 node 发布器
$nodeArgs = @('tools/publish-release.js', '--repo', $Repo, '--token', $Token)
if ($CheckToken) {
  $nodeArgs += '--check-token'
} else {
  $exe = Join-Path $Root ('dist\npm-mirror-desktop-' + $Version + '.exe')
  if (-not (Test-Path -LiteralPath $exe)) {
    Fail ('找不到待发布产物：' + $exe + '（请先运行 tools/build-desktop.ps1）')
  }
  $sumFile = Join-Path $Root 'dist\SHA256SUMS.txt'
  $sha = ''
  if (Test-Path -LiteralPath $sumFile) {
    $line = Get-Content -LiteralPath $sumFile | Where-Object { $_ -match [regex]::Escape('npm-mirror-desktop-' + $Version + '.exe') } | Select-Object -First 1
    if ($line) { $sha = ($line -split '\s+')[0] }
  }
  if (-not $sha) { $sha = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() }

  if (-not $NotesFile) {
    $notesFile = Join-Path $Root ('tmp\release-notes-v' + $Version + '.md')
    New-Item -ItemType Directory -Force -Path (Split-Path $notesFile -Parent) | Out-Null
    $body = @(
      '## 离月私人 npm 镜像源 · 桌面版 v' + $Version,
      '',
      '单 exe 桌面版（内嵌 Node 运行时，无需安装 Node.js）：',
      '',
      '- Tauri 图形界面，内置现有网页版管理界面（概览 / 包管理 / 迁移备份 / 配置 / 日志 / 服务）',
      '- 新增「控制台」菜单，实时查看镜像源服务与一键脚本输出',
      '- 新增「工具」页：开机自启开关、启动/停止服务、环境自检、从 npm 缓存补包、一键导出/导入离线包等脚本一键运行',
      '- 托盘图标：单击打开窗口；右键打开/关闭窗口、重启镜像源服务、退出程序；网页版管理页面开启后显示「重启管理界面」',
      '- 关闭窗口默认仅隐藏窗口，进程与镜像源服务继续运行',
      '- 新增配置项：是否开启网页版管理页面（默认关闭）、主数据目录（默认 exe 同目录 data，可图形化选择）',
      '- 数据目录/存储目录相对路径解析增加路径穿越防护',
      '',
      '### 校验',
      '',
      '```',
      $sha + '  npm-mirror-desktop-' + $Version + '.exe',
      '```',
      '',
      '> 数据目录默认 `<exe 所在目录>/data`，可直接指向本仓库现有 data 目录以复用已有存储。'
    ) -join "`n"
    Set-Content -LiteralPath $notesFile -Value $body -Encoding utf8
    $NotesFile = $notesFile
    Write-Host ('[发布] 已生成 Release 说明：' + $notesFile)
  }

  $nodeArgs += @('--version', $Version, '--file', $exe)
  # 校验清单也作为附件一起发布（可重复 --file）
  $sumPath = Join-Path $Root 'dist\SHA256SUMS.txt'
  if (Test-Path -LiteralPath $sumPath) { $nodeArgs += @('--file', $sumPath) }
  if ($NotesFile) { $nodeArgs += @('--notes-file', $NotesFile) }
  if ($Draft) { $nodeArgs += '--draft' }
}

& node @nodeArgs
if ($LASTEXITCODE -ne 0) { Fail ('发布器失败（exit ' + $LASTEXITCODE + '）。') }
Write-Host '[发布成功]' -ForegroundColor Green
exit 0
