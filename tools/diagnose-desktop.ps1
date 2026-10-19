# 桌面版启动环境诊断（只读 + 写一份报告，不联网、不改系统设置）
# 用法：双击项目根目录的「诊断-桌面环境.cmd」，或在 PowerShell 中运行本脚本。
# 输出：tmp\desktop-diagnose.txt

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false } catch { }
try { $OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false } catch { }

$root = Split-Path -Parent $PSScriptRoot
$reportDir = Join-Path $root 'tmp'
$reportPath = Join-Path $reportDir 'desktop-diagnose.txt'
if (-not (Test-Path -LiteralPath $reportDir)) { New-Item -ItemType Directory -Path $reportDir -Force | Out-Null }

$script:buf = New-Object System.Collections.Generic.List[string]
function Add-Line([string]$text) {
    $script:buf.Add($text)
    Write-Host $text
}
function Add-Section([string]$title) {
    Add-Line ''
    Add-Line ('=' * 68)
    Add-Line $title
    Add-Line ('=' * 68)
}
function Try-Err([object]$err) {
    if ($null -eq $err) { return '' }
    return ($err.Exception.Message + ' / ' + $err.Exception.GetType().Name)
}

Add-Line ('桌面环境诊断报告  生成时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'))
Add-Line ('项目根目录：' + $root)

