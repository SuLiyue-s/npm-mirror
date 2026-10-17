# 托盘端到端验证（手工运行；用隔离副本，不改动真实实例与用户数据）
#
# 为什么是「手工」脚本而不是 run-all 的一部分：
#   它会真的启动一个可见的命令行窗口、注册托盘图标、再把窗口隐藏——必须在有真实桌面的
#   会话里跑（无头/服务环境下窗口相关 API 不可用），所以不放进自动化测试。
#
# 流程：复制一份项目到 tmp\tray-e2e-<时间> → 用真实的「启动镜像源.cmd」在独立控制台里启动
#   → 断言：服务在线、命令行窗口被隐藏、托盘日志正常
#   → 模拟左键打开窗口（ShowWindow 校验窗口可显示）
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

"== 停止镜像源（等价于双击「停止镜像源.cmd」）"
Push-Location $dir
$stopOut = (& node cli.js stop 2>&1 | Out-String)
Pop-Location
"stop_out=$($stopOut.Trim())"

$trayExited = $false
$windowClosed = $false
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
  $h = Get-MirrorWindow
  $log = Read-TrayLog
  $trayExited = [bool]($log -match '托盘自动退出|托盘退出')
  $windowClosed = ($h -eq [IntPtr]::Zero)
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
  serviceDown = $serviceDown
  trayExited = $trayExited
  consoleWindowClosed = $windowClosed
  pass = [bool]($up -and $hidden -and $showOk -and $trayExited -and $windowClosed -and $serviceDown)
}
"== RESULT: $($result | ConvertTo-Json -Compress)"
"（隔离副本保留在 $dir，方便看 data\logs\tray.log；不需要时可直接删除）"
if (-not $result.pass) { exit 1 }
