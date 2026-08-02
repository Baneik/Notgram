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
        if ($env:GITHUB_REF_TYPE -eq "tag" -and $env:GITHUB_REF_NAME -ne $expectedTag) {
            throw "Workflow tag $($env:GITHUB_REF_NAME) does not match $expectedTag."
        }
    }

    if ($RequireSigning) {
        foreach ($name in @(
            "NOTGRAM_WINDOWS_CERTIFICATE_BASE64",
            "NOTGRAM_WINDOWS_CERTIFICATE_PASSWORD",
            "NOTGRAM_API_ID",
            "NOTGRAM_API_HASH"
        )) {
            if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
                throw "Release secret $name is not configured."
            }
        }
    }

    Write-Host "Release preflight passed for Notgram $version at $commit."
} finally {
    Pop-Location
}
