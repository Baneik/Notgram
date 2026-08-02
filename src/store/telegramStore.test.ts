import { describe, expect, it, vi } from "vitest";
import { mockSnapshot } from "../telegram/mockData";
import { MockTelegramTransport } from "../telegram/mockTransport";
import type { TelegramEventListener } from "../telegram/transport";
import type {
  CachedTelegramSnapshot,
  Chat,
  ConnectionStatus,
  Message,
  MessagePermissions,
  SendMessageInput,
  SetChatDraftInput,
  TelegramAccount,
  TelegramAccountState,
} from "../telegram/types";
import { createTelegramStore, filterAndSortChats } from "./telegramStore";

describe("telegram store", () => {
  it.each([
    "connecting",
    "syncing",
    "online",
    "waitingForNetwork",
    "proxyError",
    "offline",
  ] satisfies ConnectionStatus[])("accepts the mock %s connection state", async (status) => {
    const store = createTelegramStore(new MockTelegramTransport({ connectionStatus: status }));

    await store.getState().initialize();

    expect(store.getState().connectionStatus).toBe(status);
  });

  it("preserves chats, history, and drafts while the network disconnects and recovers", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const before = store.getState();

    transport.setConnectionStatus("waitingForNetwork");
    transport.setConnectionStatus("waitingForNetwork");
    transport.setConnectionStatus("connecting");
    transport.setConnectionStatus("syncing");
    transport.setConnectionStatus("online");

    const after = store.getState();
    expect(after.connectionStatus).toBe("online");
    expect(after.phase).toBe("ready");
    expect(after.chats).toBe(before.chats);
    expect(after.messages).toBe(before.messages);
    expect(after.drafts).toBe(before.drafts);
    expect(after.histories).toBe(before.histories);
  });

  it("keeps recoverable sync errors local and reserves the error phase for fatal runtime failures", async () => {
    class ErrorReportingTransport extends MockTelegramTransport {
      private events?: TelegramEventListener;

      override async connect(listener: TelegramEventListener) {
        this.events = listener;
        return super.connect(listener);
      }

      report(message: string, fatal = false) {
        this.events?.({ type: "sync.error", message, fatal });
      }
    }

    const transport = new ErrorReportingTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();

    transport.report("下载保存失败");
    expect(store.getState()).toMatchObject({
      phase: "ready",
      connectionStatus: "online",
      operationError: "下载保存失败",
    });
    expect(store.getState().error).toBeUndefined();
    store.getState().clearOperationError();
    expect(store.getState().operationError).toBeUndefined();

    transport.report("runtime stopped", true);
    expect(store.getState()).toMatchObject({
      phase: "error",
      connectionStatus: "offline",
      error: "runtime stopped",
    });
    expect(store.getState().operationError).toBeUndefined();
  });

  it("persists offline text messages and sends them once after restart and reconnect", async () => {
    class TrackingOutboxTransport extends MockTelegramTransport {
      sends: SendMessageInput[] = [];

      override async sendMessage(input: SendMessageInput) {
        this.sends.push(structuredClone(input));
        await super.sendMessage(input);
      }
    }

    const offlineTransport = new TrackingOutboxTransport({
      connectionStatus: "waitingForNetwork",
    });
    const offlineStore = createTelegramStore(offlineTransport);
    await offlineStore.getState().initialize();

    await expect(offlineStore.getState().sendMessage("queued while offline"))
      .resolves.toBe(true);
    expect(offlineTransport.sends).toHaveLength(0);
    expect(offlineStore.getState().outbox).toMatchObject([{
      chatId: "chat-product",
      text: "queued while offline",
      status: "queued",
    }]);
    const persisted = await offlineTransport.loadCachedSnapshot();
    expect(persisted?.outbox).toHaveLength(1);

    const restoredTransport = new TrackingOutboxTransport({
      cachedSnapshot: persisted,
      connectionStatus: "waitingForNetwork",
    });
    const restoredStore = createTelegramStore(restoredTransport);
    await restoredStore.getState().initialize();
    expect(restoredStore.getState().outbox).toHaveLength(1);

    restoredTransport.setConnectionStatus("online");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(restoredTransport.sends).toHaveLength(1);
    expect(restoredStore.getState().outbox).toHaveLength(0);
    expect(
      restoredStore.getState().messages.get("chat-product")
        ?.filter((message) => message.content.kind === "text" &&
          message.content.text === "queued while offline"),
    ).toHaveLength(1);
  });

  it("keeps a failed restored outbox message for explicit retry", async () => {
    class FailingOutboxTransport extends MockTelegramTransport {
      fail = true;
      sends = 0;

      override async sendMessage(input: SendMessageInput) {
        this.sends += 1;
        if (this.fail) throw new Error("network request rejected");
        await super.sendMessage(input);
      }
    }

    const transport = new FailingOutboxTransport({ connectionStatus: "waitingForNetwork" });
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().sendMessage("retry me");
    transport.setConnectionStatus("online");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    const failed = store.getState().messages.get("chat-product")?.find(
      (message) => message.content.kind === "text" && message.content.text === "retry me",
    );
    expect(failed).toMatchObject({ delivery: "failed", canRetry: true });
    expect(store.getState().outbox[0]).toMatchObject({ status: "failed" });

    transport.fail = false;
    await store.getState().retryMessage(failed!.id);
    expect(transport.sends).toBe(2);
    expect(store.getState().outbox).toHaveLength(0);
  });

  it("finishes loading the cached chat list before starting live updates", async () => {
    class CacheFirstTransport extends MockTelegramTransport {
      connectStarted = false;
      private releaseCache?: () => void;
      private cacheGate = new Promise<void>((resolve) => {
        this.releaseCache = resolve;
      });

      override async loadCachedSnapshot() {
        await this.cacheGate;
        return super.loadCachedSnapshot();
      }

      override async connect(listener: Parameters<MockTelegramTransport["connect"]>[0]) {
        this.connectStarted = true;
        return super.connect(listener);
      }

      release() {
        this.releaseCache?.();
      }
    }

    const transport = new CacheFirstTransport();
    const store = createTelegramStore(transport);
    const initialization = store.getState().initialize();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(transport.connectStarted).toBe(false);
    transport.release();
    await initialization;
    expect(transport.connectStarted).toBe(true);
  });

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
    expect(store.getState().cacheHealth).toBe("migrated");

    transport.release();
    await initialization;
    expect(store.getState().phase).toBe("ready");
    expect(store.getState().messages.get("chat-product")?.length).toBeGreaterThanOrEqual(30);
  });

  it("discards a damaged snapshot and rebuilds from the live server", async () => {
    class DamagedCacheTransport extends MockTelegramTransport {
      clears = 0;

      override async loadCachedSnapshot() {
        return {
          version: 2,
          savedAt: "2026-08-01T10:00:00Z",
          currentUserId: mockSnapshot.currentUserId,
          users: [],
          folders: [],
          chats: [{ title: "missing id" }],
          messages: [],
        } as unknown as CachedTelegramSnapshot;
      }

      override async clearCachedSnapshot() {
        this.clears += 1;
        await super.clearCachedSnapshot();
      }
    }

    const transport = new DamagedCacheTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(transport.clears).toBe(1);
    expect(store.getState().phase).toBe("ready");
    expect(store.getState().chats.size).toBeGreaterThan(0);
    expect(store.getState().cacheHealth).toBe("invalid");
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
        version: 2,
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

  it("only removes cached messages inside the confirmed server window", async () => {
    const missingMessage: Message = {
      id: "75",
      chatId: "chat-product",
      senderId: "u-jules",
      outgoing: false,
      sentAt: "2026-08-01T11:15:00+08:00",
      delivery: "read",
      content: { kind: "text", text: "deleted inside confirmed window" },
    };
    const olderMessage: Message = {
      id: "10",
      chatId: "chat-product",
      senderId: "u-jules",
      outgoing: false,
      sentAt: "2026-08-01T01:00:00+08:00",
      delivery: "read",
      content: { kind: "text", text: "older cached history" },
    };
    const cachedSnapshot: CachedTelegramSnapshot = {
      version: 1,
      savedAt: "2026-08-01T10:00:00+08:00",
      currentUserId: mockSnapshot.currentUserId,
      users: structuredClone(mockSnapshot.users),
      folders: structuredClone(mockSnapshot.folders),
      chats: structuredClone(mockSnapshot.chats),
      messages: [olderMessage, missingMessage],
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
        const page = Array.from({ length: 30 }, (_, index) => newestId - index)
          .filter((id) => id !== 75)
          .map((id) => {
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
    expect(messages.some((message) => message.id === missingMessage.id)).toBe(false);
    expect(messages.some((message) => message.id === olderMessage.id)).toBe(true);
    expect(messages.map((message) => message.id)).toContain("100");
    expect(messages.map((message) => message.id)).toContain("41");
  });

  it("keeps older cached history until the server window reaches it", async () => {
    const cachedMessages = Array.from({ length: 12 }, (_, index): Message => ({
      id: String(index + 1),
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
        const newestId = this.requests === 0 ? 100 : 70;
        this.requests += 1;
        return {
          loadedCount: 30,
          hasMore: true,
          messageIds: Array.from({ length: 30 }, (_, index) => String(newestId - index)),
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

  it("preserves string startup errors returned by the native bridge", async () => {
    class FailingTransport extends MockTelegramTransport {
      override async connect(): Promise<never> {
        throw "数据库密钥迁移失败";
      }
    }

    const store = createTelegramStore(new FailingTransport());
    await store.getState().initialize();

    expect(store.getState()).toMatchObject({
      phase: "error",
      error: "数据库密钥迁移失败",
    });
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
    expect(store.getState().chats.get("chat-product")?.preview)
      .toBe("这是昨晚导出的交互录屏，麻烦确认最后一段。");
  });

  it("forwards multiple messages to another chat with original source metadata", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();
    const before = store.getState().messages.get("chat-mia")?.length ?? 0;

    await expect(store.getState().forwardMessages(
      "chat-product",
      ["p-1", "p-2"],
      "chat-mia",
    )).resolves.toEqual({ forwardedCount: 2, failedMessageIds: [] });

    const forwarded = store.getState().messages.get("chat-mia")?.slice(before);
    expect(forwarded).toHaveLength(2);
    expect(forwarded?.map((message) => message.content)).toEqual([
      mockSnapshot.messages.find((message) => message.id === "p-1")?.content,
      mockSnapshot.messages.find((message) => message.id === "p-2")?.content,
    ]);
    expect(forwarded?.[0]).toMatchObject({
      chatId: "chat-mia",
      outgoing: true,
      senderId: "self",
      forwardInfo: {
        origin: { kind: "user", userId: "u-jules" },
        source: { chatId: "chat-product", messageId: "p-1" },
      },
    });
  });

  it("keeps forward failures recoverable, including partial batches", async () => {
    class PartialForwardTransport extends MockTelegramTransport {
      override async forwardMessages() {
        return { forwardedCount: 1, failedMessageIds: ["p-2"] };
      }
    }
    const store = createTelegramStore(new PartialForwardTransport());
    await store.getState().initialize();

    await expect(store.getState().forwardMessages(
      "chat-product",
      ["p-1", "p-2"],
      "chat-mia",
    )).resolves.toEqual({ forwardedCount: 1, failedMessageIds: ["p-2"] });
    expect(store.getState().operationError).toBe("1 条消息已转发，1 条失败");
  });

  it("syncs independent chat drafts after debounce and on chat switches", async () => {
    class TrackingDraftTransport extends MockTelegramTransport {
      draftWrites: { chatId: string; text: string; replyToMessageId?: string }[] = [];

      override async setChatDraft(input: SetChatDraftInput) {
        this.draftWrites.push(structuredClone(input));
        await super.setChatDraft(input);
      }
    }

    vi.useFakeTimers();
    try {
      const transport = new TrackingDraftTransport();
      const store = createTelegramStore(transport);
      await store.getState().initialize();

      store.getState().updateChatDraft("chat-product", "first draft", "p-4");
      expect(store.getState().drafts.get("chat-product")).toMatchObject({
        text: "first draft",
        replyToMessageId: "p-4",
        pending: true,
      });
      await vi.advanceTimersByTimeAsync(449);
      expect(transport.draftWrites).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(transport.draftWrites).toEqual([{
        chatId: "chat-product",
        text: "first draft",
        replyToMessageId: "p-4",
      }]);
      expect(store.getState().drafts.get("chat-product")?.pending).toBe(false);

      await store.getState().selectChat("chat-mia");
      store.getState().updateChatDraft("chat-mia", "second draft");
      await store.getState().selectChat("chat-product");
      await vi.runAllTimersAsync();
      expect(transport.draftWrites.at(-1)).toEqual({
        chatId: "chat-mia",
        text: "second draft",
        replyToMessageId: undefined,
      });
      expect(store.getState().drafts.get("chat-product")?.text).toBe("first draft");
      expect(store.getState().drafts.get("chat-mia")?.text).toBe("second draft");
      await expect(store.getState().sendMessage("first draft", "p-4")).resolves.toBe(true);
      expect(store.getState().drafts.has("chat-product")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores stale server draft updates while local text is pending", async () => {
    class ManualDraftTransport extends MockTelegramTransport {
      eventListener?: TelegramEventListener;
      writes: { chatId: string; text: string; replyToMessageId?: string }[] = [];

      override async connect(listener: TelegramEventListener) {
        this.eventListener = listener;
        return super.connect(listener);
      }

      override async setChatDraft(input: SetChatDraftInput) {
        this.writes.push(structuredClone(input));
      }

      publish(text: string) {
        this.eventListener?.({
          type: "chat.draftChanged",
          chatId: "chat-product",
          draft: {
            chatId: "chat-product",
            text,
            updatedAt: new Date().toISOString(),
          },
        });
      }
    }

    vi.useFakeTimers();
    try {
      const transport = new ManualDraftTransport();
      const store = createTelegramStore(transport);
      await store.getState().initialize();
      store.getState().updateChatDraft("chat-product", "new local draft");

      transport.publish("old server draft");
      expect(store.getState().drafts.get("chat-product")?.text).toBe("new local draft");
      await vi.advanceTimersByTimeAsync(450);
      expect(transport.writes).toHaveLength(1);
      transport.publish("old server draft");
      expect(store.getState().drafts.get("chat-product")?.text).toBe("new local draft");

      transport.publish("new local draft");
      expect(store.getState().drafts.get("chat-product")?.pending).toBe(false);
      transport.publish("newer remote draft");
      expect(store.getState().drafts.get("chat-product")?.text).toBe("newer remote draft");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes a pending draft restored from the encrypted UI snapshot", async () => {
    const cachedSnapshot: CachedTelegramSnapshot = {
      version: 1,
      savedAt: "2026-08-01T10:00:00+08:00",
      currentUserId: mockSnapshot.currentUserId,
      users: structuredClone(mockSnapshot.users),
      folders: structuredClone(mockSnapshot.folders),
      chats: structuredClone(mockSnapshot.chats),
      messages: [],
      drafts: [{
        chatId: "chat-product",
        text: "restored draft",
        updatedAt: "2026-08-01T10:00:00+08:00",
        pending: true,
      }],
    };
    class RestoredDraftTransport extends MockTelegramTransport {
      writes: string[] = [];

      override async setChatDraft(input: SetChatDraftInput) {
        this.writes.push(input.text);
        await super.setChatDraft(input);
      }
    }
    const transport = new RestoredDraftTransport({ cachedSnapshot });
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(transport.writes).toEqual(["restored draft"]);
    expect(store.getState().drafts.get("chat-product")).toMatchObject({
      text: "restored draft",
      pending: false,
    });
  });

  it("sends and cancels a selected photo through the active chat", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();
    const photo = new File(
      [new Uint8Array([137, 80, 78, 71])],
      "upload.png",
      { type: "image/png" },
    );

    await expect(store.getState().sendFile(photo)).resolves.toBe(true);
    const sent = store.getState().messages.get("chat-product")?.at(-1);
    expect(sent).toMatchObject({
      chatId: "chat-product",
      outgoing: true,
      content: {
        kind: "media",
        mediaType: "photo",
        fileName: "upload.png",
        previewDataUrl: "data:image/png;base64,iVBORw==",
      },
    });

    await store.getState().cancelFileUpload(sent!.id);
    expect(
      store.getState().messages.get("chat-product")
        ?.some((message) => message.id === sent!.id),
    ).toBe(false);
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
    expect(store.getState().operationError).toBe("temporary edit failure");
    expect(
      store.getState().messages.get("chat-product")
        ?.find((message) => message.id === "p-2"),
    ).toEqual(original);

    await expect(store.getState().deleteMessage("p-2", true)).resolves.toBe(false);
    expect(store.getState().operationError).toBe("temporary delete failure");
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

  it("updates emoji reactions optimistically and rolls back failed requests", async () => {
    class FailedReactionTransport extends MockTelegramTransport {
      override async setMessageReaction() {
        throw new Error("reaction unavailable");
      }
    }

    const store = createTelegramStore(new FailedReactionTransport());
    await store.getState().initialize();
    await store.getState().selectChat("chat-product");
    const before = structuredClone(
      store.getState().messages.get("chat-product")
        ?.find((message) => message.id === "p-4"),
    );

    await store.getState().setMessageReaction("p-4", "👍", true);

    expect(
      store.getState().messages.get("chat-product")
        ?.find((message) => message.id === "p-4"),
    ).toEqual(before);
    expect(store.getState().operationError).toBe("reaction unavailable");
  });

  it("debounces server chat search and delegates current-chat message search", async () => {
    class SearchTrackingTransport extends MockTelegramTransport {
      chatQueries: string[] = [];
      messageQueries: Array<{ chatId: string; query: string }> = [];

      override async searchChats(query: string) {
        this.chatQueries.push(query);
      }

      override async searchChatMessages(chatId: string, query: string) {
        this.messageQueries.push({ chatId, query });
        return 0;
      }
    }

    vi.useFakeTimers();
    try {
      const transport = new SearchTrackingTransport();
      const store = createTelegramStore(transport);
      await store.getState().initialize();
      await store.getState().selectChat("chat-product");
      store.getState().setSearchQuery("pro");
      store.getState().setSearchQuery("project");
      await vi.advanceTimersByTimeAsync(251);
      await store.getState().searchChatMessages("needle");

      expect(transport.chatQueries).toEqual(["project"]);
      expect(transport.messageQueries).toEqual([
        { chatId: "chat-product", query: "needle" },
      ]);
    } finally {
      vi.useRealTimers();
    }
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
    store.getState().updateChatDraft("chat-product", "不要丢失这条草稿");

    const sent = await store.getState().sendMessage("不要丢失这条草稿");

    expect(sent).toBe(false);
    expect(store.getState().operationError).toBe("temporary send failure");
    expect(store.getState().drafts.get("chat-product")).toMatchObject({
      text: "不要丢失这条草稿",
      pending: true,
    });
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

  it("registers the active Telegram profile after startup", async () => {
    class AccountRegistrationTransport extends MockTelegramTransport {
      registeredAccount?: Omit<TelegramAccount, "id">;

      override async registerCurrentAccount(account: Omit<TelegramAccount, "id">) {
        this.registeredAccount = structuredClone(account);
        return {
          activeAccountId: "default",
          accounts: [{ id: "default", ...structuredClone(account) }],
        };
      }
    }

    const transport = new AccountRegistrationTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(transport.registeredAccount).toMatchObject({
      userId: mockSnapshot.currentUserId,
      displayName: mockSnapshot.users.find(
        (user) => user.id === mockSnapshot.currentUserId,
      )?.displayName,
    });
    expect(store.getState().accounts).toEqual([
      expect.objectContaining({ id: "default", userId: mockSnapshot.currentUserId }),
    ]);
  });

  it("flushes the active snapshot before switching accounts and reloading", async () => {
    const accounts: TelegramAccount[] = [
      {
        id: "default",
        userId: "self",
        displayName: "林遥",
        avatar: { label: "遥", color: "#3390ec" },
      },
      {
        id: "account-secondary",
        userId: "secondary",
        displayName: "工作账号",
        avatar: { label: "工", color: "#26a269" },
      },
    ];

    class AccountSwitchTransport extends MockTelegramTransport {
      events: string[] = [];

      override async getAccountState(): Promise<TelegramAccountState> {
        return { activeAccountId: "default", accounts: structuredClone(accounts) };
      }

      override async registerCurrentAccount() {
        return { activeAccountId: "default", accounts: structuredClone(accounts) };
      }

      override async saveCachedSnapshot() {
        this.events.push("save");
      }

      override async disconnect() {
        this.events.push("disconnect");
      }

      override async selectAccount(accountId: string) {
        this.events.push(`select:${accountId}`);
        return { activeAccountId: accountId, accounts: structuredClone(accounts) };
      }
    }

    const transport = new AccountSwitchTransport();
    const reload = vi.fn();
    const store = createTelegramStore(transport, reload);
    await store.getState().initialize();

    await expect(store.getState().switchAccount("account-secondary")).resolves.toBe(true);

    expect(transport.events).toEqual([
      "save",
      "disconnect",
      "select:account-secondary",
    ]);
    expect(store.getState().activeAccountId).toBe("account-secondary");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("cleans an unfinished account slot before returning to a registered account", async () => {
    const account: TelegramAccount = {
      id: "default",
      userId: "self",
      displayName: "林然",
      avatar: { label: "然", color: "#3390ec" },
    };

    class UnfinishedAccountTransport extends MockTelegramTransport {
      events: string[] = [];

      override async getAccountState() {
        return { activeAccountId: "account-unfinished", accounts: [account] };
      }

      override async registerCurrentAccount() {
        return { activeAccountId: "account-unfinished", accounts: [account] };
      }

      override async saveCachedSnapshot() {
        this.events.push("save");
      }

      override async disconnect() {
        this.events.push("disconnect");
      }

      override async removeAccount(accountId: string) {
        this.events.push(`remove:${accountId}`);
        return { activeAccountId: "default", accounts: [account] };
      }

      override async selectAccount(accountId: string) {
        this.events.push(`select:${accountId}`);
        return { activeAccountId: accountId, accounts: [account] };
      }
    }

    const transport = new UnfinishedAccountTransport();
    const reload = vi.fn();
    const store = createTelegramStore(transport, reload);
    await store.getState().initialize();

    await expect(store.getState().switchAccount("default")).resolves.toBe(true);

    expect(transport.events).toEqual([
      "save",
      "disconnect",
      "remove:account-unfinished",
      "select:default",
    ]);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("logs out, removes only the active account, and reloads the fallback account", async () => {
    const accounts: TelegramAccount[] = [
      {
        id: "default",
        userId: "self",
        displayName: "林遥",
        avatar: { label: "遥", color: "#3390ec" },
      },
      {
        id: "account-secondary",
        userId: "secondary",
        displayName: "工作账号",
        avatar: { label: "工", color: "#26a269" },
      },
    ];

    class AccountLogoutTransport extends MockTelegramTransport {
      events: string[] = [];

      override async getAccountState() {
        return {
          activeAccountId: "account-secondary",
          accounts: structuredClone(accounts),
        };
      }

      override async registerCurrentAccount() {
        return {
          activeAccountId: "account-secondary",
          accounts: structuredClone(accounts),
        };
      }

      override async saveCachedSnapshot() {
        this.events.push("save");
      }

      override async logOut() {
        this.events.push("logout");
      }

      override async disconnect() {
        this.events.push("disconnect");
      }

      override async removeAccount(accountId: string) {
        this.events.push(`remove:${accountId}`);
        return { activeAccountId: "default", accounts: [structuredClone(accounts[0])] };
      }
    }

    const transport = new AccountLogoutTransport();
    const reload = vi.fn();
    const store = createTelegramStore(transport, reload);
    await store.getState().initialize();

    await expect(store.getState().logOutCurrentAccount()).resolves.toBe(true);

    expect(transport.events).toEqual([
      "save",
      "logout",
      "disconnect",
      "remove:account-secondary",
    ]);
    expect(store.getState().accounts).toEqual([accounts[0]]);
    expect(store.getState().activeAccountId).toBe("default");
    expect(reload).toHaveBeenCalledOnce();
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

    expect(store.getState().messages.get("chat-product")).toHaveLength(
      mockSnapshot.messages.filter((message) => message.chatId === "chat-product").length,
    );
    expect(store.getState().histories.get("chat-product")?.hasMore).toBe(false);
  });

  it("stops loading a chat list after the transport reports exhaustion", async () => {
    class PagedChatTransport extends MockTelegramTransport {
      chatPageRequests = 0;

      override async loadMoreChats() {
        this.chatPageRequests += 1;
        return { loadedCount: this.chatPageRequests === 1 ? 5 : 0, hasMore: false };
      }
    }

    const transport = new PagedChatTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().loadMoreChats("main");
    await store.getState().loadMoreChats("main");

    expect(transport.chatPageRequests).toBe(1);
    expect(store.getState().chatLists.get("main")).toEqual({
      loading: false,
      hasMore: false,
    });
  });

  it("marks new incoming messages in the active chat as read", async () => {
    class ReadTrackingTransport extends MockTelegramTransport {
      readChatIds: string[] = [];
      eventListener?: TelegramEventListener;

      override async connect(listener: TelegramEventListener) {
        this.eventListener = listener;
        return super.connect(listener);
      }

      override async markChatRead(chatId: string) {
        this.readChatIds.push(chatId);
        await super.markChatRead(chatId);
      }
    }

    vi.useFakeTimers();
    try {
      const transport = new ReadTrackingTransport();
      const store = createTelegramStore(transport);
      await store.getState().initialize();
      const chatId = store.getState().activeChatId!;
      const callsBeforeMessage = transport.readChatIds.length;
      transport.eventListener?.({
        type: "message.upsert",
        message: {
          id: "incoming-read-test",
          chatId,
          senderId: "u-jules",
          outgoing: false,
          sentAt: new Date().toISOString(),
          delivery: "sent",
          content: { kind: "text", text: "new message" },
        },
      });

      await vi.advanceTimersByTimeAsync(121);
      expect(transport.readChatIds).toHaveLength(callsBeforeMessage + 1);
      expect(transport.readChatIds.at(-1)).toBe(chatId);
    } finally {
      vi.useRealTimers();
    }
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

  it("loads an exact notification target once and merges it into the chat", async () => {
    const source = mockSnapshot.messages[0];
    const target: Message = {
      ...source,
      id: "notification-target",
      content: { kind: "text", text: "notification target" },
    };
    class ExactMessageTransport extends MockTelegramTransport {
      exactMessageRequests = 0;

      override async getMessage(chatId: string, messageId: string) {
        this.exactMessageRequests += 1;
        return chatId === target.chatId && messageId === target.id ? target : undefined;
      }
    }
    const transport = new ExactMessageTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();

    await expect(store.getState().loadMessage(target.chatId, target.id)).resolves.toBe(true);
    await expect(store.getState().loadMessage(target.chatId, target.id)).resolves.toBe(true);

    expect(transport.exactMessageRequests).toBe(1);
    expect(store.getState().messages.get(target.chatId)).toContainEqual(target);
  });

  it("rebuilds the encrypted UI snapshot from current live state", async () => {
    class RebuildTransport extends MockTelegramTransport {
      clears = 0;
      savedSnapshot?: CachedTelegramSnapshot;

      override async clearCachedSnapshot() {
        this.clears += 1;
        await super.clearCachedSnapshot();
      }

      override async saveCachedSnapshot(snapshot: CachedTelegramSnapshot) {
        this.savedSnapshot = structuredClone(snapshot);
        await super.saveCachedSnapshot(snapshot);
      }
    }

    const transport = new RebuildTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();

    await expect(store.getState().rebuildCachedSnapshot()).resolves.toBe(true);
    expect(transport.clears).toBe(1);
    expect(transport.savedSnapshot).toMatchObject({
      version: 2,
      currentUserId: mockSnapshot.currentUserId,
    });
    expect(store.getState().cacheHealth).toBe("rebuilt");
  });

  it("sorts pinned chats according to the active folder", () => {
    const base = structuredClone(mockSnapshot.chats[0]);
    const chats: Chat[] = [
      {
        ...base,
        id: "main-pin",
        title: "Main pin",
        pinned: true,
        pinnedFolderIds: ["main"],
        listOrderByFolder: { main: "200", "folder:work": "100" },
        folderIds: ["main", "folder:work"],
        updatedAt: "2026-08-01T09:00:00+08:00",
      },
      {
        ...base,
        id: "work-pin",
        title: "Work pin",
        pinned: true,
        pinnedFolderIds: ["folder:work"],
        listOrderByFolder: { main: "100", "folder:work": "200" },
        folderIds: ["main", "folder:work"],
        updatedAt: "2026-08-01T08:00:00+08:00",
      },
    ];

    expect(filterAndSortChats(chats, "main", "").map((chat) => chat.id))
      .toEqual(["main-pin", "work-pin"]);
    expect(filterAndSortChats(chats, "folder:work", "").map((chat) => chat.id))
      .toEqual(["work-pin", "main-pin"]);
  });

  it("keeps pinned chats in list order when their latest message changes", () => {
    const base = structuredClone(mockSnapshot.chats[0]);
    const chats: Chat[] = [
      {
        ...base,
        id: "first-pin",
        listOrderByFolder: { main: "200" },
        updatedAt: "2026-08-01T08:00:00+08:00",
      },
      {
        ...base,
        id: "second-pin",
        listOrderByFolder: { main: "100" },
        updatedAt: "2026-08-02T12:00:00+08:00",
      },
    ];

    expect(filterAndSortChats(chats, "main", "").map((chat) => chat.id))
      .toEqual(["first-pin", "second-pin"]);
  });

  it("reorders pinned chats optimistically and sends the complete fixed order", async () => {
    class ReorderTrackingTransport extends MockTelegramTransport {
      requests: Array<{ chatListId: string; chatIds: string[] }> = [];

      override async setPinnedChats(chatListId: string, chatIds: string[]) {
        this.requests.push({ chatListId, chatIds: [...chatIds] });
        await super.setPinnedChats(chatListId, chatIds);
      }
    }

    const transport = new ReorderTrackingTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();

    await expect(store.getState().reorderPinnedChats(
      "main",
      ["chat-mia", "chat-product"],
    )).resolves.toBe(true);
    expect(transport.requests).toEqual([{
      chatListId: "main",
      chatIds: ["chat-mia", "chat-product"],
    }]);
    expect(filterAndSortChats(store.getState().chats.values(), "main", "")
      .filter((chat) => chat.pinnedFolderIds?.includes("main"))
      .map((chat) => chat.id))
      .toEqual(["chat-mia", "chat-product"]);
  });

  it("restores the previous pinned order when synchronization fails", async () => {
    class FailedReorderTransport extends MockTelegramTransport {
      override async setPinnedChats() {
        throw new Error("置顶同步失败");
      }
    }

    const store = createTelegramStore(new FailedReorderTransport());
    await store.getState().initialize();
    const before = filterAndSortChats(store.getState().chats.values(), "main", "")
      .filter((chat) => chat.pinnedFolderIds?.includes("main"))
      .map((chat) => chat.id);

    await expect(store.getState().reorderPinnedChats(
      "main",
      ["chat-mia", "chat-product"],
    )).resolves.toBe(false);
    expect(filterAndSortChats(store.getState().chats.values(), "main", "")
      .filter((chat) => chat.pinnedFolderIds?.includes("main"))
      .map((chat) => chat.id))
      .toEqual(before);
    expect(store.getState().operationError).toBe("置顶同步失败");
  });
});
