import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { focusFirstMenuButton, handleMenuKeyboard } from "../utils/menuKeyboard";

export interface ContextMenuPoint {
  x: number;
  y: number;
}

interface ContextMenuSurfaceProps {
  label: string;
  point: ContextMenuPoint;
  children: ReactNode;
  className?: string;
  restoreFocus?: () => void;
  onClose: () => void;
}

const VIEWPORT_MARGIN = 8;

export function ContextMenuSurface({
  label,
  point,
  children,
  className = "",
  restoreFocus,
  onClose,
}: ContextMenuSurfaceProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(point);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    const next = {
      x: Math.max(
        VIEWPORT_MARGIN,
        Math.min(point.x, window.innerWidth - bounds.width - VIEWPORT_MARGIN),
      ),
      y: Math.max(
        VIEWPORT_MARGIN,
        Math.min(point.y, window.innerHeight - bounds.height - VIEWPORT_MARGIN),
      ),
    };
    setPosition((current) => current.x === next.x && current.y === next.y ? current : next);
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
      style={{ left: position.x, top: position.y }}
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
