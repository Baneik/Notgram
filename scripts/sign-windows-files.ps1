param(
    [Parameter(Mandatory = $true)]
    [string[]]$Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$thumbprint = $env:NOTGRAM_CERTIFICATE_THUMBPRINT
if ($thumbprint -notmatch '^[0-9A-Fa-f]{40}$') {
    throw "NOTGRAM_CERTIFICATE_THUMBPRINT must be configured before signing."
}
$timestampUrl = if ($env:NOTGRAM_TIMESTAMP_URL) {
    $env:NOTGRAM_TIMESTAMP_URL
} else {
    "http://timestamp.digicert.com"
}
$signTool = Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
if (-not $signTool) {
    $signTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -File |
        Sort-Object FullName -Descending |
        Select-Object -ExpandProperty FullName -First 1
}
if (-not $signTool) { throw "signtool.exe was not found." }

foreach ($candidate in $Path) {
    $resolved = [System.IO.Path]::GetFullPath($candidate)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "Signing input does not exist: $resolved"
    }
    & $signTool sign /sha1 $thumbprint /fd SHA256 /tr $timestampUrl /td SHA256 $resolved
    if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed for $resolved" }
}
