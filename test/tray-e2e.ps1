# 托盘端到端验证（手工运行；用隔离副本，不改动真实实例与用户数据）
#
# 为什么是「手工」脚本而不是 run-all 的一部分：
#   它会真的启动一个可见的命令行窗口、注册托盘图标、再把窗口隐藏——必须在有真实桌面的
#   会话里跑（无头/服务环境下窗口相关 API 不可用），所以不放进自动化测试。
#
# 流程：复制一份项目到 tmp\tray-e2e-<时间> → 用真实的「启动镜像源.cmd」在独立控制台里启动
#   → 断言：服务在线、命令行窗口被隐藏、托盘日志正常
#   → 模拟左键打开窗口（ShowWindow 校验窗口可显示）
#   → 场景 A：强杀托盘进程（模拟图标被关掉/崩掉，服务仍在跑）→ 再跑一次启动镜像源.cmd
#     → 断言：托盘补注册成功、接管原来的隐藏命令行窗口、服务没受影响
#   → 用 node cli.js stop 停服务（等价于双击「停止镜像源.cmd」）
#   → 断言：托盘自动退出并关掉命令行窗口
#
# 用法（二选一）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\tray-e2e.ps1
#   pwsh -NoProfile -File test\tray-e2e.ps1
# 退出码：0 = 全部通过；1 = 有断言失败。
param(
  # 隔离实例用的端口（随便挑一个没被占用的）
  [int]$Port = 4905
)

$ErrorActionPreference = 'Stop'
$root = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }
$dir = Join-Path $root ('tmp\tray-e2e-' + (Get-Date -Format 'HHmmss'))
$title = '私人 npm 镜像源 - 运行中'   # 必须与 启动镜像源.cmd 里的 title 一致

