import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ThemeId } from "../theme/theme";

export interface DesktopNotificationRoute {
  accountId: string;
  chatId: string;
  messageId: string;
}

export interface DesktopNotification {
  title: string;
  body: string;
  sound: boolean;
  themeId: ThemeId;
  reduceMotion: boolean;
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
  // Notgram notifications use an app-owned desktop window and need no OS toast permission.
  return true;
};

export const showDesktopNotification = async ({
  title,
  body,
  sound,
  themeId,
  reduceMotion,
  route,
}: DesktopNotification) => {
  try {
    await invoke("notgram_show_notification", {
      notification: { title, body, sound, themeId, reduceMotion, route },
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
