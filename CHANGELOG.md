# Changelog

Notable Notgram changes are recorded here. Versions follow Semantic Versioning,
with prerelease identifiers used for release candidates.

## [Unreleased]

## [0.5.0-rc.1] - 2026-08-03

### Added

- Connection recovery, native notifications, complete media actions, cache
  management, and automatic download controls.
- Paginated global search with filters, exact context loading, profiles,
  contacts, members, chat organization, and server-backed folder management.
- Deterministic Mock browser coverage and isolated native smoke evidence.
- Traceable portable and NSIS artifacts, signed stable/candidate update channels,
  forward-only rollback policy, and isolated install/upgrade/uninstall lifecycle
  verification.
- User-exported redacted diagnostics, opt-in local crash reports, and settings
  that keep crash capture disabled by default.
- Automated 125%/150%/200% DPI, forced-colors, long-text, narrow-screen,
  keyboard, and accessibility-tree release checks.

### Security

- Per-account DPAPI-protected database keys, constrained local-file commands,
  trusted media asset paths, and recursively redacted structured logs.
- Release builds reject hidden local inputs, publish dependency/license and
  SHA-256 inventories, verify the pinned TDLib runtime, and sign native binaries.
- Diagnostic export removes string values, identifiers, messages, credentials,
  phone numbers, and local paths before creating the ZIP archive.
