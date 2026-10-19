#Requires -Version 5.1
<#
.SYNOPSIS
  GitHub token 获取工具（被 tools/publish-release.ps1、tools/release.ps1 复用）。

.DESCRIPTION
  Get-GitHubToken 按顺序尝试：显式参数 > 环境变量 GITHUB_TOKEN / GH_TOKEN >
  Windows 凭据管理器（Git Credential Manager 保存的 github.com 凭据）。
  返回 [pscustomobject]@{ Token; Source }；找不到时返回 $null。
  凭据读取仅在本机进程内完成，不会把 token 写盘。
#>

if (-not ('WinCred.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace WinCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  public static class Native {
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr cred);

    [DllImport("advapi32.dll", EntryPoint = "CredEnumerateW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredEnumerate(string filter, uint flags, out uint count, out IntPtr credentialsPtr);

    public static byte[] ReadBlob(string target) {
      IntPtr ptr;
      if (!CredRead(target, 1, 0, out ptr)) return null;
      try {
        CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
        if (cred.CredentialBlobSize == 0 || cred.CredentialBlob == IntPtr.Zero) return new byte[0];
        byte[] blob = new byte[cred.CredentialBlobSize];
        Marshal.Copy(cred.CredentialBlob, blob, 0, blob.Length);
        return blob;
      } finally {
        CredFree(ptr);
      }
    }

    public static string ReadUserName(string target) {
      IntPtr ptr;
      if (!CredRead(target, 1, 0, out ptr)) return null;
      try {
        CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
        return cred.UserName;
      } finally {
        CredFree(ptr);
      }
    }

    public static string[] ListTargets(string filter) {
      uint count;
      IntPtr ptr;
      if (!CredEnumerate(filter, 0, out count, out ptr)) return new string[0];
      try {
        string[] result = new string[count];
        for (uint i = 0; i < count; i++) {
          IntPtr item = Marshal.ReadIntPtr(ptr, (int)i * IntPtr.Size);
          CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(item, typeof(CREDENTIAL));
          result[i] = cred.TargetName;
        }
        return result;
      } finally {
        CredFree(ptr);
      }
    }
  }
}
'@
}

$script:GitHubTokenPattern = '(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})'

function Get-GitHubTokenFromCredentialManager {
  $pattern = $script:GitHubTokenPattern
  $candidates = @(
    'git:https://github.com',
    'https://github.com',
    'git:https://github.com/SuLiyue-s',
    'GitHub - https://api.github.com',
    'GitHub - https://api.github.com/SuLiyue-s'
  )
  try {
    foreach ($t in [WinCred.Native]::ListTargets($null)) {
      if ($t -and ($t -match 'github')) { $candidates += $t }
    }
  } catch { }

  $seen = @{}
  foreach ($target in ($candidates | Select-Object -Unique)) {
    if ($seen.ContainsKey($target)) { continue }
    $seen[$target] = $true
    try { $blob = [WinCred.Native]::ReadBlob($target) } catch { continue }
    if (-not $blob -or $blob.Length -eq 0) { continue }
    $texts = @()
    try { $texts += [System.Text.Encoding]::Unicode.GetString($blob).Trim([char]0) } catch { }
    try { $texts += [System.Text.Encoding]::UTF8.GetString($blob) } catch { }
    foreach ($text in $texts) {
      if (-not $text) { continue }
      $m = [regex]::Match($text, $pattern)
      if ($m.Success) {
        return [pscustomobject]@{ Token = $m.Value; Source = 'Windows 凭据管理器：' + $target }
      }
    }
    try { $user = [WinCred.Native]::ReadUserName($target) } catch { $user = $null }
    if ($user -and ($user -match $pattern)) {
      return [pscustomobject]@{ Token = $matches[0]; Source = 'Windows 凭据管理器：' + $target }
    }
  }
  return $null
}

function Get-GitHubToken {
  param([string]$Explicit = '')
  if ($Explicit) { return [pscustomobject]@{ Token = $Explicit; Source = '显式参数' } }
  if ($env:GITHUB_TOKEN) { return [pscustomobject]@{ Token = $env:GITHUB_TOKEN; Source = '环境变量 GITHUB_TOKEN' } }
  if ($env:GH_TOKEN) { return [pscustomobject]@{ Token = $env:GH_TOKEN; Source = '环境变量 GH_TOKEN' } }
  return Get-GitHubTokenFromCredentialManager
}
