import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  requestDesktopNotificationPermission,
  showDesktopNotification,
} from "./desktopNotifications";

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

const permissionGranted = vi.mocked(isPermissionGranted);
const permissionRequest = vi.mocked(requestPermission);
const notify = vi.mocked(sendNotification);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("desktop notifications", () => {
  it("requests permission only when it is not already granted", async () => {
    permissionGranted.mockResolvedValueOnce(true);
    await expect(requestDesktopNotificationPermission()).resolves.toBe(true);
    expect(permissionRequest).not.toHaveBeenCalled();

    permissionGranted.mockResolvedValueOnce(false);
    permissionRequest.mockResolvedValueOnce("granted");
    await expect(requestDesktopNotificationPermission()).resolves.toBe(true);
  });

  it("does not send without permission and maps the sound preference", async () => {
    permissionGranted.mockResolvedValueOnce(false);
    await expect(showDesktopNotification({
      title: "Notgram",
      body: "message",
      sound: true,
    })).resolves.toBe(false);
    expect(notify).not.toHaveBeenCalled();

    permissionGranted.mockResolvedValueOnce(true);
    await expect(showDesktopNotification({
      title: "Notgram",
      body: "message",
      sound: false,
    })).resolves.toBe(true);
    expect(notify).toHaveBeenCalledWith({
      title: "Notgram",
      body: "message",
      sound: undefined,
    });

    permissionGranted.mockResolvedValueOnce(true);
    await showDesktopNotification({ title: "Notgram", body: "message", sound: true });
    expect(notify).toHaveBeenLastCalledWith({
      title: "Notgram",
      body: "message",
      sound: "IM",
    });
  });

  it("contains native permission failures without breaking the app", async () => {
    permissionGranted.mockRejectedValueOnce(new Error("native unavailable"));
    await expect(requestDesktopNotificationPermission()).resolves.toBe(false);

    permissionGranted.mockRejectedValueOnce(new Error("native unavailable"));
    await expect(showDesktopNotification({
      title: "Notgram",
      body: "message",
      sound: true,
    })).resolves.toBe(false);
  });
});
