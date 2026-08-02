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
try {
    [System.IO.File]::WriteAllBytes(
        $certificatePath,
        [Convert]::FromBase64String($env:NOTGRAM_WINDOWS_CERTIFICATE_BASE64)
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
    Add-Content -LiteralPath $EnvironmentFile -Value "NOTGRAM_CERTIFICATE_THUMBPRINT=$($certificate.Thumbprint)" -Encoding utf8
    Write-Host "Imported the Windows code-signing certificate."
} finally {
    if (Test-Path -LiteralPath $certificatePath) {
        Remove-Item -LiteralPath $certificatePath -Force
    }
}
