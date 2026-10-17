# ============================================================
#  私人 npm 镜像源 · 项目图标生成器（自绘，零依赖）
#  用法：把本文件发给 Windows PowerShell 或 pwsh 执行即可：
#        powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-icon.ps1
#  产物：public\favicon.ico（网页标签页图标 + 托盘图标共用同一个项目图标）
#
#  设计：深色控制台配色里的「镜面」——薄荷绿（#34F0CC → #119C85）圆角方块，
#        中间偏右一道深色竖槽（镜子的反光面）+ 一道细高光，小尺寸下也能认出。
#  说明：多尺寸（16/24/32/48/64/128/256）32 位带 alpha 的 ICO，Windows 托盘、
#        任务栏、浏览器标签页都会自动挑合适的一档，不会糊。
# ============================================================
param(
  # 输出路径默认留空，由脚本体推算——Windows PowerShell 5.1 在 param() 默认值里
  # 还拿不到 $PSScriptRoot（会是空串），所以不能直接写在默认值里。
  [string]$Out = '',
  [int[]]$Sizes = @(16, 24, 32, 48, 64, 128, 256)
)

$ErrorActionPreference = 'Stop'
if (-not $Out) {
  if (-not $PSScriptRoot) { throw '无法确定脚本位置：请用 -File 方式运行，或显式传 -Out <输出路径>' }
  $Out = Join-Path (Split-Path -Parent $PSScriptRoot) 'public\favicon.ico'
}
Add-Type -AssemblyName System.Drawing

function New-RoundedPath([System.Drawing.RectangleF]$Rect, [float]$Radius) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [float]($Radius * 2)
  $p.AddArc($Rect.X, $Rect.Y, $d, $d, 180, 90)
  $p.AddArc(($Rect.Right - $d), $Rect.Y, $d, $d, 270, 90)
  $p.AddArc(($Rect.Right - $d), ($Rect.Bottom - $d), $d, $d, 0, 90)
  $p.AddArc($Rect.X, ($Rect.Bottom - $d), $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-IconBitmap([int]$Size) {
  $s = [float]$Size
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # 圆角方块本体：薄荷绿渐变（与控制台的 --cy 主色一致）
  $bodyRect = New-Object System.Drawing.RectangleF(($s * 0.06), ($s * 0.06), ($s * 0.88), ($s * 0.88))
  $body = New-RoundedPath $bodyRect ([float]($s * 0.24))
  $p1 = New-Object System.Drawing.PointF(0, 0)
  $p2 = New-Object System.Drawing.PointF($s, $s)
  $c1 = [System.Drawing.Color]::FromArgb(255, 52, 240, 204)
  $c2 = [System.Drawing.Color]::FromArgb(255, 17, 156, 133)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($p1, $p2, $c1, $c2)
  $g.FillPath($grad, $body)

  # 深色描边：浅色任务栏下也能看出轮廓
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120, 4, 13, 12), ([float][Math]::Max(1, $s * 0.04)))
  $pen.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
  $g.DrawPath($pen, $body)

  # 中间偏右的深色竖槽：镜子的反光面
  $slotW = $s * 0.20
  $slotH = $s * 0.54
  $slotRect = New-Object System.Drawing.RectangleF(($s * 0.54), (($s - $slotH) / 2), $slotW, $slotH)
  $slot = New-RoundedPath $slotRect ([float]($slotW / 2))
  $slotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 7, 16, 15))
  $g.FillPath($slotBrush, $slot)

  # 槽左侧一道细高光（16px 太小就不画，避免糊成一团）
  if ($Size -ge 24) {
    $hl = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(130, 255, 255, 255))
    $hw = [float][Math]::Max(1, $s * 0.035)
    $g.FillRectangle($hl, [float]($s * 0.455), [float]($s * 0.235), $hw, [float]($s * 0.53))
  }

  $g.Dispose()
  return $bmp
}

# 把 Bitmap 转成 ICO 里的 32 位 DIB（BITMAPINFOHEADER + 自下而上的 BGRA + AND 掩码）
function Get-IconDib([System.Drawing.Bitmap]$Bmp) {
  $size = $Bmp.Width
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $data = $Bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $raw = New-Object byte[] ($stride * $size)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
  $Bmp.UnlockBits($data)

  $maskRow = [int]([Math]::Ceiling($size / 32.0) * 4)
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([uint32]40)                     # biSize
  $bw.Write([int32]$size)                   # biWidth
  $bw.Write([int32]($size * 2))             # biHeight（XOR + AND 两半）
  $bw.Write([uint16]1)                      # biPlanes
  $bw.Write([uint16]32)                     # biBitCount
  $bw.Write([uint32]0)                      # biCompression = BI_RGB
  $bw.Write([uint32](($size * $size * 4) + ($maskRow * $size)))  # biSizeImage
  $bw.Write([int32]0); $bw.Write([int32]0)  # 分辨率（0）
  $bw.Write([uint32]0); $bw.Write([uint32]0)
  # XOR：图像自下而上
  for ($y = $size - 1; $y -ge 0; $y--) {
    $bw.Write($raw, ($y * $stride), ($size * 4))
  }
  # AND 掩码：32 位 alpha 图标用全 0（无透明例外）
  $zero = New-Object byte[] $maskRow
  for ($y = 0; $y -lt $size; $y++) { $bw.Write($zero) }
  $bw.Flush()
  return ,$ms.ToArray()
}

$images = @()
foreach ($sz in $Sizes) {
  $bmp = New-IconBitmap $sz
  $dib = Get-IconDib $bmp
  $bmp.Dispose()
  $images += [pscustomobject]@{ Size = $sz; Bytes = $dib }
}

$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0)                 # reserved
$bw.Write([uint16]1)                 # type = icon
$bw.Write([uint16]$images.Count)     # count
$offset = 6 + (16 * $images.Count)
foreach ($img in $images) {
  $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }
  $bw.Write([byte]$dim)              # width
  $bw.Write([byte]$dim)              # height
  $bw.Write([byte]0)                 # color count
  $bw.Write([byte]0)                 # reserved
  $bw.Write([uint16]1)               # planes
  $bw.Write([uint16]32)              # bit count
  $bw.Write([uint32]$img.Bytes.Length)
  $bw.Write([uint32]$offset)
  $offset += $img.Bytes.Length
}
foreach ($img in $images) { $bytes = [byte[]]$img.Bytes; $bw.Write($bytes, 0, $bytes.Length) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($Out, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()

$info = Get-Item $Out
Write-Host ("图标已生成：{0}（{1} 字节，{2} 个尺寸：{3}）" -f $info.FullName, $info.Length, $images.Count, ($Sizes -join '/'))


