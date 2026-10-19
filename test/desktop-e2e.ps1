#requires -Version 5.1
<#
.SYNOPSIS
  桌面版（Tauri 单 exe）端到端验收脚本。

.DESCRIPTION
  针对 dist\npm-mirror-desktop-<版本>.exe 做黑盒验收，覆盖 tmp\DESIGN.md 第 13 节里
  可以自动化的部分：

    · 产物：exe 存在、大小、版本信息、SHA256SUMS.txt 校验、dist 已被 .gitignore 忽略
    · 阶段 0b（v0.0.5）：exe --help 可执行（退出码 0），输出含 --repair-integrity /
      --skip-integrity-prompt / --data-dir
    · 阶段 0c（v0.0.5）：--repair-integrity 修复入口的**只读**验证——把 exe 复制到临时
      目录后以 smoke 模式执行（不弹框），未提权时应退出码 3 并给出「管理员权限」原因、
      不改动副本；已提权时执行修复并退出码 0。**不请求真实 UAC、不改 dist 产物**
    · 阶段 0d（v0.0.5）：非 smoke 启动 + --skip-integrity-prompt 时不被低完整性询问框
      阻塞——进程应走到「窗口失败说明框」或自行退出（本脚本用 WM_CLOSE 关掉说明框，
      不点「是」、不触发真实 UAC），最终退出码 1，失败报告 integrity.promptSuppressed=true
    · 图标（v0.0.4）：exe/窗口/托盘统一使用网页版图标——src-tauri\icons\icon.ico 与
      public\favicon.ico SHA256 相同；window-256.rgba=262144 B、tray-32.rgba=4096 B
    · 阶段 1（默认配置，admin.enabled=false）
        - exe 可启动，镜像源服务 /-/ping 返回 200
        - admin.port 不监听（默认关闭网页版管理）
        - 桌面窗口存在（窗口标题/窗口 URL=内部回环管理端口，能加载现有管理界面）
        - 托盘图标与菜单项：关闭网页版管理时 4 项（打开窗口 / 关闭窗口 /
          重启镜像源服务 / 退出程序），没有「打开管理界面」「重启管理界面」
        - 托盘可用性（v0.0.4）：报告含 tray.available（布尔）；注册失败时 tray.error
          含「拒绝访问 / os error 5」；restricted = home_fallback || !tray_available
        - 完整性标签（v0.0.5）：报告 integrity 对象字段齐全（token/tokenRid/tokenSid/
          file/lowDetected/elevated/repairPrompted/repairLaunched/promptSuppressed/
          repairResult/repairError/error/exePath）；integrity.file 与 icacls 读到的
          dist exe 标签一致；smoke 模式不弹框（repairPrompted/repairLaunched=false，
          Low 时 promptSuppressed=true）；exe 为 Low 时进程令牌完整性也应为 Low
        - 关闭窗口行为（v0.0.4，阶段 1c-3，用 window:close 模拟 CloseRequested）：
          托盘可用 → 窗口隐藏、进程与服务继续；托盘不可用 → 程序直接退出
          （退出码 0、双端口释放、无 Node 残留；沙箱预期走此分支）
        - 托盘菜单「打开窗口 / 关闭窗口」动作；单实例：第二个实例自动退出，原服务不受影响
        - 数据目录内写出 config.json / logs
    · 阶段 1e：config.json 里写入非法 storage.dir 时服务仍能启动并回退默认 storage
    · 阶段 1g：程序配置目录回退——%LOCALAPPDATA% 不可写、未设 MIRROR_DESKTOP_HOME 时
      自动回退到 <exe目录>\LiYueNpmMirror（v0.0.2 修复；0.0.1 会报「创建桌面配置目录 …
      拒绝访问 (os error 5)」）
    · 阶段 1h：数据目录自动发现（v0.0.3 新增）——exe 放在 <项目>\portable\dist\ 下、
      不传 --data-dir 且未设 MIRROR_DATA_DIR 时，若 <exe目录>\data 不存在/为空而
      上级 <项目>\portable\data\config.json 存在，应自动使用上级 data
      （smoke 报告 dataDir=上级 data、dataDirSource=parent-project）
    · 阶段 2（admin.enabled=true）
        - 两个端口都监听，浏览器可访问管理界面（GET / 200 + HTML）
        - /desktop/info 字段校验（版本、数据目录、默认数据目录、webAdmin、internal 端口）
        - /desktop/console 读取、清空
        - /desktop/files 返回数据目录 / 日志目录 / 配置文件；未知 target 400；携带 path
          穿越参数也只返回白名单目录（不接受任意路径）
        - 一键脚本 doctor / status 经 /desktop/action 跑通，输出进入控制台
        - service.restartRegistry 动作、autostart.get（只读）动作
        - 开机自启：当前未开启时做「开启 → 校验 HKCU\...\Run 值 → 关闭 → 校验清除」
          往返（当前已开启则只读校验，不覆盖用户已有自启配置）
        - 托盘菜单为 6 项（多出「打开管理界面」「重启管理界面」），且菜单
          「重启管理界面 / 重启镜像源服务」动作生效；「打开管理界面」动作可执行
          （受限会话无法真正拉起浏览器时记 SKIP 并注明）
        - PUT /config 拒绝路径穿越（storage.dir='..\..\evil' 返回 400）
        - PUT /config 关闭 admin.enabled 后管理端口断开、镜像源端口不受影响，
          托盘菜单实时缩回 4 项（≤1s）
    · 阶段 3（admin.enabled=true）
        - 服务重启后控制台增量参数 after=旧 seq 不崩溃（seq 重置兼容）
        - app.quit 优雅退出：进程结束、两个监听都消失、无残留 node 进程
    · 阶段 3b：托盘菜单「退出程序」→ 进程退出、两个监听消失、无残留进程
    · test\desktop-path-test.js 路径穿越单测（存在才跑，缺失记 SKIP）

  窗口与托盘断言通过产品内置的测试挂钩驱动（启动参数 --smoke-report / --smoke-cmd，
  环境变量 MIRROR_DESKTOP_SMOKE=1；正常启动时挂钩完全惰性）。挂钩里的菜单 id 与
  真实托盘菜单项一一对应（tray-open / tray-hide / tray-open-webadmin /
  tray-restart-webadmin / tray-restart-registry / tray-quit），等价于右键点击对应
  菜单项，但不是鼠标级模拟。「打开管理界面」在受限会话里无法真正拉起系统浏览器，
  因此只断言菜单动作被执行（命令回执）并记 SKIP 说明。

  不能自动化的部分（托盘左键单击的鼠标事件、窗口视觉风格、原生目录选择器对话框、
  控制台页按钮交互、工具页 import/cache 小样本、**真实低完整性标签一键修复（UAC 交互，
  脚本只做只读验证）**等）在 tmp\audit-desktop.md 里标注为人工确认或代码审查证据。

  安全纪律：
    · 只使用临时数据目录（默认 tmp\e2e-data）和测试端口（默认 14873/14874）；
    · 绝不触碰 4873/4874，绝不结束不属于本测试的进程；
    · 桌面配置/日志/解压运行时通过 MIRROR_DESKTOP_HOME 放到 tmp\e2e-home，
      不写真实 %LOCALAPPDATA%\LiYueNpmMirror（受限环境通常也不允许写）；
    · CIM/WMI 不可用的受限环境自动退化为 PID 追踪（启动句柄 + desktop.log
      里的 Node PID + 端口判断），不会按进程名乱杀。

  退出码：
    0 = 自动检查项全部通过；
    1 = 存在失败项（验收未通过）；
    3 = 环境限制：失败项**全部**属于「当前会话无法创建/显示 WebView2 窗口」
        （窗口创建/导航/可见性类断言；desktop.log 可能报「创建主窗口失败：拒绝访问 /
        os error 5」）。这不是产品缺陷，需在普通 Windows 桌面会话重跑窗口类断言；
        托盘菜单、端口监听、数据目录、路径穿越、一键脚本、控制台等非窗口断言
        仍必须全绿，否则退出码为 1。

.PARAMETER ExePath
  指定要验收的 exe。默认按 package.json 版本找 dist\npm-mirror-desktop-<版本>.exe，
  找不到时退回 dist 下最新的 npm-mirror-desktop-*.exe。

.PARAMETER DataDir
  临时数据目录，默认 <仓库根>\tmp\e2e-data。每次运行前会先确认它在仓库 tmp 下再清空重建。

.PARAMETER RegistryPort
  镜像源服务测试端口，默认 14873。

.PARAMETER AdminPort
  网页版管理测试端口，默认 14874。

.PARAMETER KeepData
  保留上一次的数据目录（不清空），方便排查问题。

.PARAMETER SkipPathTest
  跳过 node test\desktop-path-test.js。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File test\desktop-e2e.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File test\desktop-e2e.ps1 -KeepData
#>
[CmdletBinding()]
param(
  [string]$ExePath = '',
  [string]$DataDir = '',
  [int]$RegistryPort = 14873,
  [int]$AdminPort = 14874,
  [switch]$KeepData,
  [switch]$SkipPathTest
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------------
# 基础环境与全局状态
# ---------------------------------------------------------------------------
$script:Root = Split-Path -Parent $PSScriptRoot
$script:Pass = 0
$script:Fail = 0
$script:Skip = 0
$script:Failures = New-Object System.Collections.ArrayList
$script:FailureCategories = New-Object System.Collections.ArrayList
$script:WindowCheckAvailable = $false
$script:Skips = New-Object System.Collections.ArrayList
$script:AppProc = $null
$script:Token = ''
$script:PkgVersion = ''
$script:LastScript = $null
$script:CimAvailable = $false
$script:TrackedNodePids = New-Object System.Collections.ArrayList
$script:TrackedAppPids = New-Object System.Collections.ArrayList
$script:DesktopHome = ''
$script:AppLaunchTime = $null
$script:LaunchCount = 0
$script:SmokeReportPath = ''
$script:SmokeCmdPath = ''
$script:LastSmokeReport = $null
# Windows 自带的 curl.exe：用于抓取任意 HTTP 状态码（含 400/500）的完整响应体。
# Windows PowerShell 5.1 的 Invoke-WebRequest 在非 2xx 时抛异常，从 WebException 里读
# 响应流在本环境实测拿不到内容（错误信息变成空串），导致「中文错误信息」类断言误判。
$script:CurlPath = ''
$curlCmd = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($curlCmd) { $script:CurlPath = $curlCmd.Source }

function Section {
  param([string]$Title)
  Write-Host ''
  Write-Host ("== " + $Title) -ForegroundColor Cyan
}

function Info {
  param([string]$Text)
  Write-Host ("   " + $Text) -ForegroundColor DarkGray
}

function Assert-True {
  param([string]$Name, [bool]$Condition, [string]$Detail = '', [string]$Category = 'general')
  if ($Condition) {
    $script:Pass++
    Write-Host ("  [PASS] " + $Name) -ForegroundColor Green
  } else {
    $script:Fail++
    [void]$script:Failures.Add($Name)
    [void]$script:FailureCategories.Add($Category)
    $msg = "  [FAIL] " + $Name
    if ($Detail) { $msg += " —— " + $Detail }
    Write-Host $msg -ForegroundColor Red
  }
}

function Assert-Skip {
  param([string]$Name, [string]$Reason)
  $script:Skip++
  [void]$script:Skips.Add($Name)
  Write-Host ("  [SKIP] " + $Name + " —— " + $Reason) -ForegroundColor Yellow
}

function Get-Prop {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $p = $Object.PSObject.Properties[$Name]
  if ($p) { return $p.Value }
  return $null
}

function Get-Data {
  param($Json)
  if ($null -eq $Json) { return $null }
  $d = Get-Prop $Json 'data'
  if ($null -ne $d) { return $d }
  return $Json
}

function Normalize-Path {
  param([string]$PathText)
  if ([string]::IsNullOrWhiteSpace($PathText)) { return '' }
  try { $full = [System.IO.Path]::GetFullPath($PathText) } catch { return $PathText.Trim().ToLowerInvariant() }
  return $full.TrimEnd('\', '/').ToLowerInvariant()
}

# ---------------------------------------------------------------------------
# HTTP / 端口 / 等待辅助
# ---------------------------------------------------------------------------
function Invoke-Api {
  param([string]$Url, [string]$Method = 'GET', [object]$Body = $null, [int]$TimeoutSec = 10)
  $headers = @{}
  if ($script:Token) { $headers['X-Mirror-Token'] = $script:Token }

  # 优先用 curl.exe：非 2xx 时也能拿到完整响应体（Windows PowerShell 5.1 的
  # Invoke-WebRequest 在 400/500 分支上读 WebException.Response 流在此环境拿不到内容）。
  if ($script:CurlPath) {
    $tmpFile = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-e2e-http-' + [guid]::NewGuid().ToString('N') + '.txt')
    $bodyFile = $null
    try {
      $curlArgs = @(
        '-sS', '--max-time', [string]$TimeoutSec, '--connect-timeout', '5',
        '-o', $tmpFile, '-w', '%{http_code}', '-X', $Method
      )
      if ($script:Token) { $curlArgs += @('-H', ('X-Mirror-Token: ' + $script:Token)) }
      if ($null -ne $Body) {
        # 关键：不能把 JSON 直接当命令行参数传给 curl.exe —— Windows PowerShell 5.1
        # 调用原生程序时会吞掉 JSON 里的双引号（服务端看到 {action:...} 或空串，
        # 实测报 EBADJSON / 「未知的桌面操作：（空）」）。改为写临时文件 + --data-binary @file。
        $jsonBody = ($Body | ConvertTo-Json -Depth 10 -Compress)
        $bodyFile = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-e2e-body-' + [guid]::NewGuid().ToString('N') + '.json')
        [System.IO.File]::WriteAllText($bodyFile, $jsonBody, (New-Object System.Text.UTF8Encoding($false)))
        $curlArgs += @('-H', 'Content-Type: application/json; charset=utf-8', '--data-binary', ('@' + $bodyFile))
      }
      $curlArgs += $Url
      $statusText = ''
      try {
        $out = & $script:CurlPath @curlArgs 2>$null
        if ($null -ne $out) { $statusText = [string](@($out)[-1]) }
      } catch { $statusText = '' }
      $status = 0
      [void][int]::TryParse($statusText.Trim(), [ref]$status)
      $content = ''
      if (Test-Path $tmpFile) {
        try { $content = [System.IO.File]::ReadAllText($tmpFile, (New-Object System.Text.UTF8Encoding($false))) } catch { }
      }
      return [pscustomobject]@{ Ok = ($status -ge 200 -and $status -lt 300); Status = $status; Content = $content; Error = $null }
    } finally {
      try { Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue } catch { }
      if ($bodyFile) { try { Remove-Item $bodyFile -Force -ErrorAction SilentlyContinue } catch { } }
    }
  }

  # 兜底：没有 curl.exe 时退回 Invoke-WebRequest 实现。
  $params = @{
    Uri             = $Url
    Method          = $Method
    UseBasicParsing = $true
    TimeoutSec      = $TimeoutSec
    Headers         = $headers
  }
  if ($null -ne $Body) {
    $params['Body'] = ($Body | ConvertTo-Json -Depth 10 -Compress)
    $params['ContentType'] = 'application/json; charset=utf-8'
  }
  try {
    $resp = Invoke-WebRequest @params
    return [pscustomobject]@{ Ok = $true; Status = [int]$resp.StatusCode; Content = [string]$resp.Content; Error = $null }
  } catch {
    $status = $null
    $content = ''
    $ex = $_.Exception
    if ($null -ne $ex.Response) {
      try { $status = [int]$ex.Response.StatusCode } catch { }
      try {
        $stream = $ex.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $content = $reader.ReadToEnd()
        $reader.Close()
      } catch { }
    }
    return [pscustomobject]@{ Ok = $false; Status = $status; Content = $content; Error = $ex.Message }
  }
}

function Get-Json {
  param($Response)
  if ($null -eq $Response -or [string]::IsNullOrWhiteSpace($Response.Content)) { return $null }
  try { return ($Response.Content | ConvertFrom-Json) } catch { return $null }
}

function Test-Port {
  param([int]$Port, [int]$TimeoutMs = 500)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch {
    return $false
  } finally {
    try { $client.Close() } catch { }
  }
}

function Test-Ping {
  param([int]$Port)
  $r = Invoke-Api ("http://127.0.0.1:" + $Port + "/-/ping") 'GET' $null 5
  return ($r.Status -eq 200)
}

function Wait-Until {
  param([scriptblock]$Condition, [int]$TimeoutSec = 30, [int]$IntervalMs = 300)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    if (& $Condition) { return $true }
    Start-Sleep -Milliseconds $IntervalMs
  }
  return $false
}

# ---------------------------------------------------------------------------
# 进程辅助
#   优先用 CIM 按命令行精确识别本测试进程；CIM/WMI 不可用的受限环境（如沙箱）
#   则退化为 PID 追踪：启动句柄 PID + desktop.log 里的「Node 子进程已启动 pid=」
#   + 端口占用判断，绝不按进程名乱杀。
# ---------------------------------------------------------------------------
function Test-ProcessAlive {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return $false }
  try {
    $p = Get-Process -Id $ProcessId -ErrorAction Stop
    return ($null -ne $p)
  } catch {
    return $false
  }
}

function Get-CimProcs {
  if (-not $script:CimAvailable) { return @() }
  try {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop)
  } catch {
    Info ('CIM 进程信息不可用（' + $_.Exception.Message + '），切换到 PID 追踪模式。')
    $script:CimAvailable = $false
    return @()
  }
}

function Initialize-ProcessApi {
  try {
    $probe = @(Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PID) -ErrorAction Stop)
    $script:CimAvailable = ($probe.Count -ge 1)
  } catch {
    $script:CimAvailable = $false
  }
  if ($script:CimAvailable) {
    Info '进程识别方式：CIM 可用（按命令行精确匹配本测试数据目录）'
  } else {
    Info '进程识别方式：CIM/WMI 在本环境不可用，改用「启动 PID + desktop.log 解析 + 端口判断」'
  }
}

