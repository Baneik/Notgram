param(
    [string]$EnvironmentFile = $env:GITHUB_ENV
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$signTool = Get-Command signtool.exe -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Source -First 1
if (-not $signTool) {
    $signTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -File |
        Sort-Object FullName -Descending |
        Select-Object -ExpandProperty FullName -First 1
}
if (-not $signTool) { throw "signtool.exe was not found in the Windows SDK." }
$toolDirectory = Split-Path -Parent $signTool
if (-not [string]::IsNullOrWhiteSpace($EnvironmentFile)) {
    Add-Content -LiteralPath $EnvironmentFile -Value "TAURI_WINDOWS_SIGNTOOL_PATH=$signTool" -Encoding utf8
}
$env:PATH = "$toolDirectory;$env:PATH"
$env:TAURI_WINDOWS_SIGNTOOL_PATH = $signTool
Write-Host "Enabled Windows SDK signing tools."
