import { convertFileSrc, isTauri } from "@tauri-apps/api/core";

export const localMediaSource = (path?: string) => {
  if (!path) return undefined;
  return isTauri() ? convertFileSrc(path) : path;
};
