# 生成白底黑字 "chillin" 图标（PWA + Android 启动图标）
# 用法：pwsh -File scripts\generate-icons.ps1
Add-Type -AssemblyName System.Drawing

function New-ChillinIcon {
    param([string]$Path, [int]$Size, [bool]$ForegroundOnly)
    $dir = Split-Path $Path -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    if ($ForegroundOnly) {
        $g.Clear([System.Drawing.Color]::Transparent)
        $maxRatio = 0.62
    } else {
        $g.Clear([System.Drawing.Color]::White)
        $maxRatio = 0.82
    }

    $fontSize = [int]($Size * 0.30)
    $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    while (($g.MeasureString("chillin", $font).Width -gt ($Size * $maxRatio)) -and ($fontSize -gt 4)) {
        $font.Dispose()
        $fontSize = $fontSize - 1
        $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    }

    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $rect = New-Object System.Drawing.RectangleF(0, 0, $Size, $Size)
    $g.DrawString("chillin", $font, [System.Drawing.Brushes]::Black, $rect, $sf)

    $font.Dispose(); $sf.Dispose(); $g.Dispose()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "OK $Path"
}

# PWA 图标（白底黑字）
New-ChillinIcon "icons\icon-180.png" 180 $false
New-ChillinIcon "icons\icon-192.png" 192 $false
New-ChillinIcon "icons\icon-512.png" 512 $false

# Android 传统启动图标（白底黑字）
New-ChillinIcon "android\app\src\main\res\mipmap-mdpi\ic_launcher.png" 48 $false
New-ChillinIcon "android\app\src\main\res\mipmap-mdpi\ic_launcher_round.png" 48 $false
New-ChillinIcon "android\app\src\main\res\mipmap-hdpi\ic_launcher.png" 72 $false
New-ChillinIcon "android\app\src\main\res\mipmap-hdpi\ic_launcher_round.png" 72 $false
New-ChillinIcon "android\app\src\main\res\mipmap-xhdpi\ic_launcher.png" 96 $false
New-ChillinIcon "android\app\src\main\res\mipmap-xhdpi\ic_launcher_round.png" 96 $false
New-ChillinIcon "android\app\src\main\res\mipmap-xxhdpi\ic_launcher.png" 144 $false
New-ChillinIcon "android\app\src\main\res\mipmap-xxhdpi\ic_launcher_round.png" 144 $false
New-ChillinIcon "android\app\src\main\res\mipmap-xxxhdpi\ic_launcher.png" 192 $false
New-ChillinIcon "android\app\src\main\res\mipmap-xxxhdpi\ic_launcher_round.png" 192 $false

# Android 自适应图标前景（透明底黑字，安全区内）
New-ChillinIcon "android\app\src\main\res\mipmap-mdpi\ic_launcher_foreground.png" 108 $true
New-ChillinIcon "android\app\src\main\res\mipmap-hdpi\ic_launcher_foreground.png" 162 $true
New-ChillinIcon "android\app\src\main\res\mipmap-xhdpi\ic_launcher_foreground.png" 216 $true
New-ChillinIcon "android\app\src\main\res\mipmap-xxhdpi\ic_launcher_foreground.png" 324 $true
New-ChillinIcon "android\app\src\main\res\mipmap-xxxhdpi\ic_launcher_foreground.png" 432 $true

Write-Host "全部图标生成完成"
