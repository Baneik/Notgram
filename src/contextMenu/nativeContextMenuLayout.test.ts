import { describe, expect, it } from "vitest";
import { calculateNativeContextMenuGeometry } from "./nativeContextMenuLayout";

interface TestMenuItem {
  id: string;
  label: string;
  children?: TestMenuItem[];
}

const item = (id: string, label: string, children?: TestMenuItem[]): TestMenuItem => ({
  id,
  label,
  children,
});

const measureLabel = (label: string) => Array.from(label).length * 14;

describe("native context menu layout", () => {
  it("sizes a flush five-row panel without blank space or scrolling", () => {
    const geometry = calculateNativeContextMenuGeometry(
      ["回复", "转发", "复制", "编辑", "删除"].map((label, index) =>
        item(String(index), label)),
      undefined,
      measureLabel,
    );

    expect(geometry.primaryPanelWidth).toBe(120);
    expect(geometry.width).toBe(144);
    expect(geometry.height).toBe(236);
    expect(geometry.expandedWidth).toBe(144);
  });

  it("reserves space for a submenu to expand to the right", () => {
    const children = Array.from({ length: 7 }, (_, index) =>
      item(`child-${index}`, `子项${index + 1}`));
    const items = [
      item("pin", "置顶"),
      item("folders", "分组", children),
      ...Array.from({ length: 5 }, (_, index) => item(`action-${index}`, `操作${index + 1}`)),
      item("window", "在窗口中播放"),
    ];
    const collapsed = calculateNativeContextMenuGeometry(items, undefined, measureLabel);
    const expanded = calculateNativeContextMenuGeometry(items, "folders", measureLabel);

    expect(collapsed.primaryPanelWidth).toBe(170);
    expect(collapsed.submenuPanelWidth).toBe(128);
    expect(collapsed.width).toBe(194);
    expect(collapsed.height).toBe(362);
    expect(collapsed.expandedWidth).toBe(328);
    expect(collapsed.maximumExpandedHeight).toBe(362);
    expect(expanded.height).toBe(362);
    expect(expanded.submenuOffsetX).toBe(188);
    expect(expanded.submenuOffsetY).toBe(42);
  });

  it("caps a long submenu at five visible rows", () => {
    const children = Array.from({ length: 10 }, (_, index) =>
      item(`child-${index}`, `会话${index + 1}`));
    const geometry = calculateNativeContextMenuGeometry(
      [item("reply", "回复"), item("forward", "转发", children), item("copy", "复制")],
      "forward",
      measureLabel,
    );

    expect(geometry.height).toBe(278);
    expect(geometry.maximumExpandedHeight).toBe(278);
  });
});
