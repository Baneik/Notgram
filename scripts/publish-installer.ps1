param(
    [string]$DestinationRoot = "",
    [string]$InstallerPath = "",
    [switch]$AllowDirty
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
if (-not $DestinationRoot) {
    $DestinationRoot = Join-Path $repositoryRoot "artifacts"
}
$resolvedDestinationRoot = [System.IO.Path]::GetFullPath($DestinationRoot)
$version = (Get-Content -LiteralPath (Join-Path $repositoryRoot "version.json") -Raw | ConvertFrom-Json).version
$releasePolicyPath = Join-Path $repositoryRoot "release-policy.json"
$releasePolicy = Get-Content -LiteralPath $releasePolicyPath -Raw | ConvertFrom-Json
$artifactName = "Notgram-$version-windows-x64-installer"
$artifactDirectory = Join-Path $resolvedDestinationRoot $artifactName
$metadataPrefix = "$artifactName-"
$releaseDirectory = Join-Path $repositoryRoot "src-tauri\target\release"
$releaseExecutable = Join-Path $releaseDirectory "notgram.exe"
$runtimeDirectory = Join-Path $releaseDirectory "tdlib"

if ($env:OS -ne "Windows_NT") {
    throw "NSIS releases currently require Windows."
}

Push-Location $repositoryRoot
try {
    npm.cmd run version:check
    if ($LASTEXITCODE -ne 0) { throw "Version synchronization check failed." }
    npm.cmd run release:policy:check
    if ($LASTEXITCODE -ne 0) { throw "Release policy check failed." }
} finally {
    Pop-Location
}

$commit = (git -C $repositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') {
    throw "Unable to resolve the release commit."
}
$dirty = [bool](git -C $repositoryRoot status --porcelain)
if ($LASTEXITCODE -ne 0) { throw "Unable to inspect the release worktree." }
if ($dirty -and -not $AllowDirty) {
    throw "Refusing to publish from a dirty worktree. Commit the release inputs first."
}

if (-not (Test-Path -LiteralPath $releaseExecutable -PathType Leaf)) {
    throw "Release executable is missing: $releaseExecutable"
}
$executableVersion = (Get-Item -LiteralPath $releaseExecutable).VersionInfo.ProductVersion
if ($executableVersion -ne $version) {
    throw "Release executable version is $executableVersion; expected $version. Rebuild before publishing."
}

if (-not $InstallerPath) {
    $installerCandidates = @(Get-ChildItem -LiteralPath (Join-Path $releaseDirectory "bundle\nsis") -Filter "*$version*x64-setup.exe" -File -ErrorAction SilentlyContinue)
    if ($installerCandidates.Count -ne 1) {
        throw "Expected exactly one NSIS installer for $version; found $($installerCandidates.Count)."
    }
    $InstallerPath = $installerCandidates[0].FullName
}
$resolvedInstallerPath = [System.IO.Path]::GetFullPath($InstallerPath)
if (-not (Test-Path -LiteralPath $resolvedInstallerPath -PathType Leaf)) {
    throw "NSIS installer is missing: $resolvedInstallerPath"
}
if ((Test-Path -LiteralPath $artifactDirectory)) {
    throw "Release destination already exists. Move it aside or choose another -DestinationRoot: $artifactName"
}

& (Join-Path $PSScriptRoot "verify-release-privacy.ps1") -Path @(
    $releaseExecutable,
    $runtimeDirectory,
    $resolvedInstallerPath
)

$tdlib = & (Join-Path $PSScriptRoot "verify-tdlib.ps1") -RuntimeDirectory $runtimeDirectory | ConvertFrom-Json
New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
$publishedInstaller = Join-Path $artifactDirectory "Notgram-$version-windows-x64-setup.exe"
Copy-Item -LiteralPath $resolvedInstallerPath -Destination $publishedInstaller
Copy-Item -LiteralPath $releasePolicyPath -Destination (Join-Path $artifactDirectory "$($metadataPrefix)RELEASE-POLICY.json")

Push-Location $repositoryRoot
try {
    node.exe scripts/generate-dependency-report.mjs --output (Join-Path $artifactDirectory "$($metadataPrefix)DEPENDENCIES.json")
    if ($LASTEXITCODE -ne 0) { throw "Dependency report generation failed." }
} finally {
    Pop-Location
}

$installerItem = Get-Item -LiteralPath $publishedInstaller
$installerHash = (Get-FileHash -LiteralPath $publishedInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
$metadata = [ordered]@{
    schemaVersion = 1
    application = "Notgram"
    version = $version
    commit = $commit
    sourceTreeClean = -not $dirty
    builtAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    target = "x86_64-pc-windows-msvc"
    artifactType = "nsis"
    artifact = [ordered]@{
        file = $installerItem.Name
        size = $installerItem.Length
        sha256 = $installerHash
    }
    tdlib = $tdlib
    releasePolicy = $releasePolicy
    releaseInputs = [ordered]@{
        apiCredentials = "build-process environment"
        localEnvironmentFileCopied = $false
        databaseKeyOverrideIncluded = $false
        localTdlibPathIncluded = $false
    }
}
$metadataJson = $metadata | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText(
    (Join-Path $artifactDirectory "$($metadataPrefix)BUILD-METADATA.json"),
    "$metadataJson`n",
    [System.Text.UTF8Encoding]::new($false)
)

$hashLines = Get-ChildItem -LiteralPath $artifactDirectory -File |
    Sort-Object Name |
    ForEach-Object {
        "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)"
    }
[System.IO.File]::WriteAllLines(
    (Join-Path $artifactDirectory "$($metadataPrefix)SHA256SUMS.txt"),
    $hashLines,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "NSIS release ready: $artifactDirectory"
Write-Host "Installer SHA-256: $installerHash"
