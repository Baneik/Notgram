import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DesktopNotificationRoute } from "./desktopNotifications";

const NOTIFICATIONS_CHANGED_EVENT = "notgram://desktop-notifications-changed";

export const readDesktopNotificationWindowSnapshot = async (): Promise<unknown> => {
  if (!isTauri()) return { revision: 0, items: [] };
  return invoke("notgram_desktop_notification_snapshot");
};

export const listenForDesktopNotificationWindowChanges = async (
  handler: (snapshot: unknown) => void,
): Promise<UnlistenFn> => {
  if (!isTauri()) return () => undefined;
  return listen<unknown>(NOTIFICATIONS_CHANGED_EVENT, ({ payload }) => handler(payload));
};

export const showDesktopNotificationWindow = async (height: number) => {
  if (!isTauri()) return true;
  return invoke<boolean>("notgram_show_notification_window", { height });
};

export const dismissDesktopNotificationWindowItem = async (
  id: string,
  expectedUpdatedAtMs: number,
): Promise<unknown | undefined> => {
  if (!isTauri()) return undefined;
  return invoke("notgram_dismiss_notification", { id, expectedUpdatedAtMs });
};

export const openDesktopNotificationWindowItem = async (
  route: DesktopNotificationRoute,
) => {
  if (!isTauri()) return false;
  await invoke("notgram_open_notification", { route });
  return true;
};
