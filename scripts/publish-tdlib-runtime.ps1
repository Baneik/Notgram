param(
    [string]$DestinationRoot = "",
    [string]$RuntimeDirectory = "",
    [switch]$SkipPinnedArchiveCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$metadataPath = Join-Path $PSScriptRoot "tdlib\version.json"
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
if (-not $DestinationRoot) {
    $DestinationRoot = Join-Path $repositoryRoot "artifacts\tdlib"
}
if (-not $RuntimeDirectory) {
    $RuntimeDirectory = Join-Path $repositoryRoot "src-tauri\tdlib"
}
$resolvedDestinationRoot = [System.IO.Path]::GetFullPath($DestinationRoot)
$resolvedRuntimeDirectory = [System.IO.Path]::GetFullPath($RuntimeDirectory)
$archivePath = Join-Path $resolvedDestinationRoot $metadata.prebuilt.asset
$checksumPath = "$archivePath.sha256"

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

if ($metadata.prebuilt.target -ne "x86_64-pc-windows-msvc") {
    throw "Unsupported prebuilt TDLib target: $($metadata.prebuilt.target)"
}
& (Join-Path $PSScriptRoot "verify-tdlib.ps1") `
    -RuntimeDirectory $resolvedRuntimeDirectory `
    -RequirePinnedHashes | Out-Null
$runtimePaths = @($metadata.runtime | ForEach-Object {
    Join-Path $resolvedRuntimeDirectory $_.file
})
& (Join-Path $PSScriptRoot "verify-release-privacy.ps1") -Path $runtimePaths

New-Item -ItemType Directory -Path $resolvedDestinationRoot -Force | Out-Null
if ((Test-Path -LiteralPath $archivePath) -or (Test-Path -LiteralPath $checksumPath)) {
    throw "TDLib package destination already exists: $archivePath"
}

Add-Type -AssemblyName System.IO.Compression
$archiveFile = [System.IO.File]::Open(
    $archivePath,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
)
$archive = [System.IO.Compression.ZipArchive]::new(
    $archiveFile,
    [System.IO.Compression.ZipArchiveMode]::Create,
    $false
)
$fixedTimestamp = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)

function Add-ZipFile {
    param(
        [System.IO.Compression.ZipArchive]$Archive,
        [string]$SourcePath,
        [string]$EntryName
    )

    $entry = $Archive.CreateEntry($EntryName, [System.IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = $fixedTimestamp
    $source = [System.IO.File]::OpenRead($SourcePath)
    $destination = $entry.Open()
    try {
        $source.CopyTo($destination)
    } finally {
        $destination.Dispose()
        $source.Dispose()
    }
}

try {
    foreach ($runtime in $metadata.runtime) {
        Add-ZipFile -Archive $archive `
            -SourcePath (Join-Path $resolvedRuntimeDirectory $runtime.file) `
            -EntryName $runtime.file
    }
    foreach ($license in @($metadata.runtime.license | Sort-Object -Unique)) {
        Add-ZipFile -Archive $archive `
            -SourcePath (Join-Path $resolvedRuntimeDirectory "licenses\$license") `
            -EntryName "licenses/$license"
    }

    $runtimeMetadata = [ordered]@{
        schemaVersion = 1
        repository = $metadata.repository
        commit = $metadata.commit
        vcpkgBaseline = $metadata.vcpkgBaseline
        target = $metadata.prebuilt.target
        runtime = $metadata.runtime
    } | ConvertTo-Json -Depth 6
    $metadataEntry = $archive.CreateEntry(
        "RUNTIME-METADATA.json",
        [System.IO.Compression.CompressionLevel]::Optimal
    )
    $metadataEntry.LastWriteTime = $fixedTimestamp
    $writer = [System.IO.StreamWriter]::new(
        $metadataEntry.Open(),
        [System.Text.UTF8Encoding]::new($false)
    )
    try {
        $writer.Write("$runtimeMetadata`n")
    } finally {
        $writer.Dispose()
    }
} finally {
    $archive.Dispose()
    $archiveFile.Dispose()
}

$archiveSha256 = Get-Sha256 -Path $archivePath
if (-not $SkipPinnedArchiveCheck -and $archiveSha256 -ne $metadata.prebuilt.sha256) {
    throw "TDLib package hash $archiveSha256 does not match the pinned archive hash $($metadata.prebuilt.sha256)."
}
[System.IO.File]::WriteAllText(
    $checksumPath,
    "$archiveSha256  $($metadata.prebuilt.asset)`n",
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "TDLib runtime package ready: $archivePath"
Write-Host "SHA-256: $archiveSha256"
