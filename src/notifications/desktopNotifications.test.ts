import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import {
  listenForDesktopNotificationOpen,
  parseDesktopNotificationRoute,
  requestDesktopNotificationPermission,
  showDesktopNotification,
} from "./desktopNotifications";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
}));

const permissionGranted = vi.mocked(isPermissionGranted);
const permissionRequest = vi.mocked(requestPermission);
const nativeInvoke = vi.mocked(invoke);
const nativeListen = vi.mocked(listen);
const route = { accountId: "default", chatId: "123", messageId: "456" };

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

  it("does not send without permission and forwards sound plus route to Rust", async () => {
    permissionGranted.mockResolvedValueOnce(false);
    await expect(showDesktopNotification({
      title: "Notgram",
      body: "message",
      sound: true,
      route,
    })).resolves.toBe(false);
    expect(nativeInvoke).not.toHaveBeenCalled();

    permissionGranted.mockResolvedValueOnce(true);
    nativeInvoke.mockResolvedValueOnce(undefined);
    await expect(showDesktopNotification({
      title: "Notgram",
      body: "message",
      sound: false,
      route,
    })).resolves.toBe(true);
    expect(nativeInvoke).toHaveBeenCalledWith("notgram_show_notification", {
      notification: {
        title: "Notgram",
        body: "message",
        sound: false,
        route,
      },
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
      route,
    })).resolves.toBe(false);
  });

  it("validates click payloads before routing them", async () => {
    expect(parseDesktopNotificationRoute(route)).toEqual(route);
    expect(parseDesktopNotificationRoute({ ...route, messageId: "" })).toBeUndefined();
    expect(parseDesktopNotificationRoute({ ...route, chatId: 123 })).toBeUndefined();

    let listener: ((event: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    nativeListen.mockImplementationOnce(async (_event, handler) => {
      listener = handler as (event: { payload: unknown }) => void;
      return unlisten;
    });
    const onOpen = vi.fn();
    await expect(listenForDesktopNotificationOpen(onOpen)).resolves.toBe(unlisten);
    listener?.({ payload: route });
    listener?.({ payload: { ...route, accountId: "" } });
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(route);
  });
});
