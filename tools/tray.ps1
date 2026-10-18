# ============================================================
#  私人 npm 镜像源 · Windows 托盘宿主（零依赖，只用系统自带的 PowerShell）
#
#  由「启动镜像源.cmd」在后台拉起，负责：
#    · 等服务就绪后，把命令行窗口隐藏到右下角托盘，并注册项目图标（public\favicon.ico）
#    · 左键单击图标 = 打开管理界面（网页端控制台）
#    · 右键菜单根据命令行窗口当前是显示还是隐藏，动态改变第一项，其余固定：
#        显示中：【隐藏控制台】【打开管理界面】【重启镜像源】【退出镜像源】
#        隐藏中：【打开控制台】【打开管理界面】【重启镜像源】【退出镜像源】
#    · 重启镜像源 = 调管理接口让服务自己重启（数据/配置不变，托盘与窗口都保持）
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
function Read-MirrorConfig {
  $file = Join-Path $Root 'data\config.json'
  $cfg = [pscustomobject]@{ port = 4873; token = '' }
  try {
    if (Test-Path $file) {
      $j = Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($j.server -and $j.server.port) { $cfg.port = [int]$j.server.port }
      if ($j.security -and $j.security.token) { $cfg.token = [string]$j.security.token }
    }
  } catch { /* 配置读不了就用默认端口 */ }
  return $cfg
}

$script:Cfg = Read-MirrorConfig
$script:Port = $script:Cfg.port
$script:Token = $script:Cfg.token

function Get-ServiceUrl([string]$Path) {
  return ('http://127.0.0.1:{0}{1}' -f $script:Port, $Path)
}

