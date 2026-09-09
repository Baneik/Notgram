import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from "react";

interface FolderDrag {
  pointerId: number;
  folderId: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  moved: boolean;
  horizontal: boolean;
  initialOrder: string[];
  order: string[];
}

interface FolderReorderOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  folderIds: string[];
  disabled: boolean;
  accountId: string;
  onReorder: (ids: string[]) => void;
}

const sameOrder = (left: string[], right: string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/** Owns one pointer session. The displayed order is also the order committed on release. */
export function useFolderReorder(options: FolderReorderOptions) {
  const { containerRef, folderIds, disabled, accountId } = options;
  const optionsRef = useRef(options);
  const dragRef = useRef<FolderDrag | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const scrollFrameRef = useRef<number | undefined>(undefined);
  const [preview, setPreview] = useState<{ folderId: string; order: string[] }>();

  const clearSession = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = undefined;
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = undefined;
    document.documentElement.classList.remove("is-reordering-folders");
    const container = containerRef.current;
    if (drag && container?.hasPointerCapture(drag.pointerId)) {
      container.releasePointerCapture(drag.pointerId);
    }
    return drag;
  }, [containerRef]);

  const cancel = useCallback(() => {
    const drag = clearSession();
    if (drag?.moved) suppressClickRef.current = true;
    setPreview(undefined);
  }, [clearSession]);

  useLayoutEffect(() => {
    const previousAccount = optionsRef.current.accountId;
    optionsRef.current = options;
    const drag = dragRef.current;
    if (drag && (disabled || accountId !== previousAccount || !sameOrder(folderIds, drag.initialOrder))) {
      cancel();
    }
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const inside = (x: number, y: number) => {
      const bounds = container.getBoundingClientRect();
      return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
    };

    const updatePreview = (drag: FolderDrag) => {
      if (!inside(drag.x, drag.y)) return;
      const bounds = container.getBoundingClientRect();
      const scale = drag.horizontal ? bounds.width / container.offsetWidth : bounds.height / container.offsetHeight;
      const position = drag.horizontal
        ? (drag.x - bounds.left) / scale + container.scrollLeft
        : (drag.y - bounds.top) / scale + container.scrollTop;
      // Layout offsets exclude FLIP transforms. Animated buttons must never be hit-test targets.
      const centers = [...container.querySelectorAll<HTMLElement>("[data-folder-id]")].map((button) =>
        drag.horizontal ? button.offsetLeft + button.offsetWidth / 2 : button.offsetTop + button.offsetHeight / 2,
      );
      const from = drag.order.indexOf(drag.folderId);
      let to = from;
      while (to > 0 && position < centers[to - 1]) to -= 1;
      while (to < centers.length - 1 && position > centers[to + 1]) to += 1;
      if (to === from) return;
      const order = [...drag.order];
      order.splice(from, 1);
      order.splice(to, 0, drag.folderId);
      drag.order = order;
      setPreview({ folderId: drag.folderId, order });
    };

    const scrollVelocity = (drag: FolderDrag) => {
      if (!inside(drag.x, drag.y)) return 0;
      const bounds = container.getBoundingClientRect();
      const position = drag.horizontal ? drag.x : drag.y;
      const start = drag.horizontal ? bounds.left : bounds.top;
      const end = drag.horizontal ? bounds.right : bounds.bottom;
      const edge = Math.min(24, (end - start) / 4);
      const offset = drag.horizontal ? container.scrollLeft : container.scrollTop;
      const maximum = drag.horizontal
        ? container.scrollWidth - container.clientWidth
        : container.scrollHeight - container.clientHeight;
      if (position < start + edge && offset > 0) return -Math.min(1, (start + edge - position) / edge);
      if (position > end - edge && offset < maximum - 1) return Math.min(1, (position - end + edge) / edge);
      return 0;
    };

    let previousScrollTime = 0;
    const scroll = (time: number) => {
      scrollFrameRef.current = undefined;
      const drag = dragRef.current;
      if (!drag?.moved) return;
      const velocity = scrollVelocity(drag);
      if (!velocity) return;
      const delta = velocity * Math.min(32, time - previousScrollTime) * 0.6;
      previousScrollTime = time;
      if (drag.horizontal) container.scrollLeft += delta;
      else container.scrollTop += delta;
      updatePreview(drag);
      scrollFrameRef.current = requestAnimationFrame(scroll);
    };

    const move = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (event.buttons === 0) { cancel(); return; }
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (!drag.moved) {
        if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 6) return;
        drag.moved = true;
        suppressClickRef.current = true;
        // Capture on the stable container; moving a captured button in the DOM loses capture.
        container.setPointerCapture(drag.pointerId);
        document.documentElement.classList.add("is-reordering-folders");
        setPreview({ folderId: drag.folderId, order: drag.order });
      }
      event.preventDefault();
      updatePreview(drag);
      if (scrollFrameRef.current === undefined && scrollVelocity(drag)) {
        previousScrollTime = performance.now();
        scrollFrameRef.current = requestAnimationFrame(scroll);
      }
    };

    const finish = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const commit = drag.moved && inside(event.clientX, event.clientY) && !sameOrder(drag.initialOrder, drag.order);
      clearSession();
      setPreview(undefined);
      if (!drag.moved) return;
      event.preventDefault();
      if (commit) optionsRef.current.onReorder(drag.order);
    };
    const cancelPointer = (event: globalThis.PointerEvent) => {
      if (event.pointerId === dragRef.current?.pointerId) cancel();
    };
    const lostCapture = (event: globalThis.PointerEvent) => {
      // Touch starts with implicit capture on the button. Its release bubbles when
      // capture transfers to our container, but does not cancel the drag session.
      if (event.target === container) cancelPointer(event);
    };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && dragRef.current) {
        event.preventDefault();
        cancel();
      }
    };
    const visibility = () => { if (document.hidden) cancel(); };
    const pointerdown = () => { suppressClickRef.current = false; };
    document.addEventListener("pointerdown", pointerdown, true);
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", cancelPointer);
    container.addEventListener("lostpointercapture", lostCapture);
    document.addEventListener("keydown", keydown);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    return () => {
      clearSession();
      document.removeEventListener("pointerdown", pointerdown, true);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", cancelPointer);
      container.removeEventListener("lostpointercapture", lostCapture);
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
    };
  }, [containerRef, cancel, clearSession]);

  const begin = useCallback((event: PointerEvent<HTMLButtonElement>, folderId: string) => {
    const current = optionsRef.current;
    if (!event.isPrimary || event.button !== 0 || current.disabled || current.folderIds.length < 2 || dragRef.current) return;
    dragRef.current = {
      pointerId: event.pointerId, folderId,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      horizontal: window.matchMedia("(max-width: 720px)").matches, moved: false,
      initialOrder: current.folderIds, order: current.folderIds,
    };
  }, []);

  const suppressClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current || event.detail === 0) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return { preview, begin, cancel, suppressClick };
}
