param(
    [switch]$RequireTag,
    [switch]$RequireSigning
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $repositoryRoot "version.json") -Raw | ConvertFrom-Json).version

Push-Location $repositoryRoot
try {
    npm.cmd run version:check
    if ($LASTEXITCODE -ne 0) { throw "Version synchronization check failed." }

    $heading = "## [$version]"
    if (-not (Select-String -LiteralPath "CHANGELOG.md" -SimpleMatch $heading -Quiet)) {
        throw "CHANGELOG.md does not contain a $heading release section."
    }
    if (git status --porcelain) {
        throw "Release preflight requires a clean worktree."
    }
    $commit = (git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Unable to resolve the release commit." }

    if ($RequireTag) {
        $expectedTag = "v$version"
        $tagType = ([string](git cat-file -t $expectedTag 2>$null)).Trim()
        if ($LASTEXITCODE -ne 0 -or $tagType -ne "tag") {
            throw "Release tag $expectedTag must be an annotated tag."
        }
        $tagCommit = ([string](git rev-list -n 1 $expectedTag 2>$null)).Trim()
        if ($LASTEXITCODE -ne 0 -or $tagCommit -ne $commit) {
            throw "Release tag $expectedTag must exist and point to HEAD."
        }
    }

    if ($RequireSigning) {
        foreach ($name in @(
            "NOTGRAM_CERTIFICATE_THUMBPRINT",
            "NOTGRAM_API_ID",
            "NOTGRAM_API_HASH",
            "TAURI_SIGNING_PRIVATE_KEY",
            "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
            "NOTGRAM_UPDATER_PUBLIC_KEY",
            "NOTGRAM_UPDATE_BASE_URL"
        )) {
            if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
                throw "Release input $name is not configured."
            }
        }

        if ($env:NOTGRAM_CERTIFICATE_THUMBPRINT -notmatch '^[0-9A-Fa-f]{40}$') {
            throw "NOTGRAM_CERTIFICATE_THUMBPRINT must be a SHA-1 certificate thumbprint."
        }
        $apiId = 0
        if (-not [int]::TryParse($env:NOTGRAM_API_ID, [ref]$apiId) -or $apiId -le 0) {
            throw "NOTGRAM_API_ID must be a positive 32-bit integer."
        }
        if ($env:NOTGRAM_API_HASH -notmatch '^[0-9A-Fa-f]{32}$') {
            throw "NOTGRAM_API_HASH must be a 32-character hexadecimal value."
        }
        $updateUri = $null
        if (-not [Uri]::TryCreate($env:NOTGRAM_UPDATE_BASE_URL, [UriKind]::Absolute, [ref]$updateUri) -or
            $updateUri.Scheme -ne "https" -or $updateUri.UserInfo -or
            $updateUri.Query -or $updateUri.Fragment) {
            throw "NOTGRAM_UPDATE_BASE_URL must be an HTTPS URL."
        }
        if ($env:NOTGRAM_UPDATER_PUBLIC_KEY.Length -gt 4096 -or
            $env:TAURI_SIGNING_PRIVATE_KEY.Length -gt 16384) {
            throw "Updater signing keys are unexpectedly large."
        }
        $updaterPublicKeyBytes = $null
        $updaterPrivateKeyBytes = $null
        try {
            $updaterPublicKeyBytes = [Convert]::FromBase64String($env:NOTGRAM_UPDATER_PUBLIC_KEY)
            $updaterPublicKeyText = [Text.Encoding]::UTF8.GetString($updaterPublicKeyBytes)
            if (-not $updaterPublicKeyText.StartsWith("untrusted comment: minisign public key")) {
                throw "unexpected public key format"
            }
            $updaterPrivateKeyBytes = [Convert]::FromBase64String($env:TAURI_SIGNING_PRIVATE_KEY)
            $updaterPrivateKeyText = [Text.Encoding]::UTF8.GetString($updaterPrivateKeyBytes)
            if (-not $updaterPrivateKeyText.StartsWith("untrusted comment: rsign encrypted secret key")) {
                throw "unexpected private key format"
            }
        } catch {
            throw "Updater signing keys are not valid Base64 Tauri key data."
        } finally {
            if ($updaterPublicKeyBytes) { [Array]::Clear($updaterPublicKeyBytes, 0, $updaterPublicKeyBytes.Length) }
            if ($updaterPrivateKeyBytes) { [Array]::Clear($updaterPrivateKeyBytes, 0, $updaterPrivateKeyBytes.Length) }
        }
    }

    Write-Host "Release preflight passed for Notgram $version at $commit."
} finally {
    Pop-Location
}
