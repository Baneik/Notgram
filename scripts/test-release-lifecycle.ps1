param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [Parameter(Mandatory = $true)]
    [string]$PortableArchive,
    [string]$EvidencePath = "",
    [switch]$ExecuteInstaller,
    [switch]$AllowLocalInstallerMutation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $repositoryRoot "version.json") -Raw | ConvertFrom-Json).version
$commit = (git -C $repositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') {
    throw "Unable to resolve the lifecycle check commit."
}
if (-not $EvidencePath) {
    $EvidencePath = Join-Path $repositoryRoot "artifacts\Notgram-$version-windows-x64-lifecycle.json"
}
$resolvedEvidence = [System.IO.Path]::GetFullPath($EvidencePath)
if ((Test-Path -LiteralPath $resolvedEvidence) -or (Test-Path -LiteralPath "$resolvedEvidence.sha256")) {
    throw "Lifecycle evidence already exists."
}

if ($env:OS -ne "Windows_NT") { throw "Release lifecycle checks require Windows." }
if ($ExecuteInstaller -and $env:CI -ne "true" -and -not $AllowLocalInstallerMutation) {
    throw "Installer execution is restricted to CI unless -AllowLocalInstallerMutation is supplied."
}

$resolvedInstaller = [System.IO.Path]::GetFullPath($InstallerPath)
$resolvedPortable = [System.IO.Path]::GetFullPath($PortableArchive)
foreach ($path in @($resolvedInstaller, $resolvedPortable, "$resolvedPortable.sha256")) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "A required lifecycle artifact is missing."
    }
}

function Test-PeFile {
    param([string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        if ($stream.Length -lt 2 -or $stream.ReadByte() -ne 0x4d -or $stream.ReadByte() -ne 0x5a) {
            throw "A lifecycle executable is not a Windows PE file."
        }
    } finally {
        $stream.Dispose()
    }
}

function Test-ArchiveHash {
    param([string]$ArchivePath)
    $line = (Get-Content -LiteralPath "$ArchivePath.sha256" -Raw).Trim()
    $expectedName = [Regex]::Escape([System.IO.Path]::GetFileName($ArchivePath))
    if ($line -notmatch "^([0-9a-f]{64})  $expectedName$") {
        throw "Portable archive hash record is invalid."
    }
    $actual = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $matches[1]) { throw "Portable archive hash verification failed." }
    return $actual
}

function Expand-CheckedArchive {
    param([string]$ArchivePath, [string]$Destination)
    New-Item -ItemType Directory -Path $Destination | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $prefix = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
        foreach ($entry in $archive.Entries) {
            $target = [System.IO.Path]::GetFullPath((Join-Path $Destination $entry.FullName))
            if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Portable archive contains an unsafe path."
            }
        }
    } finally {
        $archive.Dispose()
    }
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $Destination
}

function Get-OnlyFile {
    param([string]$Root, [string]$Filter)
    $files = @(Get-ChildItem -LiteralPath $Root -Filter $Filter -File -Recurse)
    if ($files.Count -ne 1) { throw "Expected exactly one $Filter lifecycle file." }
    return $files[0].FullName
}

