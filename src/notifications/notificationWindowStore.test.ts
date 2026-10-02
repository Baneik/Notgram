import { beforeEach, describe, expect, it, vi } from "vitest";
let {
  desktopNotificationWindowStore,
  parseDesktopNotificationWindowItem,
  removeDesktopNotificationWindowItem,
  replaceDesktopNotificationWindowSnapshot,
} = await import("./notificationWindowStore");

const item = {
  id: "notification-1",
  title: "产品讨论",
  body: "设计稿已经更新",
  avatar: { label: "产", color: "#4e86b0", imagePath: "C:\\avatars\\product.jpg" },
  themeId: "notgram-dark",
  reduceMotion: false,
  updatedAtMs: 1234,
  route: { accountId: "default", chatId: "chat-product", messageId: "p-5" },
} as const;

beforeEach(async () => {
  vi.resetModules();
  ({ desktopNotificationWindowStore, parseDesktopNotificationWindowItem,
    removeDesktopNotificationWindowItem, replaceDesktopNotificationWindowSnapshot } = await import("./notificationWindowStore"));
});

describe("desktop notification window store", () => {
  it("accepts the null avatar path serialized by the native queue", () => {
    expect(parseDesktopNotificationWindowItem({
      ...item, avatar: { label: "N", color: "#4e86b0", imagePath: null },
      route: { ...item.route, topicId: null },
    })).toEqual({ ...item, avatar: { label: "N", color: "#4e86b0" } });
  });

  it("uses the native Unicode character bounds for emoji previews", () => {
    expect(parseDesktopNotificationWindowItem({
      ...item, title: "😀".repeat(200), body: "😀".repeat(1000),
    })).toBeDefined();
    expect(parseDesktopNotificationWindowItem({ ...item, body: "😀".repeat(1001) })).toBeUndefined();
  });

  it("accepts valid native items and rejects malformed payloads", () => {
    expect(parseDesktopNotificationWindowItem(item)).toEqual(item);
    expect(parseDesktopNotificationWindowItem({ ...item, themeId: "unknown" })).toBeUndefined();
    expect(parseDesktopNotificationWindowItem({ ...item, updatedAtMs: Number.NaN })).toBeUndefined();
    expect(parseDesktopNotificationWindowItem({
      ...item,
      avatar: { ...item.avatar, color: "url(bad)" },
    })).toBeUndefined();
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
    removeDesktopNotificationWindowItem("notification-1", item.updatedAtMs);
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

  it("does not publish unchanged poll snapshots or replace retained item references", () => {
    const value = { revision: 1, items: [item] };
    replaceDesktopNotificationWindowSnapshot(value);
    const current = desktopNotificationWindowStore.getSnapshot();
    const listener = vi.fn();
    const unsubscribe = desktopNotificationWindowStore.subscribe(listener);
    replaceDesktopNotificationWindowSnapshot(structuredClone(value));
    expect(desktopNotificationWindowStore.getSnapshot()).toBe(current);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("does not remove a conversation notification after its content is refreshed", () => {
    replaceDesktopNotificationWindowSnapshot({
      revision: 4,
      items: [{ ...item, updatedAtMs: 2000, body: "newest message" }],
    });
    removeDesktopNotificationWindowItem(item.id, item.updatedAtMs);
    expect(desktopNotificationWindowStore.getSnapshot()).toMatchObject([
      { id: item.id, updatedAtMs: 2000, body: "newest message" },
    ]);
  });
});
