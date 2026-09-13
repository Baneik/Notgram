import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { Bookmark } from "lucide-react";
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
  const retryAttempts = useRef(new Map<string, number>());
  const retryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [failedSource, setFailedSource] = useState<string>();
  const [requestedImage, setRequestedImage] = useState(active || preload);
  useEffect(() => {
    if (active || preload) setRequestedImage(true);
  }, [active, preload]);
  useEffect(() => () => {
    for (const timer of retryTimers.current.values()) clearTimeout(timer);
    retryTimers.current.clear();
  }, []);
  useEffect(() => {
    const retry = () => setFailedSource(undefined);
    globalThis.addEventListener?.("online", retry);
    return () => globalThis.removeEventListener?.("online", retry);
  }, []);
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
      {avatar.icon === "saved" ? <Bookmark className="avatar-icon" size="42%" strokeWidth={2.2} fill="currentColor" /> : <span>{avatar.label}</span>}
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
            const attempts = (retryAttempts.current.get(imageSource) ?? 0) + 1;
            retryAttempts.current.set(imageSource, attempts);
            const scheduleRetry = () => {
              if (retryTimers.current.has(imageSource)) return;
              const timer = setTimeout(() => {
                retryTimers.current.delete(imageSource);
                setFailedSource((current) => current === imageSource ? undefined : current);
              }, Math.min(30_000, 1_000 * 2 ** Math.min(attempts - 1, 5)));
              retryTimers.current.set(imageSource, timer);
            };
            if (avatar.fileId === undefined || attemptedRecovery.current.has(imageSource)) {
              scheduleRetry();
              return;
            }
            attemptedRecovery.current.add(imageSource);
            void recoverFile(avatar.fileId, 24).then((recovered) => {
              if (recovered) {
                retryAttempts.current.delete(imageSource);
                setFailedSource(undefined);
              }
            }).catch(() => undefined).finally(scheduleRetry);
          }}
        />
      )}
    </span>
  );
}
