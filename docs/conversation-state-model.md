# Conversation Selection and Viewport Model

This document defines the ownership and completion rules for conversation switching and message
viewport positioning. It is a contract for future changes, not a description of one incident.

## Evidence from the db808d7 artifact

The portable artifact used for the `16fd66a` state-model analysis was built from clean commit
`db808d7`. Its performance log shows that
selection and data projection were usually fast, while stage 6 (scroll positioning) frequently took
roughly 240-334 ms. Some navigation traces stayed open until the 8 second timeout. The same sessions
also contain repeated long frames and layout shifts.

The old UI could therefore reach this state:

1. `activeChatId` changed and the sidebar highlighted the destination.
2. A full-conversation snapshot still covered the destination until positioning reported completion.
3. A second click issued a new latest-position request and happened to release the snapshot sooner.

At the bottom of a conversation, Virtuoso, viewport/content resize observers, message mount callbacks,
and a multi-frame pin loop could all write `scrollTop`. Observer notifications restarted the loop, so
the list could alternate between Virtuoso's correction and the application's correction.

## State ownership

There are only two authoritative inputs:

- The Telegram store owns the selected destination: `activeChatId` and `activeTopicId`.
- `App` owns one `ConversationScrollRequest`, a discriminated command with `entry`, `latest`, or
  `message` semantics and a monotonically increasing `requestId`.

There must not be separate entry/latest/message request states. A request is meaningful only when its
`chatId` matches the selected chat. `Conversation` derives its entire header, message projection, and
viewport command from that same selected destination.

## Selection transaction

Every user-visible route into a conversation follows this order:

1. Resolve the destination chat/topic and the viewport intent.
2. In one synchronous React transaction, issue the viewport command and call `selectChat` or
   `selectForumTopic`.
3. Let the destination shell render immediately. A bounded visual handoff may cover measurement
   latency, but it must not participate in destination selection or positioning.
4. Start or continue background history work using the captured destination generation.
5. Ignore an asynchronous result when its generation or request is no longer current.

Selection methods are synchronous by contract. Read markers, history loading, and cache writes may
continue in the background, but callers must never await them before committing the selected
destination.

An interactive, state-owning, or unbounded conversation switch snapshot is prohibited. The current
visual handoff is deliberately narrower: it clones only the already rendered shell into a closed
shadow root, copies canvas pixels, is `aria-hidden`, inert, and ignores pointer input. Destination
readiness starts its 90 ms release and a 1500 ms bound removes it even when readiness never arrives;
resize, unmount, and a newer switch cancel it. It cannot choose a destination, write scroll state,
or delay background work. A separate local snapshot remains valid for an explicit in-conversation
message jump because that operation has one owner and one list. For a distant virtual relocation the
snapshot stays still, and only the final controlled deceleration is revealed; source and destination
must not run separate whole-list transforms.

## Positioning completion

`positioning=false` means the requested geometry is stable, not merely that a correction was queued.
The performance stage `positioned` and `aria-busy=false` are published only by the final settlement
callback. Controlled message navigation must not reuse the user-scroll interrupt path, because a user
interrupt intentionally accepts the current geometry while a controlled navigation does not.

Destination changes invalidate all positioning work by identity and generation. A stale callback may
not publish completion, write memory, or change the current scroll mode.

## Bottom following coordinator

Bottom following has one writer: the coordinator in `useConversationScroll`.

- Resize, total-height, and message-mount callbacks only request reconciliation.
- Requests with the same identity and generation are coalesced; notifications do not restart the
  quiet window.
- The coordinator samples geometry until two quiet animation frames or an eight-frame bound.
- Tracking requests keep the bottom aligned while viewport or content geometry changes. A final
  conditional write starts a bounded verification pass because that write can trigger another
  Virtuoso measurement correction.
- User upward intent, pointer control, a detached scroll mode, or a destination generation change
  cancels the request.
- A passive scroll displacement can arrive after a tracking request has settled. While following,
  a raw bottom distance greater than the existing 1px rounding tolerance requests another bounded
  settlement. Preserve this tolerance: repeatedly correcting the last pixel can create a feedback loop.
  It does not restart a pending settlement or override active user input/navigation. Passive events
  describe movement, not its author; `isTrusted` alone never establishes user intent.
- The viewport observer, composer resize callback, message-mount callback, and Virtuoso's
  `totalListHeightChanged` signal may report committed geometry, but only the coordinator may write
  `scrollTop`. Observer notifications coalesce into the active request.
- A real row resize and a virtual-list layout commit must reconcile active tracking before paint,
  including repeated notifications within the same frame. They do not extend its deadline. Observe
  actual rows for late child-content changes after a transaction has settled. Do not discard per-row
  subpixel changes: their sum may be visible. A clamped scroll assignment that makes no progress is
  not a successful write and must not start another verification pass.
