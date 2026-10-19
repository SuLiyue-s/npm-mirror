<#
  compose-desktop-icon.ps1 — 合成桌面版程序图标（零依赖、可重复执行、确定性输出）

  用途（DESIGN 第 9 节）：
    底图            img/icon.ico（用户提供的多尺寸 ico，256 尺寸是 PNG 压缩帧）
    左下角贴图      public/favicon.ico（现有网页版薄荷绿圆角图标，网页 favicon 保持不变）
    右下角贴图      src-tauri/icons/tauri-logo.png（Tauri 官方透明 logo，来自
                    https://raw.githubusercontent.com/tauri-apps/tauri/dev/.github/icon.png）
    输出（全部入库，供 src-tauri 使用）：
      src-tauri/icons/icon.ico          多尺寸（16/24/32/48/64/128/256）32 位 alpha 图标
      src-tauri/icons/window-256.rgba   256x256 纯 RGBA 字节（顶行优先，供窗口图标 include_bytes!）
      src-tauri/icons/tray-32.rgba      32x32 纯 RGBA 字节（供托盘图标 include_bytes!）

  特点：
    - 只用 PowerShell 自带 System.Drawing，无第三方依赖；
    - 自己解析 ICO（PNG 帧 + DIB 帧都支持），不依赖 .NET Icon 类对 256 帧的解析能力；
    - 不修改 img/icon.ico、public/favicon.ico；
    - 相同输入 → 相同输出（无时间戳/随机数），可在构建脚本里反复执行。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/compose-desktop-icon.ps1
    powershell ... -File tools/compose-desktop-icon.ps1 -Root D:\path\to\repo
#>
[CmdletBinding()]
param(
  # 仓库根目录；默认由脚本位置（tools\）推导
  [string]$Root = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

# ---------------- 基础路径 ----------------

function Get-RepoRoot {
  param([string]$Given)
  if ($Given -and $Given.Trim()) { return [System.IO.Path]::GetFullPath($Given) }
  if ($PSScriptRoot) { return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) }
  return [System.IO.Path]::GetFullPath((Get-Location).Path)
}

$RepoRoot = Get-RepoRoot -Given $Root
$BaseIconPath = Join-Path $RepoRoot 'img\icon.ico'
$FaviconPath  = Join-Path $RepoRoot 'public\favicon.ico'
$TauriLogoPath = Join-Path $RepoRoot 'src-tauri\icons\tauri-logo.png'
$IconsDir     = Join-Path $RepoRoot 'src-tauri\icons'

foreach ($f in @($BaseIconPath, $FaviconPath, $TauriLogoPath)) {
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) {
    throw "缺少输入文件：$f（请确认在仓库根目录运行，或用 -Root 指定仓库根目录）"
  }
}
if (-not (Test-Path -LiteralPath $IconsDir -PathType Container)) {
  New-Item -ItemType Directory -Path $IconsDir -Force | Out-Null
}

# 输出尺寸（与 src-tauri 托盘/窗口/资源管理器常用尺寸对齐）
$TargetSizes = @(16, 24, 32, 48, 64, 128, 256)

# ---------------- 通用绘图辅助 ----------------

function New-ArgbBitmap {
  param([int]$Width, [int]$Height)
  return New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
}

function Set-HqGraphics {
  param([System.Drawing.Graphics]$G)
  $G.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $G.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $G.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $G.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $G.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
}

