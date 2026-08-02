param(
    [string]$EnvironmentFile = $env:GITHUB_ENV
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:NOTGRAM_WINDOWS_CERTIFICATE_BASE64) -or
    [string]::IsNullOrWhiteSpace($env:NOTGRAM_WINDOWS_CERTIFICATE_PASSWORD)) {
    throw "The Windows signing certificate and password are required."
}
if ([string]::IsNullOrWhiteSpace($EnvironmentFile)) {
    throw "An environment output file is required."
}

$certificatePath = Join-Path ([System.IO.Path]::GetTempPath()) "notgram-release-certificate.pfx"
$certificate = $null
$certificateBytes = $null
$importSucceeded = $false
try {
    $certificateBytes = [Convert]::FromBase64String($env:NOTGRAM_WINDOWS_CERTIFICATE_BASE64)
    [System.IO.File]::WriteAllBytes(
        $certificatePath,
        $certificateBytes
    )
    $password = ConvertTo-SecureString $env:NOTGRAM_WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
    $certificate = Import-PfxCertificate `
        -FilePath $certificatePath `
        -CertStoreLocation Cert:\CurrentUser\My `
        -Password $password `
        -Exportable:$false
    if (-not $certificate.HasPrivateKey) {
        throw "The imported code-signing certificate has no private key."
    }
    if (-not ($certificate.EnhancedKeyUsageList.ObjectId -contains "1.3.6.1.5.5.7.3.3")) {
        throw "The imported certificate is not valid for code signing."
    }
    $now = Get-Date
    if ($certificate.NotBefore -gt $now -or $certificate.NotAfter -le $now) {
        throw "The imported code-signing certificate is not currently valid."
    }
    Add-Content -LiteralPath $EnvironmentFile -Value "NOTGRAM_CERTIFICATE_THUMBPRINT=$($certificate.Thumbprint)" -Encoding utf8
    $importSucceeded = $true
    Write-Host "Imported the Windows code-signing certificate."
} finally {
    if (-not $importSucceeded -and $certificate) {
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
    }
    if ($certificateBytes) {
        [Array]::Clear($certificateBytes, 0, $certificateBytes.Length)
    }
    if (Test-Path -LiteralPath $certificatePath) {
        Remove-Item -LiteralPath $certificatePath -Force
    }
}
