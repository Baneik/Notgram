param(
    [string]$RuntimeDirectory = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$tdlibMetadataPath = Join-Path $PSScriptRoot "tdlib\version.json"
$vcpkgManifestPath = Join-Path $PSScriptRoot "tdlib\vcpkg.json"
if (-not $RuntimeDirectory) {
    $RuntimeDirectory = Join-Path $repositoryRoot "src-tauri\tdlib"
}
$resolvedRuntimeDirectory = [System.IO.Path]::GetFullPath($RuntimeDirectory)
$licensesDirectory = Join-Path $resolvedRuntimeDirectory "licenses"

$metadata = Get-Content -LiteralPath $tdlibMetadataPath -Raw | ConvertFrom-Json
$vcpkgManifest = Get-Content -LiteralPath $vcpkgManifestPath -Raw | ConvertFrom-Json
if ($metadata.commit -notmatch '^[0-9a-f]{40}$') {
    throw "TDLib metadata must pin a full lowercase Git commit."
}
if ($metadata.vcpkgBaseline -ne $vcpkgManifest.'builtin-baseline') {
    throw "TDLib metadata and vcpkg.json use different vcpkg baselines."
}

$verifiedFiles = @()
foreach ($runtime in $metadata.runtime) {
    $runtimePath = Join-Path $resolvedRuntimeDirectory $runtime.file
    $licensePath = Join-Path $licensesDirectory $runtime.license
    if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) {
        throw "TDLib runtime dependency is missing: $($runtime.file)"
    }
    if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
        throw "TDLib runtime license is missing: $($runtime.license)"
    }
    $file = Get-Item -LiteralPath $runtimePath
    $verifiedFiles += [ordered]@{
        file = $runtime.file
        component = $runtime.component
        size = $file.Length
        sha256 = (Get-FileHash -LiteralPath $runtimePath -Algorithm SHA256).Hash.ToLowerInvariant()
        fileVersion = $file.VersionInfo.FileVersion
        license = "licenses/$($runtime.license)"
    }
}

[ordered]@{
    repository = $metadata.repository
    commit = $metadata.commit
    vcpkgBaseline = $metadata.vcpkgBaseline
    runtime = $verifiedFiles
} | ConvertTo-Json -Depth 5
