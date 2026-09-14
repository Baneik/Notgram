import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { clampImageTransform, fitImage, zoomImageAt, type ImageSize, type ImageTransform } from "../media/imageViewport";

export function useImageViewport(identity: string, dimensions: ImageSize) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const transform = useRef<ImageTransform>({ zoom: 1, x: 0, y: 0 });
  const geometry = useRef({ viewport: { width: 1, height: 1 }, image: { width: 1, height: 1 }, maxZoom: 4, actualZoom: 1 });
  const drag = useRef<{ id: number; x: number; y: number; origin: ImageTransform } | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const [zoom, setZoom] = useState(1);
  const [pixelRatio, setPixelRatio] = useState(1);

  const paint = useCallback(() => {
    const { image, viewport } = geometry.current;
    transform.current = clampImageTransform(transform.current, image, viewport);
    const { zoom: scale, x, y } = transform.current;
    if (surfaceRef.current) surfaceRef.current.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }, []);

  useLayoutEffect(() => {
    transform.current = { zoom: 1, x: 0, y: 0 };
    setZoom(1);
    drag.current = undefined;
    viewportRef.current?.classList.remove("is-dragging");
    paint();
  }, [identity, paint]);

  useLayoutEffect(() => {
    const viewportElement = viewportRef.current;
    if (!viewportElement) return;
    const measure = () => {
      const viewport = { width: Math.max(1, viewportElement.clientWidth - 32), height: Math.max(1, viewportElement.clientHeight - 32) };
      const image = fitImage(dimensions, viewport);
      const actualZoom = dimensions.width / image.width;
      geometry.current = { viewport, image, actualZoom, maxZoom: Math.max(4, Math.min(32, actualZoom * 2)) };
      if (surfaceRef.current) {
        surfaceRef.current.style.width = `${image.width}px`;
        surfaceRef.current.style.height = `${image.height}px`;
      }
      setPixelRatio(image.width / dimensions.width);
      paint();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewportElement);
    measure();
    return () => observer.disconnect();
  }, [dimensions.width, dimensions.height, paint]);

  useLayoutEffect(() => () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
  }, []);

  const zoomTo = (nextZoom: number, point?: { x: number; y: number }) => {
    const next = Math.max(1, Math.min(geometry.current.maxZoom, nextZoom));
    const bounds = viewportRef.current?.getBoundingClientRect();
    transform.current = zoomImageAt(transform.current, next, point && bounds
      ? { x: point.x - bounds.left - bounds.width / 2, y: point.y - bounds.top - bounds.height / 2 }
      : { x: 0, y: 0 });
    if (next === 1) transform.current = { zoom: 1, x: 0, y: 0 };
    paint();
    setZoom(next);
  };

  const finishDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = undefined;
    event.currentTarget.classList.remove("is-dragging");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    paint();
  };

  return {
    viewportRef, surfaceRef, zoom, percentage: Math.round(zoom * pixelRatio * 100),
    zoomBy: (factor: number, point?: { x: number; y: number }) => zoomTo(transform.current.zoom * factor, point),
    toggleActualSize: (point: { x: number; y: number }) => zoomTo(transform.current.zoom > 1 ? 1 : Math.max(2, geometry.current.actualZoom), point),
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || transform.current.zoom <= 1 || !(event.target instanceof Element) || !event.target.closest(".media-viewer-surface")) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: { ...transform.current } };
      event.currentTarget.classList.add("is-dragging");
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const current = drag.current;
      if (!current || current.id !== event.pointerId) return;
      transform.current = { zoom: current.origin.zoom, x: current.origin.x + event.clientX - current.x, y: current.origin.y + event.clientY - current.y };
      if (frame.current === undefined) frame.current = requestAnimationFrame(() => { frame.current = undefined; paint(); });
    },
    onPointerUp: finishDragging,
    onPointerCancel: finishDragging,
    onLostPointerCapture: finishDragging,
  };
}
