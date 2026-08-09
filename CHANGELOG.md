# Changelog

Notable Notgram changes are recorded here. Versions follow Semantic Versioning,
with prerelease identifiers used for release candidates.

## [Unreleased]

### Added

- Reopen forum groups at their last topic and switch topics from a compact horizontal
  strip containing only the topic avatar, name, and unread counter, with mouse-wheel
  horizontal scrolling when the strip overflows.
- Send selected videos, audio, animations, photos, and documents as native Telegram
  media with probed dimensions, duration, generated covers, spoiler/caption placement,
  original-file mode, compatible mixed albums, and native-path-safe validation.
- Participate in Telegram polls and quizzes, including multiple-choice submissions,
  result updates, correct-answer explanations, restrictions, and vote revocation.
- Pin and unpin messages with Telegram notification scope, browse and jump through
  pinned messages, and configure preset or custom chat auto-delete durations.
- Browse server-paginated shared media by category with search and date filters,
  TTL-backed indexing, message jumps, batch downloads, forwarding, and deletion.
- Continue adjacent audio and voice messages automatically within the active
  conversation while retaining a single active playback session.
- Queue attachment uploads while offline with encrypted snapshot metadata,
  persistent browser storage, SHA-256 change detection, expiry and quota limits,
  reconnect recovery, cancellation, and explicit retry states.
- Create basic groups, supergroups, and channels with initial members,
  descriptions, public usernames, history visibility, permission templates,
  and native-path-safe chat photo selection.
- Add a lightweight WebView performance timeline for startup, interaction, rendering,
  history, and media stalls, backed by a separately rotated performance log.
- Search the current conversation through TDLib with stable pagination, total counts,
  sender, message-type, date, and forum-topic scope filters, exact context loading,
  and a member-avatar context-menu shortcut.
- Add a muted inline video surface, Alt-click floating playback, and progress-preserving
  fullscreen transitions with compact controls for narrow conversations.

### Changed

- Render in-conversation search results directly as the normal message timeline,
  preserve message interactions and media rendering, and highlight literal query
  matches across entity text, Markdown, rich content, polls, filenames, and captions;
  each result can jump directly to its real position in the conversation history.
- Move pinned-list message navigation into a compact action at each bubble's
  top-right corner and remove the redundant linked-channel jump button.
- Replace the pinned-message preview dialog with an in-conversation pinned-message
  view, a persistent header strip that advances through earlier pins as their source
  messages enter the viewport, per-message history jumps, and exact return-position
  restoration without injecting non-contiguous pinned history into the normal timeline.
- Keep the forum group name in topic conversation headers and remove the redundant
  back-to-topic-list control.
- Cache bounded forum-topic metadata with per-group selection state so forum entry
  paints immediately while topic metadata and history refresh in the background.
- Coalesce forum-topic refreshes, reuse fresh topic/read state, and load only the
  destination topic when opening a search result or notification.
- Preserve TDLib voice-note duration before media loading and disable unavailable
  voice controls instead of presenting an inert play action.
- Merge chat and message search into the single conversation-sidebar field, and hide
  the contacts navigation entry until it is assigned a new location.
- Treat all search input as plain text and remove the local regular-expression mode.
- Prefetch image and video covers above the viewport, replace percentage media loaders
  with rotating indicators, and stop paused streams after a bounded buffer window.
- Present fullscreen video controls in a light 550-by-80 floating panel that hides
  after pointer inactivity, and route Space to the selected video without activating
  the currently focused non-text control.

### Fixed

- Keep an in-conversation search timeline at the user's reading position when
  older result pages are prepended instead of repeatedly returning to the latest match.
- Keep pinned-message jumps smooth by avoiding redundant same-chat selection,
  suppressing the transient target flash, and ignoring clicks when the pinned
  source message is already visible.
- Give captioned media a stable readable card width without letting short captions
  shrink wide media, keep incoming and outgoing geometry identical, and scale the
  complete media frame proportionally in narrow conversations.
- Prevent rapid forum history initialization from leaving the virtual message list
  stuck in its positioning state and delaying conversation performance traces.

## [0.5.0-rc.2] - 2026-08-03

### Fixed

- Preserve messages when TDLib evicts them only from its local cache, avoid
  inferring deletions from incomplete history windows, and stabilize ordering
  for messages sent within the same second.

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
