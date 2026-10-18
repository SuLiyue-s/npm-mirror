# ============================================================
#  私人 npm 镜像源 · Windows 托盘宿主（零依赖，只用系统自带的 PowerShell）
#
#  由「启动镜像源.cmd」在后台拉起，负责：
#    · 两个独立监听：镜像源服务 server.ip:server.port（npm registry 协议）、
#                    管理界面   admin.ip:admin.port  （管理页面 + /__admin/api/*）
#    · 等管理界面就绪后，把命令行窗口隐藏到右下角托盘，并注册项目图标（public\favicon.ico）
#    · 左键单击图标 = 打开管理界面（网页端控制台）
#    · 右键菜单根据命令行窗口当前是显示还是隐藏，动态改变第一项，其余固定：
#        显示中：【隐藏控制台】【打开管理界面】【重启管理界面】【重启镜像源服务】【退出镜像源】
#        隐藏中：【打开控制台】【打开管理界面】【重启管理界面】【重启镜像源服务】【退出镜像源】
#    · 打开管理界面 = 用系统默认浏览器打开管理界面监听（admin.ip:admin.port）
#    · 重启管理界面 = 只调管理接口重建管理界面监听；镜像源服务与托盘都不受影响
#      （管理页面会短暂断连，恢复后刷新即可）
#    · 重启镜像源服务 = 只调管理接口重建镜像源监听；管理界面不中断（数据/配置都不变）
#    · 退出镜像源 = 调管理接口优雅停止服务 → 关闭命令行窗口 → 托盘图标消失
#    · 服务被外部停止（比如双击「停止镜像源.cmd」）时，图标自动退出
#
#  用法（一般不用手动执行）：
#    powershell -NoProfile -ExecutionPolicy Bypass -File tools\tray.ps1
#  自检（不注册托盘，只校验图标、菜单文案与 Win32 调用是否正常，输出 JSON）：
#    powershell -NoProfile -ExecutionPolicy Bypass -File tools\tray.ps1 -SelfTest
#
#  注意：本文件必须保存为「UTF-8 带 BOM」，否则 Windows PowerShell 5.1
#        会把中文菜单文案读成乱码。
# ============================================================
[CmdletBinding()]
param(
  # 项目根目录。默认留空，由下面的脚本体用 $PSScriptRoot 推算——
  # Windows PowerShell 5.1 在 param() 默认值里还拿不到 $PSScriptRoot（会是空串），
  # 所以不能写成 [string]$Root = (Split-Path -Parent $PSScriptRoot)。
  [string]$Root = '',
  [int]$WaitSeconds = 60,
  [switch]$SelfTest,
  # 自检结果写到这个文件（沙箱/无管道环境下抓不到子进程 stdout，用写文件代替）
  [string]$SelfTestOut = ''
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 的 Invoke-WebRequest 默认会画进度条：托盘常驻后台、控制台可能不可见时，
# 读取控制台输出缓冲区会抛 HostException（Access is denied），让所有探活误判为失败——直接关掉进度条。
$ProgressPreference = 'SilentlyContinue'
if (-not $Root) {
  if (-not $PSScriptRoot) {
    [Console]::Error.WriteLine('无法确定项目根目录：请用 -File 方式运行 tray.ps1，或显式传 -Root <项目目录>')
    exit 2
  }
  $Root = Split-Path -Parent $PSScriptRoot
}
$Root = [System.IO.Path]::GetFullPath($Root)

# ---------- 小工具：写诊断日志（托盘是后台进程，出问题时便于排查） ----------
$script:LogFile = Join-Path $Root 'data\logs\tray.log'
function Write-TrayLog([string]$Text) {
  try {
    $dir = Split-Path -Parent $script:LogFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'), $Text)
    [System.IO.File]::AppendAllText($script:LogFile, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
  } catch { /* 日志写不进去不影响主流程 */ }
}

# 启动脚本在「服务已经在运行」时补拉起托盘（恢复被关掉/崩掉的图标），此时会设置 MIRROR_TRAY_RESTORE=1。
# 用它区分「补注册」和「正常启动」：正常启动时服务是随后才起来的，不能只看 data\mirror.pid 判断。
$script:RestoreMode = ($env:MIRROR_TRAY_RESTORE -eq '1')

# ---------- Win32 ----------
if (-not ('MirrorTrayNative' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MirrorTrayNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint GetConsoleTitle(StringBuilder lpConsoleTitle, uint nSize);
  // 按窗口标题找「另一个已被隐藏的」经典控制台窗口（类名 ConsoleWindowClass）：
  // 场景：服务还在运行、托盘图标却被关掉/崩掉，用户再双击 启动镜像源.cmd 补注册托盘。
  // 原来那个跑着服务的命令行窗口是隐藏的，而本次双击出来的临时窗口是可见的（标题相同），
  // 所以这里只认「不可见」的那个，避免接管到马上就会关闭的临时窗口。
  public static IntPtr FindHiddenConsoleByTitle(string title, IntPtr exclude) {
    IntPtr firstMatch = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (h == exclude) return true;
      if (IsWindowVisible(h)) return true;
      var cls = new StringBuilder(256);
      GetClassName(h, cls, 256);
      if (cls.ToString() != "ConsoleWindowClass") return true;
      var sb = new StringBuilder(1024);
      GetWindowText(h, sb, 1024);
      if (sb.ToString() == title) { firstMatch = h; return false; }
      return true;
    }, IntPtr.Zero);
    return firstMatch;
  }

  // 按窗口标题找顶层窗口：优先返回可见的，找不到再退回任意匹配。
  // （实测 FindWindow(null, 标题) 在提权控制台窗口上返回 0，所以用 EnumWindows 自己找。）
  public static IntPtr FindByTitle(string title) {
    IntPtr firstMatch = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      var sb = new StringBuilder(1024);
      GetWindowText(h, sb, 1024);
      if (sb.ToString() == title) {
        if (IsWindowVisible(h)) { firstMatch = h; return false; }
        if (firstMatch == IntPtr.Zero) { firstMatch = h; }
      }
      return true;
    }, IntPtr.Zero);
    return firstMatch;
  }
}
'@
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$SW_HIDE = 0
$SW_SHOW = 5
$SW_RESTORE = 9
$WM_CLOSE = 0x0010
$WM_SETICON = 0x0080
$ICON_SMALL = [IntPtr]0
$ICON_BIG = [IntPtr]1