- Do not observe the virtualized content node to request bottom pins. Its size can change in response
  to a pin, creating a resize-pin-measurement feedback loop even when no application content changed.

Virtual rows contain their sender/day margins, and top spacing belongs to a measured Header at every
responsive breakpoint. Preserve fractional item dimensions instead of rounding each row: independent
rounding accumulates into a different endpoint than the DOM. The 12px Footer is scrollable content;
only the final 1px rounding tolerance at the raw scroll maximum may absorb downward wheel input.
Latest navigation approaches that endpoint under one application-owned animation or reconciliation
pass. If the final row is already mounted, the application skips Virtuoso's `LAST/end` command because
that command measures against the row while the application endpoint includes the Footer. An index
command is used only when it must mount an unrendered tail; the bounded bottom coordinator then owns
the final raw maximum correction.

Middle-button autoscroll outlives pointerup and the short wheel/key input timeout. Both row observers
and total-height callbacks must yield detached anchoring for its entire lifetime, until explicit input
or window blur ends it.

### Virtual index origin and viewport anchors

`firstItemIndex` is a size-cache origin, not a viewport anchor. Resolve it from the ordered stable
virtual block IDs (including sponsored blocks), against the last committed render. Subtract the
number of inserted blocks only when the entire old sequence is an unchanged suffix of the new one;
add the number of removed blocks only for the inverse operation. Normal head pagination therefore
retains the logical indexes of existing blocks.

Interior insertions/deletions, tail edits, group splits/merges, mixed changes and independent history
window replacements keep the origin. Mounted rows remeasure at their current indexes. Stable block
identity survives a member deletion or a pending-message ID confirmation, so neither counts as a
removed block. Bottom and detached reading positions remain owned by the existing before-mutation
viewport capture and coordinator. Neither the tail message nor the preferred reading anchor may
shift the global size cache. An abandoned render cannot commit a new origin or block sequence.

`ui_conversation_viewport` provides numeric-only native evidence once per second while the current
viewport is visible, and emits only when endpoint geometry or control state changes. It records the
raw scroll maximum separately from the visible Footer/message gap, clipping by ancestors, row
measurement error, scale and following/input state. Negative gaps mean content extends below the
visible viewport; `latestRowPresent` distinguishes the mounted tail from the actual latest message.
Sampling owns no scroll writes or resize reconciliation. These records diagnose persistent endpoint
failures; ordinary frame-drop events alone cannot establish pixel movement.

### Conversation diagnostics

The diagnostic build also records `ui_conversation_trace`, `ui_conversation_row`, and
`ui_conversation_member` through the existing numeric-only performance log and export pipeline.
This is instrumentation, not a scroll behavior fix. It starts for the current conversation only while
the persisted performance-monitoring switch is on (enabled by default for existing installations).
The switch is shared across windows and also controls `ui_conversation_viewport`. Turning it off
disposes diagnostic timers, animation frames, input/scroll listeners, and trace identity tables;
hot-path hooks skip diagnostic layout reads and record construction. Pending records are discarded,
while an already submitted native log batch may finish. Turning it on creates a fresh trace session
without remounting the conversation or replaying activity from the disabled interval.
No server message/chat/user IDs, text, URLs, button data, paths, or keyboard text are written.

`traceSession` identifies one mounted conversation observer; `traceRun` identifies one burst within it.
`messageToken`, `replyToken`, and `partitionToken` are opaque session-local counters, not hashes of IDs.
`rowToken` identifies the actual DOM node; `revisionToken` identifies an in-memory message object.
Thus the same logical message can be distinguished from a replaced DOM node or new object revision.
Tokens are not comparable across sessions/windows. The ID table is bounded to 4096 entries; zero means
unknown/over budget. Object identities use weak references. A conversation/account switch disposes
the observer and its ID table. Use the existing `windowId` with these keys across native windows.

Every trace record includes `traceSeq` and `traceTimeMs`. Reconstruct event time as
`traceOriginMs + traceTimeMs`; `observedAtMs`/native `timestampMs` are emission times and may be later
because pre-trigger evidence is buffered. A start marker precedes replayed history, so file order is
not necessarily event order. History can appear in successive runs; deduplicate by session/sequence
when combining runs.

Collection policy:

- Idle geometry stays at 1 Hz and is deduplicated. The most recent 96 callback/input/write events
  stay in memory. The 100 ms housekeeping timer performs no geometry reads while idle.
- A remote deletion or ghost creation triggers a burst (`triggerKind=1`). Geometry sampling can also
  trigger it for row error >8 px (`2`), or following the latest message with >32 px bottom distance,
  <-8 px latest gap, or >8 px ancestor clipping without active pointer/autoscroll (`3`). These are
  capture thresholds, not declarations that ordinary navigation is broken.
