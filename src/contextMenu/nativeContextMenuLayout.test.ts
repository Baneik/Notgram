import { describe, expect, it } from "vitest";
import { calculateNativeContextMenuGeometry } from "./nativeContextMenuLayout";

interface TestMenuItem {
  id: string;
  children?: TestMenuItem[];
}

const item = (id: string, children?: TestMenuItem[]): TestMenuItem => ({
  id,
  children,
});

describe("native context menu layout", () => {
  it("sizes a flush five-row panel without blank space or scrolling", () => {
    const geometry = calculateNativeContextMenuGeometry(
      Array.from({ length: 5 }, (_, index) => item(String(index))),
    );

    expect(geometry.width).toBe(216);
    expect(geometry.height).toBe(224);
    expect(geometry.expandedWidth).toBe(216);
  });

  it("reserves space for a submenu to expand to the right", () => {
    const children = Array.from({ length: 7 }, (_, index) => item(`child-${index}`));
    const items = [item("pin"), item("folders", children), ...Array.from(
      { length: 6 },
      (_, index) => item(`action-${index}`),
    )];
    const collapsed = calculateNativeContextMenuGeometry(items);
    const expanded = calculateNativeContextMenuGeometry(items, "folders");

    expect(collapsed.height).toBe(350);
    expect(collapsed.expandedWidth).toBe(426);
    expect(collapsed.maximumExpandedHeight).toBe(350);
    expect(expanded.height).toBe(350);
    expect(expanded.submenuOffsetY).toBe(42);
  });
});
