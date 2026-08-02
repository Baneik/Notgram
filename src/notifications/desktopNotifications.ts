import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export interface DesktopNotification {
  title: string;
  body: string;
  sound: boolean;
}

const WINDOWS_MESSAGE_SOUND = "IM";

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
}: DesktopNotification) => {
  try {
    if (!await isPermissionGranted()) return false;
    sendNotification({
      title,
      body,
      sound: sound ? WINDOWS_MESSAGE_SOUND : undefined,
    });
    return true;
  } catch {
    return false;
  }
};
