# Settings backup and restore

The **Settings → Notgram → Backup and restore** section exports and imports
`notgram-settings.txt`. Desktop builds can synchronize the same file in an
existing WebDAV directory. Browser builds support local export and import.

## Privacy and file contract

`src/backup/settingsBackup.ts` is the explicit allowlist and validation boundary.
It includes blocking keywords and regex rules, keyboard bindings, language,
notification preferences, local privacy switches, appearance, animation,
automatic download limits and cache retention preferences. It excludes account
identifiers, profiles, chats, contacts, messages, blocked users, drafts, proxy
credentials, paths, WebDAV configuration and diagnostic/developer settings.
User-written blocking rules are included as requested; their contents are not
automatically redacted.

The file is one Base64 encoding of UTF-8 JSON, with `format: "notgram-settings"`,
`version: 1`, `preferences` and per-setting numeric `revisions`. It contains no
device identifiers or account metadata. Base64 is encoding, not encryption.
Input is limited to 1,400,000 bytes. Unsupported versions, invalid field types,
out-of-range values and malformed encodings are rejected before any setting is
applied. Unknown fields are discarded. Partial backups preserve settings absent
from the file. Existing shortcut and blocking-rule normalization is reused.
Explicit imports count as new local changes and take effect through the existing
preference store, including cross-window storage synchronization. Zalgo blocking
retains its existing next-startup behavior to avoid mixing previously sanitized
identity data with a different normalization policy during the same session.

## WebDAV lifecycle

Only `src/main.tsx` starts the synchronization controller. Auxiliary settings,
media, notification and context-menu windows never start independent network
writers. Settings windows notify the main window through storage events.

- On startup, enabling WebDAV or reconnecting, read the cloud file in the
  background. An unchanged startup never performs a PUT. A missing file is
  created when there are locally modified preferences; pristine defaults alone
  do not create one. Existing nondefault preferences are recognized on migration.
- Subscribe only to allowlisted preferences. Ignore diagnostic, system-motion
  and runtime-only updates. Coalesce local edits for 1.2 seconds before syncing.
- Persist revisions locally, including while sync is disabled or offline.
  Restarting preserves pending edits. Downloaded settings retain their revisions
  and do not trigger an upload loop.
- Merge settings independently using the newer revision, retaining unrelated
  offline edits. Same-field equal-clock conflicts use a deterministic JSON value
  ordering. Revisions advance beyond the greatest observed revision so local
  clock rollback does not discard the next edit. This is a last-change-wins
  policy per setting; a keyword list is one setting, not a per-word CRDT.
- GET immediately before PUT. Replace using the observed strong ETag and
  `If-Match`; create using `If-None-Match: *`. On HTTP 412, reread and merge, up
  to three attempts. A missing or weak ETag pauses replacement, preserving the
  remote file. The WebDAV service must honor conditional writes.
- Configuration generations discard late responses from obsolete endpoints.
  Serialize requests and retain changes made during an upload for another pass.
  Errors preserve local state and retry after another edit, reconnection or
  startup, without an idle polling/upload loop.

The native bridge reuses the locked reqwest/rustls versions already used by the
updater and enables system proxy discovery. Requests have a four-second connect
timeout and a ten-second total timeout, bound response size while streaming,
validate HTTPS certificates and refuse redirects. Credentials use Basic auth.
The address must be a directory URL without embedded credentials, query or
fragment. No directory creation or cloud deletion is performed.

WebDAV credentials use the existing protected durable-record helper (Windows
DPAPI). Normal settings reads return only the URL, enable state and credential
presence flags; both username and password display fixed dots outside editing.
The WebDAV header switch enables or disables a saved configuration without
retrieving credentials into the UI. With no configured address, enabling opens
the editor first; saving commits that draft. HTTP 401 (authentication failed)
and 403 (access denied) display distinct status codes.
Only entering the editor retrieves credentials. Password input stays masked during
editing. Neither credentials nor raw network errors enter sync status records or
backup files. Native commands are restricted to main/settings windows; requests
are restricted to the main window.

## Verification

`src/backup/*.test.ts` cover file privacy/validation, revision persistence,
restore behavior, debounce, offline/clock-rollback merge, failures, conflicts and
concurrent edits. Native `settings_backup` tests exercise actual loopback HTTP
headers, conditional writes, response bounds, redirects, stalled requests and
Windows credential encryption. `tests/e2e/settings-backup.e2e.ts` verifies desktop
and narrow layouts, file downloads/imports, credential masking, cross-window
restore and responsiveness during sync failures with a native bridge fixture.
These fixtures do not substitute for acceptance against a user's WebDAV service.
