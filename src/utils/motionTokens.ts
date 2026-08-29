export const motionDuration = {
  contextMenu: 60,
  fast: 120,
  standard: 180,
  slow: 220,
  attention: 800,
  continuous: 900,
} as const;

// Message navigation uses one fixed timeline so short and long jumps feel
// like the same gesture even when the virtual list has to relocate first.
export const conversationJumpTiming = {
  accelerate: 180,
  decelerate: 300,
  relocationQuiet: 220,
  total: 480,
} as const;

export const motionEasing = {
  enter: "cubic-bezier(0.16, 1, 0.3, 1)",
  standard: "cubic-bezier(0.2, 0.75, 0.25, 1)",
  exit: "cubic-bezier(0.4, 0, 1, 1)",
} as const;

export const motionDistance = {
  near: 4,
  standard: 8,
} as const;

/** Presentation feedback timing. These delays never control network or store behavior. */
export const asyncFeedbackTiming = {
  showDelay: 140,
  minimumVisible: 320,
} as const;

/** Timers that exclusively coordinate presentation lifecycles. */
export const motionLifecycleTiming = {
  exitFallbackBuffer: 40,
  popoverHoverClose: 80,
  snapshotRelease: 90,
  historyScrollbarSettle: 120,
  popoverHoverOpen: 260,
  messageEntranceClaim: 1_000,
  transientIndicatorHold: 1_200,
  smoothScrollFallback: 1_440,
  snapshotMaximum: 1_500,
  desktopNotificationIdle: 10_000,
} as const;
