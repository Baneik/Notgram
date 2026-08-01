param(
    [string]$Destination = (Join-Path $env:LOCALAPPDATA "Programs\Notgram")
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

$environmentValues = @{}
foreach ($line in Get-Content -LiteralPath $environmentFile) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') {
        $environmentValues[$matches[1]] = $matches[2].Trim()
    }
}
if ($environmentValues["VITE_TELEGRAM_TRANSPORT"] -ne "tauri") {
    throw "Portable releases require VITE_TELEGRAM_TRANSPORT=tauri."
}
foreach ($requiredCredential in @("NOTGRAM_API_ID", "NOTGRAM_API_HASH")) {
    if (-not $environmentValues[$requiredCredential]) {
        throw "Portable releases require $requiredCredential in .env."
    }
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
$portableEnvironment = Get-Content -LiteralPath $environmentFile | Where-Object {
    $_ -notmatch '^\s*NOTGRAM_DATABASE_KEY_BASE64\s*=' -and
    $_ -notmatch '^\s*NOTGRAM_TDLIB_PATH\s*='
}
[System.IO.File]::WriteAllLines(
    (Join-Path $resolvedDestination ".env"),
    $portableEnvironment,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Portable Notgram release is ready: $resolvedDestination"
Get-Item -LiteralPath (Join-Path $resolvedDestination "Notgram.exe") | Select-Object FullName, Length, LastWriteTime
Get-ChildItem -LiteralPath (Join-Path $resolvedDestination "tdlib") -File -Recurse | Select-Object FullName, Length
