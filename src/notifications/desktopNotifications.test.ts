import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const route = { accountId: "default", chatId: "123", messageId: "456", topicId: "12" };
const avatar = { label: "N", color: "#4e86b0", imagePath: "C:\\avatars\\chat.jpg" };

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => vi.useRealTimers());

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
    vi.useFakeTimers();
    nativeInvoke.mockRejectedValue(new Error("native unavailable"));
    const result = showDesktopNotification({
      title: "Notgram",
      body: "message",
      avatar,
      sound: true,
      themeId: "notgram-light",
      reduceMotion: false,
      route,
    });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe(false);
    expect(nativeInvoke).toHaveBeenCalledTimes(3);
  });

  it("recovers transient native creation failures and stops after acceptance", async () => {
    vi.useFakeTimers();
    nativeInvoke.mockRejectedValueOnce(new Error("window unavailable"))
      .mockResolvedValueOnce(undefined);
    const result = showDesktopNotification({
      title: "Notgram", body: "message", avatar, sound: false,
      themeId: "notgram-dark", reduceMotion: true, route,
    });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe(true);
    expect(nativeInvoke).toHaveBeenCalledTimes(2);
  });

  it("does not retry an older message after a newer conversation alert is accepted", async () => {
    vi.useFakeTimers();
    nativeInvoke.mockRejectedValueOnce(new Error("window unavailable")).mockResolvedValue(undefined);
    const notification = {
      title: "Notgram", body: "old message", avatar, sound: false,
      themeId: "notgram-dark", reduceMotion: true, route,
    } as const;
    const older = showDesktopNotification(notification);
    await Promise.resolve();
    await expect(showDesktopNotification({
      ...notification, body: "new message", route: { ...route, messageId: "789" },
    })).resolves.toBe(true);
    await vi.runAllTimersAsync();
    await expect(older).resolves.toBe(false);
    expect(nativeInvoke).toHaveBeenCalledTimes(2);
  });

  it("validates click payloads before routing them", async () => {
    expect(parseDesktopNotificationRoute(route)).toEqual(route);
    expect(parseDesktopNotificationRoute({ ...route, messageId: "" })).toBeUndefined();
    expect(parseDesktopNotificationRoute({ ...route, chatId: 123 })).toBeUndefined();
    expect(parseDesktopNotificationRoute({ ...route, topicId: "" })).toBeUndefined();
    expect(parseDesktopNotificationRoute({ ...route, topicId: null })).toEqual({
      accountId: "default",
      chatId: "123",
      messageId: "456",
    });

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
