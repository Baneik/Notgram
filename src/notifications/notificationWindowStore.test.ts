import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  desktopNotificationWindowStore,
  parseDesktopNotificationWindowItem,
  removeDesktopNotificationWindowItem,
  replaceDesktopNotificationWindowSnapshot,
} from "./notificationWindowStore";

const item = {
  id: "notification-1",
  title: "产品讨论",
  body: "设计稿已经更新",
  themeId: "notgram-dark",
  reduceMotion: false,
  createdAtMs: 1234,
  route: { accountId: "default", chatId: "chat-product", messageId: "p-5" },
} as const;

beforeEach(() => {
  replaceDesktopNotificationWindowSnapshot({ revision: 0, items: [] });
});

describe("desktop notification window store", () => {
  it("accepts valid native items and rejects malformed payloads", () => {
    expect(parseDesktopNotificationWindowItem(item)).toEqual(item);
    expect(parseDesktopNotificationWindowItem({ ...item, themeId: "unknown" })).toBeUndefined();
    expect(parseDesktopNotificationWindowItem({ ...item, createdAtMs: Number.NaN })).toBeUndefined();
    expect(parseDesktopNotificationWindowItem({ ...item, route: { chatId: "missing" } }))
      .toBeUndefined();
  });

  it("deduplicates ids, publishes changes, and removes dismissed items", () => {
    const listener = vi.fn();
    const unsubscribe = desktopNotificationWindowStore.subscribe(listener);
    replaceDesktopNotificationWindowSnapshot({
      revision: 1,
      items: [item, item, { ...item, id: "notification-2" }],
    });
    expect(desktopNotificationWindowStore.getSnapshot().map(({ id }) => id)).toEqual([
      "notification-1",
      "notification-2",
    ]);
    removeDesktopNotificationWindowItem("notification-1");
    expect(desktopNotificationWindowStore.getSnapshot()).toMatchObject([
      { id: "notification-2" },
    ]);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("ignores stale native snapshots", () => {
    replaceDesktopNotificationWindowSnapshot({ revision: 3, items: [item] });
    replaceDesktopNotificationWindowSnapshot({ revision: 2, items: [] });
    expect(desktopNotificationWindowStore.getSnapshot()).toEqual([item]);
  });
});
