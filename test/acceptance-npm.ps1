# ============================================================
#  私人 npm 镜像源 —— 真实 npm 客户端验收脚本（Windows / PowerShell 7）
#  作用：用真正的 npm 命令走一遍完整生命周期，验证镜像源与 npm 客户端兼容。
#  用法：在项目目录执行  pwsh -NoProfile -File test\acceptance-npm.ps1
#  说明：脚本不会修改你的全局 npm 配置，所有操作都在临时目录里进行。
# ============================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$configFile = Join-Path $root 'data\config.json'

if (-not (Test-Path $configFile)) { Write-Host "[失败] 找不到配置文件 $configFile，请先执行 node cli.js init" -ForegroundColor Red; exit 1 }
$cfg = Get-Content -Raw -Encoding UTF8 $configFile | ConvertFrom-Json
$port = [int]$cfg.server.port
$token = $cfg.security.token
$base = "http://127.0.0.1:$port/"

$work = Join-Path $env:TEMP ("npm-mirror-acceptance-" + (Get-Date -Format 'HHmmss'))
$cache = Join-Path $work '_npmcache'
New-Item -ItemType Directory -Force -Path $work | Out-Null

$script:pass = 0; $script:fail = 0
function Check([string]$title, [bool]$ok, [string]$detail) {
  if ($ok) { Write-Host "  [通过] $title" -ForegroundColor Green; $script:pass++ }
  else { Write-Host "  [失败] $title  $detail" -ForegroundColor Red; $script:fail++ }
}
# 参数用空格分隔的单行字符串传入，避免 PowerShell 把数组展开成多个位置参数
# stdout / stderr 分开收集：stdout 用于解析 --json，stderr 用于判断 404 等错误信息；
# 并且在调用 npm 期间临时把 $ErrorActionPreference 降为 Continue——否则 PowerShell 7 会把
# 原生命令写入 stderr 的普通提示（npm notice）当成终止性错误，导致脚本中途退出。
function Invoke-Npm {
  param([string]$dir, [string]$argsLine)
  $argv = @($argsLine -split '\s+' | Where-Object { $_ })
  $errFile = Join-Path $work ('npm-stderr-' + [guid]::NewGuid().ToString('N') + '.log')
  Push-Location -LiteralPath $dir
  $oldPref = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    try {
      $out = & npm @argv 2>$errFile | Out-String
      $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $oldPref }
  }
  finally { Pop-Location }
  $errText = ''
  try {
    if (Test-Path -LiteralPath $errFile) {
      $errText = Get-Content -Raw -LiteralPath $errFile
      Remove-Item -Force -LiteralPath $errFile
    }
  } catch { }
  return @{ code = $code; out = $out; err = $errText }
}
function Write-Npmrc([string]$dir) {
  $lines = @(
    "registry=$base",
    "//127.0.0.1:$port/:_authToken=$token",
    "cache=$cache",
    'fund=false',
    'audit=false',
    'progress=false'
  )
  Set-Content -Encoding UTF8 -Path (Join-Path $dir '.npmrc') -Value $lines
}

Write-Host ""
Write-Host "私人 npm 镜像源 —— 真实 npm 客户端验收" -ForegroundColor Cyan
Write-Host "  镜像源地址 : $base"
Write-Host "  临时工作区 : $work"
Write-Host "  npm 缓存   : $cache （避免污染全局 npm 缓存）"
Write-Host ""

# ---------- 0. 服务在线 ----------
try {
  Invoke-RestMethod -Uri ($base + '-/ping') -TimeoutSec 5 | Out-Null
  Check '镜像源在线（/-/ping）' $true ''
} catch {
  Write-Host "[失败] 镜像源没有在运行，请先执行 node cli.js start --no-open" -ForegroundColor Red
  exit 1
}

# ---------- 临时工程 ----------
$proj = Join-Path $work 'consumer'
New-Item -ItemType Directory -Force -Path $proj | Out-Null
Write-Npmrc $proj

Write-Host "一、安装公共包（走镜像源回源并缓存）" -ForegroundColor Cyan
$r = Invoke-Npm $proj 'install ms@2.1.3 --no-audit --no-fund'
Check 'npm install ms@2.1.3' ($r.code -eq 0) $r.out
Check '安装产物存在（node_modules\ms\package.json）' (Test-Path (Join-Path $proj 'node_modules\ms\package.json')) ''

