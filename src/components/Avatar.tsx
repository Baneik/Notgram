import type { Avatar as AvatarModel } from "../telegram/types";

interface AvatarProps {
  avatar: AvatarModel;
  size?: "small" | "medium" | "large";
}

export function Avatar({ avatar, size = "medium" }: AvatarProps) {
  return (
    <span
      className={`avatar avatar-${size}`}
      style={{ backgroundColor: avatar.color }}
      aria-hidden="true"
    >
      {avatar.label}
    </span>
  );
}
