import { invoke, isTauri } from "@tauri-apps/api/core";

export interface WebDavConfig {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
}
export interface WebDavSummary {
  enabled: boolean;
  url: string;
  hasUsername: boolean;
  hasPassword: boolean;
  generation: string;
}
export interface WebDavResponse {
  status: number;
  body: string;
  etag: string | null;
}
export const WEBDAV_CONFIG_EVENT = "notgram:backup:webdav-config";
export const WEBDAV_SYNC_STATUS = "notgram:backup:sync-status";
export const webdavBridge = {
  available: isTauri,
  summary: () => invoke<WebDavSummary>("notgram_webdav_settings"),
  edit: () => invoke<WebDavConfig>("notgram_webdav_edit_settings"),
  save: (config: WebDavConfig) => invoke<WebDavSummary>("notgram_webdav_save_settings", { config }),
  setEnabled: (enabled: boolean) => invoke<WebDavSummary>("notgram_webdav_set_enabled", { enabled }),
  request: (method: "GET" | "PUT", generation: string, body?: string, etag?: string, create?: boolean) =>
    invoke<WebDavResponse>("notgram_webdav_request", { method, generation, body, etag, create: create ?? false }),
};
