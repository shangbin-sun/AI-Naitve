[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$NodeVersion = '22.13.0',
    [ValidatePattern('^\d+\.\d+$')]
    [string]$PythonVersion = '3.12'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $ProjectRoot
$env:PYTHONUTF8 = '1'

function Refresh-Path {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $paths = @($env:Path, $userPath, $machinePath) -join ';'
    $env:Path = (($paths -split ';' | Where-Object { $_ }) | Select-Object -Unique) -join ';'
}

function Require-Command([string]$Name, [string]$InstallHint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Command not found: $Name. $InstallHint"
    }
}

function Invoke-Native([string]$Command, [object[]]$CommandArgs) {
    $global:LASTEXITCODE = 0
    & $Command @CommandArgs
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Require-Command 'scoop' 'Install Scoop first, or run: scoop install main/uv'
    Write-Host 'uv was not found. Installing main/uv with Scoop.'
    Invoke-Native 'scoop' @('install', 'main/uv')
    Refresh-Path
}
Require-Command 'uv' 'Run: scoop install main/uv'

Require-Command 'nvm' 'Install nvm-windows, then reopen PowerShell.'
Write-Host "Installing and selecting Node.js $NodeVersion with nvm."
Invoke-Native 'nvm' @('install', $NodeVersion)
Invoke-Native 'nvm' @('use', $NodeVersion)
Refresh-Path
Require-Command 'node' 'Confirm that nvm installed Node.js.'
Require-Command 'npm' 'Confirm that nvm installed Node.js (npm is included with Node.js).'

Write-Host "Node.js version: $(& node --version)"
Write-Host "npm version: $(& npm --version)"

Write-Host "Checking for a uv-managed Python $PythonVersion."
$global:LASTEXITCODE = 0
$pythonCandidate = & uv python find $PythonVersion 2>$null
$pythonFindExit = $LASTEXITCODE
$pythonPath = if ($null -ne $pythonCandidate) {
    [string]($pythonCandidate | Select-Object -First 1)
}
else {
    ''
}
$pythonPath = $pythonPath.Trim()
if ($pythonFindExit -ne 0 -or [string]::IsNullOrWhiteSpace($pythonPath)) {
    Write-Host "Python $PythonVersion was not found; installing it with uv."
    Invoke-Native 'uv' @('python', 'install', $PythonVersion)
}
else {
    Write-Host "Found Python $PythonVersion at $pythonPath."
}

$VenvPath = Join-Path $ProjectRoot 'backend\.venv'
$VenvPython = Join-Path $VenvPath 'Scripts\python.exe'
$VenvConfig = Join-Path $VenvPath 'pyvenv.cfg'
$existingVenvVersion = ''
if (Test-Path -LiteralPath $VenvConfig) {
    $versionLine = Select-String -Path $VenvConfig -Pattern '^version_info\s*=\s*(\d+\.\d+)' | Select-Object -First 1
    if ($null -ne $versionLine -and $versionLine.Matches.Count -gt 0) {
        $existingVenvVersion = $versionLine.Matches[0].Groups[1].Value
    }
}
if (Test-Path -LiteralPath $VenvPython) {
    if ($existingVenvVersion -ne $PythonVersion) {
        throw "Existing virtual environment uses Python $existingVenvVersion, but $PythonVersion was requested. Stop its processes and recreate $VenvPath manually."
    }
    Write-Host "Reusing the existing uv virtual environment at $VenvPath."
}
else {
    Invoke-Native 'uv' @('venv', $VenvPath, '--python', $PythonVersion, '--allow-existing')
    if (-not (Test-Path -LiteralPath $VenvPython)) {
        throw "uv did not create the expected Python interpreter: $VenvPython"
    }
}

Write-Host 'Installing backend dependencies.'
Invoke-Native 'uv' @('pip', 'install', '--python', $VenvPython, '-r', 'backend\requirements.lock.txt', '-e', 'backend[test]')

Write-Host 'Installing frontend dependencies.'
Push-Location (Join-Path $ProjectRoot 'frontend')
try {
    Invoke-Native 'npm' @('ci')
}
finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Installation complete. Configure this PowerShell session, then run:'
Write-Host '  .\scripts\dev_win.ps1'
