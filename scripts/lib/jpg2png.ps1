# JPEG -> PNG through system GDI+ (no third-party deps).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File jpg2png.ps1 <in.jpg> <out.png>
param([string]$In, [string]$Out)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($In)
$img.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$img.Dispose()