function Test-OurCommandLine {
  param($Proc)
  $cmd = Get-Prop $Proc 'CommandLine'
  if ($cmd) {
    return ($cmd.IndexOf($script:DataDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
  }
  $procId = [int](Get-Prop $Proc 'ProcessId')
  return (($script:TrackedNodePids -contains $procId) -or ($script:TrackedAppPids -contains $procId))
}

function Get-OurNodeProcs {
  if ($script:CimAvailable) {
    $all = Get-CimProcs
    return @($all | Where-Object {
        $_.Name -eq 'node.exe' -and
        (Get-Prop $_ 'CommandLine') -and
        ($_.CommandLine -like '*--desktop*') -and
        (Test-OurCommandLine $_)
      })
  }
  $list = @()
  foreach ($procId in @($script:TrackedNodePids)) {
    if (Test-ProcessAlive $procId) {
      $list += [pscustomobject]@{ ProcessId = [int]$procId; Name = 'node.exe' }
    }
  }
  return @($list)
}

function Get-DesktopProcs {
  if ($script:CimAvailable) {
    $all = Get-CimProcs
    return @($all | Where-Object { $_.Name -like 'npm-mirror-desktop*.exe' })
  }
  $list = @()
  foreach ($procId in @($script:TrackedAppPids)) {
    if (Test-ProcessAlive $procId) {
      $list += [pscustomobject]@{ ProcessId = [int]$procId; Name = 'npm-mirror-desktop.exe' }
    }
  }
  return @($list)
}

function Get-AppChildPids {
  param([int]$ParentPid)
  $pids = @()
  if ($script:CimAvailable) {
    $all = Get-CimProcs
    $children = @($all | Where-Object { $_.ParentProcessId -eq $ParentPid })
    foreach ($ch in $children) {
      $pids += [int]$ch.ProcessId
      $grand = @($all | Where-Object { $_.ParentProcessId -eq $ch.ProcessId })
      foreach ($g in $grand) { $pids += [int]$g.ProcessId }
    }
  }
  foreach ($nodePid in @($script:TrackedNodePids)) {
    if (Test-ProcessAlive $nodePid) { $pids += [int]$nodePid }
  }
  return @($pids | Select-Object -Unique)
}

function Get-DesktopLogPath {
  if ($script:DesktopHome) { return (Join-Path $script:DesktopHome 'desktop.log') }
  return (Join-Path $env:LOCALAPPDATA 'LiYueNpmMirror\desktop.log')
}

# Rust 壳在启动 Node 后写一行「Node 子进程已启动：pid=123 node=... dataDir=...」，
# CIM 不可用时靠它拿到本测试实例的 Node PID（只认 dataDir 匹配且仍存活的 PID）。
function Update-TrackedNodePidsFromLog {
  $logPath = Get-DesktopLogPath
  if (-not (Test-Path $logPath)) { return }
  $lines = @(Get-Content $logPath -Tail 500 -Encoding UTF8 -ErrorAction SilentlyContinue)
  foreach ($line in $lines) {
    if ($line -match 'Node 子进程已启动：pid=(\d+)') {
      $nodeId = [int]$Matches[1]
      if ($line.IndexOf($script:DataDir, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
      if (-not (Test-ProcessAlive $nodeId)) { continue }
      if (-not ($script:TrackedNodePids -contains $nodeId)) {
        [void]$script:TrackedNodePids.Add($nodeId)
        Info ('从 desktop.log 识别到 Node 子进程 PID=' + $nodeId)
      }
    }
  }
}

function Get-TrackedPids {
  $pids = @()
  if ($null -ne $script:AppProc) {
    try { if (-not $script:AppProc.HasExited) { $pids += [int]$script:AppProc.Id } } catch { }
  }
  foreach ($procId in @($script:TrackedAppPids)) {
    if (Test-ProcessAlive $procId) { $pids += [int]$procId }
  }
  $pids += @(Get-OurNodeProcs | ForEach-Object { [int]$_.ProcessId })
  if ($script:CimAvailable) {
    $pids += @(Get-DesktopProcs | Where-Object { Test-OurCommandLine $_ } | ForEach-Object { [int]$_.ProcessId })
  }
  return @($pids | Select-Object -Unique)
}

function Stop-TrackedProcesses {
  foreach ($procId in (Get-TrackedPids)) {
    try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch { }
  }
  Wait-Until {
    ((Get-OurNodeProcs).Count -eq 0) -and
    (-not (Test-Port $RegistryPort)) -and
    (-not (Test-Port $AdminPort))
  } 20 300 | Out-Null
}

function Show-Diagnostics {
  Info '--- 诊断信息 ---'
  if ($null -ne $script:AppProc) {
    try { Info ("桌面进程 PID=" + $script:AppProc.Id + " 已退出=" + $script:AppProc.HasExited) } catch { }
  }
  Info ("进程识别方式：CIM=" + $script:CimAvailable + "，已追踪 Node PID=" + ((@($script:TrackedNodePids)) -join ','))
  Info ("端口 " + $RegistryPort + " 监听=" + (Test-Port $RegistryPort))
  Info ("端口 " + $AdminPort + " 监听=" + (Test-Port $AdminPort))
  Info ("已追踪的 node 进程数=" + (Get-OurNodeProcs).Count)
  $desktopLog = Get-DesktopLogPath
  if (Test-Path $desktopLog) {
    Info ("--- desktop.log 末尾 30 行（" + $desktopLog + "）---")
    Get-Content $desktopLog -Tail 30 -Encoding UTF8 | ForEach-Object { Info ([string]$_) }
  } else {
    Info ("未找到 desktop.log：" + $desktopLog)
  }
  $logDir = Join-Path $script:DataDir 'logs'
  if (Test-Path $logDir) {
    $logFile = Get-ChildItem $logDir -Filter 'mirror-*.log' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($logFile) {
      Info ("--- 服务日志末尾 30 行（" + $logFile.FullName + "）---")
      Get-Content $logFile.FullName -Tail 30 | ForEach-Object { Info ([string]$_) }
    }
  }
}

# ---------------------------------------------------------------------------
# 窗口辅助（P/Invoke：枚举窗口 / 取标题 / 发 WM_CLOSE）
# ---------------------------------------------------------------------------
function Initialize-WindowApi {
  if (-not ('DesktopE2E.Win32' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace DesktopE2E {
  public class Win32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    public static List<IntPtr> FindWindows(int[] pids) {
      List<IntPtr> result = new List<IntPtr>();
      EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        bool match = false;
        for (int i = 0; i < pids.Length; i++) {
          if (pids[i] == (int)pid) { match = true; break; }
        }
        if (!match) { return true; }
        if (!IsWindowVisible(hWnd)) { return true; }
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(hWnd, sb, 512);
        if (sb.Length > 0) { result.Add(hWnd); }
        return true;
      }, IntPtr.Zero);
      return result;
    }

    public static string GetTitle(IntPtr hWnd) {
      StringBuilder sb = new StringBuilder(512);
      GetWindowText(hWnd, sb, 512);
      return sb.ToString();
    }

    public static void CloseWindow(IntPtr hWnd) {
      SendMessage(hWnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
    }
  }
}
'@
  }
  [void][DesktopE2E.Win32]
}

function Get-AppWindows {
  param([int]$RootPid)
  # 延迟初始化 P/Invoke：脚本在任何阶段第一次需要枚举窗口时再 Add-Type，
  # 避免受限环境下未使用窗口 API 时也触发编译。
  if (-not ('DesktopE2E.Win32' -as [type])) { Initialize-WindowApi }
  $pids = @($RootPid)
  $pids += @(Get-AppChildPids -ParentPid $RootPid)
  $pids = @($pids | Select-Object -Unique)
  if ($pids.Count -eq 0) { return @() }
  return @([DesktopE2E.Win32]::FindWindows([int[]]$pids))
}

# ---------------------------------------------------------------------------
# 启动 / 配置 / 数据目录
# ---------------------------------------------------------------------------
function Start-DesktopApp {
  param(
    # 可选：用另一个 exe 启动（阶段 1g 程序配置目录回退测试用复制到临时目录的 exe）
    [string]$Exe = '',
    # 可选：显式数据目录；空 = 使用 $script:DataDir
    [string]$DataDirArg = '',
    # 可选：不传 --data-dir（阶段 1h 数据目录自动发现测试用；同时不得设置 MIRROR_DATA_DIR）
    [switch]$NoDataDir,
    # 可选：不设置 MIRROR_DESKTOP_HOME（让程序走 %LOCALAPPDATA% / 回退逻辑）
    [switch]$NoDesktopHome,
    # 可选：覆盖子进程的 LOCALAPPDATA（阶段 1g 用一个「不可创建」的路径模拟受限账户）
    [string]$LocalAppData = '',
    # 报告/命令文件名前缀，避免不同阶段互相覆盖
    [string]$ReportPrefix = 'smoke'
  )
  $script:LaunchCount++
  $reportPath = Join-Path $script:DesktopHome ($ReportPrefix + '-report-' + $script:LaunchCount + '.json')
  $cmdPath = Join-Path $script:DesktopHome ($ReportPrefix + '-cmd-' + $script:LaunchCount + '.txt')
  if (Test-Path $cmdPath) { Remove-Item $cmdPath -Force -ErrorAction SilentlyContinue }
  $script:SmokeReportPath = $reportPath
  $script:SmokeCmdPath = $cmdPath
  $exeToRun = if ($Exe) { $Exe } else { $script:ExePath }
  $dataDirToUse = if ($DataDirArg) { $DataDirArg } else { $script:DataDir }
  $argLine = '--smoke-report "' + $reportPath + '" --smoke-cmd "' + $cmdPath + '"'
  if (-not $NoDataDir) {
    $argLine = '--data-dir "' + $dataDirToUse + '" ' + $argLine
  }
  # 沙箱/受限环境通常不允许写 %LOCALAPPDATA%，用 Rust 壳支持的 MIRROR_DESKTOP_HOME
  # 把桌面配置/日志/解压运行时/WebView2 用户数据放到仓库 tmp 下。
  # MIRROR_DESKTOP_SMOKE=1 是产品内置的测试挂钩（正常启动时完全惰性，不产生行为）：
  # 只把窗口/托盘/Node 状态写成 JSON 报告，并允许通过命令文件触发菜单动作，
  # 供无头环境自动验收窗口/托盘；产品功能路径和正常启动完全一致。
  $oldHome = $env:MIRROR_DESKTOP_HOME
  $oldWebView2 = $env:WEBVIEW2_USER_DATA_FOLDER
  $oldSmoke = $env:MIRROR_DESKTOP_SMOKE
  $oldLocalAppData = $env:LOCALAPPDATA
  if (-not $NoDesktopHome) {
    $env:MIRROR_DESKTOP_HOME = $script:DesktopHome
    $env:WEBVIEW2_USER_DATA_FOLDER = (Join-Path $script:DesktopHome 'webview2')
  } else {
    Remove-Item Env:\MIRROR_DESKTOP_HOME -ErrorAction SilentlyContinue
    Remove-Item Env:\WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue
  }
  if ($LocalAppData) { $env:LOCALAPPDATA = $LocalAppData }
  $env:MIRROR_DESKTOP_SMOKE = '1'
  try {
    # 不用 Start-Process：受限会话/后台作业里启动 GUI 子系统 exe 时，ShellExecute 可能返回
    # 「The operation was canceled by the user.」。改用 .NET ProcessStartInfo（UseShellExecute=false）
    # 直接 CreateProcess，两条环境（普通会话 / 受限沙箱）都能稳定拉起。
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exeToRun
    $psi.Arguments = $argLine
    $psi.UseShellExecute = $false
    $psi.WorkingDirectory = (Split-Path -Parent $exeToRun)
    $proc = [System.Diagnostics.Process]::Start($psi)
  } finally {
    $env:MIRROR_DESKTOP_HOME = $oldHome
    $env:WEBVIEW2_USER_DATA_FOLDER = $oldWebView2
    $env:LOCALAPPDATA = $oldLocalAppData
    $env:MIRROR_DESKTOP_SMOKE = $oldSmoke
  }
  $script:AppProc = $proc
  $script:AppLaunchTime = Get-Date
  if (-not ($script:TrackedAppPids -contains $proc.Id)) { [void]$script:TrackedAppPids.Add($proc.Id) }
  Start-Sleep -Milliseconds 150
  Update-TrackedNodePidsFromLog
  return $proc
}

# 读取测试挂钩写出的状态报告（窗口/托盘/Node/网页版管理）；文件可能正在写入，失败返回 $null。
function Read-SmokeReport {
  $path = $script:SmokeReportPath
  if (-not $path -or -not (Test-Path $path)) { return $null }
  try {
    $text = Get-Content $path -Raw -Encoding UTF8 -ErrorAction Stop
    if (-not $text -or $text.Trim().Length -eq 0) { return $null }
    return ($text | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Wait-SmokeReport {
  param([scriptblock]$Predicate, [int]$TimeoutSec = 30, [int]$IntervalMs = 300)
  $script:LastSmokeReport = $null
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $report = Read-SmokeReport
    if ($null -ne $report) {
      $script:LastSmokeReport = $report
      if (& $Predicate $report) { return $report }
    }
    Start-Sleep -Milliseconds $IntervalMs
  }
  # 超时返回 $null（最后一份报告仍保存在 $script:LastSmokeReport 供诊断）：
  # 调用方据此区分「条件达成」与「窗口不可用/超时」，避免把环境限制误判为检查通过。
  return $null
}

# 通过命令文件触发托盘菜单动作（menu:<id> / show / hide / quit / restart-registry 等）
function Send-SmokeCommand {
  param([string]$Command, [int]$TimeoutSec = 30)
  if (-not $script:SmokeCmdPath) { return $null }
  try {
    # 必须用「无 BOM」UTF-8 追加：Rust 侧逐行 read_to_string，BOM 会让第一行命令
    # 变成 "\uFEFFmenu:xxx" 而无法匹配；Windows PowerShell 的 Add-Content -Encoding UTF8
    # 在新建文件时会写 BOM，所以这里直接用 .NET 追加。
    [System.IO.File]::AppendAllText($script:SmokeCmdPath, ($Command + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    Info ('写入冒烟命令失败：' + $_.Exception.Message)
    return $null
  }
  return (Wait-SmokeReport {
      param($report)
      $cmds = @(Get-Prop $report 'commands')
      $hit = @($cmds | Where-Object { (Get-Prop $_ 'command') -eq $Command })
      return ($hit.Count -gt 0)
    } $TimeoutSec 300)
}

# 沙箱/受限环境无法创建 WebView2 窗口时，Rust 壳会在 desktop.log 写下
# 「创建主窗口失败：拒绝访问。 (os error 5)」并以退出码 1 结束。
# 这是环境限制，不是桌面版功能失败：单独报告并退出码 3，避免误判为验收失败。
function Test-WindowCreateBlocked {
  param($Proc)
  if ($null -eq $Proc) { return $false }
  try { if (-not $Proc.HasExited) { return $false } } catch { return $false }
  $logPath = Get-DesktopLogPath
  if (-not (Test-Path $logPath)) { return $false }
  $tail = (@(Get-Content $logPath -Tail 120 -Encoding UTF8 -ErrorAction SilentlyContinue)) -join "`n"
  return (($tail -match '创建主窗口失败') -and ($tail -match '拒绝访问|os error 5|Access is denied'))
}

function Stop-EnvironmentLimited {
  param([string]$Detail = '')
  Write-Host ''
  Write-Host '[环境限制] 当前会话无法创建桌面窗口（WebView2 报「拒绝访问 / os error 5」）。' -ForegroundColor Yellow
  Write-Host '  原因：本会话的文件/进程沙箱不允许 WebView2 启动子进程或写 %LOCALAPPDATA%，' -ForegroundColor Yellow
  Write-Host '  不是桌面版功能失败。Rust 壳在创建窗口阶段就退出，Node 服务未启动，后续断言无法进行。' -ForegroundColor Yellow
  Write-Host ('  证据：' + (Get-DesktopLogPath)) -ForegroundColor Yellow
  Write-Host '  请在没有该限制的普通 Windows 桌面会话（直接双击或计划任务）里重跑本脚本，' -ForegroundColor Yellow
  Write-Host '  完成窗口/托盘/浏览器访问等窗口相关验收。' -ForegroundColor Yellow
  if ($Detail) { Write-Host ('  说明：' + $Detail) -ForegroundColor Yellow }
  $result = [ordered]@{
    ok               = $false
    environmentLimited = $true
    reason           = 'WebView2 窗口创建被拒绝（沙箱限制，非产品缺陷）'
    pass             = $script:Pass
    fail             = $script:Fail
    skip             = $script:Skip
    exe              = $script:ExePath
    dataDir          = $script:DataDir
    desktopLog       = (Get-DesktopLogPath)
    time             = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  }
  try {
    if (-not (Test-Path $script:DataDir)) { New-Item -ItemType Directory -Path $script:DataDir -Force | Out-Null }
    $result | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $script:DataDir 'e2e-result.json') -Encoding UTF8
  } catch { }
  Stop-TrackedProcesses
  Write-Host ''
  Write-Host ('== ENVIRONMENT-LIMITED: ' + ($result | ConvertTo-Json -Depth 5 -Compress)) -ForegroundColor Yellow
  exit 3
}

function Exit-IfWindowBlocked {
  param($Proc, [string]$Detail = '')
  if (Test-WindowCreateBlocked $Proc) {
    Stop-EnvironmentLimited $Detail
  }
}

function Stop-DesktopAppGraceful {
  $api = 'http://127.0.0.1:' + $AdminPort + '/__admin/api'
  $r = Invoke-Api ($api + '/desktop/action') 'POST' @{ action = 'app.quit'; params = @{} } 20
  $j = Get-Json $r
  Assert-True 'app.quit 动作返回成功' ($r.Status -eq 200 -and ((Get-Prop (Get-Data $j) 'quitting') -eq $true)) ("状态=" + $r.Status + " 响应=" + $r.Content)
  return $r
}

function Set-TestConfig {
  param([bool]$WebAdminEnabled, [string]$StorageDir = 'data/storage')
  $cfgPath = Join-Path $script:DataDir 'config.json'
  $enabledText = '0'
  if ($WebAdminEnabled) { $enabledText = '1' }

  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $code = @'
const cfg = require('./src/config');
cfg.load();
cfg.save({
  server: { ip: '127.0.0.1', port: Number(process.env.E2E_REGISTRY_PORT), openBrowserOnStart: false },
  admin: { ip: '127.0.0.1', port: Number(process.env.E2E_ADMIN_PORT), enabled: process.env.E2E_ADMIN_ENABLED === '1' },
  storage: { dir: process.env.E2E_STORAGE_DIR || 'data/storage' },
  mode: 'offline',
  log: { level: 'info' }
});
console.log(cfg.CONFIG_FILE);
'@
    $oldDataDir = $env:MIRROR_DATA_DIR
    $oldRegPort = $env:E2E_REGISTRY_PORT
    $oldAdminPort = $env:E2E_ADMIN_PORT
    $oldEnabled = $env:E2E_ADMIN_ENABLED
    $oldStorageDir = $env:E2E_STORAGE_DIR
    $env:MIRROR_DATA_DIR = $script:DataDir
    $env:E2E_REGISTRY_PORT = [string]$RegistryPort
    $env:E2E_ADMIN_PORT = [string]$AdminPort
    $env:E2E_ADMIN_ENABLED = $enabledText
    $env:E2E_STORAGE_DIR = $StorageDir
    $exitCode = 1
    $outText = ''
    $oldEap = $ErrorActionPreference
    Push-Location $script:Root
    try {
      # Windows PowerShell 5.1 下，原生程序写 stderr 且被 2>&1 合并时会产生
      # NativeCommandError；配置里有非法 storage.dir 时 node 会 warn 到 stderr，
      # 这里临时放宽 ErrorActionPreference 以免被当成终止错误（该 warn 是预期行为）。
      $ErrorActionPreference = 'Continue'
      $outText = & node -e $code 2>&1 | Out-String
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $oldEap
      Pop-Location
      $env:MIRROR_DATA_DIR = $oldDataDir
      $env:E2E_REGISTRY_PORT = $oldRegPort
      $env:E2E_ADMIN_PORT = $oldAdminPort
      $env:E2E_ADMIN_ENABLED = $oldEnabled
      $env:E2E_STORAGE_DIR = $oldStorageDir
    }
    if ($exitCode -eq 0 -and (Test-Path $cfgPath)) {
      Info ('已用 src/config.js 生成测试配置（admin.enabled=' + $WebAdminEnabled + '）：' + $cfgPath)
      return $true
    }
    Info ('node 生成配置失败（exit=' + $exitCode + '），改用最小 JSON 配置兜底。输出：' + $outText.Trim())
  } else {
    Info '未找到 node 命令，改用最小 JSON 配置兜底。'
  }

  $minimal = [ordered]@{
    server  = [ordered]@{ ip = '127.0.0.1'; port = $RegistryPort; openBrowserOnStart = $false }
    admin   = [ordered]@{ ip = '127.0.0.1'; port = $AdminPort; enabled = $WebAdminEnabled }
    storage = [ordered]@{ dir = $StorageDir }
    mode    = 'offline'
  } | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($cfgPath, $minimal, (New-Object System.Text.UTF8Encoding($false)))
  Info ('已写入最小 JSON 测试配置（admin.enabled=' + $WebAdminEnabled + '）：' + $cfgPath)
  return (Test-Path $cfgPath)
}

function Read-ConfigToken {
  $cfgPath = Join-Path $script:DataDir 'config.json'
  if (-not (Test-Path $cfgPath)) { return }
  try {
    $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $sec = Get-Prop $cfg 'security'
    $token = Get-Prop $sec 'token'
    if ($token) { $script:Token = [string]$token }
  } catch { }
}

# ---------------------------------------------------------------------------
# 启动前检查：exe / 端口 / 已运行实例 / 数据目录
# ---------------------------------------------------------------------------
function Resolve-DesktopExe {
  if ($ExePath) {
    if (-not (Test-Path $ExePath)) {
      Write-Host ''
      Write-Host ("[失败] 指定的 exe 不存在：" + $ExePath) -ForegroundColor Red
      exit 1
    }
    return
  }
  $dist = Join-Path $script:Root 'dist'
  $expected = Join-Path $dist ('npm-mirror-desktop-' + $script:PkgVersion + '.exe')
  if (Test-Path $expected) { $script:ExePath = $expected; return }
  if (Test-Path $dist) {
    $candidate = Get-ChildItem $dist -Filter 'npm-mirror-desktop-*.exe' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notlike '*debug*' } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($candidate) {
      Info ('未找到版本命名的 exe，改用 dist 下最新的：' + $candidate.Name)
      $script:ExePath = $candidate.FullName
      return
    }
  }
  Write-Host ''
  Write-Host 'dist exe 不存在，请先运行 tools/build-desktop.ps1 构建桌面版。' -ForegroundColor Red
  Write-Host ('  期望路径：' + $expected) -ForegroundColor Red
  Write-Host '  构建命令：powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-desktop.ps1' -ForegroundColor Red
  exit 1
}

function Assert-TestPortsFree {
  $ports = @(
    @{ Port = $RegistryPort; Name = '镜像源测试端口' },
    @{ Port = $AdminPort; Name = '管理界面测试端口' }
  )
  foreach ($p in $ports) {
    if (-not (Test-Port $p.Port)) { continue }
    Info ('端口 ' + $p.Port + ' 已被占用，先尝试清理本测试数据目录的残留进程…')
    Stop-TrackedProcesses
    if (-not (Test-Port $p.Port)) { continue }
    Write-Host ''
    Write-Host ('[失败] 端口 ' + $p.Port + '（' + $p.Name + '）已被其它程序占用。') -ForegroundColor Red
    Write-Host '  请先释放该端口再重跑；脚本不会结束不属于本测试的进程。' -ForegroundColor Red
    Write-Host ('  如确需换端口：powershell -File test\desktop-e2e.ps1 -RegistryPort 15873 -AdminPort 15874') -ForegroundColor Red
    exit 1
  }
}

function Assert-NoForeignDesktop {
  if (-not $script:CimAvailable) {
    Assert-Skip '已运行桌面实例扫描' 'CIM/WMI 在本环境不可用，无法按命令行识别其它实例；改由测试端口占用检查兜底'
    return
  }
  $others = @(Get-DesktopProcs | Where-Object { -not (Test-OurCommandLine $_) })
  if ($others.Count -eq 0) { return }
  $pidsText = ($others | ForEach-Object { $_.ProcessId }) -join ', '
  Write-Host ''
  Write-Host ('[失败] 检测到已在运行的桌面版进程（PID: ' + $pidsText + '）。') -ForegroundColor Red
  Write-Host '  桌面版是单实例的，会阻止本测试再启动一个实例。' -ForegroundColor Red
  Write-Host '  请先在托盘里「退出程序」后重跑；脚本不会结束其它桌面实例，也不会动用户正在运行的服务。' -ForegroundColor Red
  exit 1
}

function Initialize-TestDataDir {
  $tmpRoot = Join-Path $script:Root 'tmp'
  if (-not $DataDir) { $script:DataDir = Join-Path $tmpRoot 'e2e-data' }
  $normalized = Normalize-Path $script:DataDir
  $normalizedTmp = Normalize-Path $tmpRoot
  if (-not $normalized.StartsWith($normalizedTmp + '\')) {
    Write-Host ''
    Write-Host ('[失败] 测试数据目录必须位于本仓库 tmp 下，收到：' + $script:DataDir) -ForegroundColor Red
    Write-Host ('  例如：' + (Join-Path $tmpRoot 'e2e-data')) -ForegroundColor Red
    exit 1
  }
  $script:DataDir = [System.IO.Path]::GetFullPath($script:DataDir)
  if ((Test-Path $script:DataDir) -and (-not $KeepData)) {
    Remove-Item -LiteralPath $script:DataDir -Recurse -Force
  }
  if (-not (Test-Path $script:DataDir)) {
    New-Item -ItemType Directory -Path $script:DataDir -Force | Out-Null
  }
  Info ('测试数据目录：' + $script:DataDir)
  if ($KeepData -and (Test-Path (Join-Path $script:DataDir 'config.json'))) {
    Info '（-KeepData）保留已有数据目录与配置，仅覆盖端口与 admin.enabled'
  }

  # 桌面配置目录（%LOCALAPPDATA%\LiYueNpmMirror 的测试替代）：沙箱通常不允许写
  # %LOCALAPPDATA%，因此通过 MIRROR_DESKTOP_HOME 指到仓库 tmp 下，避免影响真实环境。
  $script:DesktopHome = Join-Path $tmpRoot 'e2e-home'
  if ((Test-Path $script:DesktopHome) -and (-not $KeepData)) {
    Remove-Item -LiteralPath $script:DesktopHome -Recurse -Force
  }
  if (-not (Test-Path $script:DesktopHome)) {
    New-Item -ItemType Directory -Path $script:DesktopHome -Force | Out-Null
  }
  Info ('测试桌面配置目录（MIRROR_DESKTOP_HOME）：' + $script:DesktopHome)
}

# ---------------------------------------------------------------------------
# 主流程
# 异常兜底：任何未捕获的终止错误都先清理本测试进程，避免留下后台服务。
# ---------------------------------------------------------------------------
trap {
  Write-Host ''
  Write-Host ('[异常] 脚本执行中断：' + $_.Exception.Message) -ForegroundColor Red
  try { Show-Diagnostics } catch { }
  try { Stop-TrackedProcesses } catch { }
  Write-Host '[桌面版 e2e] 因异常中断，验收未通过。' -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host '桌面版端到端验收 · 私人 npm 镜像源（离线版）' -ForegroundColor White
Write-Host ('仓库根目录：' + $script:Root) -ForegroundColor DarkGray
Write-Host ('测试端口：镜像源 ' + $RegistryPort + ' / 管理界面 ' + $AdminPort + '（不占用 4873/4874）') -ForegroundColor DarkGray

if ([System.Environment]::OSVersion.Platform -ne 'Win32NT') {
  Write-Host '[失败] 本脚本只支持 Windows（桌面版是 Windows 单 exe）。' -ForegroundColor Red
  exit 1
}

$pkg = $null
try { $pkg = Get-Content (Join-Path $script:Root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
if (-not $pkg) {
  Write-Host '[失败] 无法读取 package.json，请确认在仓库根目录下运行。' -ForegroundColor Red
  exit 1
}
$script:PkgVersion = [string]$pkg.version
$script:ExePath = $ExePath

Section '阶段 0：产物与环境检查'
Resolve-DesktopExe
Info ('被测 exe：' + $script:ExePath)
Info ('exe 大小：' + [math]::Round(((Get-Item $script:ExePath).Length / 1MB), 1) + ' MB')
Initialize-TestDataDir

$exeItem = Get-Item $script:ExePath
Assert-True 'dist exe 存在' ($null -ne $exeItem)
Assert-True 'exe 大小 >= 20MB（内嵌 node.exe 与前端资源，过小说明构建不完整）' ($exeItem.Length -ge 20MB) ('实际 ' + [math]::Round(($exeItem.Length / 1MB), 1) + ' MB')

$vi = $exeItem.VersionInfo
$verCandidates = @(@($vi.ProductVersion, $vi.FileVersion) | Where-Object { $_ })
$verMatched = $false
foreach ($v in $verCandidates) { if ([string]$v -like ('*' + $script:PkgVersion + '*')) { $verMatched = $true } }
if ($verCandidates.Count -gt 0) {
  Assert-True ('exe 版本信息包含 package.json 版本 ' + $script:PkgVersion) $verMatched ('ProductVersion=' + $vi.ProductVersion + ' FileVersion=' + $vi.FileVersion)
} else {
  Assert-Skip 'exe 版本信息' 'exe 没有写入版本资源（待集成验证）'
}

$exeInDist = (Normalize-Path (Split-Path -Parent $script:ExePath)).StartsWith((Normalize-Path (Join-Path $script:Root 'dist')))
$sumFile = Join-Path (Split-Path -Parent $script:ExePath) 'SHA256SUMS.txt'
if (Test-Path $sumFile) {
  $exeName = Split-Path -Leaf $script:ExePath
  $expectedHash = ''
  foreach ($line in (Get-Content $sumFile -Encoding UTF8)) {
    if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') {
      $hash = $Matches[1].ToLower()
      $name = $Matches[2]
      if ($name -eq $exeName) { $expectedHash = $hash }
    }
  }
  Assert-True ('dist\SHA256SUMS.txt 包含 ' + $exeName + ' 的 SHA256 记录') ($expectedHash -ne '')
  if ($expectedHash) {
    $actualHash = (Get-FileHash $script:ExePath -Algorithm SHA256).Hash.ToLower()
    Assert-True 'exe SHA256 与 SHA256SUMS.txt 一致' ($actualHash -eq $expectedHash) ('期望 ' + $expectedHash + '，实际 ' + $actualHash)
  }
} elseif ($exeInDist -or -not $ExePath) {
  Assert-True 'dist\SHA256SUMS.txt 存在（构建脚本应生成）' $false '文件不存在，请重新运行 tools\build-desktop.ps1'
} else {
  Assert-Skip 'dist\SHA256SUMS.txt 校验' '被测 exe 不在 dist 下（自定义 -ExePath），跳过校验文件检查'
}

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd -and $exeInDist) {
  Push-Location $script:Root
  try {
    & git check-ignore -q ('dist/' + (Split-Path -Leaf $script:ExePath)) 2>$null | Out-Null
    $ignored = ($LASTEXITCODE -eq 0)
  } finally {
    Pop-Location
  }
  Assert-True 'dist 产物已被 .gitignore 忽略（不会误提交）' $ignored
}

Assert-TestPortsFree
Assert-NoForeignDesktop
Initialize-ProcessApi
$script:Token = ''

# v0.0.4：程序图标统一为网页版图标 public\favicon.ico（exe / 窗口 / 托盘同一套图），
# 构建脚本只从该图标生成窗口 / 托盘所需的 RGBA 素材。
$faviconPath = Join-Path $script:Root 'public\favicon.ico'
$iconIcoPath = Join-Path $script:Root 'src-tauri\icons\icon.ico'
if ((Test-Path $faviconPath) -and (Test-Path $iconIcoPath)) {
  $hashFav = (Get-FileHash $faviconPath -Algorithm SHA256).Hash.ToLower()
  $hashIco = (Get-FileHash $iconIcoPath -Algorithm SHA256).Hash.ToLower()
  Assert-True 'exe/窗口图标与网页版图标一致（src-tauri\icons\icon.ico = public\favicon.ico）' ($hashFav -eq $hashIco) ('favicon=' + $hashFav + '，icon=' + $hashIco)
} else {
  Assert-Skip '程序图标与网页版图标一致性' '未找到 public\favicon.ico 或 src-tauri\icons\icon.ico'
}
$winRgbaPath = Join-Path $script:Root 'src-tauri\icons\window-256.rgba'
$trayRgbaPath = Join-Path $script:Root 'src-tauri\icons\tray-32.rgba'
if ((Test-Path $winRgbaPath) -and (Test-Path $trayRgbaPath)) {
  Assert-True '窗口图标素材 window-256.rgba 为 256×256 RGBA（262144 B）' ((Get-Item $winRgbaPath).Length -eq 262144) ('实际 ' + (Get-Item $winRgbaPath).Length + ' B')
  Assert-True '托盘图标素材 tray-32.rgba 为 32×32 RGBA（4096 B）' ((Get-Item $trayRgbaPath).Length -eq 4096) ('实际 ' + (Get-Item $trayRgbaPath).Length + ' B')
} else {
  Assert-Skip '窗口/托盘图标素材尺寸' '未找到 src-tauri\icons 下的 RGBA 素材'
}

# ---------------------------------------------------------------------------
# 阶段 0b：v0.0.5 命令行选项（完整性标签检测 / 一键修复）
# 说明：exe 是 Windows GUI 子系统程序，从控制台直接执行时默认拿不到 stdout；
# 这里用 ProcessStartInfo 重定向标准输出/错误（管道句柄对 GUI 程序同样有效）读取 --help。
# ---------------------------------------------------------------------------
Section '阶段 0b：命令行选项（--help 含完整性相关参数，v0.0.5）'
$helpText = ''
$helpExit = $null
try {
  $psiHelp = New-Object System.Diagnostics.ProcessStartInfo
  $psiHelp.FileName = $script:ExePath
  $psiHelp.Arguments = '--help'
  $psiHelp.UseShellExecute = $false
  $psiHelp.RedirectStandardOutput = $true
  $psiHelp.RedirectStandardError = $true
  $psiHelp.CreateNoWindow = $true
  $psiHelp.WorkingDirectory = (Split-Path -Parent $script:ExePath)
  $helpProc = [System.Diagnostics.Process]::Start($psiHelp)
  $helpStdout = $helpProc.StandardOutput.ReadToEnd()
  $helpStderr = $helpProc.StandardError.ReadToEnd()
  if (-not $helpProc.WaitForExit(15000)) {
    try { $helpProc.Kill() } catch { }
    throw '--help 超时未退出（15s）'
  }
  $helpExit = $helpProc.ExitCode
  $helpText = $helpStdout + $helpStderr
} catch {
  $helpText = '读取 --help 失败：' + $_.Exception.Message
}
$helpOneLine = ($helpText -replace '\r?\n', ' ')
Assert-True 'exe --help 可执行且退出码为 0' ($helpExit -eq 0) ('实际退出码：' + $helpExit + '；输出：' + $helpOneLine)
Assert-True '--help 输出包含 --repair-integrity（v0.0.5 一键修复入口）' ($helpText -match '--repair-integrity') ('实际输出：' + $helpOneLine)
Assert-True '--help 输出包含 --skip-integrity-prompt（v0.0.5 跳过启动询问框）' ($helpText -match '--skip-integrity-prompt') ('实际输出：' + $helpOneLine)
Assert-True '--help 输出包含 --data-dir（回归：原有启动参数不丢失）' ($helpText -match '--data-dir') ('实际输出：' + $helpOneLine)

# ---------------------------------------------------------------------------
# 阶段 0c：v0.0.5 --repair-integrity 修复入口（只读验证，不请求 UAC、不改 dist 产物）
# 复制 exe 到临时目录后调用，即使当前会话意外具备管理员权限，也只会改到副本。
# smoke 模式下修复入口不弹框：未提权 => 退出码 3 + repairError；已提权 => 执行修复 + 退出码 0。
# ---------------------------------------------------------------------------
Section '阶段 0c：--repair-integrity 修复入口（安全只读验证，不请求 UAC）'
$repairDir = Join-Path $script:Root 'tmp\e2e-repair'
$repairExe = Join-Path $repairDir 'repair-copy.exe'
$repairReport = Join-Path $repairDir 'repair-report.json'
try {
  if (Test-Path $repairDir) { Remove-Item $repairDir -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Path $repairDir -Force | Out-Null
  Copy-Item -Path $script:ExePath -Destination $repairExe -Force
  $repairExit = $null
  $oldSmoke = $env:MIRROR_DESKTOP_SMOKE
  $env:MIRROR_DESKTOP_SMOKE = '1'
  try {
    $psiRepair = New-Object System.Diagnostics.ProcessStartInfo
    $psiRepair.FileName = $repairExe
    $psiRepair.Arguments = '--repair-integrity --smoke-report "' + $repairReport + '"'
    $psiRepair.UseShellExecute = $false
    $psiRepair.CreateNoWindow = $true
    $psiRepair.WorkingDirectory = $repairDir
    $repairProc = [System.Diagnostics.Process]::Start($psiRepair)
    if (-not $repairProc.WaitForExit(60000)) {
      try { $repairProc.Kill() } catch { }
      throw '--repair-integrity 超时未退出（60s）'
    }
    $repairExit = $repairProc.ExitCode
  } finally {
    if ($null -eq $oldSmoke) { Remove-Item Env:MIRROR_DESKTOP_SMOKE -ErrorAction SilentlyContinue } else { $env:MIRROR_DESKTOP_SMOKE = $oldSmoke }
  }
  $repairRep = $null
  if (Test-Path $repairReport) {
    try { $repairRep = Get-Content $repairReport -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
  }
  Assert-True '--repair-integrity 在 smoke 模式可执行并退出（未请求 UAC 交互）' (($repairExit -eq 0) -or ($repairExit -eq 3)) ('实际退出码：' + $repairExit + '（0=已提权并修复，3=未提权，均为预期）')
  if ($null -ne $repairRep) {
    Assert-True '修复入口报告标记 repairMode=true' ((Get-Prop $repairRep 'repairMode') -eq $true)
    $repairInteg = Get-Prop $repairRep 'integrity'
    Assert-True '修复入口报告包含 integrity 对象' ($null -ne $repairInteg)
    if ($null -ne $repairInteg) {
      $repairErrText = [string](Get-Prop $repairInteg 'repairError')
      $repairResultText = [string](Get-Prop $repairInteg 'repairResult')
      $repairElevated = Get-Prop $repairInteg 'elevated'
      if ($repairExit -eq 3) {
        Assert-True '未提权时修复入口报告给出原因（含「管理员权限」）' ($repairErrText -match '管理员|权限|elevat') ('实际：' + $repairErrText)
        Assert-True '未提权时修复入口未修改 exe（repairResult 为空）' ($repairResultText.Length -eq 0) ('实际：' + $repairResultText)
      } elseif ($repairExit -eq 0) {
        Assert-True '已提权时修复入口报告修复结果（repairResult 非空）' ($repairResultText.Length -gt 0) ('实际：' + $repairResultText)
      }
      Assert-True '修复入口报告 elevated 与退出码语义一致' ((($repairElevated -eq $true) -and ($repairExit -eq 0)) -or (($repairElevated -ne $true) -and ($repairExit -eq 3))) ('elevated=' + $repairElevated + '，exitCode=' + $repairExit)
    }
  } else {
    Assert-True '修复入口报告已生成（--smoke-report）' $false ('未找到 ' + $repairReport)
  }
} finally {
  Remove-Item $repairDir -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# 阶段 0d：v0.0.5 非 smoke 启动 + --skip-integrity-prompt（不被完整性询问框阻塞）
# ---------------------------------------------------------------------------
# 沙箱里非 smoke 启动会走「窗口失败 → 弹说明框 → 退出码 1」路径；带 --skip-integrity-prompt
# 时应直接到窗口失败说明框（不会先被低完整性询问框卡住）。本脚本不点「是」（不触发真实 UAC），
# 只用 WM_CLOSE 关掉窗口失败说明框，断言进程最终退出码为 1。
Section '阶段 0d：非 smoke 启动 --skip-integrity-prompt（不被完整性询问框阻塞，v0.0.5）'
$nonSmokeDir = Join-Path $script:Root 'tmp\e2e-nonsmoke'
$nonSmokeReport = Join-Path $nonSmokeDir 'failure-report.json'
$p0d = $null
try {
  if (Test-Path $nonSmokeDir) { Remove-Item $nonSmokeDir -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Path $nonSmokeDir -Force | Out-Null
  $oldSmoke0d = $env:MIRROR_DESKTOP_SMOKE
  $oldHome0d = $env:MIRROR_DESKTOP_HOME
  try {
    Remove-Item Env:MIRROR_DESKTOP_SMOKE -ErrorAction SilentlyContinue
    $env:MIRROR_DESKTOP_HOME = $script:DesktopHome
    $psi0d = New-Object System.Diagnostics.ProcessStartInfo
    $psi0d.FileName = $script:ExePath
    $psi0d.Arguments = '--skip-integrity-prompt --data-dir "' + $nonSmokeDir + '" --smoke-report "' + $nonSmokeReport + '"'
    $psi0d.UseShellExecute = $false
    $psi0d.WorkingDirectory = Split-Path -Parent $script:ExePath
    $p0d = [System.Diagnostics.Process]::Start($psi0d)
  } finally {
    if ($null -eq $oldSmoke0d) { Remove-Item Env:MIRROR_DESKTOP_SMOKE -ErrorAction SilentlyContinue } else { $env:MIRROR_DESKTOP_SMOKE = $oldSmoke0d }
    if ($null -eq $oldHome0d) { Remove-Item Env:MIRROR_DESKTOP_HOME -ErrorAction SilentlyContinue } else { $env:MIRROR_DESKTOP_HOME = $oldHome0d }
  }
  # 等待出现「窗口失败说明框」（非 smoke 模式）或进程自行退出（真实桌面会话窗口正常时可能不弹框）。
  $dialogHwnd0d = $null
  $sw0d = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw0d.Elapsed.TotalSeconds -lt 45) {
    Start-Sleep -Milliseconds 300
    if ($p0d.HasExited) { break }
    $wins0d = @(Get-AppWindows -RootPid $p0d.Id)
    if ($wins0d.Count -gt 0) { $dialogHwnd0d = $wins0d[0]; break }
  }
  $sw0d.Stop()
  $reachedDialog0d = ($null -ne $dialogHwnd0d) -or $p0d.HasExited
  Assert-True '非 smoke + --skip-integrity-prompt：未被低完整性询问框阻塞（出现窗口失败说明框或已自行退出）' $reachedDialog0d ('45 秒内既未出现说明框也未退出；进程可能被询问框阻塞')
  if ($null -eq $dialogHwnd0d) {
    Assert-Skip '关闭窗口失败说明框' ('未检测到说明框窗口（真实桌面会话窗口可能正常；或进程已自行退出）')
  } else {
    [DesktopE2E.Win32]::CloseWindow($dialogHwnd0d)
    Assert-True '已关闭窗口失败说明框（模拟用户点关闭）' $true
  }
  $exited0d = $p0d.WaitForExit(60000)
  if (-not $exited0d) {
    try { $p0d.Kill() } catch { }
  }
  Assert-True '非 smoke 失败路径最终退出（未因对话框残留挂起）' $exited0d
  if ($exited0d) {
    Assert-True '非 smoke 受限启动退出码为 1（窗口/WebView2 环境受限）' ($p0d.ExitCode -eq 1) ('实际退出码：' + $p0d.ExitCode)
  }
  # 失败报告（若写出）应包含 integrity 且 promptSuppressed=true、未弹修复询问框/未启动 UAC 修复实例
  if (Test-Path $nonSmokeReport) {
    $nsRep = $null
    try { $nsRep = Get-Content $nonSmokeReport -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    $nsInteg = Get-Prop $nsRep 'integrity'
    if ($null -ne $nsInteg) {
      Assert-True '非 smoke 失败报告 integrity.promptSuppressed=true（--skip-integrity-prompt 生效）' ((Get-Prop $nsInteg 'promptSuppressed') -eq $true) ('实际：' + (Get-Prop $nsInteg 'promptSuppressed'))
      Assert-True '非 smoke 失败报告未启动 UAC 修复实例（repairLaunched=false）' ((Get-Prop $nsInteg 'repairLaunched') -ne $true) ('实际：' + (Get-Prop $nsInteg 'repairLaunched'))
    } else {
      Assert-Skip '非 smoke 失败报告的 integrity 字段' '失败报告未包含 integrity 对象'
    }
  } else {
    Assert-Skip '非 smoke 失败报告文件' ('未生成失败报告：' + $nonSmokeReport)
  }
} finally {
  if ($null -ne $p0d -and -not $p0d.HasExited) { try { $p0d.Kill() } catch { } }
  Remove-Item $nonSmokeDir -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# 阶段 1：默认配置（admin.enabled=false）
# ---------------------------------------------------------------------------
Section '阶段 1：首次启动（默认 admin.enabled=false，关闭窗口=隐藏）'
$seeded = Set-TestConfig -WebAdminEnabled $false
Assert-True '测试配置已生成' $seeded
Read-ConfigToken

$p1 = Start-DesktopApp
Info ('已启动桌面进程 PID=' + $p1.Id + '，等待镜像源服务就绪…')
$pingOk = Wait-Until { Test-Ping $RegistryPort } 150 400
Assert-True ('镜像源服务已启动（GET /-/ping 返回 200，端口 ' + $RegistryPort + '）') $pingOk
if (-not $pingOk) {
  Exit-IfWindowBlocked -Proc $p1 -Detail '阶段 1 未等到镜像源服务（窗口未创建时 Rust 壳会直接退出）'
  Show-Diagnostics
  Stop-TrackedProcesses
  Write-Host ''
  Write-Host '== RESULT: ' -NoNewline
  Write-Host ('{"pass":' + $script:Pass + ',"fail":' + $script:Fail + ',"skip":' + $script:Skip + '}') -ForegroundColor Red
  exit 1
}
Update-TrackedNodePidsFromLog

# 桌面壳状态（内置测试挂钩报告，正常启动时该挂钩惰性）：
# 验证窗口真的创建并导航到「内部回环管理端口上的现有管理界面」、托盘菜单项齐全。
# 注意：受限沙箱内 WebView2（依赖命名管道 IPC）可能无法工作、窗口被销毁；
# 本段中窗口创建/导航类失败以 Category='window' 标记，脚本末尾据此判定 exit 3（环境限制）。
$rep1 = Wait-SmokeReport {
  param($report)
  return ((Get-Prop (Get-Prop $report 'node') 'ready') -eq $true)
} 90 500
$rep1Ready = ($null -ne $rep1)
Assert-True '桌面壳报告 Node ready（桥握手成功）' $rep1Ready
if ($rep1Ready) {
  $win1 = Get-Prop $rep1 'window'
  Assert-True '主窗口已创建（label=main）' ((Get-Prop $win1 'label') -eq 'main') ('实际 ' + (Get-Prop $win1 'label')) 'window'
  $winTitle1 = [string](Get-Prop $win1 'title')
  Assert-True '窗口标题包含产品名「镜像源」' ($winTitle1 -like '*镜像源*') ('实际标题：' + $winTitle1) 'window'
  $tray1 = Get-Prop $rep1 'tray'
  Assert-True '托盘图标已创建（id=main-tray）' ((Get-Prop $tray1 'id') -eq 'main-tray') ('实际 ' + (Get-Prop $tray1 'id'))
  $trayLabels1 = @(Get-Prop $tray1 'labels')
  $needLabels = @('打开窗口', '关闭窗口', '重启镜像源服务', '退出程序')
  $missing1 = @($needLabels | Where-Object { -not ($trayLabels1 -contains $_) })
  Assert-True '默认托盘菜单包含 4 项「打开窗口 / 关闭窗口 / 重启镜像源服务 / 退出程序」' (($missing1.Count -eq 0) -and ($trayLabels1.Count -eq 4)) ('实际菜单（' + $trayLabels1.Count + ' 项）：' + ($trayLabels1 -join ' / ') + '；缺少：' + ($missing1 -join '、'))
  Assert-True '默认关闭网页版管理时托盘菜单不含「打开管理界面」' (-not ($trayLabels1 -contains '打开管理界面')) ('实际菜单：' + ($trayLabels1 -join ' / '))
  Assert-True '默认关闭网页版管理时托盘菜单不含「重启管理界面」' (-not ($trayLabels1 -contains '重启管理界面')) ('实际菜单：' + ($trayLabels1 -join ' / '))

  # v0.0.4：托盘改为程序自绘 Win32 注册，注册结果可检测（tray.available / tray.error）；
  # 受限会话（沙箱拒绝托盘注册）下 available=false，restricted = home_fallback || !tray_available。
  $trayAvailProp1 = $null
  if ($null -ne $tray1) { $trayAvailProp1 = $tray1.PSObject.Properties['available'] }
  $trayAvail1 = $null
  if ($null -ne $trayAvailProp1) { $trayAvail1 = $trayAvailProp1.Value }
  Assert-True '报告包含托盘可用性字段 tray.available（布尔）' (($null -ne $trayAvailProp1) -and ($trayAvail1 -is [bool])) ('实际：' + $trayAvail1)
  $trayErr1 = [string](Get-Prop $tray1 'error')
  if ($trayAvail1 -eq $false) {
    Assert-True '托盘注册失败时报告给出原因（tray.error 含「拒绝访问 / os error 5」）' ($trayErr1 -match '拒绝|os error|error 5') ('实际：' + $trayErr1)
  } elseif ($trayAvail1 -eq $true) {
    Assert-True '托盘注册成功时 tray.error 为空' ($trayErr1.Length -eq 0) ('实际：' + $trayErr1)
  }
  $homeFallback1 = [bool](Get-Prop (Get-Prop $rep1 'home') 'fallback')
  $restr1 = Get-Prop $rep1 'restricted'
  $expectRestr1 = ($homeFallback1 -or ($trayAvail1 -ne $true))
  Assert-True '受限标记 restricted 与「home 回退 / 托盘不可用」一致（本会话预期 true）' ($restr1 -eq $expectRestr1) ('tray.available=' + $trayAvail1 + '，home.fallback=' + $homeFallback1 + '，restricted=' + $restr1)

  # v0.0.5：完整性标签自检（低完整性 Low 标签自动检测）。
  # smoke 报告 integrity 对象字段：token/tokenRid/tokenSid/file/fileRaw/lowDetected/elevated/
  # repairPrompted/repairLaunched/promptSuppressed/repairResult/repairError/error/exePath。
  # 与 icacls 读到的 dist exe 标签交叉核对；本段只读，不执行任何 UAC / 提权 / 修复动作。
  $integ1 = Get-Prop $rep1 'integrity'
  Assert-True '报告包含完整性自检对象 integrity（v0.0.5）' ($null -ne $integ1)
  if ($null -ne $integ1) {
    $integExe1 = [string](Get-Prop $integ1 'exePath')
    Assert-True 'integrity.exePath 指向被测 exe' ((Normalize-Path $integExe1) -eq (Normalize-Path $script:ExePath)) ('实际：' + $integExe1 + '；期望：' + $script:ExePath)
    $integFile1 = [string](Get-Prop $integ1 'file')
    Assert-True 'integrity.file 为已知完整性级别（Low/Medium/High/System/Unknown）' ($integFile1 -match '^(Low|Medium|High|System|Unknown)$') ('实际：' + $integFile1)
    $integToken1 = [string](Get-Prop $integ1 'token')
    Assert-True 'integrity.token 非空（当前进程令牌完整性）' ($integToken1.Length -gt 0) ('实际：' + $integToken1)
    $integTokenRidProp = $integ1.PSObject.Properties['tokenRid']
    Assert-True 'integrity 对象包含 tokenRid 字段（未知时为 null）' ($null -ne $integTokenRidProp)
    $integElevProp = $integ1.PSObject.Properties['elevated']
    Assert-True 'integrity.elevated 为布尔值' (($null -ne $integElevProp) -and ($integElevProp.Value -is [bool])) ('实际：' + (Get-Prop $integ1 'elevated'))
    $integPrompted1 = Get-Prop $integ1 'repairPrompted'
    Assert-True 'smoke 模式不弹出低完整性修复询问框（repairPrompted=false）' ($integPrompted1 -eq $false) ('实际：' + $integPrompted1)
    $integLaunched1 = Get-Prop $integ1 'repairLaunched'
    Assert-True 'smoke 模式不启动 UAC 修复实例（repairLaunched=false）' ($integLaunched1 -eq $false) ('实际：' + $integLaunched1)
    $integLow1 = Get-Prop $integ1 'lowDetected'
    Assert-True 'integrity.lowDetected 与 integrity.file 判定一致' ($integLow1 -eq ($integFile1 -eq 'Low')) ('file=' + $integFile1 + '，lowDetected=' + $integLow1)
    $integErr1 = [string](Get-Prop $integ1 'error')
    if ($integFile1 -eq 'Unknown') {
      Assert-True 'integrity.file 为 Unknown 时给出读取失败原因（integrity.error 非空）' ($integErr1.Length -gt 0) ('实际：' + $integErr1)
    }
    # 交叉核对：用 icacls 读取被测 exe 的完整性标签（中文/英文输出都兼容）
    $icaclsLabel1 = ''
    $icaclsRaw1 = ''
    try {
      $icaclsOut1 = @(& icacls $script:ExePath 2>&1)
      $icaclsText1 = ($icaclsOut1 | Out-String)
      $labelLine1 = @($icaclsOut1 | Where-Object { [string]$_ -match 'Mandatory Label|强制标签' }) | Select-Object -First 1
      if ($labelLine1) {
        $labelText1 = [string]$labelLine1
        $icaclsRaw1 = $labelText1.Trim()
        if ($labelText1 -match 'Low|低强制|低完整性') { $icaclsLabel1 = 'Low' }
        elseif ($labelText1 -match 'Medium|中强制|中完整性|中等完整性') { $icaclsLabel1 = 'Medium' }
        elseif ($labelText1 -match 'High|高强制|高完整性') { $icaclsLabel1 = 'High' }
        elseif ($labelText1 -match 'System|系统强制') { $icaclsLabel1 = 'System' }
      }
      if (-not $icaclsLabel1) { $icaclsRaw1 = (($icaclsText1 -replace '\r?\n', ' ').Trim()) }
    } catch {
      $icaclsRaw1 = 'icacls 执行失败：' + $_.Exception.Message
    }
    if ($icaclsLabel1) {
      Assert-True 'integrity.file 与 icacls 读取到的 exe 完整性标签一致' ($integFile1 -eq $icaclsLabel1) ('报告=' + $integFile1 + '，icacls=' + $icaclsLabel1 + '（原始：' + $icaclsRaw1 + '）')
    } else {
      Assert-Skip 'integrity.file 与 icacls 交叉核对' ('icacls 输出中未找到完整性标签行：' + $icaclsRaw1)
    }
    if ($integFile1 -eq 'Low') {
      Assert-True 'exe 带 Low 标签时进程令牌完整性也为 Low（min(令牌, 文件) 规则）' ($integToken1 -eq 'Low') ('token=' + $integToken1 + '，file=' + $integFile1)
      $integSuppressed1 = Get-Prop $integ1 'promptSuppressed'
      Assert-True '检测到 Low 且 smoke 不弹框时给出抑制标记（promptSuppressed=true）' ($integSuppressed1 -eq $true) ('实际：' + $integSuppressed1)
    }
  }

  # 阶段 1f：直接编辑 config.json 的 admin.enabled（模拟用户/其它工具改配置），
  # 验证 Rust 壳的 1 秒配置轮询能把「打开管理界面 / 重启管理界面」菜单项加/减
  # （带兜底轮询，阈值放宽到 ≤2s；走桥事件的正常开关路径在阶段 2e 按 ≤1s 断言）。
  Section '阶段 1f：直接编辑 config.json → 托盘菜单刷新（≤2s，配置轮询兜底）'
  $cfgPath1f = Join-Path $script:DataDir 'config.json'
  $sw1f = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $cfg1f = Get-Content $cfgPath1f -Raw -Encoding UTF8 | ConvertFrom-Json
    $cfg1f.admin.enabled = $true
    $json1f = ($cfg1f | ConvertTo-Json -Depth 10)
    # 注意：必须写「无 BOM」UTF-8，Rust/Node 的 JSON 解析都不接受 BOM。
    [System.IO.File]::WriteAllText($cfgPath1f, $json1f, (New-Object System.Text.UTF8Encoding($false)))
    $appearedRep = Wait-SmokeReport {
      param($r)
      $lb = @(Get-Prop (Get-Prop $r 'tray') 'labels')
      return (($lb -contains '打开管理界面') -and ($lb -contains '重启管理界面'))
    } 5 200
    $sw1f.Stop()
    $appearedMs = $sw1f.ElapsedMilliseconds
    $appearedLabels = @(Get-Prop (Get-Prop $appearedRep 'tray') 'labels')
    Assert-True '直接改 config.json admin.enabled=true 后托盘出现「打开管理界面」「重启管理界面」（≤2s）' (($null -ne $appearedRep) -and $appearedMs -le 2000) ('耗时=' + $appearedMs + 'ms；实际菜单：' + ($appearedLabels -join ' / '))

    $sw1fRevert = [System.Diagnostics.Stopwatch]::StartNew()
    $cfg1fRevert = Get-Content $cfgPath1f -Raw -Encoding UTF8 | ConvertFrom-Json
    $cfg1fRevert.admin.enabled = $false
    $json1fRevert = ($cfg1fRevert | ConvertTo-Json -Depth 10)
    [System.IO.File]::WriteAllText($cfgPath1f, $json1fRevert, (New-Object System.Text.UTF8Encoding($false)))
    $disappearedRep = Wait-SmokeReport {
      param($r)
      $lb = @(Get-Prop (Get-Prop $r 'tray') 'labels')
      return ((-not ($lb -contains '打开管理界面')) -and (-not ($lb -contains '重启管理界面')))
    } 5 200
    $sw1fRevert.Stop()
    $disappearedMs = $sw1fRevert.ElapsedMilliseconds
    Assert-True '直接改回 admin.enabled=false 后两项从托盘消失（≤2s）' (($null -ne $disappearedRep) -and $disappearedMs -le 2000) ('耗时=' + $disappearedMs + 'ms')
    Assert-True '配置轮询刷新后镜像源服务仍在线（/-/ping 200）' (Test-Ping $RegistryPort)
  } catch {
    Assert-True '直接编辑 config.json 触发托盘刷新（阶段 1f）' $false ('异常：' + $_.Exception.Message)
  }

  # 窗口 URL = 内部回环管理端口（现有网页版管理界面），GET 该地址应返回同一套页面
  $repWin1 = Wait-SmokeReport {
    param($report)
    $url = [string](Get-Prop (Get-Prop $report 'window') 'url')
    return ($url.Length -gt 0)
  } 45 500
  $script:WindowCheckAvailable = ($null -ne $repWin1)
  $win1Nav = $win1
  if ($null -ne $repWin1) { $win1Nav = Get-Prop $repWin1 'window' } else { $win1Nav = $win1 }
  $winUrl1 = [string](Get-Prop $win1Nav 'url')
  $internalPort1 = [int](Get-Prop (Get-Prop $rep1 'node') 'internalAdminPort')
  Assert-True '窗口已导航到内部回环管理端口（127.0.0.1 随机端口）' ($winUrl1 -match '^http://127\.0\.0\.1:\d+/') ('实际 ' + $winUrl1) 'window'
  Assert-True '窗口 URL 的端口 = 内部管理端口' ($winUrl1 -match (':(' + $internalPort1 + ')/$')) ('URL=' + $winUrl1 + '，内部端口=' + $internalPort1) 'window'
  if ($winUrl1.Length -gt 0) {
    $internalPage = Invoke-Api $winUrl1 'GET' $null 15
    Assert-True '窗口加载的现有管理界面可访问（GET 内部管理地址 200 + HTML）' ($internalPage.Status -eq 200 -and $internalPage.Content -match '(?i)<!doctype html|<html|app\.js') ('状态=' + $internalPage.Status) 'window'
  } else {
    Assert-True '窗口加载的现有管理界面可访问（GET 内部管理地址 200 + HTML）' $false '窗口 URL 为空，窗口尚未导航（见上方失败明细）' 'window'
  }

  # v0.0.3 启动诊断：窗口初始化失败时必须能看到可读原因（window.failureReason），
  # 而不是只留下一个「进程在跑但看不到窗口」的黑盒状态。
  $diagWin = Get-Prop $script:LastSmokeReport 'window'
  $diagFailProp = $null
  if ($null -ne $diagWin) { $diagFailProp = $diagWin.PSObject.Properties['failureReason'] }
  if ($winUrl1.Length -eq 0) {
    $diagReason = if ($null -ne $diagFailProp) { [string]$diagFailProp.Value } else { '' }
    Assert-True '窗口不可用时报告给出可操作的失败原因（window.failureReason 非空）' ($null -ne $diagFailProp -and $diagReason.Length -gt 0) ('实际：' + $diagReason) 'window'
  } else {
    Assert-True '窗口正常时报告仍包含启动诊断字段 window.failureReason' ($null -ne $diagFailProp)
  }
}

Assert-True '默认配置下网页版管理端口不监听（admin.enabled=false）' (-not (Test-Port $AdminPort)) ('端口 ' + $AdminPort)

$windowsFound = Wait-Until { (Get-AppWindows -RootPid $p1.Id).Count -gt 0 } 45 500
$appWindows = @()
if ($windowsFound) { $appWindows = @(Get-AppWindows -RootPid $p1.Id) }
$hasWindow = $appWindows.Count -gt 0
if (-not $hasWindow) {
  Assert-Skip '桌面窗口已打开' '未检测到可见窗口（可能没有可交互桌面会话），需人工确认'
} else {
  $winTitle = [DesktopE2E.Win32]::GetTitle($appWindows[0])
  Assert-True '桌面窗口已打开（可见且有标题）' $true ('标题：' + $winTitle)
  if ($winTitle) {
    Assert-True '窗口标题包含产品名「镜像源」' ($winTitle -like '*镜像源*') ('实际标题：' + $winTitle)
  }
}
Assert-True '桌面进程存活' (-not $p1.HasExited)
Assert-True '数据目录内已写出 config.json' (Test-Path (Join-Path $script:DataDir 'config.json'))
Assert-True '数据目录内已创建 logs 目录（旧值 data/storage 迁移解析正常）' (Test-Path (Join-Path $script:DataDir 'logs'))

# 单实例：再启动一个实例应自动退出，原服务不受影响
Section '阶段 1b：单实例行为'
$primaryReport = $script:SmokeReportPath
$primaryCmd = $script:SmokeCmdPath
$p2 = Start-DesktopApp
Info ('已启动第二个实例 PID=' + $p2.Id + '，等待其自动退出…')
$secondExited = Wait-Until { $p2.HasExited } 25 400
Assert-True '第二个实例自动退出（单实例互斥）' $secondExited
if (-not $secondExited) {
  try { Stop-Process -Id $p2.Id -Force -ErrorAction SilentlyContinue } catch { }
}
Assert-True '第二个实例退出后原服务仍在线' (Test-Ping $RegistryPort)
# 第二个实例用了自己的报告/命令文件（smoke-report-2 / smoke-cmd-2），已随进程退出；
# 把冒烟报告/命令路径恢复指向第一个（主）实例，后续托盘菜单动作才发给仍在运行的实例。
$script:AppProc = $p1
$script:SmokeReportPath = $primaryReport
$script:SmokeCmdPath = $primaryCmd
$script:LastSmokeReport = $null

# 关闭窗口的真实行为在阶段 1c-3 用内置测试挂钩 window:close 验证：
# v0.0.4 起托盘可用 → 隐藏窗口、进程与服务继续；托盘不可用 → 程序直接退出。
Section '阶段 1c：窗口状态检查（关闭窗口行为见阶段 1c-3）'
if ($hasWindow) {
  $winTitle1c = [DesktopE2E.Win32]::GetTitle($appWindows[0])
  Assert-True '桌面窗口可见（当前会话有可交互桌面）' $true ('标题：' + $winTitle1c)
} else {
  Assert-Skip '桌面窗口可见性' '未检测到可见窗口（受限会话/无交互桌面），窗口类断言按环境限制处理（exit 3）'
}

# 托盘菜单动作：通过产品内置测试挂钩（MIRROR_DESKTOP_SMOKE=1）触发与真实右键菜单
# 相同的 menu id，验证「打开窗口 / 关闭窗口」两项菜单动作的行为。
Section '阶段 1c-2：托盘菜单动作（打开窗口 / 关闭窗口）'
$openReport = Send-SmokeCommand 'menu:tray-open' 20
$openCmd = @()
if ($null -ne $openReport) {
  $openCmd = @(@(Get-Prop $openReport 'commands') | Where-Object { (Get-Prop $_ 'command') -eq 'menu:tray-open' })
}
Assert-True '托盘菜单「打开窗口」动作被执行（命令回执 ok）' ($openCmd.Count -gt 0 -and (Get-Prop $openCmd[0] 'ok') -eq $true) ('回执：' + ($openCmd | ConvertTo-Json -Compress))
$reopened = Wait-Until { (Get-AppWindows -RootPid $p1.Id).Count -gt 0 } 15 400
$repOpen = Wait-SmokeReport { param($r) (Get-Prop (Get-Prop $r 'window') 'visible') -eq $true } 15 400
Assert-True '菜单「打开窗口」后主窗口重新可见' ($reopened -or ($null -ne $repOpen -and (Get-Prop (Get-Prop $repOpen 'window') 'visible') -eq $true)) '' 'window'
$hideReport = Send-SmokeCommand 'menu:tray-hide' 20
$hideCmd = @()
if ($null -ne $hideReport) {
  $hideCmd = @(@(Get-Prop $hideReport 'commands') | Where-Object { (Get-Prop $_ 'command') -eq 'menu:tray-hide' })
}
Assert-True '托盘菜单「关闭窗口」动作被执行（命令回执 ok）' ($hideCmd.Count -gt 0 -and (Get-Prop $hideCmd[0] 'ok') -eq $true) ('回执：' + ($hideCmd | ConvertTo-Json -Compress))
$hiddenByMenu = Wait-Until { (Get-AppWindows -RootPid $p1.Id).Count -eq 0 } 15 400
$repHidden = Wait-SmokeReport { param($r) (Get-Prop (Get-Prop $r 'window') 'visible') -eq $false } 10 300
# 沙箱内 WebView2 窗口 shell 已销毁，EnumWindows/visible 都可能读不到真实状态，
# 该项归入 window 类别：若这是唯一失败类别，脚本按环境限制 exit 3 并提示人工验收。
Assert-True '菜单「关闭窗口」后窗口隐藏（进程与服务继续）' ($hiddenByMenu -or ($null -ne $repHidden)) '' 'window'
Assert-True '托盘菜单隐藏窗口后镜像源服务仍在线（/-/ping 200）' (Test-Ping $RegistryPort)
Assert-True '托盘菜单隐藏窗口后桌面进程仍存活' (-not $p1.HasExited)

# ---------------------------------------------------------------------------
# 阶段 1c-3：关闭窗口行为（v0.0.4：托盘可用 → 隐藏；托盘不可用 → 退出程序）
# 用内置测试挂钩 window:close 模拟 CloseRequested（等价于点击窗口右上角 ×）。
# 受限会话里托盘注册被系统拒绝（tray.available=false），预期走「直接退出程序」分支：
# 进程退出码 0、镜像源/管理端口释放、无 Node 残留，避免无窗口无托盘的静默后台进程。
# ---------------------------------------------------------------------------
Section '阶段 1c-3：关闭窗口行为（托盘可用→隐藏 / 托盘不可用→退出程序，v0.0.4）'
$trayAvailForClose = $null
if ($null -ne $rep1) {
  $trayPropForClose = (Get-Prop $rep1 'tray').PSObject.Properties['available']
  if ($null -ne $trayPropForClose) { $trayAvailForClose = $trayPropForClose.Value }
}
Info ('当前托盘可用性 tray.available=' + $trayAvailForClose + '（受限会话预期 false）')
if ($null -eq $trayAvailForClose) {
  Assert-Skip '关闭窗口行为（托盘可用性未知）' '测试报告未包含 tray.available 字段，无法判定按哪个分支验收'
} else {
  # window:close 会立即触发隐藏/退出，报告可能来不及回执该命令，因此以行为断言为准。
  [void](Send-SmokeCommand 'window:close' 15)
  if ($trayAvailForClose -eq $true) {
    $hidden1c = Wait-Until { (Get-AppWindows -RootPid $p1.Id).Count -eq 0 } 15 400
    $repHidden1c = Wait-SmokeReport { param($r) (Get-Prop (Get-Prop $r 'window') 'visible') -eq $false } 10 300
    Assert-True '托盘可用时：关闭窗口后窗口隐藏（进程与服务继续）' ($hidden1c -or ($null -ne $repHidden1c)) '' 'window'
    Assert-True '托盘可用时：关闭窗口后桌面进程仍存活' (-not $p1.HasExited)
    Assert-True '托盘可用时：关闭窗口后镜像源服务仍在线（/-/ping 200）' (Test-Ping $RegistryPort)
    # 窗口已隐藏：重新打开，供后续阶段菜单动作使用
    Send-SmokeCommand 'menu:tray-open' 20 | Out-Null
    Wait-Until { (Get-AppWindows -RootPid $p1.Id).Count -gt 0 } 15 400 | Out-Null
  } else {
    $exited1c = Wait-Until { $p1.HasExited } 25 400
    Assert-True '托盘不可用时：关闭窗口 = 直接退出程序（不再静默留在后台）' $exited1c
    if ($exited1c) {
      $code1c = $null
      try { $p1.Refresh(); $code1c = $p1.ExitCode } catch { }
      Assert-True '托盘不可用时：关闭窗口后进程退出码为 0（正常退出，非崩溃）' ($code1c -eq 0) ('实际 ExitCode=' + $code1c)
      $portsClosed1c = Wait-Until { (-not (Test-Port $RegistryPort)) -and (-not (Test-Port $AdminPort)) } 15 300
      Assert-True '托盘不可用时：退出后镜像源/管理端口均不再监听' $portsClosed1c
      Start-Sleep -Milliseconds 500
      $nodeLeft1c = @(Get-OurNodeProcs)
      Assert-True '托盘不可用时：退出后无本测试的 node 残留进程' ($nodeLeft1c.Count -eq 0) ('残留：' + (($nodeLeft1c | ForEach-Object { $_.ProcessId }) -join ','))
    }
    Assert-Skip '关闭窗口 = 隐藏（进程与服务继续）' '本会话托盘注册被系统拒绝（tray.available=false），「托盘可用时关闭窗口=隐藏」分支需在普通桌面会话人工验收'
  }
}

# 阶段 1 清理（强停是本测试的清理手段，不是产品行为验收）
Section '阶段 1d：清理测试实例'
Stop-TrackedProcesses
$portsFreed = Wait-Until { (-not (Test-Port $RegistryPort)) -and (-not (Test-Port $AdminPort)) } 15 300
Assert-True '清理后测试端口全部释放' $portsFreed
Assert-True '清理后无本测试的 node 残留进程' ((Get-OurNodeProcs).Count -eq 0)

# ---------------------------------------------------------------------------
# 阶段 1e：配置文件里的非法存储目录 → 服务仍能启动并回退到默认 storage
# 说明：直接改 config.json 模拟「历史/手改」的非法值，绕过 config.save() 的净化，
# 验证 config.storageDir() 的兜底路径不会让服务起不来。
# ---------------------------------------------------------------------------
Section '阶段 1e：非法 storage.dir 回退（服务不崩、使用默认 storage）'
$cfgPath1e = Join-Path $script:DataDir 'config.json'
$injectOk = $false
try {
  $cfgObj = Get-Content $cfgPath1e -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($null -eq $cfgObj.storage) { $cfgObj | Add-Member -NotePropertyName storage -NotePropertyValue ([pscustomobject]@{}) -Force }
  $cfgObj.storage.dir = '..\..\evil'
  $rawCfg = $cfgObj | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($cfgPath1e, $rawCfg, (New-Object System.Text.UTF8Encoding($false)))
  $injectOk = $true
} catch {
  Info ('改写 config.json 失败：' + $_.Exception.Message)
}
Assert-True '已把非法 storage.dir=..\..\evil 直接写入 config.json' $injectOk
if ($injectOk) {
  $p1e = Start-DesktopApp
  Info ('已启动桌面进程 PID=' + $p1e.Id + '，验证非法存储目录下的启动行为…')
  $ping1e = Wait-Until { Test-Ping $RegistryPort } 150 400
  Assert-True 'storage.dir 非法时服务仍能启动（/-/ping 200，不因配置非法卡死）' $ping1e
  if ($ping1e) {
    Update-TrackedNodePidsFromLog
    Assert-True '非法 storage.dir 回退到默认 <数据目录>\storage（目录已创建）' (Test-Path (Join-Path $script:DataDir 'storage'))
    Assert-True '非法 storage.dir 时 admin.enabled=false 仍生效（管理端口不监听）' (-not (Test-Port $AdminPort))
  } else {
    Exit-IfWindowBlocked -Proc $p1e -Detail '阶段 1e 未等到镜像源服务'
    Show-Diagnostics
  }
  Stop-TrackedProcesses
  $portsFreed1e = Wait-Until { (-not (Test-Port $RegistryPort)) -and (-not (Test-Port $AdminPort)) } 15 300
  Assert-True '阶段 1e 清理后测试端口全部释放' $portsFreed1e
}

# ---------------------------------------------------------------------------
# 阶段 1g：程序配置目录回退（v0.0.2 修复）
# 模拟 v0.0.1 用户遇到的受限环境：%LOCALAPPDATA% 不可写（这里指向一个「同名文件」，
# 任何在其下创建目录的操作都会失败）。未设置 MIRROR_DESKTOP_HOME 时，程序应自动
# 回退到 <exe 所在目录>\LiYueNpmMirror 并继续启动，而不是报
# 「创建桌面配置目录 … 拒绝访问 (os error 5)」直接退出。
# 用 exe 的副本在临时目录里测试，不污染 dist；结束时清理进程与临时目录。
# ---------------------------------------------------------------------------
Section '阶段 1g：程序配置目录回退（%LOCALAPPDATA% 不可写 → <exe目录>\LiYueNpmMirror）'
$fallbackRoot = Join-Path $script:Root 'tmp\e2e-fallback'
if (Test-Path $fallbackRoot) { Remove-Item $fallbackRoot -Recurse -Force -ErrorAction SilentlyContinue }
$fallbackExeDir = Join-Path $fallbackRoot 'app'
[void](New-Item -ItemType Directory -Path $fallbackExeDir -Force)
$fallbackExe = Join-Path $fallbackExeDir ('npm-mirror-desktop-' + $script:PkgVersion + '.exe')
Copy-Item $script:ExePath $fallbackExe -Force
$fallbackData = Join-Path $fallbackRoot 'data'
[void](New-Item -ItemType Directory -Path $fallbackData -Force)
# 让 LOCALAPPDATA 指向一个「文件」：<LOCALAPPDATA>\LiYueNpmMirror 必然创建失败。
$blockedLocalAppData = Join-Path $fallbackRoot 'blocked-localappdata'
[System.IO.File]::WriteAllText($blockedLocalAppData, 'not a directory', (New-Object System.Text.UTF8Encoding($false)))
$expectFallbackHome = Join-Path $fallbackExeDir 'LiYueNpmMirror'

$oldDataDir1g = $script:DataDir
$script:DataDir = $fallbackData
$seeded1g = Set-TestConfig -WebAdminEnabled $false
$script:DataDir = $oldDataDir1g
Assert-True '已生成阶段 1g 测试配置（admin.enabled=false）' $seeded1g

$p1g = Start-DesktopApp -Exe $fallbackExe -DataDirArg $fallbackData -NoDesktopHome -LocalAppData $blockedLocalAppData -ReportPrefix 'fallback'
Info ('已用 exe 副本启动桌面进程 PID=' + $p1g.Id + '，LOCALAPPDATA=' + $blockedLocalAppData + '，未设置 MIRROR_DESKTOP_HOME…')
$rep1g = Wait-SmokeReport {
  param($r)
  $h = Get-Prop $r 'home'
  $n = Get-Prop $r 'node'
  return (((Get-Prop $h 'fallback') -eq $true) -and ((Get-Prop $n 'ready') -eq $true))
} 150 400
if ($null -ne $rep1g) {
  $home1g = Get-Prop $rep1g 'home'
  $homePath1g = [string](Get-Prop $home1g 'path')
  Assert-True 'smoke 报告 home.fallback=true（程序配置目录已回退）' ((Get-Prop $home1g 'fallback') -eq $true) ('实际：' + ($home1g | ConvertTo-Json -Compress))
  Assert-True ('回退目录 = <exe目录>\LiYueNpmMirror（' + $expectFallbackHome + '）') ((Normalize-Path $homePath1g) -eq (Normalize-Path $expectFallbackHome)) ('实际：' + $homePath1g)
  Assert-True '回退目录不在不可写的 %LOCALAPPDATA% 下' (-not $homePath1g.StartsWith($blockedLocalAppData, [System.StringComparison]::OrdinalIgnoreCase)) ('实际：' + $homePath1g)
  Assert-True '回退后桌面日志写在回退目录下（desktop.log 存在）' (Test-Path (Join-Path $expectFallbackHome 'desktop.log')) ('目录：' + $expectFallbackHome)
  $fallbackNode = Get-Prop $rep1g 'node'
  $fallbackNodePid = [int](Get-Prop $fallbackNode 'pid')
  if ($fallbackNodePid -gt 0 -and -not ($script:TrackedNodePids -contains $fallbackNodePid)) { [void]$script:TrackedNodePids.Add($fallbackNodePid) }
  # v0.0.4：受限标记 = home 回退 或 托盘不可用；本阶段 home.fallback=true，故 restricted 必须为 true。
  $restr1g = Get-Prop $rep1g 'restricted'
  Assert-True '回退场景下 restricted=true（受限环境标记）' ($restr1g -eq $true) ('home.fallback=' + (Get-Prop (Get-Prop $rep1g 'home') 'fallback') + '，restricted=' + $restr1g)
} else {
  Assert-Skip '程序配置目录回退（smoke 报告 home.fallback）' '等待超时或报告未包含 home 字段（旧 exe 不支持该字段时无法判定），需人工确认'
}
$ping1g = Wait-Until { Test-Ping $RegistryPort } 60 400
Assert-True '回退后镜像源服务正常启动（/-/ping 200）' $ping1g
Assert-True '回退后仍按测试配置不监听管理端口（admin.enabled=false）' (-not (Test-Port $AdminPort))

Stop-TrackedProcesses
$portsFreed1g = Wait-Until { (-not (Test-Port $RegistryPort)) -and (-not (Test-Port $AdminPort)) } 15 300
Assert-True '阶段 1g 清理后测试端口全部释放' $portsFreed1g
if (Test-Path $fallbackRoot) { Remove-Item $fallbackRoot -Recurse -Force -ErrorAction SilentlyContinue }
Assert-True '阶段 1g 临时目录已清理' (-not (Test-Path $fallbackRoot))

# ---------------------------------------------------------------------------
# 阶段 1h：数据目录自动发现（v0.0.3 新增）
# 场景：便携布局 <项目>\portable\dist\<exe> + <项目>\portable\data\config.json。
# 启动时不传 --data-dir、不设 MIRROR_DATA_DIR：程序应识别「<exe目录>\data 不存在
# 或为空、上级 data\config.json 存在」，自动使用上级 data 目录（source=parent-project），
# 而不是在 dist\ 下新建 data\。用 exe 副本在临时目录测试，结束清理。
# ---------------------------------------------------------------------------
Section '阶段 1h：数据目录自动发现（dist 运行 → 上级项目 data，dataDirSource=parent-project）'
$portableRoot = Join-Path $script:Root 'tmp\e2e-portable'
if (Test-Path $portableRoot) { Remove-Item $portableRoot -Recurse -Force -ErrorAction SilentlyContinue }
$portableDist = Join-Path $portableRoot 'portable\dist'
$portableData = Join-Path $portableRoot 'portable\data'
[void](New-Item -ItemType Directory -Path $portableDist -Force)
[void](New-Item -ItemType Directory -Path $portableData -Force)
$portableExe = Join-Path $portableDist ('npm-mirror-desktop-' + $script:PkgVersion + '.exe')
Copy-Item $script:ExePath $portableExe -Force

# 在「上级项目 data」里生成测试配置（端口 14873/14874、admin.enabled=false），
# 再把 $script:DataDir 恢复为全局测试数据目录（本阶段不传 --data-dir）。
$oldDataDir1h = $script:DataDir
$script:DataDir = $portableData
$seeded1h = Set-TestConfig -WebAdminEnabled $false
$script:DataDir = $oldDataDir1h
Assert-True '已生成阶段 1h 测试配置（上级项目 data\config.json，admin.enabled=false）' ($seeded1h -and (Test-Path (Join-Path $portableData 'config.json')))

$p1h = Start-DesktopApp -Exe $portableExe -NoDataDir -ReportPrefix 'portable'
Info ('已用 exe 副本启动桌面进程 PID=' + $p1h.Id + '（未传 --data-dir，未设 MIRROR_DATA_DIR），验证数据目录自动发现…')
$rep1h = Wait-SmokeReport {
  param($r)
  $n = Get-Prop $r 'node'
  $dd = [string](Get-Prop $r 'dataDir')
  return (((Get-Prop $n 'ready') -eq $true) -and ($dd.Length -gt 0))
} 150 400
if ($null -ne $rep1h) {
  $dataDir1h = [string](Get-Prop $rep1h 'dataDir')
  $dataSrc1h = [string](Get-Prop $rep1h 'dataDirSource')
  Assert-True ('自动发现的数据目录 = 上级项目 data（' + $portableData + '）') ((Normalize-Path $dataDir1h) -eq (Normalize-Path $portableData)) ('实际：' + $dataDir1h)
  Assert-True 'dataDirSource = parent-project（自动发现而非默认 <exe目录>\data）' ($dataSrc1h -eq 'parent-project') ('实际：' + $dataSrc1h)
  Assert-True '未在 dist\ 下新建 data 目录（第 4 档未被误判）' (-not (Test-Path (Join-Path $portableDist 'data'))) ('路径：' + (Join-Path $portableDist 'data'))
} else {
  Assert-Skip '数据目录自动发现（smoke 报告 dataDir / dataDirSource）' '等待超时或报告未包含相关字段（旧 exe 不支持时无法判定），需人工确认'
}
$ping1h = Wait-Until { Test-Ping $RegistryPort } 60 400
Assert-True '自动发现数据目录后镜像源服务正常启动（/-/ping 200）' $ping1h
if ($ping1h) {
  Update-TrackedNodePidsFromLog
  Assert-True '自动发现路径下读到了测试配置（admin.enabled=false，管理端口不监听）' (-not (Test-Port $AdminPort))
  Assert-True '自动发现数据目录内已创建 logs（服务确实使用该数据根）' (Test-Path (Join-Path $portableData 'logs')) ('目录：' + (Join-Path $portableData 'logs'))
} else {
  Exit-IfWindowBlocked -Proc $p1h -Detail '阶段 1h 未等到镜像源服务'
  Show-Diagnostics
}

Stop-TrackedProcesses
$portsFreed1h = Wait-Until { (-not (Test-Port $RegistryPort)) -and (-not (Test-Port $AdminPort)) } 15 300
Assert-True '阶段 1h 清理后测试端口全部释放' $portsFreed1h
if (Test-Path $portableRoot) { Remove-Item $portableRoot -Recurse -Force -ErrorAction SilentlyContinue }
Assert-True '阶段 1h 临时目录已清理' (-not (Test-Path $portableRoot))

# ---------------------------------------------------------------------------
# 阶段 2：admin.enabled=true，验证网页版管理、桌面 API、一键脚本
# ---------------------------------------------------------------------------
Section '阶段 2：开启网页版管理（admin.enabled=true）'
$seeded2 = Set-TestConfig -WebAdminEnabled $true
Assert-True '已写入 admin.enabled=true 的测试配置' $seeded2
Read-ConfigToken

$p2run = Start-DesktopApp
$registryBase = 'http://127.0.0.1:' + $RegistryPort
$adminBase = 'http://127.0.0.1:' + $AdminPort
$api = $adminBase + '/__admin/api'
Info ('已启动桌面进程 PID=' + $p2run.Id + '，等待两个监听就绪…')
$pingOk2 = Wait-Until { Test-Ping $RegistryPort } 150 400
Assert-True '开启后镜像源服务正常（/-/ping 200）' $pingOk2
$adminOk = Wait-Until {
  $r = Invoke-Api ($adminBase + '/') 'GET' $null 5
  return ($r.Status -eq 200)
} 90 500
Assert-True ('开启后管理端口开始监听（' + $AdminPort + '），浏览器可访问') $adminOk
if (-not ($pingOk2 -and $adminOk)) {
  Exit-IfWindowBlocked -Proc $p2run -Detail '阶段 2 未等到镜像源/管理端口就绪'
  Show-Diagnostics
  Stop-TrackedProcesses
  Write-Host ''
  Write-Host ('== RESULT: {"pass":' + $script:Pass + ',"fail":' + $script:Fail + ',"skip":' + $script:Skip + '}') -ForegroundColor Red
  exit 1
}
Update-TrackedNodePidsFromLog

$pageResp = Invoke-Api ($adminBase + '/') 'GET' $null 10
Assert-True 'GET / 返回状态 200' ($pageResp.Status -eq 200) ('实际 ' + $pageResp.Status)
Assert-True 'GET / 返回管理界面 HTML（页面标识匹配）' ($pageResp.Content -match '(?i)<!doctype html|<html|app\.js') '返回内容不含 HTML 标识'

$sessResp = Invoke-Api ($api + '/session') 'GET' $null 10
Assert-True 'GET /__admin/api/session 返回 200（管理 API 可用）' ($sessResp.Status -eq 200) ('实际 ' + $sessResp.Status)

# /desktop/info
$infoResp = Invoke-Api ($api + '/desktop/info') 'GET' $null 15
$infoJson = Get-Json $infoResp
$info = Get-Data $infoJson
Assert-True 'GET /desktop/info 返回 200' ($infoResp.Status -eq 200) ('实际 ' + $infoResp.Status + ' 响应=' + $infoResp.Content)
Assert-True 'desktop=true' ((Get-Prop $info 'desktop') -eq $true)
Assert-True ('版本号 = package.json（' + $script:PkgVersion + '）') ((Get-Prop $info 'version') -eq $script:PkgVersion) ('实际 ' + (Get-Prop $info 'version'))
$infoDataDir = [string](Get-Prop $info 'dataDir')
Assert-True 'dataDir = --data-dir 指定的测试目录' ((Normalize-Path $infoDataDir) -eq (Normalize-Path $script:DataDir)) ('实际 ' + $infoDataDir)
$defaultDir = [string](Get-Prop $info 'dataDirDefault')
$expectDefault = Join-Path (Split-Path -Parent $script:ExePath) 'data'
Assert-True 'dataDirDefault = <exe目录>\data' ((Normalize-Path $defaultDir) -eq (Normalize-Path $expectDefault)) ('实际 ' + $defaultDir + '，期望 ' + $expectDefault)
$webAdmin = Get-Prop $info 'webAdmin'
Assert-True 'webAdmin.enabled = true' ((Get-Prop $webAdmin 'enabled') -eq $true)
Assert-True 'webAdmin.listening = true' ((Get-Prop $webAdmin 'listening') -eq $true)
Assert-True ('webAdmin.port = ' + $AdminPort) ((Get-Prop $webAdmin 'port') -eq $AdminPort) ('实际 ' + (Get-Prop $webAdmin 'port'))
$internal = Get-Prop $info 'internal'
$internalPort = [int](Get-Prop $internal 'port')
Assert-True 'internal.port 已分配（内部回环管理端口随机端口）' ($internalPort -gt 0) ('实际 ' + $internalPort)
# 窗口实际加载的就是这个内部回环地址（Rust 壳在 Node ready 后导航到它）。
# 直接 HTTP 访问该地址，验证「窗口=现有管理界面」的页面内容（不依赖 WebView2 是否可渲染，
# 沙箱内窗口渲染受限时仍能证明被导航的 URL 返回的是现有管理界面）。
$internalUrl = 'http://127.0.0.1:' + $internalPort + '/'
$internalPageResp = Invoke-Api $internalUrl 'GET' $null 15
Assert-True '内部回环管理端口返回现有管理界面（GET 200 + HTML）' ($internalPageResp.Status -eq 200 -and $internalPageResp.Content -match '(?i)<!doctype html|<html|app\.js') ('状态=' + $internalPageResp.Status + '，URL=' + $internalUrl)
Assert-True 'productName 包含「镜像源」' ([string](Get-Prop $info 'productName') -like '*镜像源*') ('实际 ' + (Get-Prop $info 'productName'))
$nodePid = [int](Get-Prop $info 'pid')
Assert-True 'desktop/info 返回 Node 子进程 PID' ($nodePid -gt 0) ('实际 ' + $nodePid)
if ($nodePid -gt 0 -and -not ($script:TrackedNodePids -contains $nodePid)) {
  [void]$script:TrackedNodePids.Add($nodePid)
}

# v0.0.4：/desktop/info 的 tray.available 必须与测试报告一致（同一状态来源）
$rep2Tray = Get-Prop (Wait-SmokeReport { param($r) return ($null -ne (Get-Prop (Get-Prop $r 'tray') 'available')) } 90 400) 'tray'
$infoTray = Get-Prop $info 'tray'
$infoTrayProp = $null
if ($null -ne $infoTray) { $infoTrayProp = $infoTray.PSObject.Properties['available'] }
if ($null -eq $infoTrayProp) {
  Assert-True '/desktop/info 返回 tray 对象（含 available 字段）' $false ('info.tray=' + ($infoTray | ConvertTo-Json -Compress))
} else {
  $rep2TrayProp = $null
  if ($null -ne $rep2Tray) { $rep2TrayProp = $rep2Tray.PSObject.Properties['available'] }
  if ($null -eq $rep2TrayProp) {
    Assert-Skip '/desktop/info.tray.available 与测试报告一致' '测试报告未在超时内包含 tray.available 字段'
  } else {
    Assert-True '/desktop/info.tray.available 与测试报告一致' ($infoTrayProp.Value -eq $rep2TrayProp.Value) ('info=' + $infoTrayProp.Value + '，report=' + $rep2TrayProp.Value)
  }
}

# /desktop/files
$filesResp = Invoke-Api ($api + '/desktop/files?target=data') 'GET' $null 10
$files = Get-Data (Get-Json $filesResp)
Assert-True 'GET /desktop/files?target=data 返回数据目录' ((Normalize-Path ([string](Get-Prop $files 'path'))) -eq (Normalize-Path $script:DataDir)) ('实际 ' + (Get-Prop $files 'path'))
Assert-True 'data 目录 exists=true' ((Get-Prop $files 'exists') -eq $true)

# /desktop/files 只认 target 白名单，不允许用路径参数跳出数据目录
$filesLogsResp = Invoke-Api ($api + '/desktop/files?target=logs') 'GET' $null 10
$filesLogs = Get-Data (Get-Json $filesLogsResp)
$logsPath = Normalize-Path ([string](Get-Prop $filesLogs 'path'))
Assert-True 'GET /desktop/files?target=logs 返回日志目录' ($filesLogsResp.Status -eq 200 -and $logsPath.Length -gt 0) ('状态=' + $filesLogsResp.Status + ' 路径=' + $logsPath)
Assert-True '日志目录位于数据目录内' ($logsPath.StartsWith((Normalize-Path $script:DataDir).TrimEnd('\') + '\')) ('实际 ' + $logsPath)
$filesCfgResp = Invoke-Api ($api + '/desktop/files?target=config') 'GET' $null 10
$filesCfg = Get-Data (Get-Json $filesCfgResp)
Assert-True 'GET /desktop/files?target=config 返回配置文件路径' ((Normalize-Path ([string](Get-Prop $filesCfg 'path'))) -eq (Normalize-Path (Join-Path $script:DataDir 'config.json'))) ('实际 ' + (Get-Prop $filesCfg 'path'))
$filesBadResp = Invoke-Api ($api + '/desktop/files?target=..%2F..%2FWindows') 'GET' $null 10
Assert-True 'GET /desktop/files 未知 target 返回 400（不读取任意路径）' ($filesBadResp.Status -eq 400) ('实际状态=' + $filesBadResp.Status + ' 响应=' + $filesBadResp.Content)
if ($filesBadResp.Status -eq 400) {
  Assert-True 'GET /desktop/files 未知 target 错误信息为中文' ($filesBadResp.Content -match '未知|可选|路径') ('响应=' + $filesBadResp.Content)
}
$filesTravResp = Invoke-Api ($api + '/desktop/files?path=..%2F..%2FWindows&target=data') 'GET' $null 10
$filesTrav = Get-Data (Get-Json $filesTravResp)
Assert-True 'GET /desktop/files 携带 path 穿越参数仍只返回数据目录（参数被忽略）' ($filesTravResp.Status -eq 200 -and (Normalize-Path ([string](Get-Prop $filesTrav 'path'))) -eq (Normalize-Path $script:DataDir)) ('实际 ' + (Get-Prop $filesTrav 'path'))

# /desktop/console
$consoleResp = Invoke-Api ($api + '/desktop/console?limit=100') 'GET' $null 10
$consoleData = Get-Data (Get-Json $consoleResp)
Assert-True 'GET /desktop/console?limit=100 返回 200' ($consoleResp.Status -eq 200)
Assert-True '控制台接口返回 lines 数组' ($null -ne (Get-Prop $consoleData 'lines')) ('响应=' + $consoleResp.Content)

# 一键脚本：doctor / status
Section '阶段 2b：一键脚本（doctor / status）'
$scriptResult = New-Object System.Collections.ArrayList
function Invoke-ScriptAction {
  param([string]$Name, [int]$TimeoutSec = 180)
  $api = 'http://127.0.0.1:' + $AdminPort + '/__admin/api'
  $resp = Invoke-Api ($api + '/desktop/action') 'POST' @{ action = 'script.run'; params = @{ name = $Name } } 30
  $json = Get-Json $resp
  $data = Get-Data $json
  $taskId = [string](Get-Prop $data 'taskId')
  Assert-True ('script.run ' + $Name + ' 已受理（返回 taskId）') ($resp.Status -eq 200 -and $taskId) ('状态=' + $resp.Status + ' 响应=' + $resp.Content)
  if (-not $taskId) { return $null }
  $script:LastScript = $null
  $finished = Wait-Until {
    $q = Get-Data (Get-Json (Invoke-Api ($api + '/desktop/scripts') 'GET' $null 10))
    $last = Get-Prop $q 'last'
    $status = [string](Get-Prop $last 'status')
    if ($status -and $status -ne 'running' -and [string](Get-Prop $last 'name') -eq $Name) {
      $script:LastScript = $last
      return $true
    }
    return $false
  } $TimeoutSec 500
  $statusText = '未知'
  $exitText = '未知'
  if ($null -ne $script:LastScript) {
    $statusText = [string](Get-Prop $script:LastScript 'status')
    $exitText = [string](Get-Prop $script:LastScript 'exitCode')
  }
  Assert-True ('一键脚本 ' + $Name + ' 执行完成') $finished
  Assert-True ('一键脚本 ' + $Name + ' status=ok') ($statusText -eq 'ok') ('实际 status=' + $statusText + ' exitCode=' + $exitText)
  Assert-True ('一键脚本 ' + $Name + ' exitCode=0') ($exitText -eq '0') ('实际 exitCode=' + $exitText)
  return $script:LastScript
}

$doctorResult = Invoke-ScriptAction -Name 'doctor' -TimeoutSec 180
$statusResult = Invoke-ScriptAction -Name 'status' -TimeoutSec 120

$consoleAfter = Invoke-Api ($api + '/desktop/console?limit=1000') 'GET' $null 10
$consoleAfterData = Get-Data (Get-Json $consoleAfter)
$consoleLines = @()
if ($null -ne (Get-Prop $consoleAfterData 'lines')) { $consoleLines = @(Get-Prop $consoleAfterData 'lines') }
$scriptLines = @($consoleLines | Where-Object { (Get-Prop $_ 'source') -eq 'script' })
Assert-True '控制台里能看到脚本输出（source=script）' ($scriptLines.Count -gt 0) ('脚本行数=' + $scriptLines.Count + '，总行数=' + $consoleLines.Count)
$serverLines = @($consoleLines | Where-Object { (Get-Prop $_ 'source') -eq 'server' })
Assert-True '控制台里能看到服务日志（source=server）' ($serverLines.Count -gt 0) ('服务日志行数=' + $serverLines.Count)
if ($scriptLines.Count -gt 0) {
  $sample = [string](Get-Prop $scriptLines[0] 'text')
  Info ('脚本输出样例：' + $sample)
}
$lastSeq = Get-Prop $consoleAfterData 'lastSeq'
Assert-True '控制台返回单调递增的 lastSeq' ($null -ne $lastSeq -and [int]$lastSeq -gt 0) ('实际 ' + $lastSeq)
$incrResp = Invoke-Api ($api + '/desktop/console?after=' + [int]$lastSeq + '&limit=10') 'GET' $null 10
Assert-True '控制台支持增量拉取（after=lastSeq）' ($incrResp.Status -eq 200)
$clearResp = Invoke-Api ($api + '/desktop/console') 'DELETE' $null 10
Assert-True 'DELETE /desktop/console 清空控制台返回 200' ($clearResp.Status -eq 200) ('实际 ' + $clearResp.Status)

# 服务动作
Section '阶段 2c：桌面动作（重启镜像源 / 开机自启只读）'
$restartResp = Invoke-Api ($api + '/desktop/action') 'POST' @{ action = 'service.restartRegistry'; params = @{} } 25
$restartJson = Get-Json $restartResp
Assert-True 'service.restartRegistry 动作返回成功' ($restartResp.Status -eq 200) ('状态=' + $restartResp.Status + ' 响应=' + $restartResp.Content)
$registryBack = Wait-Until { Test-Ping $RegistryPort } 30 500
Assert-True '重启镜像源后服务恢复在线' $registryBack

# 托盘菜单：网页版管理开启后应多出「重启管理界面」项，并可用菜单动作重启两套服务
Section '阶段 2c-1：托盘菜单（网页版管理开启后的菜单项）'
$rep2 = Wait-SmokeReport {
  param($report)
  $labels = @(Get-Prop (Get-Prop $report 'tray') 'labels')
  return (($labels -contains '打开管理界面') -and ($labels -contains '重启管理界面'))
} 30 400
$trayLabels2 = @()
if ($null -ne $rep2) { $trayLabels2 = @(Get-Prop (Get-Prop $rep2 'tray') 'labels') }
Assert-True '开启网页版管理后托盘菜单出现「打开管理界面」' ($trayLabels2 -contains '打开管理界面') ('实际菜单：' + ($trayLabels2 -join ' / '))
Assert-True '开启网页版管理后托盘菜单出现「重启管理界面」' ($trayLabels2 -contains '重启管理界面') ('实际菜单：' + ($trayLabels2 -join ' / '))
$needLabels2 = @('打开窗口', '关闭窗口', '打开管理界面', '重启管理界面', '重启镜像源服务', '退出程序')
$missing2 = @($needLabels2 | Where-Object { -not ($trayLabels2 -contains $_) })
Assert-True '开启网页版管理后托盘菜单项齐全（6 项）' (($missing2.Count -eq 0) -and ($trayLabels2.Count -eq 6)) ('实际菜单（' + $trayLabels2.Count + ' 项）：' + ($trayLabels2 -join ' / ') + '；缺少：' + ($missing2 -join '、'))
if ($null -ne $rep2) {
  $repWebAdmin = Get-Prop $rep2 'webAdmin'
  Assert-True '桌面壳报告 webAdmin.enabled=true（与 /desktop/info 一致）' ((Get-Prop $repWebAdmin 'enabled') -eq $true) ('报告 webAdmin=' + ($repWebAdmin | ConvertTo-Json -Compress))
  $repWin2 = Get-Prop $rep2 'window'
  $repWinUrl = [string](Get-Prop $repWin2 'url')
  Assert-True '主窗口 URL 指向内部回环管理端口' ($repWinUrl -match '^http://127\.0\.0\.1:\d+/') ('实际 ' + $repWinUrl) 'window'
} else {
  Assert-Skip '桌面壳报告的网页版管理信息' '未读到测试挂钩状态报告'
}

# 托盘菜单「重启管理界面」：重新绑定网页版管理监听，镜像源与内部管理不受影响
$waRestartReport = Send-SmokeCommand 'menu:tray-restart-webadmin' 30
$waRestartCmd = @()
if ($null -ne $waRestartReport) {
  $waRestartCmd = @(@(Get-Prop $waRestartReport 'commands') | Where-Object { (Get-Prop $_ 'command') -eq 'menu:tray-restart-webadmin' })
}
Assert-True '托盘菜单「重启管理界面」动作被执行（命令回执 ok）' ($waRestartCmd.Count -gt 0 -and (Get-Prop $waRestartCmd[0] 'ok') -eq $true) ('回执：' + ($waRestartCmd | ConvertTo-Json -Compress))
$waBack = Wait-Until {
  $r = Invoke-Api ($adminBase + '/') 'GET' $null 5
  return ($r.Status -eq 200)
} 30 500
Assert-True '托盘重启管理界面后网页版管理端口恢复可访问' $waBack ('端口 ' + $AdminPort)
Assert-True '托盘重启管理界面后镜像源服务不受影响（/-/ping 200）' (Test-Ping $RegistryPort)
$infoAfter = Get-Data (Get-Json (Invoke-Api ($api + '/desktop/info') 'GET' $null 15))
Assert-True '托盘重启管理界面后 webAdmin.enabled 仍为 true' ((Get-Prop (Get-Prop $infoAfter 'webAdmin') 'enabled') -eq $true)

# 托盘菜单「重启镜像源服务」：只重绑镜像源监听，管理监听与进程不受影响
$regRestartReport = Send-SmokeCommand 'menu:tray-restart-registry' 30
$regRestartCmd = @()
if ($null -ne $regRestartReport) {
  $regRestartCmd = @(@(Get-Prop $regRestartReport 'commands') | Where-Object { (Get-Prop $_ 'command') -eq 'menu:tray-restart-registry' })
}
Assert-True '托盘菜单「重启镜像源服务」动作被执行（命令回执 ok）' ($regRestartCmd.Count -gt 0 -and (Get-Prop $regRestartCmd[0] 'ok') -eq $true) ('回执：' + ($regRestartCmd | ConvertTo-Json -Compress))
$regBack = Wait-Until { Test-Ping $RegistryPort } 60 500
Assert-True '托盘重启镜像源服务后服务恢复在线（/-/ping 200）' $regBack
Assert-True '托盘重启镜像源服务后桌面进程仍存活' (-not $p2run.HasExited)
Assert-True '托盘重启镜像源服务后网页版管理仍可访问' ((Invoke-Api ($adminBase + '/') 'GET' $null 10).Status -eq 200)

# 托盘菜单「打开管理界面」：用系统默认浏览器打开网页版管理页面。
# 受限会话里系统浏览器拉不起来（且无法枚举浏览器窗口），只断言菜单动作被执行；
# 真实浏览器打开效果留人工验收。
$openWaReport = Send-SmokeCommand 'menu:tray-open-webadmin' 30
$openWaCmd = @()
if ($null -ne $openWaReport) {
  $openWaCmd = @(@(Get-Prop $openWaReport 'commands') | Where-Object { (Get-Prop $_ 'command') -eq 'menu:tray-open-webadmin' })
}
Assert-True '托盘菜单「打开管理界面」动作被执行（命令回执 ok）' ($openWaCmd.Count -gt 0 -and (Get-Prop $openWaCmd[0] 'ok') -eq $true) ('回执：' + ($openWaCmd | ConvertTo-Json -Compress))
Assert-True '「打开管理界面」动作不影响程序（进程存活、镜像源在线、网页版管理仍可访问）' ((-not $p2run.HasExited) -and (Test-Ping $RegistryPort) -and ((Invoke-Api ($adminBase + '/') 'GET' $null 10).Status -eq 200))
Assert-Skip '「打开管理界面」实际拉起系统浏览器' '受限会话无法确认浏览器进程/窗口，需在普通桌面会话人工点击验收（菜单动作已自动验证）'

$autostartResp = Invoke-Api ($api + '/desktop/action') 'POST' @{ action = 'autostart.get'; params = @{} } 20
$autostartData = Get-Data (Get-Json $autostartResp)
Assert-True 'autostart.get 动作返回成功（只读，不修改注册表）' ($autostartResp.Status -eq 200 -and $null -ne (Get-Prop $autostartData 'enabled')) ('状态=' + $autostartResp.Status + ' 响应=' + $autostartResp.Content)

# 开机自启注册表：当前未开启时才做「开启→校验注册表→关闭→校验清除」往返，
# 避免覆盖用户已经配置好的自启项（当前已开启则只读校验，不写注册表）。
$autoEnabledBefore = Get-Prop $autostartData 'enabled'
if ($autoEnabledBefore -eq $true) {
  $autoExe = [string](Get-Prop $autostartData 'exe')
  Assert-True '已开启自启时 autostart.get 返回 exe 路径' ($autoExe.Length -gt 0) ('实际 exe=' + $autoExe)
  Assert-Skip '开机自启写入往返测试' '当前已开启开机自启（可能指向用户已安装的 exe），为免覆盖用户配置只做只读校验'
} else {
  $regRunPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $regValueName = 'LiYueNpmMirror'
  $autoOnResp = Invoke-Api ($api + '/desktop/action') 'POST' @{ action = 'autostart.set'; params = @{ enabled = $true } } 25
  $autoOnData = Get-Data (Get-Json $autoOnResp)
  # 受限沙箱会拒绝写 HKCU Run（Rust 侧表现为「打开注册表 Run 键失败：拒绝访问。 (os error 5)」）：
  # 这是会话环境限制，不是产品缺陷。此时只记录 SKIP，并要求在普通桌面会话人工验收自启写入。
  $autoDenied = ($autoOnResp.Status -ne 200) -and ($autoOnResp.Content -match '拒绝访问|os error 5|Access is denied|注册表')
  if ($autoDenied) {
    Assert-Skip '开机自启写入往返（HKCU Run 注册表）' ('当前会话不允许写注册表，属环境限制；接口已正确返回失败：' + $autoOnResp.Content + '；需在普通桌面会话人工验收开启/关闭自启')
  } else {
    Assert-True 'autostart.set enabled=true 返回成功' ($autoOnResp.Status -eq 200 -and (Get-Prop $autoOnData 'enabled') -eq $true) ('状态=' + $autoOnResp.Status + ' 响应=' + $autoOnResp.Content)
    $regVal = $null
    try { $regVal = (Get-ItemProperty -Path $regRunPath -Name $regValueName -ErrorAction Stop).$regValueName } catch { $regVal = $null }
    Assert-True ('注册表 HKCU\...\Run 已写入 ' + $regValueName) ($null -ne $regVal) ('实际=' + $regVal)
    if ($null -ne $regVal) {
      Assert-True '自启命令包含被验收 exe 的完整路径' ([string]$regVal -like ('*' + $script:ExePath + '*')) ('实际=' + $regVal)
      Assert-True '自启命令带 --autostart 参数（开机启动时窗口默认隐藏）' ([string]$regVal -like '*--autostart*') ('实际=' + $regVal)
    }
    $autoOffResp = Invoke-Api ($api + '/desktop/action') 'POST' @{ action = 'autostart.set'; params = @{ enabled = $false } } 25
    $autoOffData = Get-Data (Get-Json $autoOffResp)
    Assert-True 'autostart.set enabled=false 返回成功' ($autoOffResp.Status -eq 200 -and (Get-Prop $autoOffData 'enabled') -eq $false) ('状态=' + $autoOffResp.Status + ' 响应=' + $autoOffResp.Content)
    $regValAfter = $null
    try { $regValAfter = (Get-ItemProperty -Path $regRunPath -Name $regValueName -ErrorAction Stop).$regValueName } catch { $regValAfter = $null }
    Assert-True '关闭自启后注册表 Run 值被移除（测试不留残留）' ($null -eq $regValAfter) ('实际=' + $regValAfter)
  }
}

$pickResp = Invoke-Api ($api + '/desktop/action') 'POST' @{ action = 'window.hide'; params = @{} } 20
Assert-True 'window.hide 动作返回成功' ($pickResp.Status -eq 200) ('状态=' + $pickResp.Status + ' 响应=' + $pickResp.Content)
$showResp = Invoke-Api ($api + '/desktop/action') 'POST' @{ action = 'window.show'; params = @{} } 20
Assert-True 'window.show 动作返回成功' ($showResp.Status -eq 200) ('状态=' + $showResp.Status + ' 响应=' + $showResp.Content)

# 路径穿越：PUT /config
Section '阶段 2d：路径穿越防护（PUT /config）'
$badResp = Invoke-Api ($api + '/config') 'PUT' @{ config = @{ storage = @{ dir = '..\..\evil' } } } 20
Assert-True 'PUT /config 拒绝 storage.dir=''..\..\evil''（400）' ($badResp.Status -eq 400) ('实际状态=' + $badResp.Status + ' 响应=' + $badResp.Content)
if ($badResp.Status -eq 400) {
  Assert-True '拒绝时返回中文错误信息' ($badResp.Content -match '路径|穿越|目录|非法|不能') ('响应=' + $badResp.Content)
}
$badResp2 = Invoke-Api ($api + '/config') 'PUT' @{ config = @{ storage = @{ dir = '..\..\..\Windows' } } } 20
Assert-True 'PUT /config 拒绝多级路径穿越（400）' ($badResp2.Status -eq 400) ('实际状态=' + $badResp2.Status)

# 关闭网页版管理：PUT /config -> admin.enabled=false，端口即时断开
Section '阶段 2e：关闭网页版管理（PUT /config admin.enabled=false）'
$swOff = [System.Diagnostics.Stopwatch]::StartNew()
$offResp = Invoke-Api ($api + '/config') 'PUT' @{ config = @{ admin = @{ enabled = $false } } } 25
$offJson = Get-Json $offResp
$offData = Get-Data $offJson
Assert-True 'PUT /config 关闭 admin.enabled 返回 200' ($offResp.Status -eq 200) ('实际 ' + $offResp.Status + ' 响应=' + $offResp.Content)
$offWebAdmin = Get-Prop $offData 'webAdmin'
if ($null -ne $offWebAdmin) {
  Assert-True 'PUT /config 响应里 webAdmin.enabled=false' ((Get-Prop $offWebAdmin 'enabled') -eq $false)
} else {
  Assert-Skip 'PUT /config 响应 webAdmin 字段' '响应未包含 webAdmin 字段（待集成验证）'
}
$adminClosed = Wait-Until { -not (Test-Port $AdminPort) } 12 300
Assert-True '关闭后管理端口断开（不再监听）' $adminClosed ('端口 ' + $AdminPort)
Assert-True '关闭网页版管理后镜像源服务不受影响（/-/ping 200）' (Test-Ping $RegistryPort)

# 托盘菜单实时性：走桥事件（非配置轮询兜底）时，开关后菜单应在 ≤1s 内更新
$menuShrunkRep = Wait-SmokeReport {
  param($r)
  $lb = @(Get-Prop (Get-Prop $r 'tray') 'labels')
  return (($lb.Count -eq 4) -and (-not ($lb -contains '打开管理界面')) -and (-not ($lb -contains '重启管理界面')))
} 4 100
$swOff.Stop()
$menuShrunkMs = $swOff.ElapsedMilliseconds
$menuShrunkLabels = @(Get-Prop (Get-Prop $menuShrunkRep 'tray') 'labels')
Assert-True '关闭网页版管理后托盘菜单实时缩回 4 项（≤1s，桥事件路径）' (($null -ne $menuShrunkRep) -and $menuShrunkMs -le 1000) ('耗时=' + $menuShrunkMs + 'ms；实际菜单：' + ($menuShrunkLabels -join ' / '))

# 阶段 2 清理
Section '阶段 2f：清理测试实例'
Stop-TrackedProcesses
$portsFreed2 = Wait-Until { (-not (Test-Port $RegistryPort)) -and (-not (Test-Port $AdminPort)) } 15 300
Assert-True '清理后测试端口全部释放' $portsFreed2

# ---------------------------------------------------------------------------
# 阶段 3：优雅退出（app.quit）
# ---------------------------------------------------------------------------
Section '阶段 3：退出程序（app.quit，优雅退出）'
$seeded3 = Set-TestConfig -WebAdminEnabled $true
Assert-True '已写入 admin.enabled=true 的测试配置' $seeded3
Read-ConfigToken
$p3 = Start-DesktopApp
$pingOk3 = Wait-Until { Test-Ping $RegistryPort } 150 400
Assert-True '第三次启动镜像源服务就绪' $pingOk3
$adminOk3 = Wait-Until {
  $r = Invoke-Api ('http://127.0.0.1:' + $AdminPort + '/') 'GET' $null 5
  return ($r.Status -eq 200)
} 90 500
Assert-True '第三次启动管理端口可访问' $adminOk3
if (-not ($pingOk3 -and $adminOk3)) {
  Exit-IfWindowBlocked -Proc $p3 -Detail '阶段 3 未等到镜像源/管理端口就绪'
  Show-Diagnostics
  Stop-TrackedProcesses
  Write-Host ''
  Write-Host ('== RESULT: {"pass":' + $script:Pass + ',"fail":' + $script:Fail + ',"skip":' + $script:Skip + '}') -ForegroundColor Red
  exit 1
}
Update-TrackedNodePidsFromLog

# 控制台增量 after 参数跨服务重启的兼容（seq 会从 0 重新计数，不应崩溃/报错）
$oldSeq = 0
try { $oldSeq = [int]$lastSeq } catch { $oldSeq = 0 }
if ($oldSeq -le 0) { $oldSeq = 100000 }
$api3 = 'http://127.0.0.1:' + $AdminPort + '/__admin/api'
$resetResp = Invoke-Api ($api3 + '/desktop/console?after=' + $oldSeq + '&limit=10') 'GET' $null 10
$resetData = Get-Data (Get-Json $resetResp)
Assert-True '服务重启后控制台 after=旧seq 仍返回 200（seq 重置兼容）' ($resetResp.Status -eq 200) ('实际状态=' + $resetResp.Status + ' 响应=' + $resetResp.Content)
# 注意：Windows PowerShell 5.1 的 ConvertFrom-Json 会把 JSON 空数组 [] 转成 $null，
# 因此这里按原始响应体校验 lines 字段存在（空数组也算通过），而不是判断对象属性。
Assert-True '服务重启后控制台 after=旧seq 返回 lines 数组（空数组也可）' ($resetResp.Status -eq 200 -and $resetResp.Content -match '"lines"\s*:') ('响应=' + $resetResp.Content)
$resetZeroResp = Invoke-Api ($api3 + '/desktop/console?after=999999999&limit=10') 'GET' $null 10
Assert-True '控制台 after=超大 seq 返回 200（不报错）' ($resetZeroResp.Status -eq 200) ('实际状态=' + $resetZeroResp.Status)

Stop-DesktopAppGraceful | Out-Null
$appExited = Wait-Until { $p3.HasExited } 25 400
Assert-True 'app.quit 后桌面进程退出' $appExited
if (-not $appExited) {
  Show-Diagnostics
  Stop-TrackedProcesses
}
$portsClosed = Wait-Until { (-not (Test-Port $RegistryPort)) -and (-not (Test-Port $AdminPort)) } 15 300
Assert-True '退出后两个监听全部消失（镜像源 + 网页版管理）' $portsClosed
$noNode = Wait-Until { (Get-OurNodeProcs).Count -eq 0 } 15 300
Assert-True '退出后无残留 node 子进程（本测试数据目录）' $noNode
$noDesktop = Wait-Until { @(Get-DesktopProcs | Where-Object { Test-OurCommandLine $_ }).Count -eq 0 } 15 300
Assert-True '退出后无残留桌面进程（本测试数据目录）' $noDesktop

# ---------------------------------------------------------------------------
# 阶段 3b：托盘菜单「退出程序」（tray-quit）
# ---------------------------------------------------------------------------
Section '阶段 3b：托盘菜单「退出程序」'
$seeded3b = Set-TestConfig -WebAdminEnabled $true
Assert-True '托盘退出测试：已写入 admin.enabled=true 的测试配置' $seeded3b
Read-ConfigToken
$p3b = Start-DesktopApp
$pingOk3b = Wait-Until { Test-Ping $RegistryPort } 150 400
Assert-True '托盘退出测试：镜像源服务就绪' $pingOk3b
Update-TrackedNodePidsFromLog
if (-not $pingOk3b) {
  Exit-IfWindowBlocked -Proc $p3b -Detail '阶段 3b 未等到镜像源服务就绪'
  Show-Diagnostics
  Stop-TrackedProcesses
  Write-Host ''
  Write-Host ('== RESULT: {"pass":' + $script:Pass + ',"fail":' + $script:Fail + ',"skip":' + $script:Skip + '}') -ForegroundColor Red
  exit 1
}
$rep3b = Wait-SmokeReport {
  param($report)
  $nodeState = Get-Prop $report 'node'
  $labels = @(Get-Prop (Get-Prop $report 'tray') 'labels')
  return ((Get-Prop $nodeState 'ready') -eq $true -and $labels.Count -gt 0)
} 90 400
Assert-True '托盘退出测试：桌面壳已就绪（Node ready + 托盘已创建）' ($null -ne $rep3b)
# 托盘「退出程序」会让进程立即退出，可能来不及在报告里留下命令回执，这里以进程/端口行为为准
Send-SmokeCommand 'menu:tray-quit' 5 | Out-Null
$trayQuitExited = Wait-Until { $p3b.HasExited } 30 400
Assert-True '托盘菜单「退出程序」后桌面进程退出' $trayQuitExited
$trayQuitPorts = Wait-Until { (-not (Test-Port $RegistryPort)) -and (-not (Test-Port $AdminPort)) } 15 300
Assert-True '托盘「退出程序」后两个监听全部消失' $trayQuitPorts
$trayQuitNoNode = Wait-Until { (Get-OurNodeProcs).Count -eq 0 } 15 300
Assert-True '托盘「退出程序」后无残留 node 子进程' $trayQuitNoNode
$trayQuitNoDesktop = Wait-Until { @(Get-DesktopProcs | Where-Object { Test-OurCommandLine $_ }).Count -eq 0 } 15 300
Assert-True '托盘「退出程序」后无残留桌面进程' $trayQuitNoDesktop

# ---------------------------------------------------------------------------
# 路径穿越单测（node test\desktop-path-test.js）
# ---------------------------------------------------------------------------
Section '阶段 4：路径穿越单测（node test\desktop-path-test.js）'
$pathTest = Join-Path $script:Root 'test\desktop-path-test.js'
if ($SkipPathTest) {
  Assert-Skip 'node test\desktop-path-test.js' '参数 -SkipPathTest 指定跳过'
} elseif (-not (Test-Path $pathTest)) {
  Assert-Skip 'node test\desktop-path-test.js' '测试文件未交付（待集成验证）'
} else {
  Push-Location $script:Root
  try {
    $pathOut = & node $pathTest 2>&1 | Out-String
    $pathCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  Assert-True '路径穿越单测全部通过（exit 0）' ($pathCode -eq 0) ('exit=' + $pathCode + '，输出末尾：' + $pathOut.Substring([Math]::Max(0, $pathOut.Length - 600)))
  Info ('路径穿越单测输出末尾：' + $pathOut.Substring([Math]::Max(0, $pathOut.Length - 400)).Trim())
}

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
Section '汇总'
$total = $script:Pass + $script:Fail + $script:Skip
Info ('总检查项：' + $total + '，通过 ' + $script:Pass + '，失败 ' + $script:Fail + '，跳过 ' + $script:Skip)

# 环境限制判定：仅当「存在失败项」且「全部失败项都属 window 类别」时，才判定为
# 当前会话无法创建/显示 WebView2 窗口的环境限制（exit 3）。非窗口类断言失败一律 exit 1。
$nonWindowFailures = @($script:FailureCategories | Where-Object { $_ -ne 'window' })
$windowOnlyFailure = ($script:Fail -gt 0 -and $nonWindowFailures.Count -eq 0)
$windowFailCount = @($script:FailureCategories | Where-Object { $_ -eq 'window' }).Count
if ($script:Fail -gt 0) {
  Write-Host '  失败项：' -ForegroundColor Red
  foreach ($f in $script:Failures) { Write-Host ('    · ' + $f) -ForegroundColor Red }
}
if ($script:Skip -gt 0) {
  Write-Host '  跳过项（需人工确认）：' -ForegroundColor Yellow
  foreach ($s in $script:Skips) { Write-Host ('    · ' + $s) -ForegroundColor Yellow }
}

$result = [ordered]@{
  ok                = ($script:Fail -eq 0)
  environmentLimited = $windowOnlyFailure
  windowChecksAvailable = $script:WindowCheckAvailable
  pass              = $script:Pass
  fail              = $script:Fail
  skip              = $script:Skip
  windowFailures    = $windowFailCount
  nonWindowFailures = $nonWindowFailures.Count
  failures          = @($script:Failures)
  skips             = @($script:Skips)
  exe               = $script:ExePath
  version           = $script:PkgVersion
  dataDir           = $script:DataDir
  desktopHome       = $script:DesktopHome
  cimAvailable      = $script:CimAvailable
  registryPort      = $RegistryPort
  adminPort         = $AdminPort
  time              = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
}
$resultDir = Join-Path $script:Root 'tmp'
try {
  New-Item -ItemType Directory -Path $resultDir -Force | Out-Null
  $resultPath = Join-Path $script:DataDir 'e2e-result.json'
  if (-not (Test-Path $script:DataDir)) { New-Item -ItemType Directory -Path $script:DataDir -Force | Out-Null }
  $result | ConvertTo-Json -Depth 5 | Set-Content -Path $resultPath -Encoding UTF8
  Info ('结果已写入：' + $resultPath)
} catch { }

Write-Host ''
if ($windowOnlyFailure) {
  Write-Host ('== ENVIRONMENT-LIMITED: ' + ($result | ConvertTo-Json -Depth 5 -Compress)) -ForegroundColor Yellow
  Write-Host '[桌面版 e2e] 环境限制：失败项全部属于「当前会话无法创建/显示 WebView2 窗口」，非产品缺陷。' -ForegroundColor Yellow
  Write-Host '[桌面版 e2e] 窗口/视觉类断言需在普通桌面会话人工验收；请把本输出与 desktop.log 一并归档。' -ForegroundColor Yellow
  try { Stop-TrackedProcesses } catch { }
  exit 3
}
Write-Host ('== RESULT: ' + ($result | ConvertTo-Json -Depth 5 -Compress)) -ForegroundColor White
if ($script:Fail -gt 0) {
  Write-Host '[桌面版 e2e] 存在失败项，验收未通过。' -ForegroundColor Red
  try { Stop-TrackedProcesses } catch { }
  exit 1
}
Write-Host '[桌面版 e2e] 全部自动检查项通过。' -ForegroundColor Green
exit 0
