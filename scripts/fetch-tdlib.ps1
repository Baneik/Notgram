param(
    [string]$ArchivePath = "",
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$metadataPath = Join-Path $PSScriptRoot "tdlib\version.json"
$runtimeDirectory = Join-Path $repositoryRoot "src-tauri\tdlib"
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
$prebuilt = $metadata.prebuilt

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

if ($env:OS -ne "Windows_NT") {
    throw "The pinned prebuilt TDLib runtime currently supports Windows x64 only."
}
if ($prebuilt.target -ne "x86_64-pc-windows-msvc") {
    throw "Unsupported prebuilt TDLib target: $($prebuilt.target)"
}
if ($prebuilt.sha256 -notmatch '^[0-9a-f]{64}$') {
    throw "Prebuilt TDLib metadata contains an invalid archive SHA-256."
}

if (-not $Force) {
    try {
        & (Join-Path $PSScriptRoot "verify-tdlib.ps1") `
            -RuntimeDirectory $runtimeDirectory `
            -RequirePinnedHashes | Out-Null
        Write-Host "Pinned TDLib runtime is already installed in $runtimeDirectory"
        return
    } catch {
        $existingRuntime = @($metadata.runtime | Where-Object {
            Test-Path -LiteralPath (Join-Path $runtimeDirectory $_.file) -PathType Leaf
        })
        if ($existingRuntime.Count -gt 0) {
            throw "An existing TDLib runtime does not match the pinned prebuilt package. Re-run with -Force to replace it, or keep it as a manual source build."
        }
    }
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("notgram-tdlib-" + [guid]::NewGuid().ToString("N"))
$downloadedArchive = Join-Path $temporaryRoot $prebuilt.asset
$extractedDirectory = Join-Path $temporaryRoot "extracted"

try {
    New-Item -ItemType Directory -Path $temporaryRoot, $extractedDirectory | Out-Null
    if ($ArchivePath) {
        $resolvedArchive = [System.IO.Path]::GetFullPath($ArchivePath)
        if (-not (Test-Path -LiteralPath $resolvedArchive -PathType Leaf)) {
            throw "Prebuilt TDLib archive was not found: $resolvedArchive"
        }
        Copy-Item -LiteralPath $resolvedArchive -Destination $downloadedArchive
    } else {
        $downloadUri = $null
        if (-not [Uri]::TryCreate($prebuilt.url, [UriKind]::Absolute, [ref]$downloadUri) -or
            $downloadUri.Scheme -ne "https" -or $downloadUri.Host -ne "github.com") {
            throw "Prebuilt TDLib URL must be an HTTPS github.com release asset."
        }
        Write-Host "Downloading pinned TDLib runtime from $($prebuilt.url)"
        Invoke-WebRequest -Uri $downloadUri -OutFile $downloadedArchive -Headers @{
            "User-Agent" = "Notgram-TDLib-bootstrap"
        }
    }

    $archiveSha256 = Get-Sha256 -Path $downloadedArchive
    if ($archiveSha256 -ne $prebuilt.sha256) {
        throw "Prebuilt TDLib archive hash mismatch. Expected $($prebuilt.sha256), received $archiveSha256."
    }

    Expand-Archive -LiteralPath $downloadedArchive -DestinationPath $extractedDirectory
    & (Join-Path $PSScriptRoot "verify-tdlib.ps1") `
        -RuntimeDirectory $extractedDirectory `
        -RequirePinnedHashes | Out-Null

    $licenseDirectory = Join-Path $runtimeDirectory "licenses"
    New-Item -ItemType Directory -Path $runtimeDirectory, $licenseDirectory -Force | Out-Null
    foreach ($runtime in $metadata.runtime) {
        Copy-Item -LiteralPath (Join-Path $extractedDirectory $runtime.file) `
            -Destination (Join-Path $runtimeDirectory $runtime.file) -Force
        Copy-Item -LiteralPath (Join-Path $extractedDirectory "licenses\$($runtime.license)") `
            -Destination (Join-Path $licenseDirectory $runtime.license) -Force
    }

    & (Join-Path $PSScriptRoot "verify-tdlib.ps1") `
        -RuntimeDirectory $runtimeDirectory `
        -RequirePinnedHashes | Out-Null
    Write-Host "Pinned TDLib runtime installed in $runtimeDirectory"
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
