# Notgram motion system

Notgram uses motion to explain state changes in a dense desktop tool. Motion must stay quiet,
interruptible, and subordinate to message readability. The system follows the functional and
consistent motion principles in [Fluent 2](https://fluent2.microsoft.design/motion), the hierarchy
and transition guidance in [Material 3](https://m3.material.io/styles/motion/overview), and the
reduced-motion guidance from [web.dev](https://web.dev/articles/prefers-reduced-motion).

## Motion layers

| Layer | Use | Implementation |
| --- | --- | --- |
| Transient surfaces | Dialogs, drawers, toasts, anchored popovers | `MotionPresence` with a semantic `variant` |
| Local feedback | New/deleted messages, spoiler reveal, media state | CSS animation using the shared tokens |
| Content navigation | Explicit jumps to a distant message | Static relocation snapshot followed by one controlled deceleration |
| Conversation handoff | Hide virtual-list measurement latency without changing state | Bounded header and source-shell snapshot with inert contents |
| Continuous feedback | Loading, animated media, audio spectrum | Only while active and when reduced motion is disabled |
| Async feedback | Loading, pending actions, image decode | Delayed visibility and a bounded minimum visible time |

Conversation selection, scroll restoration, composer resizing, and virtual-list measurement are not
presentation animations. They remain under their existing single-owner coordinators. A normal switch
may use the bounded visual handoff above, but that layer cannot delay, select, measure, or write the
destination.

## Shared tokens

CSS tokens live at the top of `src/styles/global.css`; WAAPI and React fallback values live in
`src/utils/motionTokens.ts`. Keep the duration and easing values aligned when changing the scale.

- `60ms`: native/context-menu acknowledgement.
- `120ms`: small popovers and fast feedback.
- `180ms`: standard state transition and exit fallback.
- `220ms`: large surface entrance.
- `800ms`: bounded attention feedback such as the active message target.
- `900ms`: continuous loops such as loading indicators.
- Enter easing decelerates into place; exit easing accelerates away.
- Standard travel is `8px`; near travel is `4px`.

Presentation-only timers live in `motionLifecycleTiming`; loading visibility uses
`asyncFeedbackTiming`. Network debounce, draft persistence, transport timeouts, virtual-list
measurement, and the single scroll writer are business or geometry lifecycles and must not be moved
into the motion token module.

## Presence contract

Use `MotionPresence` when a component needs an exit animation. Pass `null` when `present` is false;
the component retains the last child until the root exit animation ends. Choose the variant by
relationship, not visual preference:

- `modal`: centered task surface with a backdrop.
- `drawer`: contextual detail surface with a backdrop.
- `toast`: non-blocking status or error notice.
- `popover`: anchored menu, picker, or suggestion panel.
- `status`: loading, empty, and error feedback that replaces another status in place.

Exiting content is inert and hidden from the accessibility tree. Exit completion listens to the root
animation and retains a cancelable timer only as a fallback. Do not add a second unmount delay in the
calling component.

Native Tauri context menus and standalone child windows are lifecycle exceptions. Their owner is the
OS window or native bridge rather than the React tree, so the browser fallback has a short entry
acknowledgement but no retained React exit. Validate those boundaries in the native WebView.

## Async stability

`useStableVisibility` waits `140ms` before publishing loading feedback. Work that finishes before the
delay produces no spinner; feedback that became visible remains for at least `320ms`, preventing a
single-frame loading/empty/result swap. Existing results stay mounted while search and shared-media
pagination update. `StableImage` keeps the reserved media geometry but does not reveal a new source
until `HTMLImageElement.decode()` completes. Decoded-resource knowledge is bounded and
independent of the lifetime of a virtual row: an already-loaded cached resource restores
before paint without another fade. Source replacement validates the current element and
resolved URL before accepting a decode result; loading failures invalidate resource knowledge.
Media surfaces opt into `retainWhileLoading`: the decoded image node stays in normal flow while
its replacement loads and decodes in an absolute layer. Only the ready replacement takes over;
it does not fade through an empty surface. Errors and superseded decodes retain the usable image.
This is scoped to one media identity, not to unrelated items in a viewer or an account switch.

The image viewer keeps its transform on a positioned surface outside the decoded-image lifecycle.
Upgrading one photo must retain both its painted preview and its zoom/pan; selecting another photo
resets the viewport before paint. Pointer moves coalesce into one transform write per animation frame,
and the window entrance changes opacity only so it cannot distort pointer coordinates. Wheel navigation
accumulates intent separately from zoom. The thumbnail strip selects small sources and adapts its item
count to available width; only the two adjacent local originals are warmed after navigation settles.
Viewer session updates coalesce file progress, ignore duplicate initialization, and cancel pending
initialization/prefetch when replaced, closed, or the main account changes. Media-window focus return
continues to follow the shared focus contract.

The minimum-visible and exit-animation rules apply to presentation feedback, not to a
viewport concealment layer. Conversation positioning feedback uses a delayed entrance and
ends synchronously when its viewport transaction is ready. Retaining an opaque loading
background after the old conversation snapshot releases would hide an already-ready view.

The document visibility policy pauses continuous work when the application is backgrounded. CSS
loops are paused through `motion-background-paused`; audio spectrum, autoplay media, stickers, and
performance sampling stop scheduling frames and resume from current state when visible again.

## Invariants

1. Animate `opacity` and `transform`; do not animate layout dimensions or virtual-list position.
2. A scroll position has one writer. Animation code may request a semantic destination but cannot
   compete with `useConversationScroll`.
3. Conversation switches do not use smooth scrolling or interactive/state-owning page snapshots.
   Their optional header/source-shell handoff is `aria-hidden`, has inert cloned contents, consumes
   pointer events, is interruptible, and is forcibly removed within 1500 ms. The destination header
   and message shell remain inert until the snapshot exits. The composer and sidebar keep their
   existing focus/navigation ownership. Exit completion follows the opacity transition event, with
   a bounded timer fallback; resize, backgrounding and account changes clean up the handoff.
   Explicit distant message jumps use a separate bounded,
   static snapshot while the virtual list relocates, then reveal one controlled deceleration. The
   source snapshot and destination list must not each run their own whole-list transform.
4. New message animation is registered once by message identity and cannot replay after
   virtualization or conversation restoration.
5. Reduced motion is both CSS and JavaScript policy. CSS transitions collapse, smooth scrolling is
   downgraded, autoplay is disabled, and Canvas/WAAPI loops must stop scheduling frames.
6. Motion state must be interruptible. Reopening during exit cancels stale timers, keeps the presence
   wrapper mounted, and starts a fresh child session so focus and local state initialize correctly.
7. Loading or geometry settlement cannot be hidden by a long opaque animation. Publish stable layout
   first, then animate presentation-only properties.
8. Every CSS transition and keyframe uses a shared duration token and only changes `opacity` or
   `transform`. Run `npm run motion:check` to enforce this contract.

## Snapshot and presentation timing

Snapshot media is frozen directly into canvases, never serialized to PNG on the navigation path.
Only media intersecting the viewport is rasterized, at displayed size with DPR capped at 2 and a
per-surface area cap of four viewport pixel areas. Overscan retains geometry with its media sources
removed. Cloned videos are disarmed before insertion; the original frame or poster supplies the
visual fallback. The virtual list and its scroll coordinator retain ownership of destination geometry.

Conversation diagnostics distinguish `titleUpdateDurationMs` (destination title committed),
`messagesVisibleDurationMs` (positioned messages have an uncovered frame after the snapshot exits),
and `firstScreenMediaDurationMs` (visible media has a decoded image, poster, canvas or video frame).
The retained header shares the message handoff even though its destination DOM commits earlier.
`visualResponseDurationMs` includes the actual handoff after transition start. Media readiness is
observed independently and never delays interactivity or selection; failed, cancelled or timed-out
loads do not produce a successful media-ready duration. Observers are bounded by the trace lifetime,
pause in the background and clean up on navigation or completion.

## Message deletion

Deletion removes the server message immediately from live data and retains only its existing
presentation record for the 220ms exit plus the shared 40ms fallback buffer. The message and
departing sender avatar fade and shrink together; exiting message controls are inert.

`ConversationViewportBoundary` captures surviving surfaces before the removing rows disappear.
`useConversationScroll` keeps the lower surviving message anchored while reading history, or
uses its existing bottom coordinator when following latest. A bounded 300ms FLIP transition
then moves the upper bubbles, albums, date labels, and avatars into place. Only the contents
are transformed: measured message rows and virtual partitions retain their final geometry.
Virtual-list commits and row measurements reconcile that same transaction before paint.
Consecutive deletions capture the current visual position instead of replaying an old start.
At the beginning of history, the measured Header reserves any distance that cannot be
compensated with a negative scroll offset. That space changes once and is not animated.

Scrolling, navigation, resizing preferences, reduced motion, backgrounding, and unmounting
cancel retained transforms. Reduced motion keeps the anchor correction without a visual fall.
The deletion browser suite checks actual per-frame positions, including stationary lower
messages and the absence of a bounce when the transform is released.

## Coverage and verification

The browser motion suite interrupts popover exits, rapidly changes conversations, performs repeated
message jumps, scrolls with an open popover, resizes across responsive breakpoints, simulates a
background tab, and holds image decoding. Its visual matrix covers `390`, `768`, and `1280` pixels in
both normal and reduced-motion modes. After changing the motion system, run:

```powershell
npm run motion:check
npm run test:e2e:types
npm run test:e2e -- tests/e2e/motion.e2e.ts
```

## Adding motion

Before adding an animation, identify the state owner and the exact information the motion explains.
Prefer an existing variant or token. Add a focused regression for rapid reopen, virtualization,
reduced motion, or geometry whenever that boundary is involved. Validate the result in the Mock
browser at desktop and narrow widths; use native WebView validation for window-level motion.
