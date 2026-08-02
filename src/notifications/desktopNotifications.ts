import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";

export interface DesktopNotificationRoute {
  accountId: string;
  chatId: string;
  messageId: string;
}

export interface DesktopNotification {
  title: string;
  body: string;
  sound: boolean;
  route: DesktopNotificationRoute;
}

const NOTIFICATION_OPEN_EVENT = "notgram://notification-open";

const isRouteId = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 256;

export const parseDesktopNotificationRoute = (
  value: unknown,
): DesktopNotificationRoute | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<DesktopNotificationRoute>;
  if (
    !isRouteId(candidate.accountId) ||
    !isRouteId(candidate.chatId) ||
    !isRouteId(candidate.messageId)
  ) return undefined;
  return {
    accountId: candidate.accountId,
    chatId: candidate.chatId,
    messageId: candidate.messageId,
  };
};

export const requestDesktopNotificationPermission = async () => {
  try {
    if (await isPermissionGranted()) return true;
    return await requestPermission() === "granted";
  } catch {
    return false;
  }
};

export const showDesktopNotification = async ({
  title,
  body,
  sound,
  route,
}: DesktopNotification) => {
  try {
    if (!await isPermissionGranted()) return false;
    await invoke("notgram_show_notification", {
      notification: { title, body, sound, route },
    });
    return true;
  } catch {
    return false;
  }
};

export const listenForDesktopNotificationOpen = async (
  handler: (route: DesktopNotificationRoute) => void,
): Promise<UnlistenFn> => {
  try {
    return await listen<unknown>(NOTIFICATION_OPEN_EVENT, ({ payload }) => {
      const route = parseDesktopNotificationRoute(payload);
      if (route) handler(route);
    });
  } catch {
    return () => undefined;
  }
};