# ---------- 配置 ----------
# 两个独立监听（端口不能相同，后端 config 会做冲突回退）：
#   · 镜像源服务 server.ip:server.port —— npm registry 协议，探活用 /-/ping
#   · 管理界面   admin.ip:admin.port   —— 管理页面 + /__admin/api/*
function Read-MirrorConfig {
  $file = Join-Path $Root 'data\config.json'
  # 老配置可能没有 admin 段：按后端 safeAdminPort 的默认值 4874 兜底（src/config.js），
  # 否则托盘会探到镜像源监听（/__admin/api/* 在那边返回 403 EADMINONLY），永远等不到就绪。
  $cfg = [pscustomobject]@{ port = 4873; adminPort = 4874; token = '' }
  try {
    if (Test-Path $file) {
      $j = Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($j.server -and $j.server.port) { $cfg.port = [int]$j.server.port }
      if ($j.admin -and $j.admin.port) { $cfg.adminPort = [int]$j.admin.port }
      if ($j.security -and $j.security.token) { $cfg.token = [string]$j.security.token }
    }
  } catch { /* 配置读不了就用默认端口 */ }
  # 两个监听不能共用端口：管理端口与镜像源端口相同时退到相邻端口（与后端 config 的规则一致）
  if ($cfg.adminPort -eq $cfg.port) {
    if ($cfg.port -gt 1) { $cfg.adminPort = $cfg.port - 1 } else { $cfg.adminPort = $cfg.port + 1 }
  }
  return $cfg
}

$script:Cfg = Read-MirrorConfig
$script:Port = $script:Cfg.port
$script:AdminPort = $script:Cfg.adminPort
$script:Token = $script:Cfg.token
# 启动脚本给命令行窗口设置的标题（必须与 启动镜像源.cmd 的 title 一致）：
# 补注册托盘时靠它找到「原来那个跑着服务、现在被隐藏的」命令行窗口。
$script:ConsoleTitle = '私人 npm 镜像源 - 运行中'

# 管理界面地址（管理页面 + /__admin/api/*）
function Get-ServiceUrl([string]$Path) {
  return ('http://127.0.0.1:{0}{1}' -f $script:AdminPort, $Path)
}

# 镜像源服务地址（npm registry 协议，探活用 /-/ping）
function Get-RegistryUrl([string]$Path) {
  return ('http://127.0.0.1:{0}{1}' -f $script:Port, $Path)
}

# 管理界面探活：GET /__admin/api/session 200
function Test-Service {
  try {
    # 超时放宽到 5 秒：服务正在跑「补全部包」这类大任务时，偶发一两次响应慢属于正常忙碌，
    # 不能因此判定服务已经停止（见下面健康检查里的进程存活二次确认）。
    $r = Invoke-WebRequest -UseBasicParsing -Uri (Get-ServiceUrl '/__admin/api/session') -TimeoutSec 5
    return [bool]($r.StatusCode -eq 200)
  } catch { return $false }
}

# 镜像源服务探活：GET /-/ping 200（2 秒超时；管理界面重启不影响它）
function Test-Registry {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri (Get-RegistryUrl '/-/ping') -TimeoutSec 2
    return [bool]($r.StatusCode -eq 200)
  } catch { return $false }
}

# 读 data/mirror.pid 里的服务进程 PID（0 表示没有记录）
function Get-MirrorPid {
  try {
    $pidFile = Join-Path $Root 'data\mirror.pid'
    if (-not (Test-Path $pidFile)) { return 0 }
    $p = Get-Content $pidFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($p -and $p.pid) { return [int]$p.pid }
  } catch { /* 忽略 */ }
  return 0
}