- A burst lasts at most 8 seconds or 640 records, including its terminal record. Starts are separated
  by at least 30 seconds; repeated callbacks cannot extend the deadline. `finishKind` is `1` for time,
  `2` for output budget, `3` for disposal. `droppedCount` reports overwritten/unemitted callback entries.
- During a burst, each animation frame reads raw scroll metrics. Every 100 ms the trace reports
  extrema, sample count, and direction reversals, preserving evidence of movement between snapshots.
  Row snapshots run at most every 250 ms: the mounted tail plus the largest measurement errors,
  at most eight rows. `selectedRowCount`/`mountedRowCount` make this sampling explicit.
- Rows record cached/actual height, layout height, relative top, width, offsetTop, transform/scale,
  logical/absolute indexes, partition/node identity, and removing-member counts. Member records map
  individual anonymous messages to expected/actual indexes whenever a selected row's membership
  changes (up to 16 members per row; `memberCount` exposes truncation). New runs resend membership.
- Live-message and deletion lifecycle evidence is also flushed outside bursts, including cooldown,
  so a bot's later self-deletion is not lost just because the geometry burst ended. This queue keeps
  at most 32 pending lifecycle records and flushes at most once per second while idle.
- Hiding the document pauses frame/row reads. Visibility/focus events and terminal elapsed time
  identify gaps; absence of a sample is not evidence of stable geometry. Disposal cancels all
  observer timers/listeners/frames. Existing file rotation and performance-log drop reporting apply.

`traceKind` decoding:

| Code | Meaning |
| --- | --- |
| 1 / 2 | Burst start / end |
| 3 | Per-frame scroll extrema and reversal summary |
| 4 | Application scrollTop assignment: requested, previous, and actual clamped value |
| 5 | Passive scroll event; `trusted` does not imply human input |
| 6 | Requested Virtuoso index scroll, alignment, offset, and smooth flag |
| 7 / 8 | Before-mutation / committed-list notification, including index/count changes |
| 9 / 10 | Real row resize / virtualizer total-height notification |
| 11 / 12 | Removal settling transaction started / released |
| 13 / 14 | Input category / document visibility or window focus change |
| 15 / 16 | Committed message upsert / received deletion event |
| 17 / 18 | Removal ghost created / expired, including timer deadline lag |
| 19 / 20 | Immediate removal / local deletion archive retained |
| 21 | Scroll-control snapshot: generation, follow mode, ownership, anchor, input window |
| 22 | Size returned to Virtuoso's itemSize callback, before it updates its size cache |
| 23 | Idle lifecycle queue truncation/drop count |

`writerKind`: `1` bottom pin, `2` latest animation, `3` latest approach,
`4` anchor correction, `5` resized-row correction, `6` jump animation, `7` target reveal,
`8` selection autoscroll, `9` selection return. Index commands are separately recorded as kind 6.
Browser anchoring, focus scrolling, and Virtuoso's internal corrections do not pass through the
application's scrollTop helper. They remain observable as kind 5 / frame changes without a matching
kind 4. Do not label an unattributed movement as a definite browser or library write.

`inputKind`: wheel, keydown, pointerdown, pointerup, pointercancel = 1..5.
`keyKind`: ArrowUp, ArrowDown, PageUp, PageDown, Home, End, Space = 1..7; all other keys = 0.
`contentKind`: text, rich, media, file, sticker, service, unsupported = 1..7; other kinds = 0.
`mediaKind`: photo, video, animation, audio, voice = 1..5; other kinds = 0.
`scrollMode`: following, detached, restoring, navigating = 0..3.
`reconcileMode`: settle, track, motion = 0..2; no transaction = -1.

For deletion investigations, follow a `messageToken` from remote deletion through ghost expiry and
the commit/index records. Compare the same `rowToken` and `partitionToken` before/after mapping
changes, then compare kind 22 measurements to the next cached heights. Finally align application
writes, passive scroll changes, control ownership, and frame extrema. This distinguishes a wrong
cache mapping, genuine content resizing, repeated scroll correction, and a DOM-node replacement.

Anchor and explicit message navigation use longer quiet windows because virtual rows can mount several
frames after the target first appears.

## Required invariants

- A selected chat row, conversation header, and rendered message IDs always name the same destination.
- One click commits the destination; a second click is never part of the switching protocol.
- Any source-view visual handoff is non-interactive, cannot own state, and is removed within its
  bounded lifecycle.
- `positioned` is emitted once per current request and only after its settlement callback.
- A following conversation remains visually motionless across idle frames.
- A detached conversation never moves because of a bottom-following notification.
- Async history results cannot restore an older selection or viewport command.

## Stable timeline partitions and visual readiness

