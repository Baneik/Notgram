import {
  backupKeys, createSettingsBackup, decodeSettingsBackup, encodeSettingsBackup,
  mergeSettingsBackups, sameValue, type SettingsBackup,
} from "./settingsBackup";
import type { WebDavResponse, WebDavSummary } from "./webdavBridge";

export interface SyncDependencies {
  snapshot: () => SettingsBackup;
  apply: (backup: SettingsBackup) => void;
  config: () => Promise<WebDavSummary>;
  request: (method: "GET" | "PUT", generation: string, body?: string, etag?: string, create?: boolean) => Promise<WebDavResponse>;
  status: (state: "disabled" | "syncing" | "synced" | "error", error?: string) => void;
}

// Only the main window owns this controller. Settings windows communicate through storage events.
export class SettingsSync {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private pending = false;
  private stopped = false;
  private epoch = 0;

  constructor(private readonly dependencies: SyncDependencies) {}

  changed(delay = 1200) {
    if (this.stopped) return;
    this.pending = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.run(); }, delay);
  }

  reconfigure() {
    this.epoch += 1;
    this.changed(0);
  }

  stop() {
    this.stopped = true;
    this.epoch += 1;
    clearTimeout(this.timer);
  }

  async run() {
    if (this.stopped) return;
    if (this.running) { this.pending = true; return; }
    clearTimeout(this.timer);
    this.running = true;
    this.pending = false;
    const epoch = this.epoch;
    const current = () => !this.stopped && epoch === this.epoch;
    try {
      const config = await this.dependencies.config();
      if (!current()) return;
      if (!config.enabled) { this.dependencies.status("disabled"); return; }
      this.dependencies.status("syncing");
      for (let attempt = 0; attempt < 3 && current(); attempt += 1) {
        const remote = await this.dependencies.request("GET", config.generation);
        if (!current()) return;
        if (remote.status !== 200 && remote.status !== 404) throw new Error(`http-${remote.status}`);
        const local = this.dependencies.snapshot();
        const cloud = remote.status === 200 ? decodeSettingsBackup(remote.body) : undefined;
        const merged = cloud ? mergeSettingsBackups(local, cloud) : local;
        if (!sameValue(local, merged)) this.dependencies.apply(merged);
        // New defaults absent from an older backup are not edits. Only revised
        // fields can create a cloud file or require replacement of an existing one.
        const needsWrite = backupKeys.some(key => (merged.revisions[key] ?? 0) > 0 &&
          (!cloud || merged.revisions[key] !== cloud.revisions[key] ||
            !sameValue(merged.preferences[key], cloud.preferences[key])));
        if (needsWrite) {
          if (cloud && (!remote.etag || remote.etag.startsWith("W/"))) throw new Error("missing-etag");
          const result = await this.dependencies.request("PUT", config.generation, encodeSettingsBackup(merged), remote.etag ?? undefined, !cloud);
          if (!current()) return;
          if (result.status === 412) continue;
          if (result.status < 200 || result.status >= 300) throw new Error(`http-${result.status}`);
        }
        this.dependencies.status("synced");
        return;
      }
      if (current()) throw new Error("conflict");
    } catch (error) {
      if (current()) this.dependencies.status("error", error instanceof Error ? error.message : "network");
    } finally {
      this.running = false;
      // Changes made during a request are retained and get their own fresh GET/merge/PUT.
      if (this.pending && !this.stopped) this.changed();
    }
  }
}

export function reviseBackup(previous: SettingsBackup, values: SettingsBackup["preferences"], now = Date.now()): SettingsBackup {
  const next = createSettingsBackup(values, previous.revisions);
  const revision = Math.min(Number.MAX_SAFE_INTEGER,
    Math.max(now, ...Object.values(previous.revisions).map(value => value + 1)));
  for (const key of backupKeys) {
    if (!sameValue(previous.preferences[key], next.preferences[key])) next.revisions[key] = revision;
  }
  return next;
}
