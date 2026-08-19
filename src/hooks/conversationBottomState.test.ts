import { describe, expect, it } from "vitest";
import {
  advanceBottomReconcile,
  latestScrollMode,
  latestScrollProgress,
  startBottomReconcile,
} from "./conversationBottomState";

describe("conversation bottom reconcile state", () => {
  it("settles after a quiet geometry window", () => {
    let state = startBottomReconcile(8);
    let step = advanceBottomReconcile(state, "1200:800:400", 2);
    expect(step.settled).toBe(false);
    state = step.state;
    step = advanceBottomReconcile(state, "1200:800:400", 2);
    expect(step.settled).toBe(false);
    state = step.state;
    step = advanceBottomReconcile(state, "1200:800:400", 2);
    expect(step.settled).toBe(true);
  });

  it("does not restart the quiet window when observers notify again", () => {
    let state = startBottomReconcile(8);
    state = advanceBottomReconcile(state, "1200:800:400", 2).state;
    state = advanceBottomReconcile(state, "1200:800:400", 2).state;
    expect(advanceBottomReconcile(state, "1200:800:400", 2).settled).toBe(true);
  });

  it("resets stability only when geometry changes", () => {
    let state = startBottomReconcile(8);
    state = advanceBottomReconcile(state, "1200:800:400", 2).state;
    state = advanceBottomReconcile(state, "1200:800:400", 2).state;
    const step = advanceBottomReconcile(state, "1240:800:440", 2);
    expect(step.state.stableFrames).toBe(0);
    expect(step.settled).toBe(false);
  });

  it("uses one smooth phase near the bottom and two phases for distant content", () => {
    expect(latestScrollMode(300, 600)).toBe("near");
    expect(latestScrollMode(751, 600)).toBe("far");
    expect(latestScrollMode(159, 0)).toBe("near");
    expect(latestScrollMode(161, 0)).toBe("far");
  });

  it("eases scroll progress without leaving its normalized range", () => {
    expect(latestScrollProgress(-1)).toBe(0);
    expect(latestScrollProgress(0.5)).toBe(0.875);
    expect(latestScrollProgress(2)).toBe(1);
  });
});
