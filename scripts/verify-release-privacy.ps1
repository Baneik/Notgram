param(
    [Parameter(Mandatory = $true)]
    [string[]]$Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$privatePrefixes = @($repositoryRoot)
if ($env:USERPROFILE) {
    $privatePrefixes += [System.IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
}
$privatePrefixes = @($privatePrefixes | Where-Object { $_.Length -ge 4 } | Sort-Object -Unique)

$files = foreach ($candidate in $Path) {
    $resolved = Get-Item -LiteralPath $candidate -ErrorAction Stop
    if ($resolved.PSIsContainer) {
        Get-ChildItem -LiteralPath $resolved.FullName -Recurse -File
    } else {
        $resolved
    }
}
$files = @($files | Sort-Object FullName -Unique)

foreach ($file in $files) {
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    $singleByteContent = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)
    $wideContent = [System.Text.Encoding]::Unicode.GetString($bytes)
    foreach ($prefix in $privatePrefixes) {
        $variants = @($prefix, $prefix.Replace('\', '/'))
        foreach ($variant in $variants) {
            if ($singleByteContent.IndexOf($variant, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                $wideContent.IndexOf($variant, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                throw "Release privacy check failed because a packaged file contains a local source path: $($file.Name)"
            }
        }
    }
}

Write-Host "Release privacy check passed for $($files.Count) files."