Semantic sender/day grouping and virtual partition identity have different lifetimes.
The timeline projector reconciles against the last **committed** partitions for the same
account, conversation and view. New history is packed independently of existing partitions;
live messages can fill the final partition. Deleting a partition's first message does not
rename its surviving siblings. A sender/day change or an album topology change may split
the affected partition, but must not repack unrelated partitions. Albums remain atomic and
the four-message target continues to bound ordinary partitions and sender-avatar geometry.

Commit the projection reference in a layout effect. Do not mutate a global partition cache
during render: an interrupted render must not redefine the next committed view. Nested React
keys must use the same stable partition identity, and album identity must not depend on its
first loaded member.

Virtuoso measurements are reusable only when the ordered message-to-partition mapping,
viewport width and geometry-affecting preferences still match. Equal first/last message IDs
and row counts are insufficient. On a mismatch, retain the semantic reading anchor and let
the destination measure its actual layout.

Positioning feedback belongs to the viewport transaction. It may appear after a delay, but
must unmount in the same commit that publishes a positioned view. It has no independent
minimum lifetime or exit animation over destination messages. The source snapshot continues
to use its bounded, presentation-only release protocol.

Image resource readiness survives virtual row remounts through bounded URL metadata. A
previously decoded image that is already loaded in the new element is revealed before paint
without replaying an entrance. A cache hit alone must never expose an unloaded or failed
element; stale source decodes must not publish readiness for a replacement.

Regression checks must include partial same-sender history pages at the production partition
size, deletion of a partition head, restored image opacity and node identity, source-decode
races, and loading/positioned handoff at both short and long response times. An unchanged
reading offset alone does not establish visual continuity.

The focused unit and browser tests cover command consistency, source-row isolation, unread-marker
settlement, repeated warm switching, bounded geometry reads, idle bottom stability, long-message edit
entry/cancel/save, and detached edit anchoring.

## History windows and recovery ownership

`ConversationHistory` owns separate refresh and reader cursors for each chat/topic. Transport calls
with an explicit `HistoryPageRequest` return the next cursor without consuming another window's
cursor. The existing history pager, message merge rules, deletion facts and sync generations remain
shared. A stale response cannot publish into a discarded scope or a new account/recovery generation.

The message cache is broader than the displayed timeline. A disjoint context loaded by search/reply
navigation has its own membership and older cursor. It remains cached while the latest timeline
excludes those context-only records. Normal pagination can admit returned records into the latest
timeline. Overlapping real server pages can join windows; numerical gaps between IDs cannot establish
or disprove continuity. Explicit navigation selects a window in the same transaction as its existing
viewport request. End/latest selects the latest window; jump return can select a cached context and
restore its original pixel offset. A context's local bottom is not the latest conversation window.

Recovery captures the recent server-message boundary before accepting new live updates. It refreshes
from the head until that boundary is returned/passed or the server confirms exhaustion. Distant
context membership is never a recovery target. Each recovery has a total nine-page budget (including
the first page), rather than an eight-page limit that silently restarts every five seconds. A budget
stop preserves the cursor and publishes `recovery: paused`; it neither deletes unconfirmed messages
nor claims completion. Explicit older loading can continue that repair with a new budget. Request
failures/stalls have a bounded three-attempt retry path using the existing retry queue. Switching
accounts clears all window and retry ownership. Reconnect retires requests but preserves reader
windows and their cursors.

Optional `historyContexts` in cache schema 4 preserves only membership present in the bounded saved
message cache. It contains no claim that an entire old cache is contiguous. Legacy caches remain
usable without this metadata; malformed optional metadata is ignored. Cache membership never takes
precedence over permanent deletion or a newer live edit.

The virtual index adapter derives from the last committed mapping. Following views preserve a
surviving bottom row; detached views preserve their reading anchor. Index/layout caches are written
only on commit. Structural changes establish a bounded bottom-follow transaction before mutation,
so list layout notifications reconcile that same owner before paint. Equivalent message refreshes
preserve existing message objects and arrays.

History diagnostics use `ui_history_data`: `purpose` 1 is recovery and 2 is reader pagination.
`stopReason` 1 means complete/page accepted, 2 stalled/no cursor progress, 3 inactive scope,
4 total budget reached and 5 request failure. `remainingBoundaryCount` is zero only when recovery
completed. These numeric fields are accepted by the native logging boundary; no message identifiers
or bodies are included.

Regression coverage must include disjoint cached context plus repeated reconnects while idle at the
bottom, original visible DOM-node identity, every sampled frame's bottom distance, context/latest and
jump-return navigation, interrupted renders, bounded recovery continuation, independent reader
cursors, restart membership and deleted recovery boundaries. Final scroll position alone is not an
adequate assertion for this failure mode.
