import { describe, expect, it } from "vitest";
import {
  clearPendingNotificationRoute,
  readPendingNotificationRoute,
  savePendingNotificationRoute,
} from "./notificationRouting";

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  };
};

describe("pending notification routes", () => {
  it("survives an account-switch reload and can be cleared", () => {
    const storage = memoryStorage();
    const route = { accountId: "secondary", chatId: "123", messageId: "456" };
    expect(savePendingNotificationRoute(route, storage)).toBe(true);
    expect(readPendingNotificationRoute(storage)).toEqual(route);
    clearPendingNotificationRoute(storage);
    expect(readPendingNotificationRoute(storage)).toBeUndefined();
  });

  it("safely rejects corrupt or incomplete stored routes", () => {
    const storage = memoryStorage();
    storage.setItem("notgram.pending-notification-route", "not-json");
    expect(readPendingNotificationRoute(storage)).toBeUndefined();
    storage.setItem(
      "notgram.pending-notification-route",
      JSON.stringify({ accountId: "default", chatId: "123" }),
    );
    expect(readPendingNotificationRoute(storage)).toBeUndefined();
  });
});