Write-Host "二、发布私有包（npm publish）" -ForegroundColor Cyan
$pub = Join-Path $work 'publisher'
New-Item -ItemType Directory -Force -Path $pub | Out-Null
Write-Npmrc $pub
$pkgName = 'acceptance-private-pkg'
@"
{
  "name": "$pkgName",
  "version": "1.0.0",
  "description": "由 acceptance-npm.ps1 发布，用于验收",
  "main": "index.js",
  "license": "MIT"
}
"@ | Set-Content -Encoding UTF8 (Join-Path $pub 'package.json')
'module.exports = "hello-from-private-mirror";' | Set-Content -Encoding UTF8 (Join-Path $pub 'index.js')
$r = Invoke-Npm $pub 'publish --tag beta'
Check 'npm publish --tag beta' ($r.code -eq 0) $r.out

$r = Invoke-Npm $pub "view $pkgName --json"
$view = $null
try { $view = $r.out | ConvertFrom-Json } catch { }
Check 'npm view 能读到包元数据' ($r.code -eq 0 -and $null -ne $view) $r.out
if ($view) {
  Check 'dist-tags 同时含 latest 与 beta' ($view.'dist-tags'.latest -eq '1.0.0' -and $view.'dist-tags'.beta -eq '1.0.0') ($view.'dist-tags' | ConvertTo-Json -Compress)
  Check 'packument 含 _rev（取消发布需要）' ([bool]$view._rev) ''
}

Write-Host "三、另一个工程安装私有包" -ForegroundColor Cyan
$proj2 = Join-Path $work 'consumer2'
New-Item -ItemType Directory -Force -Path $proj2 | Out-Null
Write-Npmrc $proj2
'{"name":"consumer2","version":"1.0.0"}' | Set-Content -Encoding UTF8 (Join-Path $proj2 'package.json')
$r = Invoke-Npm $proj2 "install $pkgName --no-audit --no-fund"
Check "npm install $pkgName" ($r.code -eq 0) $r.out
$probe = Join-Path $proj2 'probe.js'
"console.log(require('$pkgName'));" | Set-Content -Encoding UTF8 $probe
$loaded = & node $probe 2>&1 | Out-String
Check '安装后的包可正常 require' ($loaded.Trim() -eq 'hello-from-private-mirror') $loaded

Write-Host "四、dist-tag 增删查" -ForegroundColor Cyan
$r = Invoke-Npm $pub "dist-tag add $pkgName@1.0.0 stable"
Check 'npm dist-tag add' ($r.code -eq 0) $r.out
$r = Invoke-Npm $pub "dist-tag ls $pkgName"
Check 'npm dist-tag ls 含 stable' ($r.code -eq 0 -and $r.out -match 'stable') $r.out
$r = Invoke-Npm $pub "dist-tag rm $pkgName stable"
Check 'npm dist-tag rm' ($r.code -eq 0) $r.out

Write-Host "五、弃用标记（npm deprecate）" -ForegroundColor Cyan
$r = Invoke-Npm $pub "deprecate $pkgName@1.0.0 验收用弃用信息"
Check 'npm deprecate' ($r.code -eq 0) $r.out
$r = Invoke-Npm $pub "view $pkgName@1.0.0 deprecated"
Check 'npm view 回读到弃用信息' ($r.out -match '验收用弃用信息') $r.out

Write-Host "六、取消发布（npm unpublish --force）" -ForegroundColor Cyan
$r = Invoke-Npm $pub "unpublish $pkgName --force"
Check 'npm unpublish --force' ($r.code -eq 0) $r.out
$r = Invoke-Npm $pub "view $pkgName"
Check '取消发布后 npm view 返回 404' (($r.out -match '404') -or ($r.err -match '404')) ($r.out + $r.err)

Write-Host "七、离线模式（手工验证项）" -ForegroundColor Cyan
Write-Host "  把 data\config.json 的 mode 改成 offline 并重启服务后可验证：" -ForegroundColor DarkGray
Write-Host "    npm install ms@2.1.3   应成功（本地已缓存）" -ForegroundColor DarkGray
Write-Host "    npm install lodash     应报 404 并提示离线模式" -ForegroundColor DarkGray
Write-Host "  本脚本不自动切换模式，避免影响正在使用的镜像源。" -ForegroundColor DarkGray

Write-Host ""
Write-Host "验收结果：通过 $script:pass 项，失败 $script:fail 项" -ForegroundColor $(if ($script:fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "临时文件：$work（可手动删除）" -ForegroundColor DarkGray
exit $(if ($script:fail -eq 0) { 0 } else { 1 })
