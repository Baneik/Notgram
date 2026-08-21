export interface BottomReconcileState {
  remainingFrames: number;
  stableFrames: number;
  previousSignature: string;
}

export interface BottomReconcileStep {
  state: BottomReconcileState;
  settled: boolean;
}

export interface BottomReconcileRestart {
  state: BottomReconcileState;
  verificationPassCount: number;
}

export type LatestScrollMode = "near" | "far";

export const latestScrollMode = (
  distanceFromBottom: number,
  viewportHeight: number,
): LatestScrollMode => distanceFromBottom <= Math.max(160, viewportHeight * 1.25)
  ? "near"
  : "far";

export const latestScrollProgress = (elapsed: number) => {
  const progress = Math.min(1, Math.max(0, elapsed));
  return 1 - (1 - progress) ** 3;
};

export const startBottomReconcile = (maxFrames: number): BottomReconcileState => ({
  remainingFrames: Math.max(1, maxFrames),
  stableFrames: 0,
  previousSignature: "",
});

/** Wait for stable geometry so bottom following performs one final scroll commit. */
export const advanceBottomReconcile = (
  current: BottomReconcileState,
  signature: string,
  stableFrameCount: number,
): BottomReconcileStep => {
  const stableFrames = signature === current.previousSignature
    ? current.stableFrames + 1
    : 0;
  const state: BottomReconcileState = {
    remainingFrames: current.remainingFrames - 1,
    stableFrames,
    previousSignature: signature,
  };
  return {
    state,
    settled: stableFrames >= stableFrameCount || state.remainingFrames <= 0,
  };
};

/** A final scroll write can change virtual-list geometry, so verify it in a bounded new pass. */
export const restartBottomReconcileAfterWrite = (
  wrote: boolean,
  verificationPassCount: number,
  maxVerificationPasses: number,
  maxFrames: number,
): BottomReconcileRestart | undefined => {
  if (!wrote || verificationPassCount >= maxVerificationPasses) return undefined;
  return {
    state: startBottomReconcile(maxFrames),
    verificationPassCount: verificationPassCount + 1,
  };
};
