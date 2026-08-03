# Notgram

Notgram is a desktop-first third-party Telegram client built with React, TypeScript, Tauri, and TDLib. It includes messaging, multi-account storage, native authorization, paginated chat/history synchronization, server-backed search, rich media, reactions, and a mock browser runtime.

## Browser development

```powershell
npm install
npm run dev
```

Set `VITE_TELEGRAM_TRANSPORT=mock`, then open `http://127.0.0.1:1420`. Use `http://127.0.0.1:1420/?auth=1` to exercise the mock authorization flow. A local `.env` set to `tauri` intentionally requires the native shell and will not run in an ordinary browser.

## Native TDLib development

On Windows with Visual Studio 2022 Build Tools installed, build the pinned
official TDLib source and copy its runtime dependencies with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-tdlib.ps1
```

The initial build downloads the source and dependencies and can take several
minutes. Subsequent builds reuse `vendor/`. You can alternatively put a
compatible library in `src-tauri/tdlib/`, or set `NOTGRAM_TDLIB_PATH` to the
library or its containing directory.

Create `.env` from `.env.example`, set the native transport and API credentials,
then start the application:

```env
VITE_TELEGRAM_TRANSPORT=tauri
NOTGRAM_API_ID=123456
NOTGRAM_API_HASH=replace_with_your_value
NOTGRAM_TDLIB_PATH=C:\path\to\tdjson.dll
```

```powershell
npm run tauri dev
```

`NOTGRAM_API_ID` and `NOTGRAM_API_HASH` are consumed by Rust and are not sent to
the webview. `.env`, TDLib binaries, source, dependencies, and build outputs are
ignored by Git. The build script pins TDLib and vcpkg revisions in
`scripts/build-tdlib.ps1` and `scripts/tdlib/vcpkg.json`.

New account databases receive a random per-account encryption key protected for
the current Windows user. `NOTGRAM_DATABASE_KEY_BASE64` is only an explicit
override for existing development databases and is not copied into portable
releases.

## Portable Windows release

Build a release executable and copy the complete runnable directory without an
installer:

```powershell
npm run publish:portable
```

The default destination is `artifacts/`; pass `-DestinationRoot` to
`scripts/publish-portable.ps1` to override it. Publishing requires a clean
worktree and reads API credentials only from the process environment. It never
copies `.env`. The versioned ZIP contains `Notgram.exe`, TDLib and its runtime
licenses, dependency inventory, build metadata, and per-file SHA-256 hashes.
Portable builds retain account data across ZIP replacement and do not run the
NSIS auto-updater; installed builds use the signed channel configured at build
time.
After a bundled Tauri build, `npm run publish:installer` validates and stages
the matching NSIS installer with the same dependency, metadata, and hash files.
The signed release workflow also runs `scripts/test-release-lifecycle.ps1` on an
ephemeral runner. It probes portable startup, ZIP replacement, current-user
installation, in-place replacement, uninstallation, retained account data, and
explicit test-data cleanup without opening Telegram or starting the network
runtime. A separate isolated product identifier verifies a real previous-version
upgrade before the signed production build. Uninstall keeps account data by
policy; remove accounts and clear media cache in the app before uninstall when
local data must be erased.

The bridge searches these locations in order:

1. `NOTGRAM_TDLIB_PATH`
2. Packaged `resources/tdlib/`
3. The app data `tdlib/` directory
4. The executable directory
5. `src-tauri/tdlib/` during development

## Commands

```powershell
npm run dev       # Vite development server
npm run build     # TypeScript and production web build
npm test          # Unit tests
npx playwright install chromium # One-time E2E browser installation
npm run test:e2e:types # Type-check Playwright configuration and specs
npm run test:e2e  # Headless Chromium desktop/mobile flows
npm run test:native-smoke -- -Profile Clean # Prepare an isolated native smoke run
npm run check     # Frontend plus Rust formatting, lint, and tests
npm run check:release # Full check plus a native release build
npm run tauri dev # Native desktop shell
npm run publish:portable # Build a traceable portable ZIP in artifacts/
npm run version:check # Verify version.json matches npm, Cargo, and Tauri
npm run version:sync # Synchronize all manifests from version.json
cargo check       # Run from src-tauri for the native bridge
```

`version.json` is the single application version source. Release tags and
changelog rules are documented in
[`docs/release-versioning.md`](docs/release-versioning.md).

Real TDLib acceptance is tracked separately from browser mocks. See
[`docs/native-smoke.md`](docs/native-smoke.md) for the isolated clean-profile and
existing-account passes, their non-sensitive evidence format, and verification
commands.

The automated accessibility gate and native Windows checklist are documented in
[`docs/accessibility-matrix.md`](docs/accessibility-matrix.md).

## Architecture

```text
src/components/        React UI, authorization, message/media, and settings screens
src/store/             Application state, preferences, and ordered event reduction
src/telegram/          Transport contract plus mock/Tauri adapters
src-tauri/src/         TDLib dynamic loader, receive loop, and commands
```

The native bridge uses TDLib's current `td_create_client_id`, `td_send`, and `td_receive` interface. One dedicated Rust thread owns `td_receive`; updates are copied immediately and emitted to the webview in the order received. Rust automatically answers `authorizationStateWaitTdlibParameters`, while user-facing authorization states remain in the TypeScript store.

After authorization, the TDLib transport synchronizes the current user,
paginated main/folder chat lists, user presence, paginated
message history, outgoing text messages, send-failure retry state, read state,
chat and sender avatars, and common real-time chat/message updates. Message
metadata preserves replies, forward origins, edit timestamps, reactions,
and current operation permissions. Reply, edit, delete, forward, retry, download,
and emoji reaction actions are available in the conversation UI. Sender
profile photos are downloaded through TDLib and refreshed when updateFile
completes. The Tauri asset protocol starts with an empty static scope and only
authorizes completed TDLib files that were observed in trusted per-account roots;
cached snapshot paths are canonicalized and checked before exact-file authorization.
Consecutive messages from the same sender use joined Telegram-style
bubbles, local-calendar date separators, show the sender name only on the first item, and keep the sender avatar floating near
the bottom of the visible portion of its message group while scrolling. Timestamps render with
second precision. Photo messages use a sender header
only when they start a consecutive group; subsequent photos are borderless.
History is preloaded in
30-message pages and continues loading when the message list is scrolled upward.
Each account and chat keeps its reading position for the current application
session. First entry and a double-click on a chat open the latest message; when
the reader is away from the bottom, new messages stay off-screen behind a
counted jump-to-latest button instead of moving the viewport.
On startup, the UI restores a DPAPI-protected snapshot from the configured cache
directory while TDLib connects in parallel; live server updates always replace
cached chat, folder, user, and message state. The generated local archive folder
is not shown or loaded. History requests are deferred until authorization is
ready. Each chat keeps an independent server-history cursor and always starts
its first refresh from TDLib's latest window, even if a live message arrived
first. History refreshes acknowledge cached messages that TDLib returns but do
not infer deletion from gaps in a page. Only non-cache deletion updates remove
messages; partial or stalled responses preserve the existing cache and remain
retryable instead of marking history complete.
Documents and Telegram media messages are mapped separately: image documents
remain file cards, while photos, videos, video notes, animations, audio, voice,
and stickers render with previews, download state, and native playback where applicable.
Photos and stickers are cached automatically through TDLib `updateFile` events. Completed user
downloads are copied to the configured download directory without overwriting
existing files. The cache path defaults to the Windows app cache directory, while
downloads default to the downloads folder beside Notgram.exe; both paths are
configurable under Advanced Settings. Settings provides account management,
notification/sound preferences, compact chat and send-key behavior, animation
preferences, proxy controls, and storage paths. Native file upload is available
through a Rust-owned file picker so local paths are never exposed to the webview.

The desktop conversation list starts at 360 pixels wide and can be resized from its right edge
down to a 300-pixel minimum. The preferred width is restored on the next launch. Default chat
rows, avatars, message text, headers, and the composer use a unified daily-messaging scale, while
the narrow layout keeps its full-width conversation switching behavior.

Phone-number and QR-code authorization are supported. QR login uses TDLib's
`requestQrCodeAuthentication` flow and redraws whenever TDLib rotates the
confirmation link.

## Runtime logs

Notgram writes structured lifecycle and receive-loop statistics to
`logs\notgram.log` beside the executable. The app log rotates at 2 MB. Raw
TDLib logging is disabled because it may include account, network, or message
data that cannot be reliably redacted.

The receive loop blocks for up to one second while idle and enforces a 25 ms
minimum cycle when TDLib returns immediately. Receive errors use exponential
backoff up to one second, and bridge error events are limited to one every five
seconds. A `receive_stats` record is written once per minute with poll, update,
error, and polls-per-second counts. Structured log values are recursively
redacted before being written and intentionally omit credentials, authentication
secrets, phone numbers, paths, and message bodies.

History pagination also writes `ui_history_data`, `ui_history_merge`, and
`ui_history_render` records with request/merge/render duration, batch sizes,
and scroll-anchor drift. Main-thread tasks over 50 ms are sampled as
`ui_long_task` at most once every ten seconds. These records contain only
numeric and boolean diagnostics and never include chat IDs or message content.

## Diagnostics and crash reports

The native **Diagnostics and privacy** settings can export a ZIP selected by the
user. Export applies a second redaction pass to bounded runtime-log records and
includes a manifest that identifies the application version, distribution kind,
architecture, and record count. It never includes message text, credentials,
account/chat/message identifiers, phone numbers, or local paths.

Crash reporting is disabled by default. Opting in stores one minimal crash event
locally with only a fixed event type, application version, and timestamp;
nothing is uploaded.
The record is included only when the user manually exports diagnostics and is
deleted when crash reporting is disabled. Corrupt consent settings fail closed.

## Proxy settings

Notgram uses the Windows system proxy by default. On Windows, the current
per-user explicit proxy is read from Internet Settings every time the app
starts. If no explicit system proxy is enabled, system mode falls back to a
direct connection.

The connection dialog is available before login and from the main navigation.
It supports system, direct, custom HTTP, SOCKS5, and MTProto modes, including a
TDLib connection test. Custom settings are encrypted for the current Windows
user with DPAPI before being written to the application configuration directory;
proxy passwords and secrets are never written to logs.

Existing databases created before per-account keys are registered as legacy
empty-key databases during the first upgrade and remain readable. New databases
use a random DPAPI-protected key rather than `.env`.