# 指定 PID 的进程是否还活着
function Test-ProcessAlive([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  try { $null = Get-Process -Id $ProcessId -ErrorAction Stop; return $true } catch { return $false }
}

# 服务进程是否真的还活着：健康检查失败时用它做二次确认，
# 只要进程还活着就绝不能关控制台窗口（关窗口 = 直接杀进程，就是「点关闭后服务被结束」的根因）。
function Test-MirrorProcessAlive {
  return (Test-ProcessAlive (Get-MirrorPid))
}

# ---------- 命令行窗口 ----------
function Get-ConsoleTitleText {
  try {
    $sb = New-Object System.Text.StringBuilder 512
    [void][MirrorTrayNative]::GetConsoleTitle($sb, 512)
    return $sb.ToString()
  } catch { return '' }
}

function Get-WindowClass([IntPtr]$Hwnd) {
  try {
    $sb = New-Object System.Text.StringBuilder 256
    [void][MirrorTrayNative]::GetClassName($Hwnd, $sb, 256)
    return $sb.ToString()
  } catch { return '' }
}

# 取「真正该显示/隐藏的那个窗口」：
#   · 经典控制台（conhost）：GetConsoleWindow() 返回的就是那个窗口（类名 ConsoleWindowClass）
#   · Windows Terminal / ConPTY：GetConsoleWindow() 返回的是 PseudoConsoleWindow（隐藏它没有任何效果），
#     真正承载本控制台的是标题与控制台标题一致的顶层窗口（类名 CASCADIA_HOSTING_WINDOW_CLASS）
function Resolve-HostWindow {
  $title = Get-ConsoleTitleText
  $h = [MirrorTrayNative]::GetConsoleWindow()
  if ($h -ne [IntPtr]::Zero) {
    if ((Get-WindowClass $h) -eq 'ConsoleWindowClass') { return $h }
    if ($title) {
      $hostWnd = [MirrorTrayNative]::FindByTitle($title)
      if ($hostWnd -ne [IntPtr]::Zero) { return $hostWnd }
    }
    return $h
  }
  if ($title) {
    $hostWnd = [MirrorTrayNative]::FindByTitle($title)
    if ($hostWnd -ne [IntPtr]::Zero) { return $hostWnd }
  }
  return [IntPtr]::Zero
}

$script:ConsoleHwnd = [IntPtr]::Zero

function Test-ConsoleVisible {
  if ($script:ConsoleHwnd -eq [IntPtr]::Zero) { return $false }
  return [bool][MirrorTrayNative]::IsWindowVisible($script:ConsoleHwnd)
}

function Set-ConsoleVisible([bool]$Visible) {
  if ($script:ConsoleHwnd -eq [IntPtr]::Zero) { return $false }
  if ($Visible) {
    [void][MirrorTrayNative]::ShowWindow($script:ConsoleHwnd, $SW_SHOW)
    [void][MirrorTrayNative]::ShowWindowAsync($script:ConsoleHwnd, $SW_SHOW)
    Start-Sleep -Milliseconds 120
    if (-not [MirrorTrayNative]::IsWindowVisible($script:ConsoleHwnd)) {
      # 开机自启的窗口是「启动即隐藏」创建的，个别系统上 SW_SHOW 不能恢复，再补一次 SW_RESTORE
      [void][MirrorTrayNative]::ShowWindow($script:ConsoleHwnd, $SW_RESTORE)
      Start-Sleep -Milliseconds 80
    }
    try { [void][MirrorTrayNative]::SetForegroundWindow($script:ConsoleHwnd) } catch { /* 忽略 */ }
  } else {
    [void][MirrorTrayNative]::ShowWindow($script:ConsoleHwnd, $SW_HIDE)
    [void][MirrorTrayNative]::ShowWindowAsync($script:ConsoleHwnd, $SW_HIDE)
    Start-Sleep -Milliseconds 120
  }
  return [bool](([MirrorTrayNative]::IsWindowVisible($script:ConsoleHwnd)) -eq $Visible)
}

# 右键菜单文案（按当前命令行窗口显示状态决定；自检也用同一个函数）
# 「打开管理界面」「重启管理界面」「重启镜像源服务」与窗口状态无关，始终存在
function Get-MenuLabels([bool]$ConsoleVisible) {
  $toggle = if ($ConsoleVisible) { '隐藏控制台' } else { '打开控制台' }
  return @($toggle, '打开管理界面', '重启管理界面', '重启镜像源服务', '退出镜像源')
}

# 打开管理界面：用系统默认浏览器打开管理界面监听（管理页面，admin.ip:admin.port）
function Open-ManagementUi {
  $url = Get-ServiceUrl '/'
  Write-TrayLog ('用户选择「打开管理界面」：{0}' -f $url)
  try {
    Start-Process -FilePath $url | Out-Null
    return $true
  } catch {
    Write-TrayLog ('调用默认浏览器失败（{0}），改用 explorer 打开' -f $_.Exception.Message)
    try {
      Start-Process -FilePath 'explorer.exe' -ArgumentList $url | Out-Null
      return $true
    } catch {
      Write-TrayLog ('打开管理界面失败：{0}' -f $_.Exception.Message)
      return $false
    }
  }
}

# 重启管理界面：调管理接口只重建管理界面监听（镜像源服务不中断，托盘不退出）。
# 重启期间管理接口会短暂不可用，健康检查用 $script:AdminRestarting 标记跳过，
# 避免托盘把「正在重启管理界面」误判成「服务已停止」而自杀。
function Restart-AdminUi {
  if ($script:Closing) { return }
  if ($script:AdminRestarting) { Write-TrayLog '正在重启管理界面，忽略重复的「重启管理界面」请求'; return }
  $script:AdminRestarting = $true
  Write-TrayLog '用户选择「重启管理界面」：请求重启管理界面监听'
  try {
    $headers = @{ 'X-Mirror-Token' = $script:Token }
    $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri (Get-ServiceUrl '/__admin/api/service/restart-admin') -Headers $headers -TimeoutSec 10
    $accepted = $false
    try { $accepted = [bool](($resp.Content | ConvertFrom-Json).ok) } catch { /* 忽略 */ }
    if (-not $accepted) { throw '重启接口没有返回 ok=true' }
    Write-TrayLog '管理界面重启请求已受理（只重建管理界面监听），等待管理界面恢复…'
    if ($script:Notify) {
      $script:Notify.ShowBalloonTip(3000, '正在重启管理界面', '管理界面监听正在重建，稍等几秒…', [System.Windows.Forms.ToolTipIcon]::Info)
    }
    # 先给旧监听一点时间释放端口，再轮询管理界面是否恢复（最多 60 秒）
    Start-Sleep -Milliseconds 800
    $deadline = (Get-Date).AddSeconds(60)
    $ok = $false
    while ((Get-Date) -lt $deadline) {
      if (Test-Service) { $ok = $true; break }
      Start-Sleep -Milliseconds 400
    }
    if ($ok) {
      Write-TrayLog '管理界面已重启，管理接口已恢复'
      if ($script:Notify) {
        $script:Notify.Text = ('私人 npm 镜像源 · 运行中（{0}）' -f (Get-ServiceUrl '/'))
        $script:Notify.ShowBalloonTip(3000, '管理界面已重启', ('管理界面已恢复：{0}（浏览器页面如需可刷新）' -f (Get-ServiceUrl '/')), [System.Windows.Forms.ToolTipIcon]::Info)
      }
    } else {
      Write-TrayLog '重启管理界面后等待恢复超时（镜像源服务不受影响），请打开控制台查看日志'
      if ($script:Notify) { $script:Notify.ShowBalloonTip(5000, '重启管理界面超时', '管理界面 60 秒内没有恢复；镜像源服务不受影响，请打开控制台检查日志', [System.Windows.Forms.ToolTipIcon]::Warning) }
    }
  } catch {
    Write-TrayLog ('重启管理界面失败：{0}' -f $_.Exception.Message)
    if ($script:Notify) { $script:Notify.ShowBalloonTip(5000, '重启管理界面失败', ('{0}' -f $_.Exception.Message), [System.Windows.Forms.ToolTipIcon]::Error) }
  } finally {
    $script:AdminRestarting = $false
    $script:HealthFail = 0
    if ($script:Notify -and -not $script:Closing) {
      $script:Notify.Text = ('私人 npm 镜像源 · 运行中（{0}）' -f (Get-ServiceUrl '/'))
    }
  }
}

# 重启镜像源服务：调管理接口只重建镜像源监听（端口/数据/配置都不变，管理界面与托盘都保持）。
# 恢复判定用镜像源自己的 /-/ping（管理界面不会中断，不能拿 Test-Service 代替）；
# 期间健康检查用 $script:Restarting 标记跳过更稳妥。
function Restart-MirrorService {
  if ($script:Closing) { return }
  if ($script:Restarting) { Write-TrayLog '正在重启镜像源服务，忽略重复的「重启镜像源服务」请求'; return }
  $script:Restarting = $true
  Write-TrayLog '用户选择「重启镜像源服务」：请求重启镜像源监听'
  try {
    $headers = @{ 'X-Mirror-Token' = $script:Token }
    $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri (Get-ServiceUrl '/__admin/api/service/restart') -Headers $headers -TimeoutSec 10
    $accepted = $false
    try { $accepted = [bool](($resp.Content | ConvertFrom-Json).ok) } catch { /* 忽略 */ }
    if (-not $accepted) { throw '重启接口没有返回 ok=true' }
    Write-TrayLog '镜像源重启请求已受理（只重建镜像源监听，管理界面不中断），等待镜像源恢复…'
    if ($script:Notify) {
      $script:Notify.ShowBalloonTip(3000, '正在重启镜像源服务', '镜像源监听正在重建，稍等几秒…', [System.Windows.Forms.ToolTipIcon]::Info)
    }
    # 先给旧监听一点时间退出，再轮询镜像源 /-/ping 是否恢复（最多 90 秒）
    Start-Sleep -Milliseconds 800
    $started = Get-Date
    $deadline = $started.AddSeconds(90)
    $wentDown = $false
    $ok = $false
    while ((Get-Date) -lt $deadline) {
      if (-not (Test-Registry)) { $wentDown = $true; Start-Sleep -Milliseconds 400; continue }
      # 见过「镜像源消失」再恢复才算重启成功；若旧监听退得太快没观察到 down，
      # 3 秒后仍在正常响应也认为重启完成（新监听已接替）
      if ($wentDown -or ((Get-Date) - $started).TotalSeconds -ge 3) { $ok = $true; break }
      Start-Sleep -Milliseconds 400
    }
    if ($ok) {
      Write-TrayLog '镜像源服务重启完成，/-/ping 已恢复'
      if ($script:Notify) {
        $script:Notify.Text = ('私人 npm 镜像源 · 运行中（{0}）' -f (Get-ServiceUrl '/'))
        $script:Notify.ShowBalloonTip(3000, '镜像源服务已重启', ('镜像源服务已恢复：{0}' -f (Get-RegistryUrl '/')), [System.Windows.Forms.ToolTipIcon]::Info)
      }
    } else {
      Write-TrayLog '重启镜像源服务后等待 /-/ping 恢复超时（管理界面仍在运行），请打开控制台查看日志'
      if ($script:Notify) { $script:Notify.ShowBalloonTip(5000, '重启镜像源服务超时', '镜像源服务 90 秒内没有恢复；管理界面仍可用，请查看服务日志', [System.Windows.Forms.ToolTipIcon]::Warning) }
    }
  } catch {
    Write-TrayLog ('重启镜像源服务失败：{0}' -f $_.Exception.Message)
    if ($script:Notify) { $script:Notify.ShowBalloonTip(5000, '重启镜像源服务失败', ('{0}' -f $_.Exception.Message), [System.Windows.Forms.ToolTipIcon]::Error) }
  } finally {
    $script:Restarting = $false
    if ($script:Notify -and -not $script:Closing) {
      $script:Notify.Text = ('私人 npm 镜像源 · 运行中（{0}）' -f (Get-ServiceUrl '/'))
    }
  }
}

# ---------- 自检模式（不注册托盘、不改变窗口状态） ----------
if ($SelfTest) {
  $script:ConsoleHwnd = Resolve-HostWindow
  $iconPath = Join-Path $Root 'public\favicon.ico'
  $iconOk = $false
  $iconSize = 0
  try {
    $ico = New-Object System.Drawing.Icon($iconPath)
    $iconOk = $true
    $iconSize = $ico.Width
    $ico.Dispose()
  } catch { $iconOk = $false }
  $result = [ordered]@{
    ok = $true
    root = $Root
    iconPath = $iconPath
    iconOk = $iconOk
    iconSize = $iconSize
    consoleHwnd = [int64]$script:ConsoleHwnd.ToInt64()
    consoleVisible = (Test-ConsoleVisible)
    visibleMenu = @(Get-MenuLabels $true)
    hiddenMenu = @(Get-MenuLabels $false)
    servicePort = $script:Port
    adminPort = $script:AdminPort
    registryPort = $script:Port
    managementUrl = Get-ServiceUrl '/'
    registryUrl = Get-RegistryUrl '/'
  }
  $json = ($result | ConvertTo-Json -Compress)
  if ($SelfTestOut) {
    [System.IO.File]::WriteAllText($SelfTestOut, $json, (New-Object System.Text.UTF8Encoding($false)))
  } else {
    [Console]::Out.WriteLine($json)
  }
  exit 0
}

# ---------- 单实例保护：同一份程序同时只允许一个托盘宿主，保证右下角永远只有一个项目图标 ----------
# 启动脚本在「服务已经在运行」时也会补拉起托盘（用来恢复被关掉/崩掉的图标）；
# 如果托盘其实还在，这里直接退出即可（本次启动的只是一个临时控制台，脚本结束它会自己关掉）。
# 互斥体名字带上项目根目录的哈希：同一份程序重复启动只会有一个图标，
# 而测试用的隔离副本（复制到别的目录、用不同端口）和真实实例互不影响。
$script:TrayMutex = $null
$script:TrayMutexOwned = $false
try {
  $sha1 = [System.Security.Cryptography.SHA1]::Create()
  try {
    $rootHash = [System.BitConverter]::ToString($sha1.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant()))).Replace('-', '').Substring(0, 12)
  } finally { $sha1.Dispose() }
  $script:TrayMutexName = 'Local\PrivateNpmMirrorTrayHost-' + $rootHash
  $script:TrayMutex = [System.Threading.Mutex]::new($false, $script:TrayMutexName)
  try { $script:TrayMutexOwned = $script:TrayMutex.WaitOne(0) }
  catch [System.Threading.AbandonedMutexException] { $script:TrayMutexOwned = $true }
} catch {
  # 单实例只是防重复注册图标，不是托盘的必需能力：拿不到互斥体时退回无保护运行
  Write-TrayLog ('单实例互斥体不可用（{0}），继续按无保护方式运行' -f $_.Exception.Message)
  $script:TrayMutexOwned = $true
}
if (-not $script:TrayMutexOwned) {
  Write-TrayLog '已有托盘宿主在运行，本次不再重复注册托盘图标（退出）'
  exit 0
}

