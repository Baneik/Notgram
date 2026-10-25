import { afterEach, describe, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import type { DeleteMessageInput, MessagePermissions } from "../telegram/types";
import { createTelegramStore } from "./telegramStore";

const allowed: MessagePermissions = { canReply: true, canEdit: false, canForward: false,
  canDeleteOnlyForSelf: true, canDeleteForAllUsers: true };

afterEach(() => vi.restoreAllMocks());

describe("batch deletion", () => {
  it("revalidates the whole requested scope before deleting anything", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().selectChat("chat-product");
    vi.spyOn(transport, "getMessageProperties").mockImplementation(async (_chat, id) => ({
      ...allowed, canDeleteForAllUsers: id !== "p-3",
    }));
    const remove = vi.spyOn(transport, "deleteMessage");
    expect(await store.getState().deleteMessagesFromChat("chat-product", ["p-2", "p-3"], true)).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(store.getState().operationError).toBe("部分消息当前不能为所有人删除");
  });

  it("keeps failed messages and removes successes when a batch partly fails", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().selectChat("chat-product");
    vi.spyOn(transport, "getMessageProperties").mockResolvedValue(allowed);
    vi.spyOn(transport, "deleteMessage").mockImplementation(async ({ messageId }: DeleteMessageInput) => {
      if (messageId === "p-3") throw new Error("temporary delete failure");
    });
    expect(await store.getState().deleteMessagesFromChat("chat-product", ["p-2", "p-3"], true)).toBe(false);
    const messages = store.getState().messages.get("chat-product")!;
    expect(messages.some(message => message.id === "p-2")).toBe(false);
    expect(messages.find(message => message.id === "p-3")?.isRemoving).not.toBe(true);
    expect(store.getState().operationError).toBe("temporary delete failure");
  });

  it("removes retained local copies without asking TDLib about absent messages", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().selectChat("chat-product");
    store.setState(state => ({ messages: new Map(state.messages).set("chat-product",
      state.messages.get("chat-product")!.map(message => message.id === "p-2" ? { ...message, isLocallyDeleted: true } : message)) }));
    const properties = vi.spyOn(transport, "getMessageProperties");
    const remove = vi.spyOn(transport, "deleteMessage");
    expect(await store.getState().deleteMessagesFromChat("chat-product", ["p-2"], false)).toBe(true);
    expect(properties).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(store.getState().messages.get("chat-product")!.some(message => message.id === "p-2")).toBe(false);
  });

  it("does not issue deletions after switching accounts during permission loading", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().selectChat("chat-product");
    let release!: (value: MessagePermissions) => void;
    vi.spyOn(transport, "getMessageProperties").mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const remove = vi.spyOn(transport, "deleteMessage");
    const deleting = store.getState().deleteMessagesFromChat("chat-product", ["p-2"], true);
    await store.getState().switchAccount("account-secondary");
    store.setState({ operationError: "new account error" });
    release(allowed);
    await expect(deleting).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(store.getState().operationError).toBe("new account error");
  });

  it("stops a batch after switching accounts while its first deletion is in flight", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().selectChat("chat-product");
    vi.spyOn(transport, "getMessageProperties").mockResolvedValue(allowed);
    let release!: () => void;
    const remove = vi.spyOn(transport, "deleteMessage").mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const deleting = store.getState().deleteMessagesFromChat("chat-product", ["p-2", "p-3"], true);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    await store.getState().switchAccount("account-secondary");
    const newMessages = store.getState().messages;
    release();
    await expect(deleting).resolves.toBe(false);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(store.getState().messages).toBe(newMessages);
  });
});