function New-RoundedRectPath {
  param([System.Drawing.RectangleF]$Rect, [single]$Radius)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [single]($Radius * 2)
  if ($d -le 0.01) { $p.AddRectangle($Rect); return $p }
  if ($d -gt $Rect.Width) { $d = $Rect.Width }
  if ($d -gt $Rect.Height) { $d = $Rect.Height }
  $p.AddArc($Rect.X, $Rect.Y, $d, $d, 180, 90)
  $p.AddArc($Rect.Right - $d, $Rect.Y, $d, $d, 270, 90)
  $p.AddArc($Rect.Right - $d, $Rect.Bottom - $d, $d, $d, 0, 90)
  $p.AddArc($Rect.X, $Rect.Bottom - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# ---------------- ICO 解析 ----------------

# 从一帧数据构造 Bitmap（PNG 帧或 DIB 帧）；无法解析返回 $null
function ConvertTo-IconFrameBitmap {
  param([byte[]]$Data)

  if ($null -eq $Data -or $Data.Length -lt 8) { return $null }

  # PNG 压缩帧（Vista 起 256 尺寸常见）
  if ($Data[0] -eq 0x89 -and $Data[1] -eq 0x50 -and $Data[2] -eq 0x4E -and $Data[3] -eq 0x47) {
    $ms = New-Object System.IO.MemoryStream(,$Data)
    $img = $null
    try {
      $img = [System.Drawing.Image]::FromStream($ms)
      $bmp = New-ArgbBitmap -Width $img.Width -Height $img.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $g.DrawImage($img, 0, 0, $img.Width, $img.Height)
      } finally { $g.Dispose() }
      return $bmp
    } catch {
      return $null
    } finally {
      if ($img) { $img.Dispose() }
      $ms.Dispose()
    }
  }

  # DIB 帧：BITMAPINFOHEADER + 像素（自下而上 BGRA）+ AND 掩码
  if ($Data.Length -lt 40) { return $null }
  $biSize = [BitConverter]::ToInt32($Data, 0)
  if ($biSize -lt 40 -or $biSize -gt 256) { return $null }
  $w = [BitConverter]::ToInt32($Data, 4)
  $hRaw = [BitConverter]::ToInt32($Data, 8)
  $bitCount = [BitConverter]::ToUInt16($Data, 14)
  if ($w -le 0 -or $w -gt 1024) { return $null }
  $h = [int]([Math]::Abs([double]$hRaw) / 2.0)
  if ($h -le 0 -or $h -gt 1024) { return $null }
  if ($bitCount -ne 32) { return $null }             # 只处理 32 位 alpha 帧
  $topDown = ($hRaw -lt 0)
  $clrUsed = [BitConverter]::ToUInt32($Data, 32)
  $paletteBytes = 0
  if ($clrUsed -gt 0) { $paletteBytes = [int]$clrUsed * 4 }
  $pixelOffset = $biSize + $paletteBytes
  $rowBytes = $w * 4
  if ($pixelOffset + $rowBytes * $h -gt $Data.Length) { return $null }

  $bmp = New-ArgbBitmap -Width $w -Height $h
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $bd = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $buf = New-Object byte[] ($bd.Stride * $h)
    for ($y = 0; $y -lt $h; $y++) {
      $srcRow = if ($topDown) { $y } else { ($h - 1 - $y) }
      $srcOff = $pixelOffset + $srcRow * $rowBytes
      [System.Array]::Copy($Data, $srcOff, $buf, $y * $bd.Stride, $rowBytes)
    }
    [System.Runtime.InteropServices.Marshal]::Copy($buf, 0, $bd.Scan0, $buf.Length)
  } finally {
    $bmp.UnlockBits($bd)
  }
  return $bmp
}

# 解析 ICO 文件为帧列表：@{ Size; Bitmap }
function Read-IcoFrames {
  param([string]$Path)
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 6) { throw "ICO 文件过小：$Path" }
  $reserved = [BitConverter]::ToUInt16($bytes, 0)
  $type = [BitConverter]::ToUInt16($bytes, 2)
  $count = [BitConverter]::ToUInt16($bytes, 4)
  if ($reserved -ne 0 -or $type -ne 1 -or $count -le 0) { throw "不是有效的 ICO 文件：$Path" }

  $frames = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $count; $i++) {
    $e = 6 + 16 * $i
    if ($e + 16 -gt $bytes.Length) { break }
    $w = [int]$bytes[$e];     if ($w -eq 0) { $w = 256 }
    $hh = [int]$bytes[$e + 1]; if ($hh -eq 0) { $hh = 256 }
    $size = [int][BitConverter]::ToUInt32($bytes, $e + 8)
    $offset = [int][BitConverter]::ToUInt32($bytes, $e + 12)
    if ($size -le 0 -or $offset -le 0 -or ($offset + $size) -gt $bytes.Length) { continue }
    $data = New-Object byte[] $size
    [System.Array]::Copy($bytes, $offset, $data, 0, $size)
    $bmp = ConvertTo-IconFrameBitmap -Data $data
    if ($bmp) {
      [void]$frames.Add([PSCustomObject]@{ Size = [int]([Math]::Min($w, $hh)); Bitmap = $bmp })
    }
  }
  if ($frames.Count -eq 0) { throw "ICO 文件中没有可解析的 32 位帧：$Path" }
  return ,$frames
}

