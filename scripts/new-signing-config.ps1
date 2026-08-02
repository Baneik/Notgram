param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

$config = [ordered]@{
    bundle = [ordered]@{
        windows = [ordered]@{
            certificateThumbprint = $thumbprint.ToUpperInvariant()
            digestAlgorithm = "sha256"
            timestampUrl = $timestampUrl
            tsp = $true
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