# 记录自己的 PID：方便排查/测试定位托盘宿主（被强杀时文件会残留，下次启动覆盖）
try {
  $logDir = Join-Path $Root 'data\logs'
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  $pidJson = ('{{"pid":{0},"startedAt":"{1}"}}' -f $PID, (Get-Date).ToString('o'))
  [System.IO.File]::WriteAllText((Join-Path $logDir 'tray.pid'), $pidJson, (New-Object System.Text.UTF8Encoding($false)))
} catch { Write-TrayLog ('写入 data\logs\tray.pid 失败：{0}' -f $_.Exception.Message) }

# ---------- 等管理界面就绪（就绪前保持命令行窗口可见，启动失败的报错不会被吞掉） ----------
Write-TrayLog ('托盘宿主启动：root={0} registryPort={1} adminPort={2} wait={3}s' -f $Root, $script:Port, $script:AdminPort, $WaitSeconds)
$deadline = (Get-Date).AddSeconds([Math]::Max(5, $WaitSeconds))
$ready = $false
while ((Get-Date) -lt $deadline) {
  if (Test-Service) { $ready = $true; break }
  Start-Sleep -Milliseconds 400
}
if (-not $ready) {
  Write-TrayLog '等待服务就绪超时，退出托盘（命令行窗口保持显示，方便看启动报错）'
  exit 1
}

