param(
    [ValidateRange(1, 64)]
    [int]$Jobs = 4
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$tdlibCommit = "022d60202e446ad1287b9fb68e687c8a0760788b"
$tdlibRepository = "https://github.com/tdlib/td.git"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceDirectory = Join-Path $repositoryRoot "vendor\tdlib-src"
$buildDirectory = Join-Path $repositoryRoot "vendor\tdlib-build\cmake"
$installRoot = Join-Path $repositoryRoot "vendor\tdlib-install"
$vcpkgInstalled = Join-Path $installRoot "vcpkg_installed"
$tdlibInstall = Join-Path $installRoot "tdlib"
$runtimeDirectory = Join-Path $repositoryRoot "src-tauri\tdlib"
$licenseDirectory = Join-Path $runtimeDirectory "licenses"
$manifestDirectory = Join-Path $PSScriptRoot "tdlib"

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    throw "Visual Studio Installer's vswhere.exe was not found. Install Visual Studio 2022 Build Tools with the Desktop development with C++ workload."
}

$visualStudio = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $visualStudio) {
    throw "Visual Studio 2022 C++ Build Tools were not found."
}
$visualStudio = $visualStudio.Trim()

$cmake = Join-Path $visualStudio "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
$vcpkgRoot = Join-Path $visualStudio "VC\vcpkg"
$vcpkg = Join-Path $vcpkgRoot "vcpkg.exe"
$toolchain = Join-Path $vcpkgRoot "scripts\buildsystems\vcpkg.cmake"
foreach ($requiredTool in @($cmake, $vcpkg, $toolchain)) {
    if (-not (Test-Path -LiteralPath $requiredTool -PathType Leaf)) {
        throw "Required build tool was not found: $requiredTool"
    }
}

New-Item -ItemType Directory -Force (Split-Path -Parent $sourceDirectory), $buildDirectory, $installRoot, $runtimeDirectory, $licenseDirectory | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory ".git") -PathType Container)) {
    if ((Test-Path -LiteralPath $sourceDirectory) -and (Get-ChildItem -LiteralPath $sourceDirectory -Force | Select-Object -First 1)) {
        throw "TDLib source directory exists but is not a Git checkout: $sourceDirectory"
    }
    git init $sourceDirectory
    if ($LASTEXITCODE -ne 0) { throw "Unable to initialize the TDLib source checkout." }
    git -C $sourceDirectory remote add origin $tdlibRepository
    if ($LASTEXITCODE -ne 0) { throw "Unable to configure the TDLib source remote." }
    git -C $sourceDirectory fetch --depth 1 origin $tdlibCommit
    if ($LASTEXITCODE -ne 0) { throw "Unable to fetch TDLib commit $tdlibCommit." }
    git -C $sourceDirectory checkout --detach FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { throw "Unable to check out TDLib commit $tdlibCommit." }
}

$currentCommit = (git -C $sourceDirectory rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $currentCommit -ne $tdlibCommit) {
    throw "TDLib checkout is at $currentCommit; expected pinned commit $tdlibCommit. Preserve local work, then update the checkout explicitly."
}

& $vcpkg install "--x-manifest-root=$manifestDirectory" "--x-install-root=$vcpkgInstalled" --triplet x64-windows
if ($LASTEXITCODE -ne 0) { throw "vcpkg dependency installation failed." }

$gperf = Join-Path $vcpkgInstalled "x64-windows\usr\local\tools\gperf\gperf.exe"
if (-not (Test-Path -LiteralPath $gperf -PathType Leaf)) {
    throw "gperf was installed, but its executable was not found at $gperf"
}

& $cmake -S $sourceDirectory -B $buildDirectory -G "Visual Studio 17 2022" -A x64 `
    "-DCMAKE_TOOLCHAIN_FILE=$toolchain" `
    "-DVCPKG_INSTALLED_DIR=$vcpkgInstalled" `
    "-DCMAKE_INSTALL_PREFIX=$tdlibInstall" `
    "-DGPERF_EXECUTABLE=$gperf"
if ($LASTEXITCODE -ne 0) { throw "TDLib CMake configuration failed." }

& $cmake --build $buildDirectory --config Release --target tdjson --parallel $Jobs
if ($LASTEXITCODE -ne 0) { throw "TDLib compilation failed." }

$vcpkgBin = Join-Path $vcpkgInstalled "x64-windows\bin"
$runtimeFiles = @(
    (Join-Path $buildDirectory "Release\tdjson.dll"),
    (Join-Path $vcpkgBin "libcrypto-3-x64.dll"),
    (Join-Path $vcpkgBin "libssl-3-x64.dll"),
    (Join-Path $vcpkgBin "z.dll")
)
foreach ($runtimeFile in $runtimeFiles) {
    if (-not (Test-Path -LiteralPath $runtimeFile -PathType Leaf)) {
        throw "Expected runtime file was not produced: $runtimeFile"
    }
    Copy-Item -LiteralPath $runtimeFile -Destination $runtimeDirectory -Force
}

Copy-Item -LiteralPath (Join-Path $sourceDirectory "LICENSE_1_0.txt") -Destination (Join-Path $licenseDirectory "TDLib-LICENSE_1_0.txt") -Force
Copy-Item -LiteralPath (Join-Path $vcpkgInstalled "x64-windows\share\openssl\copyright") -Destination (Join-Path $licenseDirectory "OpenSSL.txt") -Force
Copy-Item -LiteralPath (Join-Path $vcpkgInstalled "x64-windows\share\zlib\copyright") -Destination (Join-Path $licenseDirectory "zlib.txt") -Force

Write-Host "TDLib runtime is ready in $runtimeDirectory"
Get-FileHash (Join-Path $runtimeDirectory "*.dll") | Select-Object Path, Hash
