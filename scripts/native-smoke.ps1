param(
    [ValidateSet("Prepare", "Verify")]
    [string]$Mode = "Prepare",
    [ValidateSet("Clean", "Existing")]
    [string]$Profile = "Existing",
    [string]$RunDirectory = "",
    [switch]$ResetCleanProfile,
    [switch]$Launch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$runRoot = Join-Path $repositoryRoot ".native-smoke"
$environmentFile = Join-Path $repositoryRoot ".env"
$smokeIdentifier = "dev.notgram.desktop.smoke"
$normalIdentifier = "dev.notgram.desktop"
$runtimeLogRelativePath = "src-tauri\target\debug\logs\notgram.log"
$runtimeLogPath = Join-Path $repositoryRoot $runtimeLogRelativePath

function Read-EnvironmentValues {
    param([string]$Path)

    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') {
            $values[$matches[1]] = $matches[2].Trim()
        }
    }
    return $values
}

function Test-TdlibRuntime {
    param([hashtable]$EnvironmentValues)

    $candidates = New-Object System.Collections.Generic.List[string]
    $configured = $EnvironmentValues["NOTGRAM_TDLIB_PATH"]
    if ($configured) {
        if ([System.IO.Path]::GetExtension($configured)) {
            $candidates.Add($configured)
        } else {
            $candidates.Add((Join-Path $configured "tdjson.dll"))
        }
    }
    $candidates.Add((Join-Path $repositoryRoot "src-tauri\tdlib\tdjson.dll"))
    $candidates.Add((Join-Path $repositoryRoot "src-tauri\target\debug\tdlib\tdjson.dll"))
    $candidates.Add((Join-Path $repositoryRoot "src-tauri\target\release\tdlib\tdjson.dll"))

    return [bool]($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1)
}

function Remove-CleanProfileData {
    $roots = @(
        [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA $smokeIdentifier)),
        [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA $smokeIdentifier))
    )

    foreach ($path in $roots) {
        if ([System.IO.Path]::GetFileName($path) -ne $smokeIdentifier) {
            throw "Refusing to reset an unexpected clean-profile path."
        }
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Recurse -Force
        }
    }
}

function Get-RunPath {
    if ($RunDirectory) {
        if ([System.IO.Path]::IsPathRooted($RunDirectory)) {
            return [System.IO.Path]::GetFullPath($RunDirectory)
        }
        return [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $RunDirectory))
    }
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
    return Join-Path $runRoot "$stamp-$($Profile.ToLowerInvariant())"
}

function Write-Checklist {
    param(
        [string]$Path,
        [string]$SelectedProfile,
        [string]$Commit
    )

    $profileExpectation = if ($SelectedProfile -eq "Clean") {
        "Fresh authorization completes in the isolated smoke profile."
    } else {
        "Existing authorization and the last selected account restore without a new login."
    }
    $content = @"
# Notgram native smoke: $SelectedProfile

- Commit: `$Commit`
- Profile: `$SelectedProfile`
- Started (UTC): `$((Get-Date).ToUniversalTime().ToString("o"))`

Do not record credentials, phone numbers, account/chat identifiers, message text,
proxy secrets, or local paths in this file.

- [ ] REQUIRED: Startup — $profileExpectation
- [ ] REQUIRED: Chats — the server chat list loads and cached chats remain browsable during a temporary offline interval.
- [ ] REQUIRED: History — load at least two older pages, switch chats repeatedly, and observe no gap, duplicate, or scroll jump.
- [ ] REQUIRED: Send — send a disposable text in Saved Messages/test chat and observe sending, sent, and read states.
- [ ] REQUIRED: Reply and reaction — reply to the disposable message, add/remove a reaction, and verify the final server state.
- [ ] REQUIRED: Upload and download — upload a disposable file, download it, and verify completion without exposing a local path in the UI/log.
- [ ] REQUIRED: Network recovery — disconnect/reconnect once; the state changes from waiting/offline to syncing/online without clearing history or drafts.
- [ ] REQUIRED: Restart — close and relaunch; the selected chat, draft/cache state, and latest server messages recover without duplication.
- [ ] REQUIRED: Account switching — switch between two registered test accounts and verify account-specific chats/cache remain isolated. Use N/A only for the fresh profile before a second test account exists, and explain why below.
- [ ] REQUIRED: Logs — no credential, phone, proxy secret, message body, account identifier, or local path is visible in the runtime log.

Redacted observations:

- Result: PASS / FAIL
- Failed label (if any):
- Symptom (no private data):
"@
    [System.IO.File]::WriteAllText($Path, $content, [System.Text.UTF8Encoding]::new($false))
}

