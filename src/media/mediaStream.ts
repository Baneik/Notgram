import { invoke, isTauri } from "@tauri-apps/api/core";

export interface MediaStreamStatus {
  downloadedBytes: number;
  active: boolean;
  completed: boolean;
}

export const updateMediaStreamPlayback = async (
  fileId: number | undefined,
  currentTime: number,
  duration: number,
  paused: boolean,
) => {
  if (!isTauri() || fileId === undefined) return;
  await invoke("telegram_update_media_stream", {
    fileId,
    currentTime,
    duration,
    paused,
  });
};

export const suspendMediaStream = async (fileId: number | undefined) => {
  if (!isTauri() || fileId === undefined) return;
  await invoke("telegram_suspend_media_stream", { fileId });
};

export const readMediaStreamStatus = async (
  fileId: number | undefined,
): Promise<MediaStreamStatus | undefined> => {
  if (!isTauri() || fileId === undefined) return undefined;
  return invoke<MediaStreamStatus | null>("telegram_media_stream_status", { fileId })
    .then((status) => status ?? undefined);
};

export const formatTransferSpeed = (bytesPerSecond: number) => {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
};
