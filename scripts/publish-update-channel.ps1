param(
    [string]$DestinationRoot = "",
    [string]$BaseDownloadUrl = $env:NOTGRAM_UPDATE_BASE_URL,
    [string]$UpdateArtifact = "",
    [string]$SignaturePath = "",
    [switch]$AllowDirty
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
if (-not $DestinationRoot) {
    $DestinationRoot = Join-Path $repositoryRoot "artifacts\update"
}
$version = (Get-Content -LiteralPath (Join-Path $repositoryRoot "version.json") -Raw | ConvertFrom-Json).version
$policy = Get-Content -LiteralPath (Join-Path $repositoryRoot "release-policy.json") -Raw | ConvertFrom-Json
$versionCheck = & node.exe (Join-Path $PSScriptRoot "sync-version.mjs") --check
if ($LASTEXITCODE -ne 0) { throw "Version synchronization check failed.`n$versionCheck" }
$policyCheck = & node.exe (Join-Path $PSScriptRoot "verify-release-policy.mjs")
if ($LASTEXITCODE -ne 0) { throw "Release policy check failed.`n$policyCheck" }
$dirty = [bool](git -C $repositoryRoot status --porcelain)
if ($LASTEXITCODE -ne 0) { throw "Unable to inspect the release worktree." }
if ($dirty -and -not $AllowDirty) {
    throw "Refusing to stage an update channel from a dirty worktree."
}
$releaseChannel = if ($version.Contains("-")) { "candidate" } else { "stable" }
if (-not $policy.channels.$releaseChannel) { throw "Release policy does not define channel $releaseChannel." }
if ($releaseChannel -eq "stable" -and $policy.channels.stable.acceptPrerelease) {
    throw "Stable release policy must reject prerelease versions."
}
if ($policy.channels.candidate.acceptStable -ne $true) {
    throw "Candidate channel policy must accept promotion to a stable release."
}
if ($policy.rollback.allowDowngrades) {
    throw "Release policy must not enable automatic downgrades."
}
$baseUri = $null
if (-not [Uri]::TryCreate($BaseDownloadUrl, [UriKind]::Absolute, [ref]$baseUri) -or
    $baseUri.Scheme -ne "https" -or $baseUri.UserInfo -or
    $baseUri.Query -or $baseUri.Fragment) {
    throw "NOTGRAM_UPDATE_BASE_URL must be an HTTPS URL."
}
$baseUrl = $baseUri.AbsoluteUri.TrimEnd('/')

$bundleDirectory = Join-Path $repositoryRoot "src-tauri\target\release\bundle\nsis"
if (-not $UpdateArtifact) {
    $artifacts = @(Get-ChildItem -LiteralPath $bundleDirectory -Filter "*$version*x64-setup.exe" -File -ErrorAction SilentlyContinue | Where-Object {
        Test-Path -LiteralPath "$($_.FullName).sig" -PathType Leaf
    })
    if ($artifacts.Count -ne 1) {
        throw "Expected exactly one signed updater installer for $version; found $($artifacts.Count)."
    }
    $UpdateArtifact = $artifacts[0].FullName
}
$resolvedArtifact = [System.IO.Path]::GetFullPath($UpdateArtifact)
if (-not $SignaturePath) { $SignaturePath = "$resolvedArtifact.sig" }
$resolvedSignature = [System.IO.Path]::GetFullPath($SignaturePath)
foreach ($path in @($resolvedArtifact, $resolvedSignature)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Updater release input is missing: $path"
    }
}
$artifactHeader = [System.IO.File]::ReadAllBytes($resolvedArtifact)
if ($artifactHeader.Length -lt 2 -or $artifactHeader[0] -ne 0x4d -or $artifactHeader[1] -ne 0x5a) {
    throw "Updater installer is not a Windows PE executable."
}
$signature = (Get-Content -LiteralPath $resolvedSignature -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($signature) -or $signature.Length -gt 4096) {
    throw "Updater signature is empty or unexpectedly large."
}
$signatureBytes = $null
try {
    $signatureBytes = [Convert]::FromBase64String($signature)
    $signatureText = [Text.Encoding]::UTF8.GetString($signatureBytes)
    if (-not $signatureText.StartsWith("untrusted comment: signature from tauri secret key")) {
        throw "unexpected signature format"
    }
} catch {
    throw "Updater signature is not valid Base64 Tauri signature data."
} finally {
    if ($signatureBytes) { [Array]::Clear($signatureBytes, 0, $signatureBytes.Length) }
}