New-Item -ItemType Directory -Path $dir -Force | Out-Null
foreach ($d in 'src', 'public', 'tools') { Copy-Item (Join-Path $root $d) (Join-Path $dir $d) -Recurse }
foreach ($f in 'cli.js', 'package.json', '启动镜像源.cmd') { Copy-Item (Join-Path $root $f) (Join-Path $dir $f) }
New-Item -ItemType Directory -Path (Join-Path $dir 'data') -Force | Out-Null
$cfg = @{
  server   = @{ ip = '127.0.0.1'; port = $Port; openBrowserOnStart = $false }
  # 管理界面用 端口+1：和真实实例（默认 4873/4874）完全隔离，否则托盘会探到真实实例的管理端口
  admin    = @{ ip = '127.0.0.1'; port = ($Port + 1); openBrowserOnStart = $false }
  mode     = 'offline'
  storage  = @{ dir = 'data/storage' }
  security = @{ token = 'tray-e2e-token'; requirePublish = $false; trustLocalhost = $true }
  log      = @{ level = 'info' }
}
[System.IO.File]::WriteAllText((Join-Path $dir 'data\config.json'), ($cfg | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MirrorE2E {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  public static IntPtr FindByTitle(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      var sb = new StringBuilder(1024);
      GetWindowText(h, sb, 1024);
      if (sb.ToString() == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

# 注意：控制台窗口用 FindWindow(类名=null, 标题) 在本机拿不到句柄（实测返回 0），
# 所以改用 EnumWindows + GetWindowText 精确匹配标题。
function Get-MirrorWindow {
  return [MirrorE2E]::FindByTitle($title)
}
function Test-Up {
  try { $r = Invoke-WebRequest -UseBasicParsing ('http://127.0.0.1:{0}/-/ping' -f $Port) -TimeoutSec 2; return ($r.StatusCode -eq 200) } catch { return $false }
}
function Read-TrayLog {
  $f = Join-Path $dir 'data\logs\tray.log'
  if (Test-Path $f) { return (Get-Content $f -Raw) }
  return ''
}

"== 启动：cmd /c 启动镜像源.cmd（工作目录 $dir）"
$cmdProc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', '启动镜像源.cmd' -WorkingDirectory $dir -PassThru
$deadline = (Get-Date).AddSeconds(90)
$up = $false
while ((Get-Date) -lt $deadline) {
  if (Test-Up) { $up = $true; break }
  Start-Sleep -Milliseconds 500
}
"service_up=$up"

$hwnd = [IntPtr]::Zero
$hidden = $false
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  $hwnd = Get-MirrorWindow
  if ($hwnd -ne [IntPtr]::Zero -and (-not [MirrorE2E]::IsWindowVisible($hwnd))) { $hidden = $true; break }
  Start-Sleep -Milliseconds 500
}
"console_hwnd=$($hwnd.ToInt64())  console_hidden=$hidden"

$log1 = Read-TrayLog
"--- tray.log（启动 + 隐藏后）---"
$log1

# 模拟「左键单击托盘图标」：脚本里直接 ShowWindow，验证窗口能被重新显示
$showOk = $false
if ($hwnd -ne [IntPtr]::Zero) {
  [void][MirrorE2E]::ShowWindow($hwnd, 5)
  Start-Sleep -Milliseconds 600
  $showOk = [bool][MirrorE2E]::IsWindowVisible($hwnd)
  [void][MirrorE2E]::ShowWindow($hwnd, 0)
  Start-Sleep -Milliseconds 300
}
"console_can_show=$showOk"

# ---------- 场景 A：托盘被关掉/崩掉、但服务还在跑 → 再跑一次启动脚本应补注册托盘 ----------
"== 场景 A：强杀托盘进程（模拟图标没了），再跑一次 启动镜像源.cmd 应补注册托盘"
function Read-TrayPid {
  $f = Join-Path $dir 'data\logs\tray.pid'
  if (Test-Path $f) { try { return [int]((Get-Content $f -Raw | ConvertFrom-Json).pid) } catch { return 0 } }
  return 0
}
$firstTrayPid = Read-TrayPid
$trayKilled = $false
if ($firstTrayPid -gt 0) {
  Stop-Process -Id $firstTrayPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
  $trayKilled = -not [bool](Get-Process -Id $firstTrayPid -ErrorAction SilentlyContinue)
}
$serviceUpAfterTrayKilled = Test-Up
"first_tray_pid=$firstTrayPid  tray_killed=$trayKilled  service_up_after_tray_killed=$serviceUpAfterTrayKilled"

# 模拟用户再双击一次「启动镜像源.cmd」：用普通可见窗口启动（和真实双击一致；
# 补注册模式的托盘会把它当成临时宿主窗口，就绪后隐藏，并接管上面那个原来被隐藏的控制台）。
$restoreProc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', '启动镜像源.cmd', '--no-open' -WorkingDirectory $dir -PassThru
$restoreDeadline = (Get-Date).AddSeconds(90)
$restored = $false
while ((Get-Date) -lt $restoreDeadline) {
  $logRestore = Read-TrayLog
  if ($logRestore -match '服务已在运行，接管原命令行窗口' -or $logRestore -match '服务已在运行，但没有找到原来的命令行窗口') { $restored = $true; break }
  Start-Sleep -Milliseconds 500
}
$restoredTrayPid = Read-TrayPid
$restoredTrayAlive = [bool]($restoredTrayPid -gt 0 -and $restoredTrayPid -ne $firstTrayPid -and (Get-Process -Id $restoredTrayPid -ErrorAction SilentlyContinue))
$adoptedConsole = [bool]((Read-TrayLog) -match '服务已在运行，接管原命令行窗口')
$serviceStillUp = Test-Up
"restore_logged=$restored  adopted_console=$adoptedConsole  restored_tray_pid=$restoredTrayPid  restored_tray_alive=$restoredTrayAlive  service_still_up=$serviceStillUp"

"== 停止镜像源（等价于双击「停止镜像源.cmd」）"
Push-Location $dir
$stopOut = (& node cli.js stop 2>&1 | Out-String)
Pop-Location
"stop_out=$($stopOut.Trim())"

$trayExited = $false
$windowClosed = $false
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
  # 用启动时记下的窗口句柄判断是否已被关闭（不能按标题再找：本机可能还有别处同标题的
  # 隐藏窗口，例如真实实例的宿主窗口，会把关闭误判成没关）。
  $windowClosed = -not [MirrorE2E]::IsWindow($hwnd)
  $log = Read-TrayLog
  $trayExited = [bool]($log -match '托盘自动退出|托盘退出')
  if ($trayExited -and $windowClosed) { break }
  Start-Sleep -Milliseconds 500
}
"tray_exited=$trayExited  console_window_closed=$windowClosed"

$log2 = Read-TrayLog
"--- tray.log（停止后）---"
$log2

$serviceDown = -not (Test-Up)
"service_down=$serviceDown"

# 收尾：清掉可能残留的 cmd / node / powershell
try {
  if ($cmdProc -and -not $cmdProc.HasExited) { Stop-Process -Id $cmdProc.Id -Force -ErrorAction SilentlyContinue }
} catch { }
try {
  if ($restoreProc -and -not $restoreProc.HasExited) { Stop-Process -Id $restoreProc.Id -Force -ErrorAction SilentlyContinue }
} catch { }
try {
  if ($restoredTrayPid -gt 0) { Stop-Process -Id $restoredTrayPid -Force -ErrorAction SilentlyContinue }
} catch { }
try {
  $pidFile = Join-Path $dir 'data\mirror.pid'
  if (Test-Path $pidFile) {
    $p = Get-Content $pidFile -Raw | ConvertFrom-Json
    if ($p -and $p.pid) { Stop-Process -Id ([int]$p.pid) -Force -ErrorAction SilentlyContinue }
  }
} catch { }

$result = [ordered]@{
  serviceUp = $up
  consoleHidden = $hidden
  consoleCanShow = $showOk
  trayLogHasHidden = [bool]($log1 -match '命令行窗口已隐藏=True')
  trayKilled = $trayKilled
  serviceSurvivedTrayKill = $serviceUpAfterTrayKilled
  restoreLogged = $restored
  adoptedConsole = $adoptedConsole
  restoredTrayAlive = $restoredTrayAlive
  serviceDown = $serviceDown
  trayExited = $trayExited
  consoleWindowClosed = $windowClosed
  pass = [bool]($up -and $hidden -and $showOk -and $trayKilled -and $serviceUpAfterTrayKilled -and $restored -and $adoptedConsole -and $restoredTrayAlive -and $trayExited -and $windowClosed -and $serviceDown)
}
"== RESULT: $($result | ConvertTo-Json -Compress)"
"（隔离副本保留在 $dir，方便看 data\logs\tray.log；不需要时可直接删除）"
if (-not $result.pass) { exit 1 }
