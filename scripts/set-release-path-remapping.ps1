Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$userProfile = if ($env:USERPROFILE) {
    [System.IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
} else {
    $null
}

function Add-ProcessEnvironmentFlag {
    param(
        [string]$Name,
        [string]$Flag
    )

    $current = [System.Environment]::GetEnvironmentVariable($Name, "Process")
    if ([string]::IsNullOrWhiteSpace($current)) {
        [System.Environment]::SetEnvironmentVariable($Name, $Flag, "Process")
    } elseif ($current.IndexOf($Flag, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        [System.Environment]::SetEnvironmentVariable($Name, "$current $Flag", "Process")
    }
}

function Add-KeptEnvironmentVariable {
    param([string]$Name)

    $current = [System.Environment]::GetEnvironmentVariable("VCPKG_KEEP_ENV_VARS", "Process")
    $names = @($current -split ';' | Where-Object { $_ })
    if ($names -notcontains $Name) {
        [System.Environment]::SetEnvironmentVariable(
            "VCPKG_KEEP_ENV_VARS",
            (@($names) + $Name) -join ';',
            "Process"
        )
    }
}

$pathMappings = @(
    [pscustomobject]@{ Source = $repositoryRoot; Destination = 'C:\Source\Notgram' }
)
if ($userProfile) {
    $pathMappings += [pscustomobject]@{ Source = $userProfile; Destination = 'C:\Users\Developer' }
}

Add-ProcessEnvironmentFlag -Name "CL" -Flag "/experimental:deterministic"
Add-ProcessEnvironmentFlag -Name "LINK" -Flag '/PDBALTPATH:%_PDB%'
foreach ($mapping in $pathMappings) {
    Add-ProcessEnvironmentFlag -Name "RUSTFLAGS" -Flag "--remap-path-prefix=$($mapping.Source)=$($mapping.Destination)"
    Add-ProcessEnvironmentFlag -Name "CL" -Flag "/pathmap:$($mapping.Source)=$($mapping.Destination)"
}
Add-KeptEnvironmentVariable -Name "CL"
Add-KeptEnvironmentVariable -Name "LINK"
