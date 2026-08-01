import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import type { Avatar as AvatarModel } from "../telegram/types";

interface AvatarProps {
  avatar: AvatarModel;
  size?: "small" | "medium" | "large";
}

export function Avatar({ avatar, size = "medium" }: AvatarProps) {
  const imageSource = avatar.imagePath && isTauri()
    ? convertFileSrc(avatar.imagePath)
    : undefined;
  return (
    <span
      className={`avatar avatar-${size}`}
      style={{ backgroundColor: avatar.color }}
      aria-hidden="true"
    >
      <span>{avatar.label}</span>
      {imageSource && (
        <img
          src={imageSource}
          alt=""
          onError={(event) => { event.currentTarget.hidden = true; }}
        />
      )}
    </span>
  );
}