# ---------- 命令行窗口：正常启动用本窗口；服务已在运行时接管它原来那个已被隐藏的窗口 ----------
# 场景：服务还在跑（比如托盘图标被关掉/崩掉、或「停止镜像源.cmd」只停了托盘），用户再双击 启动镜像源.cmd：
# 启动脚本在 prestart=10 分支会补拉起托盘（前台运行，这个 cmd 窗口先当宿主，托盘就绪后把它隐藏）。
# 这里按标题找到原来那个「跑着服务、已被隐藏」的命令行窗口接管，「打开控制台」打开的才是真正跑服务的窗口。
$script:ConsoleHwnd = [IntPtr]::Zero
$script:AdoptedConsole = $false
if ($script:RestoreMode) {
  # exclude 本进程自己的控制台（本次双击出来的临时窗口），只接管「另一个被隐藏的」控制台
  $adoptHwnd = [MirrorTrayNative]::FindHiddenConsoleByTitle($script:ConsoleTitle, [MirrorTrayNative]::GetConsoleWindow())
  if ($adoptHwnd -ne [IntPtr]::Zero) {
    $script:ConsoleHwnd = $adoptHwnd
    $script:AdoptedConsole = $true
    Write-TrayLog ('服务已在运行，接管原命令行窗口：hwnd={0}（本次只补注册托盘，不重复启动服务）' -f $adoptHwnd.ToInt64())
  } else {
    Write-TrayLog '服务已在运行，但没有找到原来的命令行窗口（可能已被关闭或运行在 Windows Terminal 里）'
  }
}
if ($script:ConsoleHwnd -eq [IntPtr]::Zero) {
  $script:ConsoleHwnd = Resolve-HostWindow
  if ($script:ConsoleHwnd -ne [IntPtr]::Zero) {
    Write-TrayLog ('命令行窗口：hwnd={0} class={1}' -f $script:ConsoleHwnd.ToInt64(), (Get-WindowClass $script:ConsoleHwnd))
  } else {
    Write-TrayLog '没找到命令行窗口（无法隐藏/显示，托盘图标仍可用）'
  }
}
$script:Closing = $false
$script:HealthFail = 0
$script:Restarting = $false
$script:AdminRestarting = $false
$script:Context = New-Object System.Windows.Forms.ApplicationContext
$script:Notify = $null
$script:Timer = $null
$script:Icon = $null

