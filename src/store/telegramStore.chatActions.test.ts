import { afterEach, describe, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import type { TelegramEventListener } from "../telegram/transport";
import { createTelegramStore } from "./telegramStore";
import { preferencesStore } from "./preferencesStore";

class ChatActionTransport extends MockTelegramTransport {
  publish!: TelegramEventListener;
  override async connect(listener: TelegramEventListener) {
    this.publish = listener;
    return super.connect(listener);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("chat list actions", () => {
  it.each([false, true])("ignores an old account's pending deletion on failure=%s", async failure => {
    const transport = new ChatActionTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    let finish!: () => void;
    vi.spyOn(transport, "deletePrivateChat").mockImplementation(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      if (failure) throw new Error("old deletion failed");
    });
    const deleting = store.getState().deletePrivateChat("chat-mia");
    await store.getState().switchAccount("account-secondary");
    const pending = new Set(["chat-mia"]);
    store.setState({ chatManagementPending: pending, operationError: "new account error" });
    finish();
    await expect(deleting).resolves.toBe(false);
    expect(store.getState().chatManagementPending).toBe(pending);
    expect(store.getState().operationError).toBe("new account error");
  });

  it("deletes private history, including retained copies, without deleting another chat", async () => {
    const transport = new ChatActionTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    store.getState().selectChat("chat-mia");
    await vi.waitFor(() => expect(store.getState().messages.get("chat-mia")?.length).toBeGreaterThan(0));
    const old = store.getState().messages.get("chat-mia")![0];
    transport.publish({ type: "message.upsert", message: { ...old, id: "retained-copy", isLocallyDeleted: true } });
    const product = store.getState().chats.get("chat-product");
    await expect(store.getState().deletePrivateChat("chat-mia")).resolves.toBe(true);
    expect(store.getState().messages.get("chat-mia")).toEqual([]);
    expect(store.getState().chats.get("chat-mia")?.folderIds).toEqual([]);
    expect(store.getState().activeChatId).not.toBe("chat-mia");
    expect(store.getState().chats.get("chat-product")).toEqual(product);
    transport.publish({ type: "message.upsert", message: old });
    expect(store.getState().messages.get("chat-mia")).toEqual([]);
  });

  it("rejects stale history while preserving messages newer than the deleted history", async () => {
    const transport = new ChatActionTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const old = store.getState().messages.get("chat-product")![0];
    const message = { ...old, chatId: "chat-mia", id: "200" };
    transport.publish({ type: "message.upsert", message });
    transport.publish({ type: "chat.historyDeleted", chatId: "chat-mia", lastMessageId: "100" });
    transport.publish({ type: "message.upsert", message: { ...message, id: "50" } });
    expect(store.getState().messages.get("chat-mia")?.some(item => item.id === "50")).toBe(false);
    expect(store.getState().messages.get("chat-mia")?.some(item => item.id === "200")).toBe(true);
  });

  it("leaves a channel even when Telegram keeps its history in the list", async () => {
    const transport = new ChatActionTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const channel = store.getState().chats.get("chat-release")!;
    vi.spyOn(transport, "leaveChat").mockImplementation(async () => {
      transport.publish({ type: "chat.upsert", chat: { ...channel, isMember: false } });
    });
    await expect(store.getState().leaveGroup(channel.id)).resolves.toBe(true);
    expect(store.getState().chats.get(channel.id)?.folderIds).toEqual(channel.folderIds);
    await expect(store.getState().leaveGroup(channel.id)).resolves.toBe(false);
    expect(transport.leaveChat).toHaveBeenCalledTimes(1);
  });

  it("stops only bots, keeps their chats, and reflects unblocking from settings", async () => {
    const transport = new ChatActionTransport({ blockedSenderCount: 105 });
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const bot = await transport.createPrivateChat("u-notgram-bot");
    await expect(store.getState().stopBot("chat-mia")).resolves.toBe(false);
    await expect(store.getState().stopBot(bot.id)).resolves.toBe(true);
    expect(store.getState().chats.get(bot.id)).toMatchObject({ isBlocked: true, folderIds: ["main"] });
    await transport.setMessageSenderBlocked(bot.peerId!, "user", false);
    expect(store.getState().chats.get(bot.id)?.isBlocked).toBe(false);
  });

  it("rejects unsupported or unknown deletion capabilities before sending a request", async () => {
    const transport = new ChatActionTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const deleting = vi.spyOn(transport, "deletePrivateChat");
    for (const id of ["chat-product", "chat-release", "chat-saved"]) {
      await expect(store.getState().deletePrivateChat(id)).resolves.toBe(false);
    }
    const chat = store.getState().chats.get("chat-mia")!;
    transport.publish({ type: "chat.upsert", chat: { ...chat, canDeleteForSelf: undefined } });
    await expect(store.getState().deletePrivateChat(chat.id)).resolves.toBe(false);
    expect(deleting).not.toHaveBeenCalled();
  });

  it("keeps history and releases the per-chat lock after deletion fails", async () => {
    const transport = new ChatActionTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const previous = store.getState().chats.get("chat-mia");
    let reject!: (error: Error) => void;
    vi.spyOn(transport, "deletePrivateChat").mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    const deleting = store.getState().deletePrivateChat("chat-mia");
    await expect(store.getState().setChatMuted("chat-mia", true)).resolves.toBe(false);
    reject(new Error("CHAT_DELETE_FAILED"));
    await expect(deleting).resolves.toBe(false);
    expect(store.getState().chats.get("chat-mia")).toEqual(previous);
    expect(store.getState().operationError).toBe("CHAT_DELETE_FAILED");
    expect(store.getState().chatManagementPending.size).toBe(0);
  });

  it("does not archive explicitly deleted history when remote-delete retention is enabled", async () => {
    const previous = preferencesStore.getState().deletedMessageArchiveEnabled;
    preferencesStore.setState({ deletedMessageArchiveEnabled: true });
    try {
      const transport = new ChatActionTransport();
      const store = createTelegramStore(transport);
      await store.getState().initialize();
      const message = { ...store.getState().messages.get("chat-product")![0], outgoing: false,
        senderId: "u-mia", content: { kind: "text" as const, text: "deleted history" } };
      transport.publish({ type: "message.upsert", message: { ...message, chatId: "chat-mia", id: "100" } });
      transport.publish({ type: "chat.historyDeleted", chatId: "chat-mia", lastMessageId: "100" });
      transport.publish({ type: "message.remove", chatId: "chat-mia", messageId: "50", source: "remote",
        permanent: true, preservedMessage: { ...message, chatId: "chat-mia", id: "50" } });
      expect(store.getState().messages.get("chat-mia")?.some(item => item.isLocallyDeleted)).toBe(false);
    } finally {
      preferencesStore.setState({ deletedMessageArchiveEnabled: previous });
    }
  });
});
