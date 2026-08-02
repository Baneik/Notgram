param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    [switch]$SkipWindowsSigning
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$windows = [ordered]@{
    allowDowngrades = $false
}
if (-not $SkipWindowsSigning) {
    $thumbprint = $env:NOTGRAM_CERTIFICATE_THUMBPRINT
    if ($thumbprint -notmatch '^[0-9A-Fa-f]{40}$') {
        throw "NOTGRAM_CERTIFICATE_THUMBPRINT must be a SHA-1 certificate thumbprint."
    }
    $timestampUrl = if ($env:NOTGRAM_TIMESTAMP_URL) {
        $env:NOTGRAM_TIMESTAMP_URL
    } else {
        "http://timestamp.digicert.com"
    }
    if ($timestampUrl -notmatch '^https?://') {
        throw "NOTGRAM_TIMESTAMP_URL must be an HTTP(S) URL."
    }
    $windows.certificateThumbprint = $thumbprint.ToUpperInvariant()
    $windows.digestAlgorithm = "sha256"
    $windows.timestampUrl = $timestampUrl
    $windows.tsp = $true
    $windows.signCommand = [ordered]@{
        cmd = "powershell"
        args = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", (Join-Path $PSScriptRoot "sign-windows-files.ps1"),
            "-Path", "%1"
        )
    }
}
$updateBaseUrl = $env:NOTGRAM_UPDATE_BASE_URL
$updateUri = $null
if (-not [Uri]::TryCreate($updateBaseUrl, [UriKind]::Absolute, [ref]$updateUri) -or
    $updateUri.Scheme -ne "https" -or $updateUri.UserInfo -or
    $updateUri.Query -or $updateUri.Fragment) {
    throw "NOTGRAM_UPDATE_BASE_URL must be an HTTPS URL."
}
$updaterPublicKey = $env:NOTGRAM_UPDATER_PUBLIC_KEY
if ([string]::IsNullOrWhiteSpace($updaterPublicKey) -or $updaterPublicKey.Length -gt 4096) {
    throw "NOTGRAM_UPDATER_PUBLIC_KEY is empty or unexpectedly large."
}
$publicKeyBytes = $null
try {
    $publicKeyBytes = [Convert]::FromBase64String($updaterPublicKey)
    $publicKeyText = [Text.Encoding]::UTF8.GetString($publicKeyBytes)
    if (-not $publicKeyText.StartsWith("untrusted comment: minisign public key")) {
        throw "unexpected key format"
    }
} catch {
    throw "NOTGRAM_UPDATER_PUBLIC_KEY is not a valid Tauri updater public key."
} finally {
    if ($publicKeyBytes) { [Array]::Clear($publicKeyBytes, 0, $publicKeyBytes.Length) }
}
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $repositoryRoot "version.json") -Raw | ConvertFrom-Json).version
$channel = if ($version.Contains("-")) { "candidate" } else { "stable" }

$config = [ordered]@{
    bundle = [ordered]@{
        createUpdaterArtifacts = $true
        windows = $windows
    }
    plugins = [ordered]@{
        updater = [ordered]@{
            endpoints = @("$($updateUri.AbsoluteUri.TrimEnd('/'))/$channel/latest.json")
            pubkey = $updaterPublicKey
            windows = [ordered]@{
                installMode = "passive"
            }
        }
    }
}
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path (Split-Path -Parent $resolvedOutput) -Force | Out-Null
$json = $config | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText(
    $resolvedOutput,
    "$json`n",
    [System.Text.UTF8Encoding]::new($false)
)
Write-Host "Created ephemeral Tauri signing configuration."