function Stop-Tray([bool]$CloseConsole) {
  if ($script:Closing) { return }
  $script:Closing = $true
  try { if ($script:Timer) { $script:Timer.Stop(); $script:Timer.Dispose() } } catch { /* 忽略 */ }
  try { if ($script:Notify) { $script:Notify.Visible = $false; $script:Notify.Dispose() } } catch { /* 忽略 */ }
  try { if ($script:Icon) { $script:Icon.Dispose() } } catch { /* 忽略 */ }
  Write-TrayLog ('托盘退出（关闭命令行窗口={0}）' -f $CloseConsole)
  if ($CloseConsole -and $script:ConsoleHwnd -ne [IntPtr]::Zero) {
    # 先隐藏再关：避免用户看到窗口闪一下
    try { [void][MirrorTrayNative]::ShowWindow($script:ConsoleHwnd, $SW_HIDE) } catch { /* 忽略 */ }
    try { [void][MirrorTrayNative]::PostMessage($script:ConsoleHwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) } catch { /* 忽略 */ }
  }
  try { $script:Context.ExitThread() } catch { /* 忽略 */ }
  # 清掉自己的 tray.pid（只删自己写的那个，避免误删新托盘的记录）
  try {
    $pidFile = Join-Path $Root 'data\logs\tray.pid'
    if (Test-Path $pidFile) {
      $jp = Get-Content $pidFile -Raw | ConvertFrom-Json
      if ([int]$jp.pid -eq $PID) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
    }
  } catch { /* 忽略 */ }
  [System.Environment]::Exit(0)
}

