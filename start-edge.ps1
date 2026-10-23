# Starts the Claude Edge dashboard server (if needed) and opens it as a frameless app window
# on the Xeneon Edge (the 2560x720 / 720x2560 display). Falls back to a normal window elsewhere.
#   -Startup     also create a shortcut so this runs at login
#   -NoBrowser   only start the server
param([switch]$Startup, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction Stop).Source

# Creates the config (port + token) on first run.
& $node -e "require(process.argv[1]).loadConfig()" (Join-Path $here 'config.js')
$cfg = Get-Content (Join-Path $env:USERPROFILE '.claude-edge\config.json') -Raw | ConvertFrom-Json
$base = "http://127.0.0.1:$($cfg.port)"

function Test-Server { try { (Invoke-WebRequest "$base/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false } }

if (-not (Test-Server)) {
  $log = Join-Path $env:USERPROFILE '.claude-edge\server.log'
  Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $here 'server.js')`"" -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  for ($i = 0; $i -lt 20 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-Server)) { throw "Dashboard server did not start; see $log.err" }
}

if ($Startup) {
  $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Edge.lnk'
  $sh = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $sh.TargetPath = 'powershell.exe'
  $sh.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`""
  $sh.WindowStyle = 7
  $sh.Save()
  Write-Host "Added login shortcut: $lnk"
}
if ($NoBrowser) { return }

Add-Type -AssemblyName System.Windows.Forms
$edge = [System.Windows.Forms.Screen]::AllScreens | Where-Object {
  ($_.Bounds.Width -eq 2560 -and $_.Bounds.Height -eq 720) -or ($_.Bounds.Width -eq 720 -and $_.Bounds.Height -eq 2560)
} | Select-Object -First 1

$browser = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw 'Microsoft Edge or Chrome not found.' }

# A separate profile so the window flags apply even when the browser is already open.
$profileDir = Join-Path $env:LOCALAPPDATA 'claude-edge\browser'
$bargs = @("--app=$base/#t=$($cfg.token)", "--user-data-dir=`"$profileDir`"", '--no-first-run', '--disable-pinch', '--overscroll-history-navigation=0')
if ($edge) {
  $b = $edge.Bounds
  $bargs += "--window-position=$($b.X),$($b.Y)", "--window-size=$($b.Width),$($b.Height)", '--start-fullscreen'
} else {
  Write-Host 'Xeneon Edge (2560x720) not detected; opening a regular window.'
  $bargs += '--window-size=1600,520'
}
Start-Process -FilePath $browser -ArgumentList $bargs