# 取最合适的帧（精确 → 更大的最小 → 更小的最大）
function Get-BestFrame {
  param($Frames, [int]$Size)
  $exact = @($Frames | Where-Object { $_.Size -eq $Size })
  if ($exact.Count -gt 0) { return $exact[0].Bitmap }
  $larger = @($Frames | Where-Object { $_.Size -gt $Size } | Sort-Object -Property Size)
  if ($larger.Count -gt 0) { return $larger[0].Bitmap }
  $smaller = @($Frames | Where-Object { $_.Size -lt $Size } | Sort-Object -Property Size -Descending)
  return $smaller[0].Bitmap
}

# ---------------- 位图辅助 ── 不透明边界裁剪 ----------------

function Get-OpaqueBounds {
  param([System.Drawing.Bitmap]$Bitmap, [int]$Threshold = 8)
  $w = $Bitmap.Width; $h = $Bitmap.Height
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $bd = $Bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $buf = New-Object byte[] ($bd.Stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $buf, 0, $buf.Length)
    $stride = $bd.Stride
  } finally {
    $Bitmap.UnlockBits($bd)
  }
  $minX = $w; $minY = $h; $maxX = -1; $maxY = -1
  for ($y = 0; $y -lt $h; $y++) {
    $row = $y * $stride
    for ($x = 0; $x -lt $w; $x++) {
      if ($buf[$row + $x * 4 + 3] -gt $Threshold) {
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  if ($maxX -lt 0) { return (New-Object System.Drawing.Rectangle(0, 0, $w, $h)) }
  return (New-Object System.Drawing.Rectangle($minX, $minY, ($maxX - $minX + 1), ($maxY - $minY + 1)))
}

function Copy-BitmapRegion {
  param([System.Drawing.Bitmap]$Bitmap, [System.Drawing.Rectangle]$Region)
  $crop = New-ArgbBitmap -Width $Region.Width -Height $Region.Height
  $g = [System.Drawing.Graphics]::FromImage($crop)
  try {
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $g.DrawImage($Bitmap,
      (New-Object System.Drawing.Rectangle(0, 0, $Region.Width, $Region.Height)),
      $Region.X, $Region.Y, $Region.Width, $Region.Height,
      [System.Drawing.GraphicsUnit]::Pixel)
  } finally { $g.Dispose() }
  return $crop
}

# ---------------- 图标合成 ----------------

# 在指定位置画白色圆角底垫 + 图片（图片按比例居中放入底垫，避免拉伸变形）
function Add-Badge {
  param(
    [System.Drawing.Graphics]$G,
    [System.Drawing.Bitmap]$Image,
    [single]$X, [single]$Y, [single]$Size,
    [single]$Pad, [single]$Radius, [System.Drawing.Color]$BackColor, [System.Drawing.Color]$OutlineColor
  )
  $rect = New-Object System.Drawing.RectangleF(($X - $Pad), ($Y - $Pad), ($Size + 2 * $Pad), ($Size + 2 * $Pad))
  $path = New-RoundedRectPath -Rect $rect -Radius $Radius
  $brush = New-Object System.Drawing.SolidBrush($BackColor)
  try { $G.FillPath($brush, $path) } finally { $brush.Dispose() }
  $pen = New-Object System.Drawing.Pen($OutlineColor, [single][Math]::Max(1.0, $Size / 48.0))
  try { $G.DrawPath($pen, $path) } finally { $pen.Dispose() }
  $path.Dispose()

  # 等比缩放居中
  $sw = [single]$Image.Width; $sh = [single]$Image.Height
  $k = [Math]::Min($Size / $sw, $Size / $sh)
  $dw = $sw * $k; $dh = $sh * $k
  $dx = $X + ($Size - $dw) / 2.0
  $dy = $Y + ($Size - $dh) / 2.0
  $G.DrawImage($Image, (New-Object System.Drawing.RectangleF($dx, $dy, $dw, $dh)))
}

# 合成某个尺寸的图标（底图铺满 + 左下 favicon 徽标 + 右下 Tauri logo 徽标）
function New-ComposedIcon {
  param(
    [int]$Size,
    $BaseFrames,
    $FaviconFrames,
    [System.Drawing.Bitmap]$TauriLogo
  )
  $bmp = New-ArgbBitmap -Width $Size -Height $Size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    Set-HqGraphics -G $g
    $g.Clear([System.Drawing.Color]::Transparent)

    # 1) 底图铺满
    $base = Get-BestFrame -Frames $BaseFrames -Size $Size
    $g.DrawImage($base, 0, 0, $Size, $Size)

    # 2) 左下角：现有网页版图标
    #    小尺寸也要能看清，所以徽标占比略大；白色底垫保证在深色底图上可见
    $margin = [single][Math]::Max(1.0, [Math]::Round($Size * 0.035))
    $pad    = [single][Math]::Max(1.0, [Math]::Round($Size * 0.022))
    $radius = [single][Math]::Max(1.5, $Size * 0.11)

    $favSize = [single][Math]::Max(5.0, [Math]::Round($Size * 0.46))
    if (($margin + $favSize + $pad) -gt ($Size * 0.62)) {
      $favSize = [single]([Math]::Max(5.0, $Size * 0.62 - $margin - $pad))
    }
    $fav = Get-BestFrame -Frames $FaviconFrames -Size ([int][Math]::Round($favSize))
    $favX = $margin
    $favY = [single]($Size - $margin - $favSize)
    $white = [System.Drawing.Color]::FromArgb(242, 255, 255, 255)
    $outline = [System.Drawing.Color]::FromArgb(70, 8, 40, 36)
    Add-Badge -G $g -Image $fav -X $favX -Y $favY -Size $favSize -Pad $pad -Radius $radius -BackColor $white -OutlineColor $outline

    # 3) 右下角：Tauri 官方 logo（16px 太糊，略去）
    if ($Size -ge 20 -and $TauriLogo) {
      $tauriSize = [single][Math]::Max(5.0, [Math]::Round($Size * 0.40))
      $tauriX = [single]($Size - $margin - $tauriSize)
      $tauriY = [single]($Size - $margin - $tauriSize)
      # 黄色系底垫（Tauri 品牌黄），带一点透明让底图透出来
      $yellow = [System.Drawing.Color]::FromArgb(246, 255, 205, 0)
      $outlineY = [System.Drawing.Color]::FromArgb(90, 60, 48, 0)
      Add-Badge -G $g -Image $TauriLogo -X $tauriX -Y $tauriY -Size $tauriSize -Pad ([single][Math]::Max(1.0, $pad * 0.8)) -Radius $radius -BackColor $yellow -OutlineColor $outlineY
    }
  } finally {
    $g.Dispose()
  }
  return $bmp
}

# ---------------- 输出：ICO / RGBA ----------------

# 生成 32bpp ICO 的 DIB 数据（BITMAPINFOHEADER + 自下而上 BGRA + 全 0 AND 掩码）
function Get-IconDib {
  param([System.Drawing.Bitmap]$Bitmap, [int]$BoxSize)
  $w = $BoxSize; $h = $BoxSize
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $bd = $Bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $buf = New-Object byte[] ($bd.Stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $buf, 0, $buf.Length)
    $stride = $bd.Stride
  } finally {
    $Bitmap.UnlockBits($bd)
  }

  $maskRowBytes = [int]([Math]::Floor(($w + 31) / 32) * 4)   # 1bpp AND 掩码行按 4 字节对齐
  $dib = New-Object byte[] (40 + $w * $h * 4 + $maskRowBytes * $h)
  [BitConverter]::GetBytes([int]40).CopyTo($dib, 0)          # biSize
  [BitConverter]::GetBytes([int]$w).CopyTo($dib, 4)          # biWidth
  [BitConverter]::GetBytes([int]($h * 2)).CopyTo($dib, 8)    # biHeight（XOR + AND 两倍高）
  [BitConverter]::GetBytes([int16]1).CopyTo($dib, 12)        # biPlanes
  [BitConverter]::GetBytes([int16]32).CopyTo($dib, 14)       # biBitCount
  # biCompression=BI_RGB(0)、biSizeImage/xppm/yppm/clrUsed/clrImportant 均为 0，数组默认值已满足
  for ($y = 0; $y -lt $h; $y++) {
    $srcRow = $h - 1 - $y                                     # ICO DIB 自下而上
    [System.Array]::Copy($buf, $srcRow * $stride, $dib, 40 + $y * $w * 4, $w * 4)
  }
  # AND 掩码保持全 0：32 位图标以 alpha 通道为准
  return ,$dib
}