# ---------- 退出镜像源：停服务（管理接口 + 进程兜底）→ 关窗口、退托盘 ----------
function Stop-MirrorAndExit {
  if ($script:Closing) { return }
  Write-TrayLog '用户选择「退出镜像源」：请求停止整个程序（镜像源服务 + 管理界面）'
  # 端口/令牌可能刚在管理界面改过：先重读一次配置，避免还按旧端口/旧令牌去调停止接口
  try {
    $cfg = Read-MirrorConfig
    $script:Cfg = $cfg
    $script:Port = $cfg.port
    $script:AdminPort = $cfg.adminPort
    $script:Token = $cfg.token
  } catch { Write-TrayLog ('重新读取配置失败，沿用启动时配置：{0}' -f $_.Exception.Message) }
  $targetPid = Get-MirrorPid
  try {
    if (Test-Service) {
      $headers = @{ 'X-Mirror-Token' = $script:Token }
      Invoke-WebRequest -UseBasicParsing -Method Post -Uri (Get-ServiceUrl '/__admin/api/service/shutdown') -Headers $headers -TimeoutSec 8 | Out-Null
      Write-TrayLog '已请求服务优雅退出（/__admin/api/service/shutdown）'
    } else {
      Write-TrayLog '管理接口当前不可达，改为按 data\mirror.pid 结束进程'
    }
  } catch { Write-TrayLog ('停止接口调用失败：{0}' -f $_.Exception.Message) }
  # 以「进程是否真的退出」为准：接口可能先回 200 而进程还在收尾；
  # 旧版只等管理接口不可用就关窗口，遇到「接口停不掉」时会留下一个没人管的 node 进程。
  if ($targetPid -le 0) { $targetPid = Get-MirrorPid }
  for ($i = 0; $i -lt 40; $i++) {
    if ($targetPid -gt 0) { if (-not (Test-ProcessAlive $targetPid)) { break } }
    elseif (-not (Test-Service)) { break }
    Start-Sleep -Milliseconds 250
  }
  if ($targetPid -gt 0 -and (Test-ProcessAlive $targetPid)) {
    Write-TrayLog ('服务进程仍在运行（PID {0}），强制结束' -f $targetPid)
    try {
      Stop-Process -Id $targetPid -Force -ErrorAction Stop
      Write-TrayLog ('已强制结束服务进程 PID {0}' -f $targetPid)
    } catch { Write-TrayLog ('强制结束服务进程失败：{0}' -f $_.Exception.Message) }
    Start-Sleep -Milliseconds 300
  }
  Stop-Tray -CloseConsole $true
}

# ---------- 托盘图标 ----------
$iconPath = Join-Path $Root 'public\favicon.ico'
if (-not (Test-Path $iconPath)) {
  Write-TrayLog ('缺少项目图标：{0}（可先执行 tools\make-icon.ps1 生成）' -f $iconPath)
  exit 1
}
$script:Icon = New-Object System.Drawing.Icon($iconPath)
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $script:Icon
$notify.Text = ('私人 npm 镜像源 · 运行中（{0}）' -f (Get-ServiceUrl '/'))
$notify.Visible = $true
$script:Notify = $notify
Write-TrayLog ('托盘图标已注册：{0}（左键打开管理界面，右键选择操作）' -f $iconPath)

# 顺便把命令行窗口的标题栏/任务栏图标也换成项目图标（不换 Windows Terminal 的标签页图标）
try {
  if ($script:ConsoleHwnd -ne [IntPtr]::Zero) {
    $big = New-Object System.Drawing.Icon($iconPath, 32, 32)
    $small = New-Object System.Drawing.Icon($iconPath, 16, 16)
    $script:IconBig = $big
    $script:IconSmall = $small
    [void][MirrorTrayNative]::SendMessage($script:ConsoleHwnd, $WM_SETICON, $ICON_BIG, $big.Handle)
    [void][MirrorTrayNative]::SendMessage($script:ConsoleHwnd, $WM_SETICON, $ICON_SMALL, $small.Handle)
  }
} catch { Write-TrayLog ('设置命令行窗口图标失败：{0}' -f $_.Exception.Message) }

