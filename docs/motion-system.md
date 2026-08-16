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
| Content navigation | Explicit jumps to a distant message | Snapshot-assisted WAAPI motion from `conversationJumpMotion` |
| Continuous feedback | Loading, animated media, audio spectrum | Only while active and when reduced motion is disabled |
| Async feedback | Loading, pending actions, image decode | Delayed visibility and a bounded minimum visible time |

Normal conversation switches, scroll restoration, composer resizing, and virtual-list measurement
are not presentation animations. They must remain under their existing single-owner coordinators.

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
until `HTMLImageElement.decode()` completes.

The document visibility policy pauses continuous work when the application is backgrounded. CSS
loops are paused through `motion-background-paused`; audio spectrum, autoplay media, stickers, and
performance sampling stop scheduling frames and resume from current state when visible again.

## Invariants

1. Animate `opacity` and `transform`; do not animate layout dimensions or virtual-list position.
2. A scroll position has one writer. Animation code may request a semantic destination but cannot
   compete with `useConversationScroll`.
3. Conversation switches do not use cloned page snapshots or smooth scrolling. Only explicit,
   distant message jumps may use the bounded directional snapshot.
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