function Test-Service {
  try {
    # 超时放宽到 5 秒：服务正在跑「补全部包」这类大任务时，偶发一两次响应慢属于正常忙碌，
    # 不能因此判定服务已经停止（见下面健康检查里的进程存活二次确认）。
    $r = Invoke-WebRequest -UseBasicParsing -Uri (Get-ServiceUrl '/__admin/api/session') -TimeoutSec 5
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

# 服务进程是否真的还活着：健康检查失败时用它做二次确认，
# 只要进程还活着就绝不能关控制台窗口（关窗口 = 直接杀进程，就是「点关闭后服务被结束」的根因）。
function Test-MirrorProcessAlive {
  $p = Get-MirrorPid
  if (-not $p) { return $false }
  try { return [bool](Get-Process -Id $p -ErrorAction Stop) } catch { return $false }
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
# 「打开管理界面」「重启镜像源」与窗口状态无关，始终存在
function Get-MenuLabels([bool]$ConsoleVisible) {
  $toggle = if ($ConsoleVisible) { '隐藏控制台' } else { '打开控制台' }
  return @($toggle, '打开管理界面', '重启镜像源', '退出镜像源')
}

# 打开管理界面：用系统默认浏览器打开镜像源的网页端首页
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

# 重启镜像源：调管理接口让服务自己重启（旧进程退出、拉新进程，端口/数据/配置都不变）。
# 不关控制台窗口、退出托盘；重启期间健康检查会短暂失败，用 $script:Restarting 标记跳过，
# 避免托盘把「正在重启」误判成「服务已停止」而自杀。
function Restart-MirrorService {
  if ($script:Closing) { return }
  if ($script:Restarting) { Write-TrayLog '正在重启中，忽略重复的「重启镜像源」请求'; return }
  $script:Restarting = $true
  Write-TrayLog '用户选择「重启镜像源」：请求重启服务'
  try {
    $headers = @{ 'X-Mirror-Token' = $script:Token }
    $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri (Get-ServiceUrl '/__admin/api/service/restart') -Headers $headers -TimeoutSec 10
    $accepted = $false
    try { $accepted = [bool](($resp.Content | ConvertFrom-Json).ok) } catch { /* 忽略 */ }
    if (-not $accepted) { throw '重启接口没有返回 ok=true' }
    Write-TrayLog '重启请求已受理（旧进程会退出并拉起新进程），等待服务恢复…'
    if ($script:Notify) {
      $script:Notify.Text = '私人 npm 镜像源 · 正在重启…'
      $script:Notify.ShowBalloonTip(3000, '正在重启镜像源', '服务正在重启，稍等几秒…', [System.Windows.Forms.ToolTipIcon]::Info)
    }
    # 先给旧进程一点时间退出，再等新进程把端口监听起来（最多 90 秒）
    Start-Sleep -Milliseconds 1500
    $started = Get-Date
    $deadline = $started.AddSeconds(90)
    $wentDown = $false
    $ok = $false
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 400
      if (-not (Test-Service)) { $wentDown = $true; continue }
      # 见过「服务消失」再恢复才算重启成功；若旧进程退得太快没观察到 down，
      # 3 秒后仍在正常响应也认为重启完成（新进程已接替）
      if ($wentDown -or ((Get-Date) - $started).TotalSeconds -ge 3) { $ok = $true; break }
    }
    if ($ok) {
      Write-TrayLog '镜像源重启完成，服务已恢复'
      if ($script:Notify) {
        $script:Notify.Text = ('私人 npm 镜像源 · 运行中（{0}）' -f (Get-ServiceUrl '/'))
        $script:Notify.ShowBalloonTip(3000, '镜像源已重启', ('服务已恢复：{0}' -f (Get-ServiceUrl '/')), [System.Windows.Forms.ToolTipIcon]::Info)
      }
    } else {
      Write-TrayLog '重启后等待服务恢复超时（可能还在启动或启动失败），请打开控制台查看'
      if ($script:Notify) { $script:Notify.ShowBalloonTip(5000, '镜像源重启超时', '请打开控制台检查服务日志', [System.Windows.Forms.ToolTipIcon]::Warning) }
    }
  } catch {
    Write-TrayLog ('重启镜像源失败：{0}' -f $_.Exception.Message)
    if ($script:Notify) { $script:Notify.ShowBalloonTip(5000, '重启镜像源失败', ('{0}' -f $_.Exception.Message), [System.Windows.Forms.ToolTipIcon]::Error) }
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
    managementUrl = Get-ServiceUrl '/'
  }
  $json = ($result | ConvertTo-Json -Compress)
  if ($SelfTestOut) {
    [System.IO.File]::WriteAllText($SelfTestOut, $json, (New-Object System.Text.UTF8Encoding($false)))
  } else {
    [Console]::Out.WriteLine($json)
  }
  exit 0
}

# ---------- 等镜像源就绪（就绪前保持命令行窗口可见，启动失败的报错不会被吞掉） ----------
Write-TrayLog ('托盘宿主启动：root={0} port={1} wait={2}s' -f $Root, $script:Port, $WaitSeconds)
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

$script:ConsoleHwnd = Resolve-HostWindow
if ($script:ConsoleHwnd -ne [IntPtr]::Zero) {
  Write-TrayLog ('命令行窗口：hwnd={0} class={1}' -f $script:ConsoleHwnd.ToInt64(), (Get-WindowClass $script:ConsoleHwnd))
} else {
  Write-TrayLog '没找到命令行窗口（无法隐藏/显示，托盘图标仍可用）'
}
$script:Closing = $false
$script:HealthFail = 0
$script:Restarting = $false
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
  [System.Environment]::Exit(0)
}

# ---------- 退出镜像源：先优雅停服务，再关窗口、退托盘 ----------
function Stop-MirrorAndExit {
  if ($script:Closing) { return }
  Write-TrayLog '用户选择「退出镜像源」：请求停止服务'
  try {
    if (Test-Service) {
      $headers = @{ 'X-Mirror-Token' = $script:Token }
      Invoke-WebRequest -UseBasicParsing -Method Post -Uri (Get-ServiceUrl '/__admin/api/service/shutdown') -Headers $headers -TimeoutSec 8 | Out-Null
    }
  } catch { Write-TrayLog ('停止接口调用失败：{0}' -f $_.Exception.Message) }
  # 最多等 10 秒让服务自己退干净
  for ($i = 0; $i -lt 40; $i++) {
    if (-not (Test-Service)) { break }
    Start-Sleep -Milliseconds 250
  }
  if (Test-Service) {
    # 接口停不掉时按 pid 文件兜底
    try {
      $pidFile = Join-Path $Root 'data\mirror.pid'
      if (Test-Path $pidFile) {
        $p = Get-Content $pidFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($p -and $p.pid) { Stop-Process -Id ([int]$p.pid) -Force -ErrorAction SilentlyContinue }
      }
    } catch { /* 忽略 */ }
    Start-Sleep -Milliseconds 500
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

# ---------- 右键菜单（每次弹出时按当前窗口状态重建，保证只显示该显示的控制台项；「打开管理界面」「重启镜像源」「退出镜像源」始终在） ----------
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
  $restart = $menu.Items.Add($labels[2])
  $restart.add_Click({ Restart-MirrorService })
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $exit = $menu.Items.Add($labels[3])
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
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.add_Tick({
  if ($script:Closing) { return }
  # 正在重启时服务必然短暂不可用：跳过检查，等 Restart-MirrorService 自己等到恢复
  if ($script:Restarting) { return }
  if (Test-Service) {
    $script:HealthFail = 0
    if (-not $script:Closing -and $script:Notify) { $script:Notify.Text = ('私人 npm 镜像源 · 运行中（{0}）' -f (Get-ServiceUrl '/')) }
    return
  }
  $script:HealthFail++
  if ($script:HealthFail -ge 5) {
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
Write-TrayLog ('服务已就绪，命令行窗口已隐藏={0}' -f $hidden)
if (-not $hidden) {
  # 隐藏失败（极少见：例如宿主是 Windows Terminal）时不至于让用户没法操作
  Write-TrayLog '未能隐藏命令行窗口：托盘仍可用，右键菜单会显示「隐藏控制台」'
}

[System.Windows.Forms.Application]::Run($script:Context)
