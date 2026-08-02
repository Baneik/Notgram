param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$PlaywrightArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node.exe).Source
$viteCli = Join-Path $repositoryRoot "node_modules\vite\bin\vite.js"
$playwrightCli = Join-Path $repositoryRoot "node_modules\playwright\cli.js"
$serverProcess = $null
$exitCode = 1
$originalTransport = [Environment]::GetEnvironmentVariable(
    "VITE_TELEGRAM_TRANSPORT",
    [EnvironmentVariableTarget]::Process
)
$originalExternalServer = [Environment]::GetEnvironmentVariable(
    "NOTGRAM_E2E_EXTERNAL_SERVER",
    [EnvironmentVariableTarget]::Process
)

function Restore-ProcessEnvironment([string]$Name, [AllowNull()][string]$Value) {
    if ($null -eq $Value) {
        [Environment]::SetEnvironmentVariable(
            $Name,
            $null,
            [EnvironmentVariableTarget]::Process
        )
    } else {
        [Environment]::SetEnvironmentVariable(
            $Name,
            $Value,
            [EnvironmentVariableTarget]::Process
        )
    }
}

Push-Location $repositoryRoot
try {
    $existingListener = Get-NetTCPConnection `
        -LocalAddress "127.0.0.1" `
        -LocalPort 1422 `
        -State Listen `
        -ErrorAction SilentlyContinue
    if ($existingListener) {
        throw "Port 1422 is already in use. Stop the existing server before running E2E."
    }

    $env:VITE_TELEGRAM_TRANSPORT = "mock"
    $serverProcess = Start-Process `
        -FilePath $nodePath `
        -ArgumentList @($viteCli, "--host", "127.0.0.1", "--port", "1422") `
        -WorkingDirectory $repositoryRoot `
        -WindowStyle Hidden `
        -PassThru

    $available = $false
    for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
        if ($serverProcess.HasExited) {
            throw "The E2E Vite server exited before it became available."
        }
        try {
            $response = Invoke-WebRequest `
                -UseBasicParsing `
                -Uri "http://127.0.0.1:1422" `
                -TimeoutSec 1
            if ($response.StatusCode -eq 200) {
                $available = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 100
        }
    }
    if (-not $available) {
        throw "Timed out waiting for the E2E Vite server."
    }

    $env:NOTGRAM_E2E_EXTERNAL_SERVER = "1"
    & $nodePath $playwrightCli test @PlaywrightArgs
    $exitCode = $LASTEXITCODE
} finally {
    if ($serverProcess -and -not $serverProcess.HasExited) {
        Stop-Process -Id $serverProcess.Id -Force
        $serverProcess.WaitForExit()
    }
    Restore-ProcessEnvironment "VITE_TELEGRAM_TRANSPORT" $originalTransport
    Restore-ProcessEnvironment "NOTGRAM_E2E_EXTERNAL_SERVER" $originalExternalServer
    Pop-Location
}

exit $exitCode
