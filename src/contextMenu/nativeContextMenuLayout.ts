export const NATIVE_CONTEXT_MENU_WIDTH = 216;
export const NATIVE_CONTEXT_MENU_EXPANDED_WIDTH = 426;
export const NATIVE_CONTEXT_MENU_ROW_HEIGHT = 42;
export const NATIVE_CONTEXT_MENU_PANEL_OFFSET = 6;

const windowHeightForRows = (rowCount: number) =>
  22 + Math.max(1, rowCount) * NATIVE_CONTEXT_MENU_ROW_HEIGHT;

export interface NativeContextMenuGeometry {
  width: number;
  height: number;
  expandedWidth: number;
  maximumExpandedHeight: number;
  submenuOffsetY: number;
}

interface NativeContextMenuLayoutItem {
  id: string;
  children?: NativeContextMenuLayoutItem[];
}

export const calculateNativeContextMenuGeometry = (
  items: NativeContextMenuLayoutItem[],
  expandedId?: string,
): NativeContextMenuGeometry => {
  const primaryRows = Math.max(1, items.length);
  const expandedIndex = items.findIndex((item) => item.id === expandedId && item.children?.length);
  const expandedRows = expandedIndex >= 0
    ? Math.max(primaryRows, expandedIndex + (items[expandedIndex].children?.length ?? 0))
    : primaryRows;
  const maximumExpandedRows = items.reduce(
    (maximum, item, index) => Math.max(maximum, index + (item.children?.length ?? 0)),
    primaryRows,
  );
  const hasSubmenu = items.some((item) => item.children?.length);

  return {
    width: NATIVE_CONTEXT_MENU_WIDTH,
    height: windowHeightForRows(expandedRows),
    expandedWidth: hasSubmenu
      ? NATIVE_CONTEXT_MENU_EXPANDED_WIDTH
      : NATIVE_CONTEXT_MENU_WIDTH,
    maximumExpandedHeight: windowHeightForRows(maximumExpandedRows),
    submenuOffsetY: NATIVE_CONTEXT_MENU_PANEL_OFFSET
      + Math.max(0, expandedIndex) * NATIVE_CONTEXT_MENU_ROW_HEIGHT,
  };
};
