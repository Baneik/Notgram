export const motionDuration = {
  contextMenu: 60,
  fast: 120,
  standard: 180,
  slow: 220,
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
