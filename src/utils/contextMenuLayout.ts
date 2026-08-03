export interface ContextMenuPoint {
  x: number;
  y: number;
}

export interface ContextMenuSize {
  width: number;
  height: number;
}

export interface ContextMenuViewport {
  width: number;
  height: number;
}

export interface ContextMenuLayout {
  x: number;
  y: number;
  submenuOffsetX: number;
  submenuOffsetY: number;
  submenuSide: "left" | "right";
}

export const CONTEXT_MENU_VIEWPORT_MARGIN = 8;
export const CONTEXT_MENU_GAP = 4;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(value, Math.max(minimum, maximum)));

export const calculateContextMenuLayout = (
  point: ContextMenuPoint,
  viewport: ContextMenuViewport,
  primary: ContextMenuSize,
  submenu?: ContextMenuSize,
): ContextMenuLayout => {
  const x = clamp(
    point.x,
    CONTEXT_MENU_VIEWPORT_MARGIN,
    viewport.width - primary.width - CONTEXT_MENU_VIEWPORT_MARGIN,
  );
  const y = clamp(
    point.y,
    CONTEXT_MENU_VIEWPORT_MARGIN,
    viewport.height - primary.height - CONTEXT_MENU_VIEWPORT_MARGIN,
  );

  if (!submenu) {
    return {
      x,
      y,
      submenuOffsetX: primary.width + CONTEXT_MENU_GAP,
      submenuOffsetY: 0,
      submenuSide: "right",
    };
  }

  const rightX = x + primary.width + CONTEXT_MENU_GAP;
  const leftX = x - CONTEXT_MENU_GAP - submenu.width;
  const rightFits = rightX + submenu.width <=
    viewport.width - CONTEXT_MENU_VIEWPORT_MARGIN;
  const leftFits = leftX >= CONTEXT_MENU_VIEWPORT_MARGIN;
  const submenuSide = rightFits || !leftFits ? "right" : "left";
  const preferredSubmenuX = submenuSide === "right" ? rightX : leftX;
  const submenuX = clamp(
    preferredSubmenuX,
    CONTEXT_MENU_VIEWPORT_MARGIN,
    viewport.width - submenu.width - CONTEXT_MENU_VIEWPORT_MARGIN,
  );
  const submenuY = clamp(
    y,
    CONTEXT_MENU_VIEWPORT_MARGIN,
    viewport.height - submenu.height - CONTEXT_MENU_VIEWPORT_MARGIN,
  );

  return {
    x,
    y,
    submenuOffsetX: submenuX - x,
    submenuOffsetY: submenuY - y,
    submenuSide,
  };
};

