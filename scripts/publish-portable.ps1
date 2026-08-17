param(
    [string]$DestinationRoot = "",
    [switch]$SkipBuild,
    [switch]$SkipChecks,
    [switch]$ChecksPassed,
    [switch]$AllowDirty
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
# Progress rendering can fail when an inherited Windows console is resized.
$ProgressPreference = "SilentlyContinue"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$defaultDestinationRoot = Join-Path $repositoryRoot "artifacts\notgram"
$usingDefaultDestination = -not $DestinationRoot
if (-not $DestinationRoot) {
    $DestinationRoot = $defaultDestinationRoot
}
$resolvedDestinationRoot = [System.IO.Path]::GetFullPath($DestinationRoot)
$releaseDirectory = Join-Path $repositoryRoot "src-tauri\target\release"
$executable = Join-Path $releaseDirectory "notgram.exe"
$runtimeSource = Join-Path $releaseDirectory "tdlib"
$version = (Get-Content -LiteralPath (Join-Path $repositoryRoot "version.json") -Raw | ConvertFrom-Json).version
$releasePolicyPath = Join-Path $repositoryRoot "release-policy.json"
$releasePolicy = Get-Content -LiteralPath $releasePolicyPath -Raw | ConvertFrom-Json
$artifactName = "Notgram-$version-windows-x64-portable"
$portableDirectory = Join-Path $resolvedDestinationRoot $artifactName
$portableArchive = Join-Path $resolvedDestinationRoot "$artifactName.zip"

function Invoke-CheckedCommand {
    param(
        [string]$FailureMessage,
        [scriptblock]$Command
    )
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw $FailureMessage
    }
}

function Set-ReleaseEnvironment {
    $apiId = 0
    if (-not [int]::TryParse($env:NOTGRAM_API_ID, [ref]$apiId) -or $apiId -le 0) {
        throw "NOTGRAM_API_ID must be supplied as a positive 32-bit integer in the release process environment."
    }
    if ($env:NOTGRAM_API_HASH -notmatch '^[0-9A-Fa-f]{32}$') {
        throw "NOTGRAM_API_HASH must be supplied as a 32-character hexadecimal value in the release process environment."
    }
    $env:VITE_TELEGRAM_TRANSPORT = "tauri"
    Remove-Item Env:NOTGRAM_DATABASE_KEY_BASE64 -ErrorAction SilentlyContinue
    Remove-Item Env:NOTGRAM_TDLIB_PATH -ErrorAction SilentlyContinue
}

if ($env:OS -ne "Windows_NT") {
    throw "Portable releases currently require Windows."
}
Invoke-CheckedCommand "Version synchronization check failed." { npm.cmd run version:check }
Invoke-CheckedCommand "Release policy check failed." { npm.cmd run release:policy:check }

$commit = (git -C $repositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw "Unable to resolve the release commit." }
$dirty = [bool](git -C $repositoryRoot status --porcelain)
if ($LASTEXITCODE -ne 0) { throw "Unable to inspect the release worktree." }
if ($dirty -and -not $AllowDirty) {
    throw "Refusing to publish from a dirty worktree. Commit the release inputs first."
}

if (-not $SkipBuild) {
    Set-ReleaseEnvironment
    Push-Location $repositoryRoot
    try {
        if (-not $SkipChecks) {
            Invoke-CheckedCommand "Release checks failed." { npm.cmd run check }
        }
        Invoke-CheckedCommand "Tauri release build failed." { npm.cmd run tauri build -- --no-bundle }
    } finally {
        Pop-Location
    }
}

foreach ($requiredPath in @($executable, (Join-Path $runtimeSource "tdjson.dll"))) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Release build output is missing: $requiredPath"
    }
}
$executableVersion = (Get-Item -LiteralPath $executable).VersionInfo.ProductVersion
if ($executableVersion -ne $version) {
    throw "Release executable version is $executableVersion; expected $version. Rebuild before publishing."
}
$tdlib = & (Join-Path $PSScriptRoot "verify-tdlib.ps1") -RuntimeDirectory $runtimeSource | ConvertFrom-Json