# ---------- 右键菜单（每次弹出时按当前窗口状态重建，保证只显示该显示的控制台项；「打开管理界面」「重启管理界面」「重启镜像源服务」「退出镜像源」始终在） ----------
$menu = New-Object System.Windows.Forms.ContextMenuStrip
function Rebuild-Menu {
  $menu.Items.Clear()
  $labels = Get-MenuLabels (Test-ConsoleVisible)
  $toggle = $menu.Items.Add($labels[0])
  $toggle.add_Click({
    if (Test-ConsoleVisible) { [void](Set-ConsoleVisible $false) } else { [void](Set-ConsoleVisible $true) }
  })
  $openUi = $menu.Items.Add($labels[1])
  $openUi.add_Click({ [void](Open-ManagementUi) })
  $restartAdmin = $menu.Items.Add($labels[2])
  $restartAdmin.add_Click({ Restart-AdminUi })
  $restartMirror = $menu.Items.Add($labels[3])
  $restartMirror.add_Click({ Restart-MirrorService })
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $exit = $menu.Items.Add($labels[4])
  $exit.add_Click({ Stop-MirrorAndExit })
}
$menu.add_Opening({ Rebuild-Menu })
$notify.ContextMenuStrip = $menu
# 左键单击：打开管理界面（网页端控制台）
$notify.add_MouseClick({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { [void](Open-ManagementUi) }
})

# ---------- 服务健康检查：被外部停止（比如双击「停止镜像源.cmd」）时自动退出 ----------
# 注意：服务「忙」和「已停止」必须区分开。大任务（如补全部包）期间接口可能连续几秒没响应，
# 以前 3 次探测失败就直接关控制台窗口，等于把还活着的 node 进程一起杀掉。
# 现在失败 5 次后先看 data/mirror.pid 里的进程是否真的还在：还活着就只记日志、继续等。
# 探活只打管理界面的 /__admin/api/session：重启镜像源服务时管理界面不中断，托盘不会因此误退出；
# 重启管理界面期间用 $script:AdminRestarting 跳过，避免把「正在重启」误判成「服务已停止」。
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.add_Tick({
  if ($script:Closing) { return }
  # 正在重启时对应监听必然短暂不可用：跳过检查，等 Restart-* 自己等到恢复
  if ($script:Restarting -or $script:AdminRestarting) { return }
  if (Test-Service) {
    $script:HealthFail = 0
    if (-not $script:Closing -and $script:Notify) { $script:Notify.Text = ('私人 npm 镜像源 · 运行中（{0}）' -f (Get-ServiceUrl '/')) }
    return
  }
  $script:HealthFail++
  if ($script:HealthFail -ge 5) {
    # 连续失败：可能是管理界面端口刚在配置里改过（例如先改 admin.port、再点「重启管理界面」），
    # 重读一次配置换成新端口再确认，避免一直按旧端口探活而误判成「服务已停止」。
    try {
      $cfg = Read-MirrorConfig
      $script:Cfg = $cfg
      $script:Port = $cfg.port
      $script:AdminPort = $cfg.adminPort
      $script:Token = $cfg.token
    } catch { /* 配置读不了就按旧值继续 */ }
    if (Test-Service) {
      $script:HealthFail = 0
      if (-not $script:Closing -and $script:Notify) { $script:Notify.Text = ('私人 npm 镜像源 · 运行中（{0}）' -f (Get-ServiceUrl '/')) }
      return
    }
    if (Test-MirrorProcessAlive) {
      Write-TrayLog ('服务响应超时，但进程仍在运行（PID {0}），继续等待，不关闭窗口' -f (Get-MirrorPid))
      $script:HealthFail = 0
      if (-not $script:Closing -and $script:Notify) { $script:Notify.Text = ('私人 npm 镜像源 · 运行中（忙碌）') }
      return
    }
    Write-TrayLog '检测到服务已停止（进程已退出），托盘自动退出'
    Stop-Tray -CloseConsole $true
  }
})
$script:Timer = $timer
$timer.Start()

# ---------- 隐藏命令行窗口，进入托盘常驻 ----------
$hidden = Set-ConsoleVisible $false
if ($script:AdoptedConsole) {
  # 补注册托盘时，本次双击出来的临时窗口只用来当宿主，不能留在桌面上；
  # 真正由托盘管理的是被接管的那个原来的隐藏窗口。
  $ownHwnd = [MirrorTrayNative]::GetConsoleWindow()
  if ($ownHwnd -ne [IntPtr]::Zero -and $ownHwnd -ne $script:ConsoleHwnd) {
    try { [void][MirrorTrayNative]::ShowWindow($ownHwnd, $SW_HIDE) } catch { /* 忽略 */ }
  }
  Write-TrayLog ('服务已就绪，已接管原有命令行窗口（原窗口隐藏={0}），本次启动的临时窗口已隐藏' -f $hidden)
} else {
  Write-TrayLog ('服务已就绪，命令行窗口已隐藏={0}' -f $hidden)
  if (-not $hidden) {
    # 隐藏失败（极少见：例如宿主是 Windows Terminal）时不至于让用户没法操作
    Write-TrayLog '未能隐藏命令行窗口：托盘仍可用，右键菜单会显示「隐藏控制台」'
  }
}

[System.Windows.Forms.Application]::Run($script:Context)
