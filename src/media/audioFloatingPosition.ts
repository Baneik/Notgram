export interface FloatingPosition {
  x: number;
  y: number;
}

export interface FloatingBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FloatingSize {
  width: number;
  height: number;
}

const clamp = (value: number, minimum: number, maximum: number) => (
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
);

export const clampAudioFloatingPosition = (
  position: FloatingPosition,
  bounds: FloatingBounds,
  size: FloatingSize,
  padding = 12,
): FloatingPosition => ({
  x: clamp(position.x, bounds.left + padding, bounds.right - size.width - padding),
  y: clamp(position.y, bounds.top + padding, bounds.bottom - size.height - padding),
});

export const defaultAudioFloatingPosition = (
  bounds: FloatingBounds,
  size: FloatingSize,
  padding = 12,
): FloatingPosition => clampAudioFloatingPosition({
  x: bounds.right - size.width - padding,
  y: bounds.top + 72,
}, bounds, size, padding);