function Write-IcoFile {
  param([string]$Path, $Bitmaps)
  $count = @($Bitmaps).Count
  $dibs = New-Object System.Collections.ArrayList
  foreach ($b in @($Bitmaps)) { [void]$dibs.Add([byte[]](Get-IconDib -Bitmap $b -BoxSize $b.Width)) }

  $offset = 6 + 16 * $count
  $entries = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $count; $i++) {
    $b = @($Bitmaps)[$i]
    $dib = $dibs[$i]
    $wByte = if ($b.Width -ge 256) { 0 } else { [int]$b.Width }
    $hByte = if ($b.Height -ge 256) { 0 } else { [int]$b.Height }
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    try {
      $bw.Write([byte]$wByte)
      $bw.Write([byte]$hByte)
      $bw.Write([byte]0)              # 调色板颜色数
      $bw.Write([byte]0)              # 保留
      $bw.Write([UInt16]1)            # 平面数
      $bw.Write([UInt16]32)           # 位深
      $bw.Write([UInt32]$dib.Length)  # 数据大小
      $bw.Write([UInt32]$offset)      # 数据偏移
      $bw.Flush()
      [void]$entries.Add($ms.ToArray())
    } finally { $bw.Dispose(); $ms.Dispose() }
    $offset += $dib.Length
  }

  $out = New-Object System.IO.MemoryStream
  $w2 = New-Object System.IO.BinaryWriter($out)
  try {
    $w2.Write([UInt16]0)                # reserved
    $w2.Write([UInt16]1)                # type = icon
    $w2.Write([UInt16]$count)
    foreach ($e in $entries) { $w2.Write($e) }
    foreach ($d in $dibs) { $w2.Write($d) }
    $w2.Flush()
    [System.IO.File]::WriteAllBytes($Path, $out.ToArray())
  } finally { $w2.Dispose(); $out.Dispose() }
}