if ($usingDefaultDestination -and (Test-Path -LiteralPath $resolvedDestinationRoot)) {
    $resolvedDefaultDestination = [System.IO.Path]::GetFullPath($defaultDestinationRoot)
    if ($resolvedDestinationRoot -ne $resolvedDefaultDestination) {
        throw "Refusing to replace an unexpected portable destination: $resolvedDestinationRoot"
    }
    Remove-Item -LiteralPath $resolvedDestinationRoot -Recurse -Force
} elseif ((Test-Path -LiteralPath $portableDirectory) -or (Test-Path -LiteralPath $portableArchive)) {
    throw "Release destination already exists. Move it aside or choose another -DestinationRoot: $artifactName"
}
New-Item -ItemType Directory -Path $resolvedDestinationRoot -Force | Out-Null
New-Item -ItemType Directory -Path $portableDirectory -Force | Out-Null
Copy-Item -LiteralPath $executable -Destination (Join-Path $portableDirectory "Notgram.exe")
Copy-Item -LiteralPath $runtimeSource -Destination $portableDirectory -Recurse
Copy-Item -LiteralPath $releasePolicyPath -Destination (Join-Path $portableDirectory "RELEASE-POLICY.json")
[System.IO.File]::WriteAllText(
    (Join-Path $portableDirectory ".notgram-portable"),
    "Notgram portable distribution`n",
    [System.Text.UTF8Encoding]::new($false)
)

Push-Location $repositoryRoot
try {
    Invoke-CheckedCommand "Dependency report generation failed." {
        node.exe scripts/generate-dependency-report.mjs --output (Join-Path $portableDirectory "DEPENDENCIES.json")
    }
} finally {
    Pop-Location
}

$tauriCliVersion = (& node.exe -e "const fs=require('node:fs');const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));process.stdout.write(lock.packages['node_modules/@tauri-apps/cli'].version)").Trim()
$metadata = [ordered]@{
    schemaVersion = 1
    application = "Notgram"
    version = $version
    commit = $commit
    sourceTreeClean = -not $dirty
    builtAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    target = "x86_64-pc-windows-msvc"
    artifactType = "portable"
    transport = "tauri"
    checks = [ordered]@{
        versionSynchronization = "passed"
        repositoryChecks = if ($ChecksPassed -or (-not $SkipBuild -and -not $SkipChecks)) { "passed" } else { "not-run" }
        tauriReleaseBuild = if ($SkipBuild) { "prebuilt" } else { "passed" }
        tdlibRuntime = "passed"
    }
    toolchain = [ordered]@{
        node = (& node.exe --version).Trim()
        npm = (& npm.cmd --version).Trim()
        rustc = (& rustc.exe --version).Trim()
        cargo = (& cargo.exe --version).Trim()
        tauriCli = $tauriCliVersion
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
$metadata | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $portableDirectory "BUILD-METADATA.json") -Encoding utf8

$unexpectedFiles = @(Get-ChildItem -LiteralPath $portableDirectory -Recurse -Force -File | Where-Object {
    $_.Name -eq ".env" -or $_.Extension -in @(".pdb", ".map")
})
if ($unexpectedFiles.Count -gt 0) {
    throw "Portable release contains a forbidden environment or debug file."
}
$textFiles = Get-ChildItem -LiteralPath $portableDirectory -Recurse -File | Where-Object {
    $_.Extension -in @(".json", ".txt", ".md")
}
foreach ($textFile in $textFiles) {
    $content = Get-Content -LiteralPath $textFile.FullName -Raw
    if ($content -match '(?im)^\s*(NOTGRAM_API_ID|NOTGRAM_API_HASH|NOTGRAM_DATABASE_KEY_BASE64|NOTGRAM_TDLIB_PATH)\s*=' -or
        $content -match '(?i)"(api_hash|database_encryption_key|proxy_password|proxy_secret|token)"\s*:\s*"(?!\[redacted\])') {
        throw "Portable release text contains a potentially sensitive value: $($textFile.Name)"
    }
}

$hashLines = Get-ChildItem -LiteralPath $portableDirectory -Recurse -File |
    Sort-Object FullName |
    ForEach-Object {
        $relativePath = $_.FullName.Substring($portableDirectory.TrimEnd('\').Length + 1).Replace('\', '/')
        "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $relativePath"
    }
[System.IO.File]::WriteAllLines(
    (Join-Path $portableDirectory "SHA256SUMS.txt"),
    $hashLines,
    [System.Text.UTF8Encoding]::new($false)
)

Compress-Archive -LiteralPath $portableDirectory -DestinationPath $portableArchive -CompressionLevel Optimal
$archiveHash = (Get-FileHash -LiteralPath $portableArchive -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText(
    "$portableArchive.sha256",
    "$archiveHash  $([System.IO.Path]::GetFileName($portableArchive))`n",
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Portable release ready: $portableArchive"
Write-Host "SHA-256: $archiveHash"
