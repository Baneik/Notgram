import { describe, expect, it } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { createTelegramStore, filterAndSortChats } from "./telegramStore";

describe("telegram store", () => {
  it("loads a snapshot and selects the first pinned chat", async () => {
    const store = createTelegramStore(new MockTelegramTransport());

    await store.getState().initialize();

    const state = store.getState();
    expect(state.phase).toBe("ready");
    expect(state.activeChatId).toBe("chat-product");
    expect(state.chats.size).toBeGreaterThan(0);
  });

  it("applies message and chat updates emitted by the transport", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();
    const previousCount = store.getState().messages.get("chat-product")?.length ?? 0;

    await store.getState().sendMessage("一条新的测试消息");

    const state = store.getState();
    expect(state.messages.get("chat-product")).toHaveLength(previousCount + 1);
    expect(state.chats.get("chat-product")?.preview).toBe("一条新的测试消息");
  });

  it("moves through phone, code, password, and ready authorization states", async () => {
    const store = createTelegramStore(
      new MockTelegramTransport({ authFlow: true }),
    );
    await store.getState().initialize();
    expect(store.getState().authorization.kind).toBe("waitPhoneNumber");

    await store.getState().authenticate({ kind: "phone", phoneNumber: "+8613800000000" });
    expect(store.getState().authorization.kind).toBe("waitCode");

    await store.getState().authenticate({ kind: "code", code: "12345" });
    expect(store.getState().authorization.kind).toBe("waitPassword");

    await store.getState().authenticate({ kind: "password", password: "test" });
    expect(store.getState().authorization.kind).toBe("ready");
  });

  it("switches from phone entry to QR confirmation", async () => {
    const store = createTelegramStore(
      new MockTelegramTransport({ authFlow: true }),
    );
    await store.getState().initialize();

    await store.getState().authenticate({ kind: "qr" });

    const authorization = store.getState().authorization;
    expect(authorization.kind).toBe("waitOtherDeviceConfirmation");
    if (authorization.kind === "waitOtherDeviceConfirmation") {
      expect(authorization.link).toMatch(/^tg:\/\/login\?token=/);
    }
  });

  it("loads, tests, and saves proxy preferences", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();

    await store.getState().loadProxySettings();
    expect(store.getState().proxySettings?.mode).toBe("system");

    const direct = { ...store.getState().proxySettings!, mode: "direct" as const };
    await store.getState().testProxy(direct);
    expect(store.getState().proxyLatencyMs).toBe(42);
    expect(await store.getState().saveProxySettings(direct)).toBe(true);
    expect(store.getState().proxySettings?.mode).toBe("direct");
  });
});

describe("chat filtering", () => {
  it("returns only unread main-list chats", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();

    const chats = filterAndSortChats(store.getState().chats.values(), "unread", "");

    expect(chats.length).toBeGreaterThan(0);
    expect(chats.every((chat) => chat.folder === "main" && chat.unreadCount > 0)).toBe(true);
  });
});
