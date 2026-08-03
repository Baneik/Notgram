import { useEffect, type RefObject } from "react";

export function useContextMenuDismiss(
  menuRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
) {
  useEffect(() => {
    const dismissOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !menuRef.current?.contains(target)) onDismiss();
    };

    document.addEventListener("pointerdown", dismissOutside, true);
    window.addEventListener("wheel", dismissOutside, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      window.removeEventListener("wheel", dismissOutside, true);
    };
  }, [menuRef, onDismiss]);
}
