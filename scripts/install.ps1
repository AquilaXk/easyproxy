#Requires -Version 5.1
$ErrorActionPreference = "Stop"

Write-Host "Installing easyproxy..." -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js 18+ is required. Install Node from https://nodejs.org/ and rerun this script."
    exit 1
}

$nodeVersion = & node -p "process.versions.node"
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt 18) {
    Write-Error "Node.js 18+ is required. Current version: v$nodeVersion"
    exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm is required to install the published easyproxy package."
    exit 1
}

Write-Host "Using Node v$nodeVersion"

# Install easyproxy globally. npm 12 blocks dependency lifecycle scripts by default, and
# bun's postinstall is what unpacks the bundled runtime; without this approval the install
# succeeds but `epx` cannot start (#8361). npm 8 through 11 accept the flag on global installs.
# (use an elevated PowerShell if the original install was elevated)
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
    $npm = Get-Command npm -ErrorAction Stop
}
& $npm.Source install -g --allow-scripts=bun easyproxy
if ($LASTEXITCODE -ne 0) {
    Write-Error "npm install failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

$epx = Get-Command epx.cmd -ErrorAction SilentlyContinue
if (-not $epx) {
    $epx = Get-Command epx -ErrorAction SilentlyContinue
}
if (-not $epx) {
    $npmPrefix = & $npm.Source prefix -g
    Write-Error "easyproxy installed, but 'epx' is not on PATH. Add your npm global bin directory to PATH, then reopen PowerShell: $npmPrefix"
    exit 1
}

& $epx.Source help *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Error "easyproxy installed, but 'epx.cmd help' failed with exit code $LASTEXITCODE. Check your npm global install and PATH."
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "easyproxy installed! Run 'epx init' to set up." -ForegroundColor Green
