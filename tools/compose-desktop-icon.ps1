#Requires -Version 5.1
<#
.SYNOPSIS
  从网页版图标 public/favicon.ico 生成桌面程序图标产物（v0.0.4 起统一使用网页版图标）。

.DESCRIPTION
  生成（输出路径与文件名固定，build-desktop.ps1 依赖）：
    1. src-tauri/icons/icon.ico        = public/favicon.ico 逐字节复制（exe / 窗口默认图标）
    2. src-tauri/icons/window-256.rgba = favicon 256x256 帧解包为 RGBA（顶行优先，256*256*4=262144 字节）
    3. src-tauri/icons/tray-32.rgba    = favicon 32x32 帧解包为 RGBA（32*32*4=4096 字节）

  同时删除旧版遗留的 src-tauri/icons/tauri-logo.png，不再读取 img/icon.ico。
  零外部依赖（仅 PowerShell + System.Drawing 用于 PNG 压缩帧兜底解码），可重复执行（幂等）。
  网页版图标 public/favicon.ico 本身不做任何修改。

.PARAMETER Root
  仓库根目录；默认由脚本所在目录（tools/）的上级推导。
#>
[CmdletBinding()]
param(
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Add-Type -AssemblyName System.Drawing

function Get-RepoRoot {
  if ($Root -and (Test-Path -LiteralPath $Root)) {
    return (Resolve-Path -LiteralPath $Root).Path
  }
  return (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
}

function Read-IcoEntries {
  param([byte[]]$Bytes)
  if ($Bytes.Length -lt 6) { throw 'ICO 文件过小，无法解析。' }
  $reserved = [BitConverter]::ToUInt16($Bytes, 0)
  $type = [BitConverter]::ToUInt16($Bytes, 2)
  $count = [BitConverter]::ToUInt16($Bytes, 4)
  if ($reserved -ne 0 -or $type -ne 1 -or $count -le 0) {
    throw ('不是有效的 ICO 文件（reserved={0} type={1} count={2}）。' -f $reserved, $type, $count)
  }
  $entries = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $count; $i++) {
    $base = 6 + 16 * $i
    if ($base + 16 -gt $Bytes.Length) { throw ('ICO 目录越界（索引 {0}）。' -f $i) }
    $w = [int]$Bytes[$base]
    $h = [int]$Bytes[$base + 1]
    if ($w -eq 0) { $w = 256 }
    if ($h -eq 0) { $h = 256 }
    $bitCount = [BitConverter]::ToUInt16($Bytes, $base + 6)
    $bytesInRes = [BitConverter]::ToUInt32($Bytes, $base + 8)
    $offset = [BitConverter]::ToUInt32($Bytes, $base + 12)
    if ([int64]$offset + [int64]$bytesInRes -gt $Bytes.Length) {
      throw ('ICO 帧越界（{0}x{1}）。' -f $w, $h)
    }
    $null = $entries.Add([pscustomobject]@{
      Index      = $i
      Width      = $w
      Height     = $h
      BitCount   = [int]$bitCount
      BytesInRes = [int]$bytesInRes
      Offset     = [int]$offset
    })
  }
  return ,$entries
}

# 把一帧 ICO 数据解码为 RGBA 顶行优先像素（DIB 帧自下而上 BGRA；PNG 帧用 System.Drawing 兜底）。
function Get-FramePixels {
  param(
    [byte[]]$Bytes,
    [object]$Entry
  )
  $data = New-Object byte[] $Entry.BytesInRes
  [Array]::Copy($Bytes, $Entry.Offset, $data, 0, $Entry.BytesInRes)
  $isPng = ($data.Length -ge 8) -and ($data[0] -eq 0x89) -and ($data[1] -eq 0x50) -and ($data[2] -eq 0x4E) -and ($data[3] -eq 0x47)
  if ($isPng) {
    $stream = New-Object System.IO.MemoryStream($data, $false)
    try {
      $image = [System.Drawing.Image]::FromStream($stream)
      $bitmap = New-Object System.Drawing.Bitmap($image)
      $width = $bitmap.Width
      $height = $bitmap.Height
      $pixels = New-Object byte[] ($width * $height * 4)
      for ($y = 0; $y -lt $height; $y++) {
        for ($x = 0; $x -lt $width; $x++) {
          $c = $bitmap.GetPixel($x, $y)
          $p = ($y * $width + $x) * 4
          $pixels[$p] = $c.R
          $pixels[$p + 1] = $c.G
          $pixels[$p + 2] = $c.B
          $pixels[$p + 3] = $c.A
        }
      }
      return [pscustomobject]@{ Width = $width; Height = $height; Pixels = $pixels }
    } finally {
      $stream.Dispose()
    }
  }

  # DIB（BITMAPINFOHEADER）帧
  if ($data.Length -lt 40) { throw 'ICO 帧数据过小，不是有效的 DIB/PNG 帧。' }
  $biSize = [BitConverter]::ToUInt32($data, 0)
  $biWidth = [BitConverter]::ToInt32($data, 4)
  $biHeight = [BitConverter]::ToInt32($data, 8)
  $biPlanes = [BitConverter]::ToUInt16($data, 12)
  $biBitCount = [BitConverter]::ToUInt16($data, 14)
  $biCompression = [BitConverter]::ToUInt32($data, 16)
  if ($biSize -lt 40 -or $biWidth -le 0 -or $biHeight -le 0) { throw 'DIB 帧头无效。' }
  if ($biPlanes -ne 1 -or $biCompression -ne 0) { throw ('不支持的 DIB 格式：planes={0} compression={1}。' -f $biPlanes, $biCompression) }
  $width = $biWidth
  $height = [int]($biHeight / 2)   # XOR 位图 + AND 掩码，高度是显示高度的 2 倍
  if ($biBitCount -ne 32) { throw ('不支持的 DIB 位深：{0}（预期 32 位 BGRA）。' -f $biBitCount) }
  $stride = $width * 4
  $pixelOffset = [int]$biSize
  $need = $pixelOffset + $stride * $height
  if ($data.Length -lt $need) { throw ('DIB 像素数据不完整（需要 {0} 字节，实际 {1}）。' -f $need, $data.Length) }
  $pixels = New-Object byte[] ($width * $height * 4)
  for ($y = 0; $y -lt $height; $y++) {
    $srcRow = $pixelOffset + ($height - 1 - $y) * $stride   # 自下而上翻转
    $dstRow = $y * $width * 4
    for ($x = 0; $x -lt $width; $x++) {
      $s = $srcRow + $x * 4
      $d = $dstRow + $x * 4
      $pixels[$d] = $data[$s + 2]       # R <- B
      $pixels[$d + 1] = $data[$s + 1]   # G
      $pixels[$d + 2] = $data[$s]       # B <- R
      $pixels[$d + 3] = $data[$s + 3]   # A
    }
  }
  return [pscustomobject]@{ Width = $width; Height = $height; Pixels = $pixels }
}

function Find-FrameBySize {
  param(
    [object[]]$Entries,
    [int]$Width,
    [int]$Height
  )
  $exact = $Entries | Where-Object { $_.Width -eq $Width -and $_.Height -eq $Height -and $_.BitCount -eq 32 } | Select-Object -First 1
  if ($exact) { return $exact }
  return ($Entries | Where-Object { $_.Width -eq $Width -and $_.Height -eq $Height } | Select-Object -First 1)
}

function Get-OpaqueCount {
  param([byte[]]$Pixels)
  $count = 0
  for ($i = 3; $i -lt $Pixels.Length; $i += 4) {
    if ($Pixels[$i] -ne 0) { $count++ }
  }
  return $count
}

function Get-Sha256 {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$repo = Get-RepoRoot
Set-Location $repo
Write-Host ('仓库根目录：' + $repo)

$favicon = Join-Path $repo 'public\favicon.ico'
$iconDir = Join-Path $repo 'src-tauri\icons'
$outIco = Join-Path $iconDir 'icon.ico'
$outWindow = Join-Path $iconDir 'window-256.rgba'
$outTray = Join-Path $iconDir 'tray-32.rgba'
$legacyTauri = Join-Path $iconDir 'tauri-logo.png'

if (-not (Test-Path -LiteralPath $favicon)) { throw ('缺少网页版图标：' + $favicon) }
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null

$faviconBytes = [System.IO.File]::ReadAllBytes($favicon)
$entries = Read-IcoEntries -Bytes $faviconBytes
Write-Host ('网页版图标：{0}（{1} 字节，{2} 帧）' -f $favicon, $faviconBytes.Length, $entries.Count)
foreach ($entry in $entries) {
  Write-Host ('  帧 #{0}: {1}x{2} {3}bpp {4} 字节 @ {5}' -f $entry.Index, $entry.Width, $entry.Height, $entry.BitCount, $entry.BytesInRes, $entry.Offset)
}

$frame256 = Find-FrameBySize -Entries $entries -Width 256 -Height 256
$frame32 = Find-FrameBySize -Entries $entries -Width 32 -Height 32
if (-not $frame256) { throw 'favicon.ico 中找不到 256x256 帧，无法生成 window-256.rgba。' }
if (-not $frame32) { throw 'favicon.ico 中找不到 32x32 帧，无法生成 tray-32.rgba。' }

$pixels256 = Get-FramePixels -Bytes $faviconBytes -Entry $frame256
$pixels32 = Get-FramePixels -Bytes $faviconBytes -Entry $frame32
if ($pixels256.Pixels.Length -ne 256 * 256 * 4) { throw ('256 帧解包尺寸异常：{0}' -f $pixels256.Pixels.Length) }
if ($pixels32.Pixels.Length -ne 32 * 32 * 4) { throw ('32 帧解包尺寸异常：{0}' -f $pixels32.Pixels.Length) }

# 1) icon.ico：逐字节复制网页版图标
[System.IO.File]::WriteAllBytes($outIco, $faviconBytes)
# 2) window-256.rgba：256x256 RGBA 顶行优先
[System.IO.File]::WriteAllBytes($outWindow, $pixels256.Pixels)
# 3) tray-32.rgba：32x32 RGBA 顶行优先
[System.IO.File]::WriteAllBytes($outTray, $pixels32.Pixels)

# 清理旧版遗留的 Tauri 官方 logo（v0.0.4 起不再使用）
$removed = $false
if (Test-Path -LiteralPath $legacyTauri) {
  Remove-Item -LiteralPath $legacyTauri -Force
  $removed = $true
}

Write-Host ''
Write-Host '生成结果：'
$summary = @(
  [pscustomobject]@{ Name = 'icon.ico'; Path = $outIco; Expected = $faviconBytes.Length; Size = '多尺寸（网页版图标逐字节复制）' },
  [pscustomobject]@{ Name = 'window-256.rgba'; Path = $outWindow; Expected = 262144; Size = '256x256 RGBA' },
  [pscustomobject]@{ Name = 'tray-32.rgba'; Path = $outTray; Expected = 4096; Size = '32x32 RGBA' }
)
foreach ($item in $summary) {
  $actual = (Get-Item -LiteralPath $item.Path).Length
  if ($actual -ne $item.Expected) {
    throw ('输出文件大小异常：{0} 期望 {1} 字节，实际 {2} 字节。' -f $item.Name, $item.Expected, $actual)
  }
  $hash = Get-Sha256 -Path $item.Path
  Write-Host ('  {0,-16} {1,7} 字节  SHA256={2}  ({3})' -f $item.Name, $actual, $hash, $item.Size)
}
$opaque256 = Get-OpaqueCount -Pixels $pixels256.Pixels
$opaque32 = Get-OpaqueCount -Pixels $pixels32.Pixels
if ($opaque256 -le 0) { throw 'window-256.rgba 全透明，图标内容异常。' }
if ($opaque32 -le 0) { throw 'tray-32.rgba 全透明，图标内容异常。' }
Write-Host ('尺寸/透明度校验：256 帧 {0}x{1}，不透明像素 {2}/{3}；32 帧 {4}x{5}，不透明像素 {6}/{7}' -f `
    $pixels256.Width, $pixels256.Height, $opaque256, (256 * 256), `
    $pixels32.Width, $pixels32.Height, $opaque32, (32 * 32))
Write-Host ('favicon.ico SHA256={0}' -f (Get-Sha256 -Path $favicon))
if ($removed) { Write-Host '已删除旧版遗留文件：src-tauri/icons/tauri-logo.png' }
Write-Host ''
Write-Host '[图标生成完成] 桌面程序图标已统一为网页版图标（public/favicon.ico）。'
exit 0
