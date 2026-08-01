import { describe, expect, it, vi } from "vitest";
import { mockSnapshot } from "../telegram/mockData";
import { MockTelegramTransport } from "../telegram/mockTransport";
import type { TelegramEventListener } from "../telegram/transport";
import type {
  CachedTelegramSnapshot,
  Chat,
  Message,
  MessagePermissions,
} from "../telegram/types";
import { createTelegramStore, filterAndSortChats } from "./telegramStore";

describe("telegram store", () => {
  it("hydrates cached chats before the server connection finishes", async () => {
    const cachedSnapshot: CachedTelegramSnapshot = {
      version: 1,
      savedAt: "2026-08-01T10:00:00+08:00",
      currentUserId: mockSnapshot.currentUserId,
      users: structuredClone(mockSnapshot.users),
      folders: structuredClone(mockSnapshot.folders),
      chats: structuredClone(mockSnapshot.chats),
      messages: structuredClone(
        mockSnapshot.messages
          .filter((message) => message.chatId === "chat-product")
          .slice(-3),
      ),
      activeChatId: "chat-product",
      chatFilter: "folder:work",
    };

    class DelayedTransport extends MockTelegramTransport {
      connectStarted = false;
      private releaseConnection?: () => void;
      private connectionGate = new Promise<void>((resolve) => {
        this.releaseConnection = resolve;
      });

      override async connect(listener: Parameters<MockTelegramTransport["connect"]>[0]) {
        this.connectStarted = true;
        await this.connectionGate;
        return super.connect(listener);
      }

      release() {
        this.releaseConnection?.();
      }
    }

    const transport = new DelayedTransport({ cachedSnapshot });
    const store = createTelegramStore(transport);
    const initialization = store.getState().initialize();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(transport.connectStarted).toBe(true);
    expect(store.getState().phase).toBe("loading");
    expect(store.getState().activeChatId).toBe("chat-product");
    expect(store.getState().chatFilter).toBe("folder:work");
    expect(store.getState().chatListReady).toBe(true);
    expect(store.getState().messages.get("chat-product")).toHaveLength(3);

    transport.release();
    await initialization;
    expect(store.getState().phase).toBe("ready");
    expect(store.getState().messages.get("chat-product")?.length).toBeGreaterThanOrEqual(30);
  });

  it("persists a bounded snapshot after live state changes", async () => {
    class TrackingTransport extends MockTelegramTransport {
      savedSnapshot?: CachedTelegramSnapshot;

      override async saveCachedSnapshot(snapshot: CachedTelegramSnapshot) {
        this.savedSnapshot = structuredClone(snapshot);
      }
    }

    vi.useFakeTimers();
    try {
      const transport = new TrackingTransport();
      const store = createTelegramStore(transport);
      await store.getState().initialize();
      const permissions = await store.getState().loadMessageProperties("chat-product", "p-4");
      expect(permissions).toMatchObject({ canReply: true, canEdit: false });
      expect(
        store.getState().messages.get("chat-product")
          ?.find((message) => message.id === "p-4")?.permissions,
      ).toEqual(permissions);
      await vi.advanceTimersByTimeAsync(601);

      expect(transport.savedSnapshot).toMatchObject({
        version: 1,
        currentUserId: "self",
        activeChatId: "chat-product",
      });
      expect(transport.savedSnapshot?.folders.some((folder) => folder.id === "archive")).toBe(false);
      expect(transport.savedSnapshot?.messages.length).toBeLessThanOrEqual(5_000);
      expect(
        transport.savedSnapshot?.messages.find((message) => message.id === "p-4"),
      ).not.toHaveProperty("permissions");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears cached account data when authorization is no longer valid", async () => {
    const cachedSnapshot: CachedTelegramSnapshot = {
      version: 1,
      savedAt: "2026-08-01T10:00:00+08:00",
      currentUserId: mockSnapshot.currentUserId,
      users: structuredClone(mockSnapshot.users),
      folders: structuredClone(mockSnapshot.folders),
      chats: structuredClone(mockSnapshot.chats),
      messages: [],
      activeChatId: "chat-product",
      chatFilter: "main",
    };
    const transport = new MockTelegramTransport({ authFlow: true, cachedSnapshot });
    const store = createTelegramStore(transport);

    await store.getState().initialize();

    expect(store.getState().authorization.kind).toBe("waitPhoneNumber");
    expect(store.getState().chats.size).toBe(0);
    expect(await transport.loadCachedSnapshot()).toBeUndefined();
  });

  it("does not request history until authorization is ready", async () => {
    const cachedSnapshot: CachedTelegramSnapshot = {
      version: 1,
      savedAt: "2026-08-01T10:00:00+08:00",
      currentUserId: mockSnapshot.currentUserId,
      users: structuredClone(mockSnapshot.users),
      folders: structuredClone(mockSnapshot.folders),
      chats: structuredClone(mockSnapshot.chats),
      messages: structuredClone(
        mockSnapshot.messages
          .filter((message) => message.chatId === "chat-product")
          .slice(-3),
      ),
      activeChatId: "chat-product",
      chatFilter: "main",
    };

    class PreparingTransport extends MockTelegramTransport {
      historyRequests = 0;
      private eventListener?: TelegramEventListener;

      override async connect(listener: TelegramEventListener) {
        this.eventListener = listener;
        const snapshot = await super.connect(listener);
        return { ...snapshot, authorization: { kind: "preparing" as const } };
      }

      override async loadChatHistory(chatId: string, limit = 30) {
        this.historyRequests += 1;
        return super.loadChatHistory(chatId, limit);
      }

      authorize() {
        this.eventListener?.({
          type: "authorization.changed",
          state: { kind: "ready" },
        });
      }
    }

    const transport = new PreparingTransport({ cachedSnapshot });
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().loadMoreHistory("chat-product");

    expect(transport.historyRequests).toBe(0);

    transport.authorize();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    expect(transport.historyRequests).toBe(1);
  });

  it("removes a disconnected cached segment after confirming recent server history", async () => {
    const disconnectedMessage: Message = {
      id: "1",
      chatId: "chat-product",
      senderId: "u-jules",
      outgoing: false,
      sentAt: "2026-08-01T01:00:00+08:00",
      delivery: "read",
      content: { kind: "text", text: "stale cached boundary" },
    };
    const cachedSnapshot: CachedTelegramSnapshot = {
      version: 1,
      savedAt: "2026-08-01T10:00:00+08:00",
      currentUserId: mockSnapshot.currentUserId,
      users: structuredClone(mockSnapshot.users),
      folders: structuredClone(mockSnapshot.folders),
      chats: structuredClone(mockSnapshot.chats),
      messages: [disconnectedMessage],
      activeChatId: "chat-product",
      chatFilter: "main",
    };

    class GapTransport extends MockTelegramTransport {
      historyRequests = 0;
      private eventListener?: TelegramEventListener;

      override async connect(listener: TelegramEventListener) {
        this.eventListener = listener;
        return super.connect(listener);
      }

      override async loadChatHistory() {
        const newestId = this.historyRequests === 0 ? 100 : 70;
        this.historyRequests += 1;
        const page = Array.from({ length: 30 }, (_, index) => {
          const id = newestId - index;
          const message: Message = {
            id: String(id),
            chatId: "chat-product",
            senderId: "u-jules",
            outgoing: false,
            sentAt: new Date(Date.UTC(2026, 7, 1, 10, id)).toISOString(),
            delivery: "read",
            content: { kind: "text", text: `server message ${id}` },
          };
          this.eventListener?.({ type: "message.upsert", message });
          return message;
        });
        return {
          loadedCount: page.length,
          hasMore: true,
          messageIds: page.map((message) => message.id),
        };
      }
    }

    const transport = new GapTransport({ cachedSnapshot });
    const store = createTelegramStore(transport);
    await store.getState().initialize();

    const messages = store.getState().messages.get("chat-product") ?? [];
    expect(transport.historyRequests).toBe(2);
    expect(messages).toHaveLength(60);
    expect(messages.some((message) => message.id === disconnectedMessage.id)).toBe(false);
    expect(messages.map((message) => message.id)).toContain("100");
    expect(messages.map((message) => message.id)).toContain("41");
  });

  it("keeps cached history when the server confirmation window is incomplete", async () => {
    const cachedMessages = Array.from({ length: 12 }, (_, index): Message => ({
      id: `cached-${index}`,
      chatId: "chat-product",
      senderId: "u-jules",
      outgoing: false,
      sentAt: new Date(Date.UTC(2026, 7, 1, 8, index)).toISOString(),
      delivery: "read",
      content: { kind: "text", text: `cached ${index}` },
    }));
    const cachedSnapshot: CachedTelegramSnapshot = {
      version: 1,
      savedAt: "2026-08-01T10:00:00+08:00",
      currentUserId: mockSnapshot.currentUserId,
      users: structuredClone(mockSnapshot.users),
      folders: structuredClone(mockSnapshot.folders),
      chats: structuredClone(mockSnapshot.chats),
      messages: cachedMessages,
      activeChatId: "chat-product",
      chatFilter: "main",
    };

    class IncompleteHistoryTransport extends MockTelegramTransport {
      requests = 0;

      override async connect(listener: TelegramEventListener) {
        await super.connect(listener);
        return {
          currentUserId: mockSnapshot.currentUserId,
          authorization: { kind: "ready" as const },
          users: [],
          folders: [],
          chats: [],
          messages: [],
        };
      }

      override async loadChatHistory() {
        this.requests += 1;
        return {
          loadedCount: 0,
          hasMore: true,
          messageIds: ["unconfirmed-server-message"],
        };
      }
    }

    const transport = new IncompleteHistoryTransport({ cachedSnapshot });
    const store = createTelegramStore(transport);
    await store.getState().initialize();

    expect(transport.requests).toBe(2);
    expect(store.getState().messages.get("chat-product")?.map((message) => message.id))
      .toEqual(cachedMessages.map((message) => message.id));
    expect(store.getState().histories.get("chat-product")?.hasMore).toBe(true);
  });

  it("loads a snapshot and selects the first pinned chat", async () => {
    const store = createTelegramStore(new MockTelegramTransport());

    await store.getState().initialize();

    const state = store.getState();
    expect(state.phase).toBe("ready");
    expect(state.activeChatId).toBe("chat-product");
    expect(state.chats.size).toBeGreaterThan(0);
    expect(state.messages.get("chat-product")).toHaveLength(30);
    expect(state.histories.get("chat-product")).toEqual({ loading: false, hasMore: true });
  });

  it("applies the initial server chat refresh in one store update", async () => {
    class BatchedChatTransport extends MockTelegramTransport {
      private eventListener?: TelegramEventListener;

      override async connect(listener: TelegramEventListener) {
        this.eventListener = listener;
        const snapshot = await super.connect(listener);
        return { ...snapshot, chats: [] };
      }

      publish(chats: Chat[]) {
        this.eventListener?.({ type: "chats.upserted", chats });
      }
    }

    const transport = new BatchedChatTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    expect(store.getState().chatListReady).toBe(false);

    let chatStateChanges = 0;
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.chats !== previous.chats) chatStateChanges += 1;
    });

    transport.publish(structuredClone(mockSnapshot.chats));
    unsubscribe();

    expect(chatStateChanges).toBe(1);
    expect(store.getState().chatListReady).toBe(true);
    expect(store.getState().chats.size).toBe(mockSnapshot.chats.length);
    expect(store.getState().activeChatId).toBe("chat-product");
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

  it("completes reply, edit, and delete operations through transport events", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();

    const replied = await store.getState().sendMessage("收到，我会跟进", "p-4");
    const reply = store.getState().messages.get("chat-product")?.at(-1);
    expect(replied).toBe(true);
    expect(reply).toMatchObject({
      content: { kind: "text", text: "收到，我会跟进" },
      replyTo: { kind: "message", messageId: "p-4" },
    });

    const edited = await store.getState().editMessage("p-2", "调整后的消息内容");
    expect(edited).toBe(true);
    expect(
      store.getState().messages.get("chat-product")
        ?.find((message) => message.id === "p-2"),
    ).toMatchObject({
      editedAt: expect.any(String),
      content: { kind: "text", text: "调整后的消息内容" },
    });

    const deleted = await store.getState().deleteMessage("p-4", false);
    expect(deleted).toBe(true);
    expect(
      store.getState().messages.get("chat-product")
        ?.some((message) => message.id === "p-4"),
    ).toBe(false);

    const deletedReply = await store.getState().deleteMessage(reply!.id, true);
    expect(deletedReply).toBe(true);
    expect(store.getState().chats.get("chat-product")?.preview).toBe("新的媒体预览样式");
  });

  it("preserves message state when edit or delete is rejected", async () => {
    class FailingOperationsTransport extends MockTelegramTransport {
      override async editMessage() {
        throw new Error("temporary edit failure");
      }

      override async deleteMessage() {
        throw new Error("temporary delete failure");
      }
    }

    const store = createTelegramStore(new FailingOperationsTransport());
    await store.getState().initialize();
    const original = structuredClone(
      store.getState().messages.get("chat-product")
        ?.find((message) => message.id === "p-2"),
    );

    await expect(store.getState().editMessage("p-2", "不会保存")).resolves.toBe(false);
    expect(store.getState().error).toBe("temporary edit failure");
    expect(
      store.getState().messages.get("chat-product")
        ?.find((message) => message.id === "p-2"),
    ).toEqual(original);

    await expect(store.getState().deleteMessage("p-2", true)).resolves.toBe(false);
    expect(store.getState().error).toBe("temporary delete failure");
    expect(
      store.getState().messages.get("chat-product")
        ?.some((message) => message.id === "p-2"),
    ).toBe(true);
  });

  it("applies repeated message metadata updates idempotently", async () => {
    class MetadataTransport extends MockTelegramTransport {
      private eventListener?: TelegramEventListener;

      override async connect(listener: TelegramEventListener) {
        this.eventListener = listener;
        return super.connect(listener);
      }

      publish(message: Message) {
        this.eventListener?.({ type: "message.upsert", message });
      }
    }

    const transport = new MetadataTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const initialMessages = store.getState().messages.get("chat-product") ?? [];
    const original = initialMessages.find((message) => message.id === "p-4")!;
    const updated: Message = {
      ...original,
      editedAt: "2026-08-01T10:00:00+08:00",
      interaction: {
        viewCount: 0,
        forwardCount: 0,
        replyCount: 0,
        reactions: [{
          type: { kind: "emoji", emoji: "👍" },
          totalCount: 2,
          chosen: true,
          recentSenderIds: ["self"],
        }],
      },
    };

    transport.publish(structuredClone(updated));
    transport.publish(structuredClone(updated));

    const finalMessages = store.getState().messages.get("chat-product") ?? [];
    expect(finalMessages).toHaveLength(initialMessages.length);
    expect(finalMessages.filter((message) => message.id === "p-4")).toHaveLength(1);
    expect(finalMessages.find((message) => message.id === "p-4")).toMatchObject({
      editedAt: "2026-08-01T10:00:00+08:00",
      interaction: {
        reactions: [{ type: { kind: "emoji", emoji: "👍" }, totalCount: 2 }],
      },
    });
  });

  it("discards stale permissions when the message changes during the request", async () => {
    class DelayedPropertiesTransport extends MockTelegramTransport {
      private eventListener?: TelegramEventListener;
      private releaseProperties?: (permissions: MessagePermissions) => void;
      private properties = new Promise<MessagePermissions>((resolve) => {
        this.releaseProperties = resolve;
      });

      override async connect(listener: TelegramEventListener) {
        this.eventListener = listener;
        return super.connect(listener);
      }

      override async getMessageProperties() {
        return this.properties;
      }

      publish(message: Message) {
        this.eventListener?.({ type: "message.upsert", message });
      }

      release() {
        this.releaseProperties?.({
          canReply: true,
          canEdit: true,
          canDeleteOnlyForSelf: false,
          canDeleteForAllUsers: true,
          canForward: true,
        });
      }
    }

    const transport = new DelayedPropertiesTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const original = store.getState().messages.get("chat-product")
      ?.find((message) => message.id === "p-4")!;
    const pending = store.getState().loadMessageProperties("chat-product", "p-4");

    transport.publish({
      ...structuredClone(original),
      editedAt: "2026-08-01T10:00:00+08:00",
    });
    transport.release();

    await expect(pending).resolves.toBeUndefined();
    const current = store.getState().messages.get("chat-product")
      ?.find((message) => message.id === "p-4");
    expect(current).toMatchObject({
      editedAt: "2026-08-01T10:00:00+08:00",
    });
    expect(current).not.toHaveProperty("permissions");
  });

  it("reports a rejected send so the composer can retain its draft", async () => {
    class FailingTransport extends MockTelegramTransport {
      override async sendMessage() {
        throw new Error("temporary send failure");
      }
    }
    const store = createTelegramStore(new FailingTransport());
    await store.getState().initialize();

    const sent = await store.getState().sendMessage("不要丢失这条草稿");

    expect(sent).toBe(false);
    expect(store.getState().error).toBe("temporary send failure");
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

  it("loads and saves storage paths", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();

    await store.getState().loadStorageSettings();
    const current = store.getState().storageSettings!;
    expect(current.cachePath).toBeTruthy();
    expect(current.downloadPath).toContain("downloads");

    const updated = {
      ...current,
      cachePath: "D:\\NotgramCache",
      downloadPath: "D:\\NotgramDownloads",
    };
    expect(await store.getState().saveStorageSettings(updated)).toBe(true);
    expect(store.getState().storageSettings).toMatchObject(updated);
  });
});

describe("chat filtering", () => {
  it("uses folders synchronized by the transport", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();

    const chats = filterAndSortChats(store.getState().chats.values(), "folder:work", "");

    expect(chats.length).toBeGreaterThan(0);
    expect(chats.every((chat) => chat.folderIds.includes("folder:work"))).toBe(true);
  });

  it("loads another page when older history is requested", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();

    await store.getState().loadMoreHistory("chat-product");

    expect(store.getState().messages.get("chat-product")).toHaveLength(41);
    expect(store.getState().histories.get("chat-product")?.hasMore).toBe(false);
  });

  it("uses chat ids as a stable fallback for equal sort keys", () => {
    const base = structuredClone(mockSnapshot.chats[0]);
    const chats: Chat[] = [
      { ...base, id: "chat-b", pinned: false, updatedAt: "2026-08-01T10:00:00+08:00" },
      { ...base, id: "chat-a", pinned: false, updatedAt: "2026-08-01T10:00:00+08:00" },
    ];

    expect(filterAndSortChats(chats, "main", "").map((chat) => chat.id))
      .toEqual(["chat-a", "chat-b"]);
  });
});
