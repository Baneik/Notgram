param(
    [string]$Destination = "C:\Users\Developer\Desktop\Data\Program\Notgram"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$resolvedDestination = [System.IO.Path]::GetFullPath($Destination)
$releaseDirectory = Join-Path $repositoryRoot "src-tauri\target\release"
$executable = Join-Path $releaseDirectory "notgram.exe"
$runtimeSource = Join-Path $releaseDirectory "tdlib"
$environmentFile = Join-Path $repositoryRoot ".env"

if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
    throw "Local .env is missing. Configure TDLib transport and credentials before publishing."
}

Push-Location $repositoryRoot
try {
    npm run tauri build -- --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "Tauri release build failed." }
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Release executable was not produced: $executable"
}
if (-not (Test-Path -LiteralPath (Join-Path $runtimeSource "tdjson.dll") -PathType Leaf)) {
    throw "Packaged TDLib runtime was not produced: $runtimeSource"
}

New-Item -ItemType Directory -Force $resolvedDestination | Out-Null
New-Item -ItemType Directory -Force (Join-Path $resolvedDestination "logs") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $resolvedDestination "downloads") | Out-Null
Copy-Item -LiteralPath $executable -Destination (Join-Path $resolvedDestination "Notgram.exe") -Force
Copy-Item -LiteralPath $runtimeSource -Destination $resolvedDestination -Recurse -Force
Copy-Item -LiteralPath $environmentFile -Destination (Join-Path $resolvedDestination ".env") -Force

Write-Host "Portable Notgram release is ready: $resolvedDestination"
Get-Item -LiteralPath (Join-Path $resolvedDestination "Notgram.exe") | Select-Object FullName, Length, LastWriteTime
Get-ChildItem -LiteralPath (Join-Path $resolvedDestination "tdlib") -File -Recurse | Select-Object FullName, Length
