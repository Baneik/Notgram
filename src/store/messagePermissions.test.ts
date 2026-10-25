import { describe, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { createTelegramStore } from "./telegramStore";
import type { ConnectionStatus, Message, MessagePermissions, TelegramEvent } from "../telegram/types";
import type { TelegramEventListener } from "../telegram/transport";

const permissions: MessagePermissions = { canReply: true, canEdit: true, canForward: true, canDeleteOnlyForSelf: false, canDeleteForAllUsers: true };

class PublishingTransport extends MockTelegramTransport {
  private events?: TelegramEventListener;
  override async connect(listener: TelegramEventListener) {
    this.events = listener;
    return super.connect(listener);
  }
  publish(event: TelegramEvent) { this.events?.(event); }
}

describe("message permission request ownership", () => {
  const setup = async () => {
    const transport = new PublishingTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const lookup = vi.spyOn(transport, "getMessageProperties").mockResolvedValue(permissions);
    const replace = (update: (message: Message) => Message) => {
      const messages = new Map(store.getState().messages);
      messages.set("chat-product", messages.get("chat-product")!.map(message => message.id === "p-4" ? update(message) : message));
      store.setState({ messages });
    };
    return { transport, store, lookup, replace, load: (force = false, signal?: AbortSignal) =>
      store.getState().loadMessageProperties("chat-product", "p-4", force, signal) };
  };

  it("reuses permissions for 60 seconds and refreshes on expiry or force", async () => {
    const { transport, lookup, load } = await setup();
    const clock = vi.spyOn(Date, "now");
    const now = Date.now();
    try {
      clock.mockReturnValue(now);
      await load(); await load();
      expect(lookup).toHaveBeenCalledTimes(1);
      await load(true);
      expect(lookup).toHaveBeenCalledTimes(2);
      clock.mockReturnValue(now + 60_001);
      await load();
      expect(lookup).toHaveBeenCalledTimes(3);
    } finally { clock.mockRestore(); transport.disconnect(); }
  });

  it("accepts results after read and reaction updates and keeps the latest presentation", async () => {
    const { transport, store, lookup, replace, load } = await setup();
    let resolve!: (value: MessagePermissions) => void;
    lookup.mockImplementation(() => new Promise(yes => { resolve = yes; }));
    const pending = load();
    replace(message => ({ ...message, delivery: "read", interaction: {
      viewCount: 42, forwardCount: 0, replyCount: 0, reactions: [],
    } }));
    resolve(permissions);
    expect(await pending).toEqual(permissions);
    expect(store.getState().messages.get("chat-product")!.find(message => message.id === "p-4")).toMatchObject({
      delivery: "read", interaction: { viewCount: 42 }, permissions,
    });
    await load();
    expect(lookup).toHaveBeenCalledTimes(1);
    transport.disconnect();
  });

  it.each(["edit", "delete", "rights"] as const)("rejects in-flight results after %s", async change => {
    const { transport, store, lookup, replace, load } = await setup();
    let resolve!: (value: MessagePermissions) => void;
    lookup.mockImplementation(() => new Promise(yes => { resolve = yes; }));
    const pending = load();
    if (change === "edit") replace(message => ({ ...message, editedAt: "new edit" }));
    else if (change === "delete") replace(message => ({ ...message, isLocallyDeleted: true }));
    else {
      const chats = new Map(store.getState().chats);
      chats.set("chat-product", { ...chats.get("chat-product")!, canPinMessages: false });
      store.setState({ chats });
    }
    resolve(permissions);
    expect(await pending).toBeUndefined();
    transport.disconnect();
  });

  it("shares a pending lookup while cancellation belongs to each consumer", async () => {
    const { transport, store, lookup, load } = await setup();
    let resolve!: (value: MessagePermissions) => void;
    lookup.mockImplementation(() => new Promise(yes => { resolve = yes; }));
    const controller = new AbortController();
    const first = load(false, controller.signal);
    const second = load();
    expect(lookup).toHaveBeenCalledTimes(1);
    controller.abort();
    resolve(permissions);
    expect(await first).toBeUndefined();
    expect(await second).toEqual(permissions);
    expect(store.getState().messages.get("chat-product")!.find(message => message.id === "p-4")!.permissions).toEqual(permissions);
    transport.disconnect();
  });

  it("starts a new lookup after all previous consumers cancel", async () => {
    const { transport, lookup, load } = await setup();
    const releases: Array<(value: MessagePermissions) => void> = [];
    lookup.mockImplementation(() => new Promise(yes => { releases.push(yes); }));
    const controller = new AbortController();
    const first = load(false, controller.signal);
    controller.abort();
    const second = load();
    expect(lookup).toHaveBeenCalledTimes(2);
    releases[0](permissions);
    expect(await first).toBeUndefined();
    releases[1](permissions);
    expect(await second).toEqual(permissions);
    transport.disconnect();
  });

  it("retains cached permissions through transport progress and invalidates changed chat rights", async () => {
    const { transport, store, lookup, replace, load } = await setup();
    replace(message => ({ ...message, content: { kind: "media", mediaType: "photo", fileName: "photo.png",
      fileId: 1, sizeLabel: "1 MB", isDownloading: true, progress: 0 } }));
    await load();
    const message = store.getState().messages.get("chat-product")!.find(message => message.id === "p-4")!;
    transport.publish({ type: "message.upsert", message: { ...message, permissions: undefined,
      content: { ...message.content, progress: 0.5, downloadedSize: 512 } as Message["content"] } });
    expect(store.getState().messages.get("chat-product")!.find(message => message.id === "p-4")!.permissions).toEqual(permissions);
    await load();
    expect(lookup).toHaveBeenCalledTimes(1);
    const chat = store.getState().chats.get("chat-product")!;
    transport.publish({ type: "chat.upsert", chat: { ...chat, canPinMessages: !chat.canPinMessages } });
    expect(store.getState().messages.get("chat-product")!.find(message => message.id === "p-4")!.permissions).toBeUndefined();
    await load();
    expect(lookup).toHaveBeenCalledTimes(2);
    transport.publish({ type: "chat.upsert", chat });
    await load();
    expect(lookup).toHaveBeenCalledTimes(3);
    transport.disconnect();
  });
  it.each(["offline", "recovering", "connecting", "waitingForNetwork", "proxyError"] satisfies ConnectionStatus[])(
    "does not query without a connection (%s), and can retry after recovery", async connectionStatus => {
      const transport = new MockTelegramTransport();
      const store = createTelegramStore(transport);
      await store.getState().initialize();
      const lookup = vi.spyOn(transport, "getMessageProperties").mockResolvedValue(permissions);
      store.setState({ connectionStatus });
      expect(await store.getState().loadMessageProperties("chat-product", "p-4", true)).toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
      store.setState({ connectionStatus: "online" });
      expect(await store.getState().loadMessageProperties("chat-product", "p-4", true)).toEqual(permissions);
      transport.disconnect();
    },
  );

  it.each(["abort", "account"] as const)("ignores late results and errors after %s", async reason => {
    for (const fail of [false, true]) {
      const transport = new MockTelegramTransport();
      const store = createTelegramStore(transport);
      await store.getState().initialize();
      let resolve!: (value: MessagePermissions) => void;
      let reject!: (error: Error) => void;
      vi.spyOn(transport, "getMessageProperties").mockImplementation(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
      const controller = new AbortController();
      const pending = store.getState().loadMessageProperties("chat-product", "p-4", true, controller.signal);
      if (reason === "abort") controller.abort();
      else store.setState({ activeAccountId: "another-account" });
      store.setState({ operationError: "new operation" });
      if (fail) reject(new Error("late permission error"));
      else resolve(permissions);
      expect(await pending).toBeUndefined();
      expect(store.getState().messages.get("chat-product")!.find(message => message.id === "p-4")!.permissions).toBeUndefined();
      expect(store.getState().operationError).toBe("new operation");
      transport.disconnect();
    }
  });
});
