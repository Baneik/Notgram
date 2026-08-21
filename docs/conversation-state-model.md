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
message jump because that operation has one owner, one list, and a bounded animation.

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
- The viewport observer, composer resize callback, message-mount callback, and Virtuoso's
  `totalListHeightChanged` signal may report committed geometry, but only the coordinator may write
  `scrollTop`. Observer notifications coalesce into the active request.
- Do not observe the virtualized content node to request bottom pins. Its size can change in response
  to a pin, creating a resize-pin-measurement feedback loop even when no application content changed.

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

The focused unit and browser tests cover command consistency, source-row isolation, unread-marker
settlement, repeated warm switching, bounded geometry reads, idle bottom stability, long-message edit
entry/cancel/save, and detached edit anchoring.
