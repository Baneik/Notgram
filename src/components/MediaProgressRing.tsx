interface MediaProgressRingProps {
  progress?: number;
  size?: number;
  className?: string;
}

const RADIUS = 12;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function MediaProgressRing({
  progress = 0,
  size = 28,
  className = "",
}: MediaProgressRingProps) {
  const normalized = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return (
    <svg
      className={`media-progress-ring ${className}`.trim()}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      viewBox="0 0 28 28"
      aria-hidden="true"
    >
      <circle className="media-progress-ring-track" cx="14" cy="14" r={RADIUS} />
      <circle
        className="media-progress-ring-value"
        cx="14"
        cy="14"
        r={RADIUS}
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - normalized)}
      />
    </svg>
  );
}
