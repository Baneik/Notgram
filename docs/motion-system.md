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

Normal conversation switches, scroll restoration, composer resizing, and virtual-list measurement
are not presentation animations. They must remain under their existing single-owner coordinators.

## Shared tokens

CSS tokens live at the top of `src/styles/global.css`; WAAPI and React fallback values live in
`src/utils/motionTokens.ts`. Keep the duration and easing values aligned when changing the scale.

- `60ms`: native/context-menu acknowledgement.
- `120ms`: small popovers and fast feedback.
- `180ms`: standard state transition and exit fallback.
- `220ms`: large surface entrance.
- Enter easing decelerates into place; exit easing accelerates away.
- Standard travel is `8px`; near travel is `4px`.

## Presence contract

Use `MotionPresence` when a component needs an exit animation. Pass `null` when `present` is false;
the component retains the last child until the root exit animation ends. Choose the variant by
relationship, not visual preference:

- `modal`: centered task surface with a backdrop.
- `drawer`: contextual detail surface with a backdrop.
- `toast`: non-blocking status or error notice.
- `popover`: anchored menu, picker, or suggestion panel.

Exiting content is inert and hidden from the accessibility tree. Exit completion listens to the root
animation and retains a cancelable timer only as a fallback. Do not add a second unmount delay in the
calling component.

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

## Adding motion

Before adding an animation, identify the state owner and the exact information the motion explains.
Prefer an existing variant or token. Add a focused regression for rapid reopen, virtualization,
reduced motion, or geometry whenever that boundary is involved. Validate the result in the Mock
browser at desktop and narrow widths; use native WebView validation for window-level motion.
