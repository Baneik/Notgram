import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  listenForDesktopNotificationOpen,
  parseDesktopNotificationRoute,
  requestDesktopNotificationPermission,
  showDesktopNotification,
} from "./desktopNotifications";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const nativeInvoke = vi.mocked(invoke);
const nativeListen = vi.mocked(listen);
const route = { accountId: "default", chatId: "123", messageId: "456" };
const avatar = { label: "N", color: "#4e86b0", imagePath: "C:\\avatars\\chat.jpg" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("desktop notifications", () => {
  it("does not require Windows toast permission", async () => {
    await expect(requestDesktopNotificationPermission()).resolves.toBe(true);
  });

  it("forwards presentation, sound, appearance, and route to Rust", async () => {
    nativeInvoke.mockResolvedValueOnce(undefined);
    await expect(showDesktopNotification({
      title: "Notgram",
      body: "message",
      avatar,
      sound: false,
      themeId: "notgram-dark",
      reduceMotion: true,
      route,
    })).resolves.toBe(true);
    expect(nativeInvoke).toHaveBeenCalledWith("notgram_show_notification", {
      notification: {
        title: "Notgram",
        body: "message",
        avatar,
        sound: false,
        themeId: "notgram-dark",
        reduceMotion: true,
        route,
      },
    });
  });

  it("contains native command failures without breaking the app", async () => {
    nativeInvoke.mockRejectedValueOnce(new Error("native unavailable"));
    await expect(showDesktopNotification({
      title: "Notgram",
      body: "message",
      avatar,
      sound: true,
      themeId: "notgram-light",
      reduceMotion: false,
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
