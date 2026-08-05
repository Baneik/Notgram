import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import type { Avatar as AvatarModel } from "../telegram/types";
import { useVisibleFile } from "../hooks/useVisibleFile";

interface AvatarProps {
  avatar: AvatarModel;
  size?: "small" | "medium" | "large";
}

export function Avatar({ avatar, size = "medium" }: AvatarProps) {
  const targetRef = useVisibleFile<HTMLSpanElement>(
    avatar.fileId,
    !avatar.imagePath && avatar.canDownload === true && avatar.isDownloading !== true,
    12,
    "160px",
  );
  const imageSource = avatar.imagePath
    ? isTauri() ? convertFileSrc(avatar.imagePath) : avatar.imagePath
    : undefined;
  return (
    <span
      ref={targetRef}
      className={`avatar avatar-${size}`}
      style={{ backgroundColor: avatar.color }}
      aria-hidden="true"
    >
      <span>{avatar.label}</span>
      {imageSource && (
        <img
          key={imageSource}
          src={imageSource}
          alt=""
          loading="lazy"
          decoding="async"
          onError={(event) => { event.currentTarget.hidden = true; }}
        />
      )}
    </span>
  );
}