function Invoke-Prepare {
    if ($env:OS -ne "Windows_NT") {
        throw "Native smoke checks currently require Windows."
    }
    if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
        throw "Local .env is missing. Configure the native transport before running smoke checks."
    }
    if ($ResetCleanProfile -and $Profile -ne "Clean") {
        throw "-ResetCleanProfile is only valid with -Profile Clean."
    }

    $environmentValues = Read-EnvironmentValues -Path $environmentFile
    if ($environmentValues["VITE_TELEGRAM_TRANSPORT"] -ne "tauri") {
        throw "Native smoke checks require VITE_TELEGRAM_TRANSPORT=tauri."
    }
    foreach ($required in @("NOTGRAM_API_ID", "NOTGRAM_API_HASH")) {
        if (-not $environmentValues[$required]) {
            throw "Native smoke checks require $required in the local .env."
        }
    }
    if (-not (Test-TdlibRuntime -EnvironmentValues $environmentValues)) {
        throw "tdjson.dll was not found in a configured or standard development location."
    }
    if ($ResetCleanProfile) {
        Remove-CleanProfileData
    }

    $runPath = Get-RunPath
    if (Test-Path -LiteralPath $runPath) {
        throw "Run directory already exists: $runPath"
    }
    New-Item -ItemType Directory -Path $runPath | Out-Null

    $commit = (git -C $repositoryRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Unable to resolve the current Git commit." }
    $dirty = [bool](git -C $repositoryRoot status --porcelain)
    if ($LASTEXITCODE -ne 0) { throw "Unable to inspect the Git worktree." }
    $logOffset = if (Test-Path -LiteralPath $runtimeLogPath -PathType Leaf) {
        (Get-Item -LiteralPath $runtimeLogPath).Length
    } else {
        0
    }
    $metadata = [ordered]@{
        schemaVersion = 1
        profile = $Profile
        identifier = if ($Profile -eq "Clean") { $smokeIdentifier } else { $normalIdentifier }
        commit = $commit
        dirty = $dirty
        startedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        runtimeLogRelativePath = $runtimeLogRelativePath
        runtimeLogStartOffset = $logOffset
        processExitCode = $null
        endedAtUtc = $null
    }
    $metadataPath = Join-Path $runPath "run.json"
    $checklistPath = Join-Path $runPath "checklist.md"
    $metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding utf8
    Write-Checklist -Path $checklistPath -SelectedProfile $Profile -Commit $commit

    Write-Host "Native smoke run prepared: $runPath"
    Write-Host "Checklist: $checklistPath"
    if ($dirty) {
        Write-Warning "The worktree is dirty; the run metadata records this fact."
    }

    if ($Launch) {
        Push-Location $repositoryRoot
        try {
            if ($Profile -eq "Clean") {
                & npm.cmd run tauri dev -- --config src-tauri/tauri.smoke.conf.json
            } else {
                & npm.cmd run tauri dev
            }
            $metadata.processExitCode = $LASTEXITCODE
            $metadata.endedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
            $metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding utf8
            if ($LASTEXITCODE -ne 0) {
                throw "The native smoke process exited with code $LASTEXITCODE."
            }
        } finally {
            Pop-Location
        }
    }
}

function Invoke-Verify {
    $runPath = Get-RunPath
    $metadataPath = Join-Path $runPath "run.json"
    $checklistPath = Join-Path $runPath "checklist.md"
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $checklistPath -PathType Leaf)) {
        throw "The run directory must contain run.json and checklist.md."
    }

    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    $unchecked = @(Get-Content -LiteralPath $checklistPath | Where-Object {
        $_ -match '^- \[ \] REQUIRED:'
    })
    if ($unchecked.Count -gt 0) {
        throw "Native smoke checklist still has $($unchecked.Count) unchecked required item(s)."
    }
    if ($null -eq $metadata.processExitCode -or [int]$metadata.processExitCode -ne 0) {
        throw "The run metadata does not contain a successful native process exit."
    }

    $logPath = Join-Path $repositoryRoot $metadata.runtimeLogRelativePath
    if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) {
        throw "The native runtime log was not produced."
    }
    $bytes = [System.IO.File]::ReadAllBytes($logPath)
    $offset = [Math]::Min([int64]$metadata.runtimeLogStartOffset, [int64]$bytes.Length)
    $segment = [System.Text.Encoding]::UTF8.GetString($bytes, [int]$offset, $bytes.Length - [int]$offset)
    if ($segment -notmatch '"event"\s*:\s*"runtime_started"') {
        throw "The run log segment does not contain runtime_started."
    }
    $unsafeField = '(?i)"(?:api_id|api_hash|authentication_code|cache_path|database_encryption_key|download_path|email|files_directory|library_path|link|message|password|path|phone_number|proxy_password|proxy_secret|secret|text|token|username)"\s*:\s*"(?!\[redacted\])'
    if ($segment -match $unsafeField) {
        throw "The run log segment contains a potentially unredacted sensitive field."
    }

    Write-Host "Native smoke evidence verified: $runPath"
    Write-Host "Profile: $($metadata.profile); commit: $($metadata.commit)"
}

if ($Mode -eq "Verify") {
    if (-not $RunDirectory) {
        throw "-RunDirectory is required with -Mode Verify."
    }
    Invoke-Verify
} else {
    Invoke-Prepare
}
