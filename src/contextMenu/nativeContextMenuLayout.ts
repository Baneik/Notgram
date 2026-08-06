export const NATIVE_CONTEXT_MENU_ROW_HEIGHT = 42;
export const NATIVE_CONTEXT_MENU_PANEL_OFFSET = 0;
export const NATIVE_CONTEXT_MENU_WINDOW_INSET = 12;
export const NATIVE_CONTEXT_MENU_PANEL_GAP = 6;
export const NATIVE_CONTEXT_MENU_MIN_PANEL_WIDTH = 120;
export const NATIVE_CONTEXT_MENU_MAX_PANEL_WIDTH = 204;

const NATIVE_CONTEXT_MENU_ITEM_CHROME_WIDTH = 56;
const NATIVE_CONTEXT_MENU_SUBMENU_INDICATOR_WIDTH = 16;
const NATIVE_CONTEXT_MENU_EXTRA_WIDTH = 30;
const NATIVE_CONTEXT_MENU_FONT = '14px "Segoe UI", "Microsoft YaHei UI", Arial, sans-serif';

let measurementContext: CanvasRenderingContext2D | null | undefined;

const fallbackLabelWidth = (label: string) => Array.from(label).reduce(
  (width, character) => width + (/^[\x00-\xff]$/.test(character) ? 7.5 : 14),
  0,
);

export const measureNativeContextMenuLabel = (label: string) => {
  if (typeof document === "undefined") return fallbackLabelWidth(label);
  if (measurementContext === undefined) {
    measurementContext = document.createElement("canvas").getContext("2d");
    if (measurementContext) measurementContext.font = NATIVE_CONTEXT_MENU_FONT;
  }
  return measurementContext?.measureText(label).width ?? fallbackLabelWidth(label);
};

const windowHeightForRows = (rowCount: number) =>
  26 + Math.max(1, rowCount) * NATIVE_CONTEXT_MENU_ROW_HEIGHT;

export interface NativeContextMenuGeometry {
  width: number;
  height: number;
  expandedWidth: number;
  maximumExpandedHeight: number;
  primaryPanelWidth: number;
  submenuPanelWidth: number;
  submenuOffsetX: number;
  submenuOffsetY: number;
}

interface NativeContextMenuLayoutItem {
  id: string;
  label: string;
  children?: NativeContextMenuLayoutItem[];
}

type MeasureLabel = (label: string) => number;

const panelWidthFor = (
  items: NativeContextMenuLayoutItem[],
  measureLabel: MeasureLabel,
) => {
  const desiredWidth = items.reduce((maximum, item) => Math.max(
    maximum,
    measureLabel(item.label) +
      NATIVE_CONTEXT_MENU_ITEM_CHROME_WIDTH +
      (item.children?.length ? NATIVE_CONTEXT_MENU_SUBMENU_INDICATOR_WIDTH : 0) +
      NATIVE_CONTEXT_MENU_EXTRA_WIDTH,
  ), 0);
  return Math.ceil(Math.min(
    NATIVE_CONTEXT_MENU_MAX_PANEL_WIDTH,
    Math.max(NATIVE_CONTEXT_MENU_MIN_PANEL_WIDTH, desiredWidth),
  ));
};

export const calculateNativeContextMenuGeometry = (
  items: NativeContextMenuLayoutItem[],
  expandedId?: string,
  measureLabel: MeasureLabel = measureNativeContextMenuLabel,
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
  const primaryPanelWidth = panelWidthFor(items, measureLabel);
  const expandedChildren = expandedIndex >= 0 ? items[expandedIndex].children ?? [] : undefined;
  const submenuPanelWidth = expandedChildren
    ? panelWidthFor(expandedChildren, measureLabel)
    : items.reduce((maximum, item) => item.children?.length
      ? Math.max(maximum, panelWidthFor(item.children, measureLabel))
      : maximum, NATIVE_CONTEXT_MENU_MIN_PANEL_WIDTH);
  const width = NATIVE_CONTEXT_MENU_WINDOW_INSET * 2 + primaryPanelWidth;
  const expandedWidth = hasSubmenu
    ? NATIVE_CONTEXT_MENU_WINDOW_INSET * 2 + primaryPanelWidth +
      NATIVE_CONTEXT_MENU_PANEL_GAP + submenuPanelWidth
    : width;

  return {
    width,
    height: windowHeightForRows(expandedRows),
    expandedWidth,
    maximumExpandedHeight: windowHeightForRows(maximumExpandedRows),
    primaryPanelWidth,
    submenuPanelWidth,
    submenuOffsetX: NATIVE_CONTEXT_MENU_WINDOW_INSET + primaryPanelWidth +
      NATIVE_CONTEXT_MENU_PANEL_GAP,
    submenuOffsetY: NATIVE_CONTEXT_MENU_PANEL_OFFSET
      + Math.max(0, expandedIndex) * NATIVE_CONTEXT_MENU_ROW_HEIGHT,
  };
};