# ---------------------------------------------------------------- C# 探针
$cs = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class DesktopDiag
{
    const int TOKEN_QUERY = 0x0008;
    const int TokenElevation = 20;
    const int TokenIntegrityLevel = 25;
    const int TokenRestrictedSids = 11;
    const int TokenIsAppContainer = 29;
    const int TokenUIAccess = 26;
    const int UOI_NAME = 2;
    const uint TH32CS_SNAPPROCESS = 0x00000002;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint NIM_ADD = 0x00000000;
    const uint NIM_DELETE = 0x00000002;
    const uint NIF_MESSAGE = 0x00000001;
    const uint NIF_ICON = 0x00000002;
    const uint NIF_TIP = 0x00000004;
    const uint WM_APP = 0x8000;
    const uint WS_POPUP = 0x80000000;

    [StructLayout(LayoutKind.Sequential)]
    public struct WNDCLASSW
    {
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public IntPtr lpszMenuName;
        public IntPtr lpszClassName;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct NOTIFYICONDATAW
    {
        public uint cbSize;
        public IntPtr hWnd;
        public uint uID;
        public uint uFlags;
        public uint uCallbackMessage;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szTip;
        public uint dwState;
        public uint dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szInfo;
        public uint uVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szInfoTitle;
        public uint dwInfoFlags;
        public Guid guidItem;
        public IntPtr hBalloonIcon;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SID_AND_ATTRIBUTES
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct TOKEN_MANDATORY_LABEL
    {
        public SID_AND_ATTRIBUTES Label;
    }

    public delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern void SetLastError(uint code);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr GetModuleHandleW(string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
    [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int infoLength, out int returnLength);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr stringSid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr LocalFree(IntPtr mem);

    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetUserObjectInformationW(IntPtr obj, int index, StringBuilder info, int length, out int needed);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ushort RegisterClassW(ref WNDCLASSW wc);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowExW(uint exStyle, string className, string windowName, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll", SetLastError = true)] static extern bool DestroyWindow(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr DefWindowProcW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr FindWindowW(string className, string windowName);
    [DllImport("user32.dll", SetLastError = true)] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr LoadIconW(IntPtr instance, IntPtr iconName);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Shell_NotifyIconW(uint message, ref NOTIFYICONDATAW data);

    static uint ReadTokenUInt(IntPtr token, int infoClass, out bool ok)
    {
        ok = false;
        int length = 0;
        GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out length);
        if (length <= 0) { length = 4; }
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            int returned = 0;
            if (!GetTokenInformation(token, infoClass, buffer, length, out returned)) { return 0; }
            uint value = (uint)Marshal.ReadInt32(buffer);
            ok = true;
            return value;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public static string TokenInfo()
    {
        StringBuilder sb = new StringBuilder();
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token))
        {
            return "OpenProcessToken 失败，GetLastError=" + Marshal.GetLastWin32Error();
        }
        try
        {
            bool ok;
            uint elevation = ReadTokenUInt(token, TokenElevation, out ok);
            sb.AppendLine("TokenElevation(是否提权)=" + elevation + (ok ? "" : "(读取失败)"));
            uint appContainer = ReadTokenUInt(token, TokenIsAppContainer, out ok);
            sb.AppendLine("TokenIsAppContainer=" + appContainer + (ok ? "" : "(读取失败)"));
            uint uiAccess = ReadTokenUInt(token, TokenUIAccess, out ok);
            sb.AppendLine("TokenUIAccess=" + uiAccess + (ok ? "" : "(读取失败)"));
            uint restricted = ReadTokenUInt(token, TokenRestrictedSids, out ok);
            sb.AppendLine("TokenRestrictedSidCount(受限 SID 数量)=" + restricted + (ok ? "" : "(读取失败)"));

            int length = 0;
            GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out length);
            if (length > 0)
            {
                IntPtr buffer = Marshal.AllocHGlobal(length);
                try
                {
                    int returned = 0;
                    if (GetTokenInformation(token, TokenIntegrityLevel, buffer, length, out returned))
                    {
                        TOKEN_MANDATORY_LABEL label = (TOKEN_MANDATORY_LABEL)Marshal.PtrToStructure(buffer, typeof(TOKEN_MANDATORY_LABEL));
                        IntPtr stringSid;
                        if (ConvertSidToStringSidW(label.Label.Sid, out stringSid))
                        {
                            sb.AppendLine("TokenIntegrityLevelSid=" + Marshal.PtrToStringUni(stringSid));
                            LocalFree(stringSid);
                        }
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }

            uint sessionId;
            uint selfPid = (uint)Process.GetCurrentProcess().Id;
            if (ProcessIdToSessionId(selfPid, out sessionId))
            {
                sb.AppendLine("ProcessSessionId=" + sessionId);
            }
            sb.AppendLine("ActiveConsoleSessionId=" + WTSGetActiveConsoleSessionId());
        }
        finally
        {
            CloseHandle(token);
        }
        return sb.ToString();
    }

    static string GetObjectName(IntPtr obj)
    {
        if (obj == IntPtr.Zero) { return "(句柄为空)"; }
        StringBuilder sb = new StringBuilder(512);
        int needed;
        if (GetUserObjectInformationW(obj, UOI_NAME, sb, 1024, out needed)) { return sb.ToString(); }
        return "(读取失败，GetLastError=" + Marshal.GetLastWin32Error() + ")";
    }

    public static string DesktopInfo()
    {
        StringBuilder sb = new StringBuilder();
        sb.AppendLine("WindowStation(窗口站)=" + GetObjectName(GetProcessWindowStation()));
        sb.AppendLine("Desktop(桌面)=" + GetObjectName(GetThreadDesktop(GetCurrentThreadId())));
        IntPtr tray = FindWindowW("Shell_TrayWnd", null);
        sb.AppendLine("Shell_TrayWnd hwnd=" + tray);
        if (tray != IntPtr.Zero)
        {
            uint pid;
            GetWindowThreadProcessId(tray, out pid);
            sb.AppendLine("Shell_TrayWnd 所属进程 pid=" + pid);
        }
        IntPtr progman = FindWindowW("Progman", null);
        sb.AppendLine("Progman hwnd=" + progman);
        return sb.ToString();
    }

    static string TryGetProcessPath(uint pid)
    {
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle == IntPtr.Zero) { return "(OpenProcess 失败，GetLastError=" + Marshal.GetLastWin32Error() + ")"; }
        try
        {
            StringBuilder sb = new StringBuilder(1024);
            int size = sb.Capacity;
            if (QueryFullProcessImageNameW(handle, 0, sb, ref size)) { return sb.ToString(); }
            return "(读取路径失败，GetLastError=" + Marshal.GetLastWin32Error() + ")";
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    public static string ParentChain(uint pid)
    {
        Dictionary<uint, string> names = new Dictionary<uint, string>();
        Dictionary<uint, uint> parents = new Dictionary<uint, uint>();
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1))
        {
            return "(创建进程快照失败，GetLastError=" + Marshal.GetLastWin32Error() + ")";
        }
        try
        {
            PROCESSENTRY32W entry = new PROCESSENTRY32W();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            if (Process32FirstW(snapshot, ref entry))
            {
                do
                {
                    names[entry.th32ProcessID] = entry.szExeFile;
                    parents[entry.th32ProcessID] = entry.th32ParentProcessID;
                }
                while (Process32NextW(snapshot, ref entry));
            }
        }
        finally
        {
            CloseHandle(snapshot);
        }

        StringBuilder sb = new StringBuilder();
        sb.AppendLine("父进程链（由近到远）：");
        uint current = pid;
        int depth = 0;
        while (current != 0 && depth < 8)
        {
            string name = names.ContainsKey(current) ? names[current] : "?";
            sb.AppendLine("  " + depth + ": pid=" + current + " name=" + name + " path=" + TryGetProcessPath(current));
            if (!parents.ContainsKey(current)) { break; }
            current = parents[current];
            depth++;
        }
        sb.AppendLine("explorer.exe 进程列表：");
        foreach (KeyValuePair<uint, string> pair in names)
        {
            if (string.Equals(pair.Value, "explorer.exe", StringComparison.OrdinalIgnoreCase))
            {
                sb.AppendLine("  pid=" + pair.Key + " path=" + TryGetProcessPath(pair.Key));
            }
        }
        return sb.ToString();
    }

    public static string TrayProbe()
    {
        StringBuilder sb = new StringBuilder();
        IntPtr instance = GetModuleHandleW(null);
        string className = "LiYueDiagTrayWindow" + Process.GetCurrentProcess().Id;
        WndProcDelegate proc = delegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
        {
            return DefWindowProcW(hWnd, msg, wParam, lParam);
        };

        WNDCLASSW wc = new WNDCLASSW();
        wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(proc);
        wc.hInstance = instance;
        wc.lpszClassName = Marshal.StringToHGlobalUni(className);
        SetLastError(0);
        ushort atom = RegisterClassW(ref wc);
        sb.AppendLine("RegisterClass atom=" + atom + " GetLastError=" + Marshal.GetLastWin32Error());

        SetLastError(0);
        IntPtr hwnd = CreateWindowExW(0, className, className, WS_POPUP, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
        sb.AppendLine("CreateWindowEx(隐藏窗口) hwnd=" + hwnd + " GetLastError=" + Marshal.GetLastWin32Error());

        IntPtr icon = LoadIconW(IntPtr.Zero, new IntPtr(32512));

        NOTIFYICONDATAW data = new NOTIFYICONDATAW();
        data.cbSize = (uint)Marshal.SizeOf(typeof(NOTIFYICONDATAW));
        data.hWnd = hwnd;
        data.uID = 1;
        data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        data.uCallbackMessage = WM_APP + 7;
        data.hIcon = icon;
        data.szTip = "桌面环境诊断（测试图标）";
        data.szInfo = "";
        data.szInfoTitle = "";

        sb.AppendLine("NOTIFYICONDATAW.cbSize=" + data.cbSize);
        SetLastError(0);
        bool added = Shell_NotifyIconW(NIM_ADD, ref data);
        sb.AppendLine("Shell_NotifyIconW(NIM_ADD) 成功=" + added + " GetLastError=" + Marshal.GetLastWin32Error());
        if (added)
        {
            SetLastError(0);
            bool deleted = Shell_NotifyIconW(NIM_DELETE, ref data);
            sb.AppendLine("Shell_NotifyIconW(NIM_DELETE) 成功=" + deleted + " GetLastError=" + Marshal.GetLastWin32Error());
        }
        if (hwnd != IntPtr.Zero) { DestroyWindow(hwnd); }
        GC.KeepAlive(proc);
        return sb.ToString();
    }
}
'@

$addTypeOk = $true
try {
    Add-Type -TypeDefinition $cs -Language CSharp -ErrorAction Stop
} catch {
    $addTypeOk = $false
    Add-Section '警告'
    Add-Line ('C# 探针编译失败（后续部分检查无法执行）：' + (Try-Err $_))
}

Add-Section '一、身份与令牌（当前诊断脚本进程）'
Add-Line ('PowerShell 进程 PID = ' + $PID)
Add-Line ('当前用户 = ' + [System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
try { Add-Line ('是否管理员 = ' + (New-Object System.Security.Principal.WindowsPrincipal -ArgumentList ([System.Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) } catch { Add-Line ('是否管理员 = 读取失败') }
try { Add-Line ('认证类型 = ' + [System.Security.Principal.WindowsIdentity]::GetCurrent().AuthenticationType) } catch { }
Add-Line ''
Add-Line '--- whoami /user ---'
try { (& whoami.exe /user 2>&1 | Out-String).Split("`n") | ForEach-Object { Add-Line $_.TrimEnd() } } catch { Add-Line ('whoami /user 失败：' + (Try-Err $_)) }
Add-Line ''
Add-Line '--- whoami /groups（仅关键项）---'
try {
    $groupText = (& whoami.exe /groups 2>&1 | Out-String)
    foreach ($line in $groupText.Split("`n")) {
        if ($line -match 'S-1-16-|S-1-5-32-544|S-1-5-32-545|S-1-5-113|Mandatory Label|强制标签|Everyone|Administrators|Users') {
            Add-Line ('  ' + $line.Trim())
        }
    }
} catch { Add-Line ('whoami /groups 失败：' + (Try-Err $_)) }
if ($addTypeOk) {
    Add-Section '二、令牌完整性 / 会话（Win32 探针）'
    try { [DesktopDiag]::TokenInfo().Split("`n") | ForEach-Object { Add-Line $_.TrimEnd() } } catch { Add-Line ('TokenInfo 失败：' + (Try-Err $_)) }
}

Add-Section '三、窗口站 / 桌面 / 任务栏 Shell'
if ($addTypeOk) {
    try { [DesktopDiag]::DesktopInfo().Split("`n") | ForEach-Object { Add-Line $_.TrimEnd() } } catch { Add-Line ('DesktopInfo 失败：' + (Try-Err $_)) }
    Add-Line ''
    Add-Line '--- 当前脚本进程的父进程链 ---'
    try { [DesktopDiag]::ParentChain([uint32]$PID).Split("`n") | ForEach-Object { Add-Line $_.TrimEnd() } } catch { Add-Line ('ParentChain 失败：' + (Try-Err $_)) }
}

Add-Section '四、托盘图标注册权限探测（使用系统默认图标）'
if ($addTypeOk) {
    try { [DesktopDiag]::TrayProbe().Split("`n") | ForEach-Object { Add-Line $_.TrimEnd() } } catch { Add-Line ('TrayProbe 失败：' + (Try-Err $_)) }
}

Add-Section '五、目录可写性探测（创建并删除临时探针目录）'
function Test-DirWritable([string]$label, [string]$dir) {
    if ([string]::IsNullOrWhiteSpace($dir)) {
        Add-Line ('[' + $label + '] 路径为空')
        return
    }
    if (-not (Test-Path -LiteralPath $dir)) {
        Add-Line ('[' + $label + '] 不存在：' + $dir)
        return
    }
    $probe = Join-Path $dir ('.diag-write-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        New-Item -ItemType Directory -Path $probe -ErrorAction Stop | Out-Null
        Set-Content -LiteralPath (Join-Path $probe 'probe.txt') -Value 'ok' -Encoding ascii -ErrorAction Stop
        Remove-Item -LiteralPath $probe -Recurse -Force -ErrorAction Stop
        Add-Line ('[' + $label + '] 可写 OK：' + $dir)
    } catch {
        Add-Line ('[' + $label + '] 不可写 FAIL：' + $dir + ' -> ' + (Try-Err $_))
        try { if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Recurse -Force -ErrorAction SilentlyContinue } } catch { }
    }
}

$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
Test-DirWritable 'LOCALAPPDATA' $localAppData
Test-DirWritable 'LOCALAPPDATA\LiYueNpmMirror（程序配置目录）' (Join-Path $localAppData 'LiYueNpmMirror')
Test-DirWritable 'APPDATA' ([Environment]::GetFolderPath('ApplicationData'))
Test-DirWritable 'TEMP' ([System.IO.Path]::GetTempPath())
Test-DirWritable '项目 tmp 目录' $reportDir
Test-DirWritable 'dist 目录' (Join-Path $root 'dist')

Add-Section '六、环境变量'
foreach ($name in @('USERNAME', 'USERDOMAIN', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'SESSIONNAME', 'COMPUTERNAME')) {
    try { Add-Line ($name + ' = ' + [System.Environment]::GetEnvironmentVariable($name)) } catch { }
}
Add-Line '--- DSH_* / MIRROR_* / TAURI 相关 ---'
$found = $false
foreach ($item in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) {
    if ($item.Key -match '^(DSH|MIRROR|TAURI|WEBVIEW)') {
        $found = $true
        Add-Line ('  ' + $item.Key + ' = ' + $item.Value)
    }
}
if (-not $found) { Add-Line '  （无）' }

Add-Section '七、系统与策略'
try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    Add-Line ('系统 = ' + $os.Caption + ' 版本 ' + $os.Version + ' Build ' + $os.BuildNumber)
} catch {
    Add-Line ('系统版本读取失败：' + (Try-Err $_))
    try { Add-Line ('[Environment]::OSVersion = ' + [Environment]::OSVersion.VersionString) } catch { }
}
foreach ($key in @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer',
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\System',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Policies\System')) {
    try {
        if (Test-Path $key) {
            $item = Get-ItemProperty -Path $key -ErrorAction Stop
            $values = @($item.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' })
            if ($values.Count -gt 0) {
                Add-Line ('[策略] ' + $key)
                foreach ($v in $values) { Add-Line ('  ' + $v.Name + ' = ' + $v.Value) }
            }
        }
    } catch { Add-Line ('[策略] ' + $key + ' 读取失败：' + (Try-Err $_)) }
}
try {
    $uac = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction Stop
    Add-Line ('UAC: EnableLUA=' + $uac.EnableLUA + ' ConsentPromptBehaviorAdmin=' + $uac.ConsentPromptBehaviorAdmin + ' PromptOnSecureDesktop=' + $uac.PromptOnSecureDesktop)
} catch { Add-Line 'UAC 读取失败' }
Add-Line '--- AppCompatFlags\Layers（兼容性层）---'
foreach ($layerKey in @('HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers', 'HKLM:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers')) {
    try {
        if (Test-Path $layerKey) {
            $l = Get-ItemProperty -Path $layerKey -ErrorAction Stop
            $hits = @($l.PSObject.Properties | Where-Object { $_.Name -match 'npm-mirror|npm私人镜像源' })
            if ($hits.Count -gt 0) {
                foreach ($h in $hits) { Add-Line ('  ' + $h.Name + ' = ' + $h.Value) }
            } else { Add-Line ('  ' + $layerKey + '：本程序无条目') }
        }
    } catch { }
}
Add-Line '--- 安全软件 / 沙箱类服务 ---'
try {
    $svcs = Get-Service -ErrorAction Stop | Where-Object { $_.Name -match 'Sandbox|Sandboxie|sbie|360|huorong|hipstray|QQPCMgr|WinDefend|WdNisSvc|MDCoreSvc|Sense' }
    foreach ($s in $svcs) { Add-Line ('  ' + $s.Name + ' [' + $s.Status + ']') }
} catch { Add-Line ('服务枚举失败：' + (Try-Err $_)) }
Add-Line '--- 目录 ACL 摘要 ---'
foreach ($path in @($localAppData, (Join-Path $localAppData 'LiYueNpmMirror'), (Join-Path $root 'dist'))) {
    try {
        if (Test-Path -LiteralPath $path) {
            $acl = Get-Acl -LiteralPath $path -ErrorAction Stop
            Add-Line ('[' + $path + '] Owner=' + $acl.Owner)
            foreach ($ace in $acl.Access) {
                Add-Line ('  ' + $ace.AccessControlType + ' ' + $ace.IdentityReference + ' ' + $ace.FileSystemRights + ' ' + $ace.InheritanceFlags)
            }
        } else {
            Add-Line ('[' + $path + '] 不存在')
        }
    } catch { Add-Line ('[' + $path + '] ACL 读取失败：' + (Try-Err $_)) }
}

Add-Section '八、程序文件与最近运行痕迹'
foreach ($exe in @('dist\npm-mirror-desktop-0.0.4.exe', 'dist\npm-mirror-desktop-0.0.5.exe', 'dist\npm-mirror-desktop-0.0.3.exe')) {
    $full = Join-Path $root $exe
    if (Test-Path -LiteralPath $full) {
        $item = Get-Item -LiteralPath $full
        Add-Line ($exe + '  大小=' + $item.Length + '  修改时间=' + $item.LastWriteTime)
        $labelText = (& icacls.exe $full 2>$null | Out-String)
        $labelMatch = [regex]::Match($labelText, 'Mandatory Label\\(.+)')
        if ($labelMatch.Success) {
            Add-Line ('    完整性标签：' + $labelMatch.Groups[1].Value.Trim())
        }
    }
}
try {
    $log = Join-Path $root 'dist\LiYueNpmMirror\desktop.log'
    if (Test-Path -LiteralPath $log) {
        $logItem = Get-Item -LiteralPath $log
        Add-Line ('desktop.log 大小=' + $logItem.Length + '  修改时间=' + $logItem.LastWriteTime)
    } else {
        Add-Line ('desktop.log 不存在：' + $log)
    }
} catch { }

Add-Section '九、结论提示'
$verdictTray = '未知（未执行探测）'
if ($addTypeOk) {
    try {
        $probeText = [DesktopDiag]::TrayProbe()
        if ($probeText -match 'NIM_ADD\) 成功=True') { $verdictTray = '本进程可以注册托盘图标' }
        elseif ($probeText -match 'NIM_ADD\) 成功=False') {
            if ($probeText -match 'GetLastError=5') { $verdictTray = '系统拒绝本进程注册托盘图标（错误 5 拒绝访问：权限或会话受限）' }
            else { $verdictTray = '系统拒绝本进程注册托盘图标（见上方错误码）' }
        }
    } catch { }
}
Add-Line ('托盘注册探测结论：' + $verdictTray)
if ($addTypeOk) {
    try {
        $why = [DesktopDiag]::DesktopInfo()
        if ($why -match 'WindowStation\(窗口站\)=(.+)') {
            $ws = $Matches[1].Trim()
            if ($ws -ne 'WinSta0') { Add-Line ('窗口站不是 WinSta0（当前=' + $ws + '）：进程不在交互式桌面，无法显示窗口/托盘。') }
            else { Add-Line '窗口站 = WinSta0（交互式桌面），窗口/托盘显示的基本条件满足。' }
        }
    } catch { }
}
$distExe = Get-ChildItem -LiteralPath (Join-Path $root 'dist') -Filter 'npm-mirror-desktop-*.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($null -ne $distExe) {
    $labelText2 = (& icacls.exe $distExe.FullName 2>$null | Out-String)
    if ($labelText2 -match 'Low Mandatory') {
        Add-Line '[重点] 桌面版 exe 带有「低完整性（Low）」标签：即使从资源管理器双击，系统也会把进程降级为低完整性运行，导致无法写配置目录、托盘图标注册被拒绝。'
        Add-Line '       修复方式：双击 启动桌面版.cmd（会自动请求 UAC 修复），或运行 修复-桌面版启动限制.cmd。'
    } elseif ($labelText2 -match 'Medium Mandatory') {
        Add-Line '桌面版 exe 完整性标签为 Medium（正常）。'
    }
}
Add-Line '若本脚本是从 Windows 资源管理器双击启动：第一节、第三节的父进程链中应能看到 explorer.exe。'
Add-Line '请把本报告文件 tmp\desktop-diagnose.txt 发给开发者。'

try {
    [System.IO.File]::WriteAllLines($reportPath, $script:buf, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
    Write-Host ''
    Write-Host ('报告已写入：' + $reportPath)
} catch {
    Write-Host ''
    Write-Host ('报告写入失败：' + (Try-Err $_))
}
