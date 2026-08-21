param(
    [string]$RuntimeDirectory = "",
    [switch]$RequirePinnedHashes
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

function Get-Sha256 {
    param([string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

if ($metadata.commit -notmatch '^[0-9a-f]{40}$') {
    throw "TDLib metadata must pin a full lowercase Git commit."
}
if ($metadata.vcpkgBaseline -ne $vcpkgManifest.'builtin-baseline') {
    throw "TDLib metadata and vcpkg.json use different vcpkg baselines."
}

$verifiedFiles = @()
foreach ($runtime in $metadata.runtime) {
    if ($runtime.sha256 -notmatch '^[0-9a-f]{64}$') {
        throw "TDLib runtime metadata has an invalid SHA-256 for $($runtime.file)."
    }
    $runtimePath = Join-Path $resolvedRuntimeDirectory $runtime.file
    $licensePath = Join-Path $licensesDirectory $runtime.license
    if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) {
        throw "TDLib runtime dependency is missing: $($runtime.file)"
    }
    if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
        throw "TDLib runtime license is missing: $($runtime.license)"
    }
    $file = Get-Item -LiteralPath $runtimePath
    $sha256 = Get-Sha256 -Path $runtimePath
    if ($RequirePinnedHashes -and $sha256 -ne $runtime.sha256) {
        throw "TDLib runtime dependency hash mismatch: $($runtime.file)"
    }
    $verifiedFiles += [ordered]@{
        file = $runtime.file
        component = $runtime.component
        size = $file.Length
        sha256 = $sha256
        pinnedSha256 = $runtime.sha256
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