# 输出纯 RGBA 字节（顶行优先；.NET 位图是 BGRA，这里交换 R/B）
function Write-RgbaFile {
  param([string]$Path, [System.Drawing.Bitmap]$Bitmap)
  $w = $Bitmap.Width; $h = $Bitmap.Height
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $bd = $Bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $buf = New-Object byte[] ($bd.Stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $buf, 0, $buf.Length)
    $stride = $bd.Stride
  } finally {
    $Bitmap.UnlockBits($bd)
  }
  $rgba = New-Object byte[] ($w * $h * 4)
  for ($y = 0; $y -lt $h; $y++) {
    $srcRow = $y * $stride
    $dstRow = $y * $w * 4
    for ($x = 0; $x -lt $w; $x++) {
      $s = $srcRow + $x * 4
      $d = $dstRow + $x * 4
      $rgba[$d] = $buf[$s + 2]
      $rgba[$d + 1] = $buf[$s + 1]
      $rgba[$d + 2] = $buf[$s]
      $rgba[$d + 3] = $buf[$s + 3]
    }
  }
  [System.IO.File]::WriteAllBytes($Path, $rgba)
}

# ---------------- 主流程 ----------------

Write-Host "[compose-desktop-icon] 仓库根：$RepoRoot"

$baseFrames = Read-IcoFrames -Path $BaseIconPath
$favFrames = Read-IcoFrames -Path $FaviconPath
Write-Host ("[compose-desktop-icon] 底图帧：" + (($baseFrames | ForEach-Object { $_.Size }) -join ', '))
Write-Host ("[compose-desktop-icon] favicon 帧：" + (($favFrames | ForEach-Object { $_.Size }) -join ', '))

