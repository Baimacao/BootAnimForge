# fetch-node.ps1 - Download a portable Node.js runtime into runtime\node.exe
#
# Why: the app must run on a machine that has never had Node.js installed.
# This is the only bootstrap step (the launcher calls it automatically).
# After it succeeds, nothing else needs to be installed by hand.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File tools\fetch-node.ps1 [-Version 22.20.0]

param(
  [string]$Version = '22.20.0'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root    = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$work    = Join-Path $root '.work\node-dl'
$target  = Join-Path $runtime 'node.exe'

if (Test-Path $target) {
  Write-Host "[node] runtime\node.exe already present"
  exit 0
}
New-Item -ItemType Directory -Force -Path $runtime, $work | Out-Null

$zipName = "node-v$Version-win-x64.zip"
$mirrors = @(
  "https://registry.npmmirror.com/-/binary/node/v$Version/$zipName",
  "https://nodejs.org/dist/v$Version/$zipName",
  "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v$Version/$zipName"
)

$zip = Join-Path $work $zipName
$ok = $false
foreach ($url in $mirrors) {
  try {
    Write-Host "[node] downloading $zipName from $url"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 300
    if ((Get-Item $zip).Length -gt 10MB) { $ok = $true; break }
  } catch {
    Write-Host "[node] mirror failed: $($_.Exception.Message)"
  }
}
if (-not $ok) {
  Write-Error "[node] all mirrors failed. Please install Node.js 18+ manually from https://nodejs.org/"
  exit 1
}

# Extract. tar.exe (bsdtar) ships with Windows 10 1803+ and can read zip.
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
$ex = Join-Path $work 'x'
if (Test-Path $ex) { Remove-Item -Recurse -Force $ex }
New-Item -ItemType Directory -Force -Path $ex | Out-Null

if (Test-Path $tar) {
  & $tar -xf $zip -C $ex
} else {
  Expand-Archive -LiteralPath $zip -DestinationPath $ex -Force
}

$found = Get-ChildItem -Path $ex -Filter 'node.exe' -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $found) {
  Write-Error "[node] node.exe not found inside the archive"
  exit 1
}

Copy-Item $found.FullName $target -Force

# Optional extras that make node behave better: the full distribution also has
# npm/npx, but this app only needs node.exe. Keep the runtime minimal.
Remove-Item -Recurse -Force $ex -ErrorAction SilentlyContinue
Remove-Item -Force $zip -ErrorAction SilentlyContinue

$ver = & $target -v
Write-Host "[node] installed $ver to runtime\node.exe"
exit 0
