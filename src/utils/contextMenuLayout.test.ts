import { describe, expect, it } from "vitest";
import { calculateContextMenuLayout } from "./contextMenuLayout";

describe("context menu layout", () => {
  it("keeps the primary menu anchored when a tall submenu opens near the bottom", () => {
    const point = { x: 426, y: 390 };
    const viewport = { width: 760, height: 420 };
    const primary = { width: 204, height: 136 };
    const initial = calculateContextMenuLayout(point, viewport, primary);
    const nested = calculateContextMenuLayout(
      point,
      viewport,
      primary,
      { width: 190, height: 360 },
    );

    expect({ x: nested.x, y: nested.y }).toEqual({ x: initial.x, y: initial.y });
    const submenuY = nested.y + nested.submenuOffsetY;
    expect(submenuY).toBeGreaterThanOrEqual(8);
    expect(submenuY + 360).toBeLessThanOrEqual(412);
  });

  it("opens a submenu to the left when the right edge has no room", () => {
    const layout = calculateContextMenuLayout(
      { x: 426, y: 200 },
      { width: 760, height: 600 },
      { width: 204, height: 136 },
      { width: 190, height: 240 },
    );

    expect(layout.submenuSide).toBe("left");
    expect(layout.submenuOffsetX).toBe(-194);
  });

  it("keeps oversized submenu coordinates inside the viewport margins", () => {
    const layout = calculateContextMenuLayout(
      { x: 8, y: 8 },
      { width: 360, height: 240 },
      { width: 204, height: 136 },
      { width: 344, height: 224 },
    );

    expect(layout.x + layout.submenuOffsetX).toBe(8);
    expect(layout.y + layout.submenuOffsetY).toBe(8);
  });
});
