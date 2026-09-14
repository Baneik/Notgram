export interface ImageSize { width: number; height: number }
export interface ImageTransform { zoom: number; x: number; y: number }

export const fitImage = (image: ImageSize, viewport: ImageSize): ImageSize => {
  const ratio = Math.min(viewport.width / Math.max(1, image.width), viewport.height / Math.max(1, image.height), 1);
  return { width: Math.max(1, image.width * ratio), height: Math.max(1, image.height * ratio) };
};

export const clampImageTransform = (transform: ImageTransform, image: ImageSize, viewport: ImageSize): ImageTransform => {
  const maxX = Math.max(0, (image.width * transform.zoom - viewport.width) / 2);
  const maxY = Math.max(0, (image.height * transform.zoom - viewport.height) / 2);
  return { zoom: transform.zoom, x: maxX ? Math.max(-maxX, Math.min(maxX, transform.x)) : 0, y: maxY ? Math.max(-maxY, Math.min(maxY, transform.y)) : 0 };
};

export const zoomImageAt = (transform: ImageTransform, zoom: number, point: { x: number; y: number }): ImageTransform => {
  const ratio = zoom / transform.zoom;
  return { zoom, x: point.x - (point.x - transform.x) * ratio, y: point.y - (point.y - transform.y) * ratio };
};

export interface WheelNavigation { distance: number; direction: number; lastEvent: number; lastNavigation: number }
export const emptyWheelNavigation = (): WheelNavigation => ({ distance: 0, direction: 0, lastEvent: -Infinity, lastNavigation: -Infinity });

/** A touchpad gesture must accumulate intent; its momentum cannot race through the album. */
export const navigateImageWheel = (state: WheelNavigation, delta: number, now: number): -1 | 1 | undefined => {
  if (!Number.isFinite(delta) || delta === 0) return undefined;
  const direction = Math.sign(delta);
  if (now - state.lastEvent > 180 || direction !== state.direction) state.distance = 0;
  state.direction = direction;
  state.lastEvent = now;
  if (now - state.lastNavigation < 220) return undefined;
  state.distance += Math.abs(delta);
  if (state.distance < 60) return undefined;
  state.distance = 0;
  state.lastNavigation = now;
  return direction as -1 | 1;
};