function Invoke-ReleaseProbe {
    param(
        [string]$Executable,
        [string]$ExpectedDistribution,
        [string]$OutputDirectory,
        [switch]$RequireSignature
    )
    Test-PeFile -Path $Executable
    if ($RequireSignature -and
        (Get-AuthenticodeSignature -LiteralPath $Executable).Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "Release probe executable does not have a valid Authenticode signature."
    }
    $output = Join-Path $OutputDirectory "probe-$([Guid]::NewGuid().ToString('N')).json"
    $argument = "--notgram-release-probe=`"$output`""
    $process = Start-Process -FilePath $Executable -ArgumentList $argument -PassThru -Wait
    if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) {
        throw "Release probe failed."
    }
    try {
        $payload = Get-Content -LiteralPath $output -Raw
        $probe = $payload | ConvertFrom-Json
        if ($probe.schemaVersion -ne 1 -or $probe.distribution -ne $ExpectedDistribution -or
            $probe.version -ne $version -or $probe.runtimeVerified -ne $true) {
            throw "Release probe result is invalid."
        }
        if ($payload -match '(?i)(?:[A-Z]:\\|Users\\|phone|token|password|api_hash)') {
            throw "Release probe exposed path or credential-like data."
        }
        return $probe
    } finally {
        [System.IO.File]::Delete($output)
    }
}

function Invoke-ProcessChecked {
    param([string]$Executable, [string]$Arguments, [string]$FailureMessage)
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw $FailureMessage }
}

Test-PeFile -Path $resolvedInstaller
$portableHash = Test-ArchiveHash -ArchivePath $resolvedPortable
$installerHash = (Get-FileHash -LiteralPath $resolvedInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
$checkRoot = Join-Path ([System.IO.Path]::GetTempPath()) "notgram-lifecycle-$([Guid]::NewGuid().ToString('N'))"
$portableFirst = Join-Path $checkRoot "portable-first"
$portableSecond = Join-Path $checkRoot "portable-second"
$installDirectory = Join-Path $checkRoot "installed"
$dataDirectory = if ($ExecuteInstaller) {
    Join-Path $env:APPDATA "dev.notgram.desktop"
} else {
    Join-Path $checkRoot "retained-data"
}
$dataDirectoryExisted = Test-Path -LiteralPath $dataDirectory
$sentinel = Join-Path $dataDirectory "release-lifecycle-$([Guid]::NewGuid().ToString('N')).dat"
$uninstaller = $null
$installerExecuted = $false
$uninstalled = $false

$evidence = [ordered]@{
    schemaVersion = 1
    version = $version
    commit = $commit
    checkedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    installerSha256 = $installerHash
    portableSha256 = $portableHash
    portable = [ordered]@{
        startup = "pending"
        replacement = "pending"
        dataRetained = "pending"
    }
    installer = [ordered]@{
        mode = if ($ExecuteInstaller) { "executed" } else { "artifact-only" }
        startup = "not-run"
        inPlaceUpgrade = "not-run"
        uninstall = "not-run"
        dataRetained = "not-run"
        explicitCleanup = "not-run"
    }
}

try {
    New-Item -ItemType Directory -Path $checkRoot | Out-Null
    New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
    [System.IO.File]::WriteAllText($sentinel, "notgram release lifecycle sentinel`n", [Text.UTF8Encoding]::new($false))

    Expand-CheckedArchive -ArchivePath $resolvedPortable -Destination $portableFirst
    $portableExecutable = Get-OnlyFile -Root $portableFirst -Filter "Notgram.exe"
    Invoke-ReleaseProbe -Executable $portableExecutable -ExpectedDistribution "portable" -OutputDirectory $checkRoot -RequireSignature:$ExecuteInstaller | Out-Null
    $evidence.portable.startup = "passed"

    Expand-CheckedArchive -ArchivePath $resolvedPortable -Destination $portableSecond
    $replacementExecutable = Get-OnlyFile -Root $portableSecond -Filter "Notgram.exe"
    Invoke-ReleaseProbe -Executable $replacementExecutable -ExpectedDistribution "portable" -OutputDirectory $checkRoot -RequireSignature:$ExecuteInstaller | Out-Null
    $evidence.portable.replacement = "passed"
    if (-not (Test-Path -LiteralPath $sentinel -PathType Leaf)) { throw "Portable replacement removed retained data." }
    $evidence.portable.dataRetained = "passed"

    if ($ExecuteInstaller) {
        $signature = Get-AuthenticodeSignature -LiteralPath $resolvedInstaller
        if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
            throw "Executable lifecycle checks require a valid Authenticode installer."
        }
        $installerExecuted = $true
        Invoke-ProcessChecked -Executable $resolvedInstaller -Arguments "/S /D=$installDirectory" -FailureMessage "Silent installation failed."
        $installedExecutable = Join-Path $installDirectory "Notgram.exe"
        if (-not (Test-Path -LiteralPath $installedExecutable -PathType Leaf)) { throw "Installed executable is missing." }
        $uninstaller = Get-OnlyFile -Root $installDirectory -Filter "uninstall*.exe"
        Invoke-ReleaseProbe -Executable $installedExecutable -ExpectedDistribution "installed" -OutputDirectory $checkRoot -RequireSignature | Out-Null
        $evidence.installer.startup = "passed"

        Invoke-ProcessChecked -Executable $resolvedInstaller -Arguments "/S /D=$installDirectory" -FailureMessage "In-place installer upgrade failed."
        Invoke-ReleaseProbe -Executable $installedExecutable -ExpectedDistribution "installed" -OutputDirectory $checkRoot -RequireSignature | Out-Null
        if (-not (Test-Path -LiteralPath $sentinel -PathType Leaf)) { throw "Installer upgrade removed retained data." }
        $evidence.installer.inPlaceUpgrade = "passed"

        Invoke-ProcessChecked -Executable $uninstaller -Arguments "/S" -FailureMessage "Silent uninstallation failed."
        $uninstalled = $true
        if (Test-Path -LiteralPath $installedExecutable -PathType Leaf) { throw "Uninstall left the application executable behind." }
        $evidence.installer.uninstall = "passed"
        if (-not (Test-Path -LiteralPath $sentinel -PathType Leaf)) { throw "Uninstall removed retained account data." }
        $evidence.installer.dataRetained = "passed"

        [System.IO.File]::Delete($sentinel)
        if (Test-Path -LiteralPath $sentinel) { throw "Explicit lifecycle data cleanup failed." }
        $evidence.installer.explicitCleanup = "passed"
    }

    $parent = Split-Path -Parent $resolvedEvidence
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $json = $evidence | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($resolvedEvidence, "$json`n", [Text.UTF8Encoding]::new($false))
    $evidenceHash = (Get-FileHash -LiteralPath $resolvedEvidence -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText(
        "$resolvedEvidence.sha256",
        "$evidenceHash  $([System.IO.Path]::GetFileName($resolvedEvidence))`n",
        [Text.UTF8Encoding]::new($false)
    )
    Write-Host "Release lifecycle checks passed."
} finally {
    if ($installerExecuted -and -not $uninstalled -and -not $uninstaller -and (Test-Path -LiteralPath $installDirectory)) {
        $cleanupCandidates = @(Get-ChildItem -LiteralPath $installDirectory -Filter "uninstall*.exe" -File -ErrorAction SilentlyContinue)
        if ($cleanupCandidates.Count -eq 1) { $uninstaller = $cleanupCandidates[0].FullName }
    }
    if ($installerExecuted -and -not $uninstalled -and $uninstaller -and (Test-Path -LiteralPath $uninstaller)) {
        try { Invoke-ProcessChecked -Executable $uninstaller -Arguments "/S" -FailureMessage "Cleanup uninstall failed." } catch { Write-Warning $_ }
    }
    if (Test-Path -LiteralPath $sentinel) { [System.IO.File]::Delete($sentinel) }
    if (-not $dataDirectoryExisted -and (Test-Path -LiteralPath $dataDirectory) -and
        @(Get-ChildItem -LiteralPath $dataDirectory -Force).Count -eq 0) {
        [System.IO.Directory]::Delete($dataDirectory, $false)
    }
    if (Test-Path -LiteralPath $checkRoot) { [System.IO.Directory]::Delete($checkRoot, $true) }
}
