import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import type { Avatar as AvatarModel } from "../telegram/types";
import { useVisibleFile } from "../hooks/useVisibleFile";
import { useTelegramStore } from "../store/telegramStore";
import { StableImage } from "./StableImage";

interface AvatarProps {
  avatar: AvatarModel;
  size?: "small" | "medium" | "large";
}

export function Avatar({ avatar, size = "medium" }: AvatarProps) {
  const recoverFile = useTelegramStore((state) => state.recoverFile);
  const attemptedRecovery = useRef(new Set<string>());
  const [failedSource, setFailedSource] = useState<string>();
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
      {imageSource && imageSource !== failedSource && (
        <StableImage
          key={imageSource}
          src={imageSource}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => {
            setFailedSource(imageSource);
            if (avatar.fileId === undefined || attemptedRecovery.current.has(imageSource)) return;
            attemptedRecovery.current.add(imageSource);
            void recoverFile(avatar.fileId, 24).then((recovered) => {
              if (recovered) setFailedSource(undefined);
            });
          }}
        />
      )}
    </span>
  );
}
