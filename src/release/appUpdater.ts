import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import versionSource from "../../version.json";

export interface AppUpdateInfo {
  currentVersion: string;
  version: string;
  date?: string;
  notes?: string;
}

export interface AppUpdateProgress {
  downloadedBytes: number;
  totalBytes?: number;
  fraction?: number;
}

export type AppDistribution = "installed" | "portable" | "unknown" | "browser";

interface NativeDownloadEvent {
  event: "Started" | "Progress" | "Finished";
  data?: { contentLength?: number; chunkLength?: number };
}

interface NativeUpdate {
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  downloadAndInstall: (onEvent: (event: NativeDownloadEvent) => void) => Promise<void>;
  close: () => Promise<void>;
}

export interface AppUpdaterBridge {
  available: () => boolean;
  distribution: () => Promise<Exclude<AppDistribution, "browser">>;
  currentVersion: () => Promise<string>;
  check: () => Promise<NativeUpdate | null>;
  relaunch: () => Promise<void>;
}

export class AppUpdater {
  private update?: NativeUpdate;

  constructor(private readonly bridge: AppUpdaterBridge) {}

  isAvailable() {
    return this.bridge.available();
  }

  async distribution(): Promise<AppDistribution> {
    if (!this.isAvailable()) return "browser";
    return this.bridge.distribution();
  }

  currentVersion() {
    return this.bridge.currentVersion();
  }

  async check(): Promise<AppUpdateInfo | undefined> {
    if (await this.distribution() !== "installed") return undefined;
    if (this.update) {
      await this.update.close();
      this.update = undefined;
    }
    const update = await this.bridge.check();
    if (!update) return undefined;
    this.update = update;
    return {
      currentVersion: update.currentVersion,
      version: update.version,
      date: update.date,
      notes: update.body?.trim().slice(0, 4_000) || undefined,
    };
  }

  async install(onProgress: (progress: AppUpdateProgress) => void): Promise<void> {
    const update = this.update;
    if (!update) throw new Error("没有可安装的更新");

    let downloadedBytes = 0;
    let totalBytes: number | undefined;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        totalBytes = event.data?.contentLength;
        downloadedBytes = 0;
      } else if (event.event === "Progress") {
        downloadedBytes += event.data?.chunkLength ?? 0;
      } else {
        downloadedBytes = totalBytes ?? downloadedBytes;
      }
      onProgress({
        downloadedBytes,
        totalBytes,
        fraction: totalBytes && totalBytes > 0
          ? Math.min(downloadedBytes / totalBytes, 1)
          : event.event === "Finished" ? 1 : undefined,
      });
    });
    await update.close();
    this.update = undefined;
    await this.bridge.relaunch();
  }
}

export const appUpdater = new AppUpdater({
  available: isTauri,
  distribution: async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<Exclude<AppDistribution, "browser">>("notgram_distribution_kind");
  },
  currentVersion: async () => isTauri() ? getVersion() : versionSource.version,
  check: async () => {
    const { check } = await import("@tauri-apps/plugin-updater");
    return check({ timeout: 15_000, allowDowngrades: false });
  },
  relaunch: async () => {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },
});