$tauriLogoFull = New-Object System.Drawing.Bitmap([string]$TauriLogoPath)
$tauriLogo = $null
try {
  # 先裁掉官方 logo 的透明留白，再留 4% 边距，避免徽标里图案过小
  $bounds = Get-OpaqueBounds -Bitmap $tauriLogoFull -Threshold 8
  $marginPx = [int][Math]::Max(1, [Math]::Round([Math]::Max($bounds.Width, $bounds.Height) * 0.04))
  $rx = [Math]::Max(0, $bounds.X - $marginPx)
  $ry = [Math]::Max(0, $bounds.Y - $marginPx)
  $rw = [Math]::Min($tauriLogoFull.Width - $rx, $bounds.Width + 2 * $marginPx)
  $rh = [Math]::Min($tauriLogoFull.Height - $ry, $bounds.Height + 2 * $marginPx)
  $tauriLogo = Copy-BitmapRegion -Bitmap $tauriLogoFull -Region (New-Object System.Drawing.Rectangle($rx, $ry, $rw, $rh))
  Write-Host "[compose-desktop-icon] Tauri logo 裁剪：${rw}x${rh}（原始 $($tauriLogoFull.Width)x$($tauriLogoFull.Height)）"
} finally {
  $tauriLogoFull.Dispose()
}

$composed = New-Object System.Collections.ArrayList
$bitmaps = New-Object System.Collections.ArrayList
foreach ($s in $TargetSizes) {
  $bmp = New-ComposedIcon -Size $s -BaseFrames $baseFrames -FaviconFrames $favFrames -TauriLogo $tauriLogo
  [void]$bitmaps.Add($bmp)
  [void]$composed.Add([PSCustomObject]@{ Size = $s; Bitmap = $bmp })
}

$iconPath = Join-Path $IconsDir 'icon.ico'
$windowRgbaPath = Join-Path $IconsDir 'window-256.rgba'
$trayRgbaPath = Join-Path $IconsDir 'tray-32.rgba'

Write-IcoFile -Path $iconPath -Bitmaps $bitmaps.ToArray()
$b256 = @($composed | Where-Object { $_.Size -eq 256 })[0].Bitmap
$b32 = @($composed | Where-Object { $_.Size -eq 32 })[0].Bitmap
Write-RgbaFile -Path $windowRgbaPath -Bitmap $b256
Write-RgbaFile -Path $trayRgbaPath -Bitmap $b32

# 自检：重新解析写出的 ico，确认帧数与尺寸；检查 RGBA 长度与 alpha 非全 0
$verify = Read-IcoFrames -Path $iconPath
$verifySizes = @($verify | ForEach-Object { $_.Size })
if ($verifySizes.Count -ne $TargetSizes.Count) {
  throw "自检失败：icon.ico 帧数 $($verifySizes.Count)，期望 $($TargetSizes.Count)"
}
for ($i = 0; $i -lt $TargetSizes.Count; $i++) {
  if ($verifySizes[$i] -ne $TargetSizes[$i]) {
    throw "自检失败：icon.ico 第 $i 帧尺寸 $($verifySizes[$i])，期望 $($TargetSizes[$i])"
  }
}
foreach ($p in @($windowRgbaPath, $trayRgbaPath)) {
  $len = (Get-Item -LiteralPath $p).Length
  $rgbaBytes = [System.IO.File]::ReadAllBytes($p)
  $nonZeroAlpha = 0
  for ($i = 3; $i -lt $rgbaBytes.Length; $i += 4) { if ($rgbaBytes[$i] -ne 0) { $nonZeroAlpha++ } }
  if ($nonZeroAlpha -eq 0) { throw "自检失败：$p 的 alpha 全为 0" }
}

foreach ($f in $verify) { $f.Bitmap.Dispose() }
foreach ($b in $bitmaps) { $b.Dispose() }
if ($tauriLogo) { $tauriLogo.Dispose() }
foreach ($f in $baseFrames) { $f.Bitmap.Dispose() }
foreach ($f in $favFrames) { $f.Bitmap.Dispose() }

$iconSize = (Get-Item -LiteralPath $iconPath).Length
$winSize = (Get-Item -LiteralPath $windowRgbaPath).Length
$traySize = (Get-Item -LiteralPath $trayRgbaPath).Length
Write-Host ("[compose-desktop-icon] 输出 icon.ico：{0} 字节，帧 {1}" -f $iconSize, ($verifySizes -join '/'))
Write-Host ("[compose-desktop-icon] 输出 window-256.rgba：{0} 字节；tray-32.rgba：{1} 字节" -f $winSize, $traySize)
Write-Host '[compose-desktop-icon] 完成（public/favicon.ico、img/icon.ico 未修改）'
