import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { Avatar as AvatarModel } from "../telegram/types";
import { useVisibleFile } from "../hooks/useVisibleFile";
import { useTelegramStore } from "../store/telegramStore";
import { StableImage } from "./StableImage";

interface AvatarProps {
  avatar: AvatarModel;
  size?: "small" | "medium" | "large";
  active?: boolean;
  preload?: boolean;
}

export function Avatar({ avatar, size = "medium", active = true, preload = false }: AvatarProps) {
  const recoverFile = useTelegramStore((state) => state.recoverFile);
  const attemptedRecovery = useRef(new Set<string>());
  const [failedSource, setFailedSource] = useState<string>();
  const [requestedImage, setRequestedImage] = useState(active || preload);
  useEffect(() => {
    if (active || preload) setRequestedImage(true);
  }, [active, preload]);
  const targetRef = useVisibleFile<HTMLSpanElement>(
    avatar.fileId,
    (active || preload) && !avatar.imagePath && avatar.canDownload === true && avatar.isDownloading !== true,
    active ? 12 : 4,
    "160px",
    preload,
  );
  // Keep previously requested images attached while hidden; untouched offscreen rows stay lazy.
  const imageSource = (active || preload || requestedImage) && avatar.imagePath
    ? isTauri() ? convertFileSrc(avatar.imagePath, "notgram-asset") : avatar.imagePath
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
          loading={preload ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
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
