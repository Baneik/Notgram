import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { focusFirstMenuButton, handleMenuKeyboard } from "../utils/menuKeyboard";
import {
  calculateContextMenuLayout,
  type ContextMenuLayout,
  type ContextMenuPoint,
} from "../utils/contextMenuLayout";

export type { ContextMenuPoint } from "../utils/contextMenuLayout";

interface ContextMenuSurfaceProps {
  label: string;
  point: ContextMenuPoint;
  children: ReactNode;
  className?: string;
  restoreFocus?: () => void;
  onClose: () => void;
}

interface ContextMenuPanelProps extends HTMLAttributes<HTMLDivElement> {
  submenu?: boolean;
}

export function ContextMenuPanel({
  submenu = false,
  className = "",
  ...props
}: ContextMenuPanelProps) {
  return (
    <div
      {...props}
      className={`context-menu-panel ${submenu ? "context-menu-submenu" : ""} ${className}`.trim()}
      data-context-menu-primary={submenu ? undefined : "true"}
      data-context-menu-submenu={submenu ? "true" : undefined}
    />
  );
}

export function ContextMenuSurface({
  label,
  point,
  children,
  className = "",
  restoreFocus,
  onClose,
}: ContextMenuSurfaceProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<ContextMenuLayout>({
    x: point.x,
    y: point.y,
    submenuOffsetX: 0,
    submenuOffsetY: 0,
    submenuSide: "right",
  });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const primary = menu.querySelector<HTMLElement>("[data-context-menu-primary]");
    if (!primary) return;
    const submenu = menu.querySelector<HTMLElement>("[data-context-menu-submenu]");
    const next = calculateContextMenuLayout(
      point,
      { width: window.innerWidth, height: window.innerHeight },
      { width: primary.offsetWidth, height: primary.offsetHeight },
      submenu ? { width: submenu.offsetWidth, height: submenu.offsetHeight } : undefined,
    );
    setLayout((current) =>
      current.x === next.x &&
        current.y === next.y &&
        current.submenuOffsetX === next.submenuOffsetX &&
        current.submenuOffsetY === next.submenuOffsetY &&
        current.submenuSide === next.submenuSide
        ? current
        : next
    );
  });

  useEffect(() => {
    const timer = globalThis.setTimeout(() => {
      if (!focusFirstMenuButton(menuRef.current)) menuRef.current?.focus();
    }, 0);
    const closeOutside = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeForViewportChange = () => onClose();
    document.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("blur", closeForViewportChange);
    window.addEventListener("resize", closeForViewportChange);
    return () => {
      globalThis.clearTimeout(timer);
      document.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("blur", closeForViewportChange);
      window.removeEventListener("resize", closeForViewportChange);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className={`context-menu-surface ${className}`}
      style={{
        left: layout.x,
        top: layout.y,
        "--context-submenu-x": `${layout.submenuOffsetX}px`,
        "--context-submenu-y": `${layout.submenuOffsetY}px`,
      } as CSSProperties}
      data-context-submenu-side={layout.submenuSide}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const restore = event.key === "Escape";
        handleMenuKeyboard(event, onClose);
        if (restore) globalThis.setTimeout(() => restoreFocus?.(), 0);
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
