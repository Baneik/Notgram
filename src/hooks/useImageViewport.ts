import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { clampImageTransform, fitImage, zoomImageAt, type ImageSize, type ImageTransform } from "../media/imageViewport";

export function useImageViewport(identity: string, dimensions: ImageSize) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const transform = useRef<ImageTransform>({ zoom: 1, x: 0, y: 0 });
  const geometry = useRef({ viewport: { width: 1, height: 1 }, image: { width: 1, height: 1 }, center: { x: 0, y: 0 }, maxZoom: 4, actualZoom: 1 });
  const drag = useRef<{ id: number; x: number; y: number; origin: ImageTransform } | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const [zoom, setZoom] = useState(1);
  const [pixelRatio, setPixelRatio] = useState(1);

  const paint = useCallback(() => {
    const { image, viewport, center } = geometry.current;
    transform.current = clampImageTransform(transform.current, image, viewport, center);
    const { zoom: scale, x, y } = transform.current;
    if (surfaceRef.current) surfaceRef.current.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }, []);

  const schedulePaint = () => {
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      paint();
      setZoom(transform.current.zoom);
    });
  };

  useLayoutEffect(() => {
    transform.current = { zoom: 1, x: 0, y: 0 };
    setZoom(1);
    drag.current = undefined;
    viewportRef.current?.classList.remove("is-dragging");
    paint();
  }, [identity, paint]);

  useLayoutEffect(() => {
    const viewportElement = viewportRef.current;
    const fitElement = fitRef.current;
    if (!viewportElement || !fitElement) return;
    const measure = () => {
      const bounds = viewportElement.getBoundingClientRect();
      const fit = fitElement.getBoundingClientRect();
      const viewport = { width: bounds.width, height: bounds.height };
      const center = { x: fit.left + fit.width / 2 - bounds.left - bounds.width / 2, y: fit.top + fit.height / 2 - bounds.top - bounds.height / 2 };
      // Fit above the controls; enlarged pixels and pan bounds use the entire screen.
      const image = fitImage(dimensions, { width: Math.max(1, fit.width - 112), height: Math.max(1, fit.height - 32) });
      const actualZoom = dimensions.width / image.width;
      geometry.current = { viewport, image, center, actualZoom, maxZoom: Math.max(4, Math.min(32, actualZoom * 2)) };
      if (surfaceRef.current) {
        surfaceRef.current.style.left = `${viewport.width / 2 + center.x}px`;
        surfaceRef.current.style.top = `${viewport.height / 2 + center.y}px`;
        surfaceRef.current.style.width = `${image.width}px`;
        surfaceRef.current.style.height = `${image.height}px`;
      }
      setPixelRatio(image.width / dimensions.width);
      paint();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewportElement); observer.observe(fitElement);
    measure();
    return () => observer.disconnect();
  }, [identity, dimensions.width, dimensions.height, paint]);

  useLayoutEffect(() => () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
  }, []);

  const zoomTo = (nextZoom: number, point?: { x: number; y: number }) => {
    const next = Math.max(1, Math.min(geometry.current.maxZoom, nextZoom));
    const bounds = viewportRef.current?.getBoundingClientRect();
    transform.current = zoomImageAt(transform.current, next, point && bounds
      ? { x: point.x - bounds.left - bounds.width / 2 - geometry.current.center.x, y: point.y - bounds.top - bounds.height / 2 - geometry.current.center.y }
      : { x: 0, y: 0 });
    if (next === 1) transform.current = { zoom: 1, x: 0, y: 0 };
    // Keep every input delta in the model, but avoid a style write and forced
    // layout read for each wheel event delivered within the same frame.
    transform.current = clampImageTransform(transform.current, geometry.current.image, geometry.current.viewport, geometry.current.center);
    schedulePaint();
  };

  const finishDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = undefined;
    event.currentTarget.classList.remove("is-dragging");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    paint();
  };

  return {
    viewportRef, fitRef, surfaceRef, zoom, percentage: Math.round(zoom * pixelRatio * 100),
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
      schedulePaint();
    },
    onPointerUp: finishDragging,
    onPointerCancel: finishDragging,
    onLostPointerCapture: finishDragging,
  };
}
