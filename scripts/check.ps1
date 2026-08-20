param(
    [switch]$Release
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $repositoryRoot "src-tauri\Cargo.toml"

Push-Location $repositoryRoot
try {
    npm run version:check
    if ($LASTEXITCODE -ne 0) { throw "Version synchronization check failed." }

    npm run release:policy:check
    if ($LASTEXITCODE -ne 0) { throw "Release policy check failed." }

    npm run theme:check
    if ($LASTEXITCODE -ne 0) { throw "Theme contract check failed." }

    npm run motion:check
    if ($LASTEXITCODE -ne 0) { throw "Motion contract check failed." }

    npm test
    if ($LASTEXITCODE -ne 0) { throw "Frontend tests failed." }

    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend production build failed." }

    npm run test:e2e:types
    if ($LASTEXITCODE -ne 0) { throw "Playwright type check failed." }

    cargo fmt --manifest-path $manifest --check
    if ($LASTEXITCODE -ne 0) { throw "Rust formatting check failed." }

    cargo clippy --manifest-path $manifest --all-targets -- -D warnings
    if ($LASTEXITCODE -ne 0) { throw "Rust Clippy check failed." }

    cargo test --manifest-path $manifest
    if ($LASTEXITCODE -ne 0) { throw "Rust tests failed." }

    if ($Release) {
        & (Join-Path $PSScriptRoot "set-release-path-remapping.ps1")
        npm run tauri build -- --no-bundle
        if ($LASTEXITCODE -ne 0) { throw "Tauri release build failed." }
    }
} finally {
    Pop-Location
}
