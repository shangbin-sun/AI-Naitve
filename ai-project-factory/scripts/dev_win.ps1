[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$NodeVersion = '22.13.0'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$BackendRoot = Join-Path $ProjectRoot 'backend'
$FrontendRoot = Join-Path $ProjectRoot 'frontend'
$VenvPython = Join-Path $BackendRoot '.venv\Scripts\python.exe'
$env:PYTHONUTF8 = '1'
$backendProcess = $null
$frontendProcess = $null

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

function Test-PortAvailable([int]$Port) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    try {
        $listener.Start()
        return $true
    }
    catch {
        return $false
    }
    finally {
        $listener.Stop()
    }
}

function Stop-ProcessTree([System.Diagnostics.Process]$Process) {
    if ($null -eq $Process) {
        return
    }
    $Process.Refresh()
    if (-not $Process.HasExited) {
        & taskkill.exe /PID $Process.Id /T /F *> $null
    }
}

try {
    if (-not (Test-Path -LiteralPath $VenvPython)) {
        throw "Backend virtual environment not found: $VenvPython. Run .\scripts\setup_win.ps1 first."
    }
    Require-Command 'nvm' 'Install nvm-windows, then reopen PowerShell.'
    $global:LASTEXITCODE = 0
    & nvm use $NodeVersion
    if ($LASTEXITCODE -ne 0) {
        throw "nvm could not select Node.js $NodeVersion. Run .\scripts\setup_win.ps1 first."
    }
    Refresh-Path
    Require-Command 'npm' 'Confirm that nvm installed Node.js.'
    $npmCommand = (Get-Command npm -ErrorAction Stop).Source

    foreach ($port in @(8000, 5173)) {
        if (-not (Test-PortAvailable $port)) {
            throw "Port $port is already in use. Stop the existing service first."
        }
    }

    $backendProcess = Start-Process -FilePath $VenvPython `
        -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000') `
        -WorkingDirectory $BackendRoot -PassThru -NoNewWindow
    $frontendProcess = Start-Process -FilePath $npmCommand `
        -ArgumentList @('run', 'dev') `
        -WorkingDirectory $FrontendRoot -PassThru -NoNewWindow

    Write-Host ''
    Write-Host 'AI Studio: http://127.0.0.1:5173'
    Write-Host 'API docs: http://127.0.0.1:8000/docs'
    Write-Host 'Press Ctrl+C to stop both services.'

    while ($true) {
        $backendProcess.Refresh()
        $frontendProcess.Refresh()
        if ($backendProcess.HasExited -or $frontendProcess.HasExited) {
            break
        }
        Start-Sleep -Milliseconds 500
    }

    $backendCode = if ($backendProcess.HasExited) { $backendProcess.ExitCode } else { 0 }
    $frontendCode = if ($frontendProcess.HasExited) { $frontendProcess.ExitCode } else { 0 }
    if ($backendCode -ne 0 -or $frontendCode -ne 0) {
        Write-Warning "A service exited (backend: $backendCode, frontend: $frontendCode)."
    }
}
finally {
    Stop-ProcessTree $frontendProcess
    Stop-ProcessTree $backendProcess
}
