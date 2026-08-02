param(
    [Parameter(Mandatory = $true)]
    [string[]]$Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$expectedThumbprint = $env:NOTGRAM_CERTIFICATE_THUMBPRINT
if ($expectedThumbprint -notmatch '^[0-9A-Fa-f]{40}$') {
    throw "NOTGRAM_CERTIFICATE_THUMBPRINT must be configured before verification."
}
foreach ($candidate in $Path) {
    $resolved = [System.IO.Path]::GetFullPath($candidate)
    $signature = Get-AuthenticodeSignature -LiteralPath $resolved
    if ($signature.Status -ne "Valid") {
        throw "Authenticode signature is not valid for ${resolved}: $($signature.Status)"
    }
    if ($signature.SignerCertificate.Thumbprint -ne $expectedThumbprint) {
        throw "Authenticode signer does not match the release certificate for $resolved."
    }
    if (-not $signature.TimeStamperCertificate) {
        throw "Authenticode signature is not timestamped for $resolved."
    }
}
Write-Host "Verified $($Path.Count) Authenticode signature(s)."
