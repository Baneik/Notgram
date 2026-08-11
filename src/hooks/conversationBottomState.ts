export interface BottomReconcileState {
  remainingFrames: number;
  stableFrames: number;
  previousSignature: string;
}

export interface BottomReconcileStep {
  state: BottomReconcileState;
  settled: boolean;
}

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
