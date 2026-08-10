# Native Tauri smoke checks

Browser E2E tests prove deterministic UI behavior, but they cannot prove TDLib
loading, authorization restoration, real network recovery, filesystem access, or
Windows account storage. Run both native profiles before accepting the `0.2`
baseline.

Never put Telegram codes, phone numbers, API credentials, proxy secrets, message
text, account identifiers, or local file paths in the checklist. Use Saved
Messages or a dedicated test chat, and upload only disposable non-sensitive data.

## 1. Clean profile

The clean profile uses the separate Tauri identifier
`dev.notgram.desktop.smoke`; it cannot read or delete the normal
`dev.notgram.desktop` account directories.

```powershell
npm run test:native-smoke -- -Profile Clean -ResetCleanProfile -Launch
```

Complete the generated checklist while the native app is open, then close the
app. The command prints the ignored run directory containing `checklist.md` and
`run.json`.

## 2. Existing account profile

This pass uses the normal development identifier and verifies restoration and
account switching without erasing existing state.

```powershell
npm run test:native-smoke -- -Profile Existing -Launch
```

Do not use `-ResetCleanProfile` with this profile; the script rejects it.

## 3. Verify evidence

Mark every `REQUIRED` checklist item as `[x]`, record only pass/fail and short
redacted observations, and verify the run:

```powershell
npm run test:native-smoke -- -Mode Verify -RunDirectory .native-smoke\<run-name>
```

Verification requires all required boxes, a successful native process exit, a
`runtime_started` event in the log segment produced by this run, and no obvious
unredacted sensitive fields. The generated evidence is intentionally ignored by
Git; summarize the two verified run names and commit hash in the release record,
not the private runtime artifacts themselves.

## Playwright against the real Tauri account

Notgram can expose its authenticated WebView2 target to Playwright for focused
native debugging. The endpoint is disabled by default, binds only to
`127.0.0.1`, and must be enabled before the process starts. Fully exit an
existing Notgram instance first because the single-instance process cannot gain
an automation endpoint after startup.

The formal release exposes the same option under **Settings → Advanced →
Developer options**. Enable developer mode, choose a local port, save the
debugging setting, then fully exit and reopen Notgram. The command-line form
below remains available for one-off and CI runs without changing the saved
preference.

```powershell
.\Notgram.exe --notgram-automation-port=9333
```

The equivalent environment variable is `NOTGRAM_AUTOMATION_PORT=9333`. In this
mode Notgram also mutes WebView audio and enables WebView2 DevTools so Playwright
can attach to the real DOM and TDLib session:

```javascript
const { chromium } = require("playwright");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts().flatMap((context) => context.pages())[0];
```

Do not bind or proxy this endpoint to a LAN or public interface. A client that
can connect to it can read and operate the authenticated Notgram UI. Close the
automation-enabled instance as soon as the focused test is complete.

## Failure handling

For each real failure:

1. Record the failed checklist label and a redacted symptom.
2. Preserve the generated run directory locally.
3. Add the smallest reproducible Vitest, Rust, or browser regression when the
   native boundary can be simulated.
4. Fix and rerun the affected profile before continuing the roadmap.
