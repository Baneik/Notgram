import { describe, expect, it } from "vitest";
import { listMotionContentPosition } from "./useFlipListMotion";

describe("list motion content position", () => {
  it("does not treat scrolling as an item reorder", () => {
    const before = listMotionContentPosition(
      { left: 80, top: 100 },
      { left: 92, top: 340 },
      0,
      0,
    );
    const after = listMotionContentPosition(
      { left: 80, top: 100 },
      { left: 92, top: 140 },
      0,
      200,
    );

    expect(after).toEqual(before);
  });

  it("ignores container movement but preserves real item movement", () => {
    const before = listMotionContentPosition(
      { left: 80, top: 100 },
      { left: 92, top: 340 },
      0,
      0,
    );
    const movedWithContainer = listMotionContentPosition(
      { left: 120, top: 160 },
      { left: 132, top: 400 },
      0,
      0,
    );
    const reordered = listMotionContentPosition(
      { left: 120, top: 160 },
      { left: 132, top: 472 },
      0,
      0,
    );

    expect(movedWithContainer).toEqual(before);
    expect(reordered.top - before.top).toBe(72);
  });
});
