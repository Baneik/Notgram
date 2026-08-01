# Notgram

Notgram is a desktop-first third-party Telegram client built with React, TypeScript, Tauri, and TDLib. The current milestone includes a working messaging UI, an ordered application store, a mock transport, a runtime-loaded TDLib bridge, and the phone/code/password authorization flow.

## Browser development

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:1420`. Browser development uses mock chats by default. Open `http://127.0.0.1:1420/?auth=1` to exercise the mock authorization flow.

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

## Portable Windows release

Build a release executable and copy the complete runnable directory without an
installer:

```powershell
npm run publish:portable
```

The default destination is `C:\Users\Developer\Desktop\Data\Program\Notgram`.
The directory contains `Notgram.exe`, the local `.env`, TDLib, its dependent
DLLs, and licenses. The application reads `.env` beside the executable before
falling back to the current working directory.

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
npm run tauri dev # Native desktop shell
npm run publish:portable # Release directly to Program\Notgram
cargo check       # Run from src-tauri for the native bridge
```

## Architecture

```text
src/components/        React UI and authorization screens
src/store/             Application state and ordered event reduction
src/telegram/          Transport contract plus mock/Tauri adapters
src-tauri/src/         TDLib dynamic loader, receive loop, and commands
```

The native bridge uses TDLib's current `td_create_client_id`, `td_send`, and `td_receive` interface. One dedicated Rust thread owns `td_receive`; updates are copied immediately and emitted to the webview in the order received. Rust automatically answers `authorizationStateWaitTdlibParameters`, while user-facing authorization states remain in the TypeScript store.

After authorization, the TDLib transport now synchronizes the current user,
the main list and server-defined chat folders, user presence, paginated
message history, outgoing text messages, send-failure retry state, read state,
chat and sender avatars, and common real-time chat/message updates. Sender
profile photos are downloaded through TDLib and refreshed when updateFile
completes. The Tauri asset scope includes both the configurable TDLib files
directory and TDLib's app-data database directory, where profile and chat
thumbnails can be stored. Consecutive messages from the same sender use joined Telegram-style
bubbles, show the sender name only on the first item and the avatar on the last,
and render timestamps with second precision. Photo messages use a sender header
only when they start a consecutive group; subsequent photos are borderless.
History is preloaded in
30-message pages and continues loading when the message list is scrolled upward.
On startup, the UI restores a DPAPI-protected snapshot from the configured cache
directory while TDLib connects in parallel; live server updates always replace
cached chat, folder, user, and message state. The generated local archive folder
is not shown or loaded. History requests are deferred until authorization is
ready. Each chat keeps an independent server-history cursor and always starts
its first refresh from TDLib's latest window, even if a live message arrived
first. Cached continuity cleanup runs only after a complete recent window is
confirmed; partial or stalled responses preserve the existing cache and remain
retryable instead of marking history complete.
Documents and Telegram media messages are mapped separately: image documents
remain file cards, while photo media uses the embedded preview immediately and
is cached automatically for inline rendering through TDLib updateFile events. Completed user
downloads are copied to the configured download directory without overwriting
existing files. The cache path defaults to the Windows app cache directory, while
downloads default to the downloads folder beside Notgram.exe; both paths are
configurable under Advanced Settings. Settings also provides the Telegram-style
account, notification, privacy, chat, folder, device, power, and language
categories. Real file upload and dedicated video/audio players
remain disabled.

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

For local development, an empty database encryption key is allowed. A release build must store a generated key in the operating system credential vault rather than in `.env`.