$resolvedDestinationRoot = [System.IO.Path]::GetFullPath($DestinationRoot)
$targetChannels = if ($releaseChannel -eq "stable") { @("stable", "candidate") } else { @("candidate") }
$deploymentArchive = Join-Path (Split-Path -Parent $resolvedDestinationRoot) "Notgram-$version-update-channel.zip"
foreach ($path in @($deploymentArchive, "$deploymentArchive.sha256")) {
    if (Test-Path -LiteralPath $path) { throw "Update deployment artifact already exists: $path" }
}
foreach ($channel in $targetChannels) {
    $channelDirectory = Join-Path $resolvedDestinationRoot $channel
    if (Test-Path -LiteralPath $channelDirectory) {
        throw "Update channel destination already exists: $channelDirectory"
    }
}

$artifactName = "Notgram-$version-windows-x64-update.exe"
$commit = (git -C $repositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') {
    throw "Unable to resolve the update source commit."
}
$publishedAt = (Get-Date).ToUniversalTime().ToString("o")

foreach ($channel in $targetChannels) {
    $channelDirectory = Join-Path $resolvedDestinationRoot $channel
    New-Item -ItemType Directory -Path $channelDirectory -Force | Out-Null
    $publishedArtifact = Join-Path $channelDirectory $artifactName
    if ($channel -eq $releaseChannel) {
        Copy-Item -LiteralPath $resolvedArtifact -Destination $publishedArtifact
        Copy-Item -LiteralPath $resolvedSignature -Destination "$publishedArtifact.sig"
    }

    $manifest = [ordered]@{
        version = $version
        notes = "Notgram $version"
        pub_date = $publishedAt
        platforms = [ordered]@{
            "windows-x86_64-nsis" = [ordered]@{
                signature = $signature
                url = "$baseUrl/$releaseChannel/$artifactName"
            }
        }
        channel = $channel
        minimumCompatibleVersion = $policy.minimumCompatibleVersion
        cacheSchemaVersion = $policy.cacheSchemaVersion
        rollbackStrategy = $policy.rollback.strategy
        commit = $commit
    }
    $manifestJson = $manifest | ConvertTo-Json -Depth 8
    $manifestPath = Join-Path $channelDirectory "latest.json"
    [System.IO.File]::WriteAllText($manifestPath, "$manifestJson`n", [System.Text.UTF8Encoding]::new($false))

    $published = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($published.version -ne $version -or
        $published.channel -ne $channel -or
        $published.platforms.'windows-x86_64-nsis'.signature -ne $signature -or
        $published.platforms.'windows-x86_64-nsis'.url -notmatch '^https://') {
        throw "Generated updater manifest failed validation."
    }
    $hashLines = Get-ChildItem -LiteralPath $channelDirectory -File |
        Sort-Object Name |
        ForEach-Object {
            "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)"
        }
    [System.IO.File]::WriteAllLines(
        (Join-Path $channelDirectory "SHA256SUMS.txt"),
        $hashLines,
        [System.Text.UTF8Encoding]::new($false)
    )
}

Compress-Archive -Path (Join-Path $resolvedDestinationRoot "*") -DestinationPath $deploymentArchive -CompressionLevel Optimal
$deploymentHash = (Get-FileHash -LiteralPath $deploymentArchive -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText(
    "$deploymentArchive.sha256",
    "$deploymentHash  $([System.IO.Path]::GetFileName($deploymentArchive))`n",
    [System.Text.UTF8Encoding]::new($false)
)
Write-Host "Update channel staged: $($targetChannels -join ', ')"
Write-Host "Deployment payload: $deploymentArchive"
