export interface ImageSize { width: number; height: number }
export interface ImageTransform { zoom: number; x: number; y: number }

export const fitImage = (image: ImageSize, viewport: ImageSize): ImageSize => {
  const ratio = Math.min(viewport.width / Math.max(1, image.width), viewport.height / Math.max(1, image.height), 1);
  return { width: Math.max(1, image.width * ratio), height: Math.max(1, image.height * ratio) };
};

export const clampImageTransform = (transform: ImageTransform, image: ImageSize, viewport: ImageSize, center = { x: 0, y: 0 }): ImageTransform => {
  const maxX = Math.max(0, (image.width * transform.zoom - viewport.width) / 2);
  const maxY = Math.max(0, (image.height * transform.zoom - viewport.height) / 2);
  // Preserve the fitted center above the controls when zooming. Its offset is
  // part of the pan range, so a zoom need not jump to cover a screen edge.
  const clamp = (value: number, limit: number, offset: number) => limit ? Math.max(-limit - Math.abs(offset), Math.min(limit + Math.abs(offset), value)) : 0;
  return { zoom: transform.zoom, x: clamp(transform.x, maxX, center.x), y: clamp(transform.y, maxY, center.y) };
};

export const zoomImageAt = (transform: ImageTransform, zoom: number, point: { x: number; y: number }): ImageTransform => {
  const ratio = zoom / transform.zoom;
  return { zoom, x: point.x - (point.x - transform.x) * ratio, y: point.y - (point.y - transform.y) * ratio };
};
