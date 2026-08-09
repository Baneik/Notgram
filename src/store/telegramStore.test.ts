import { describe, expect, it, vi } from "vitest";
import { mockSnapshot } from "../telegram/mockData";
import { MockTelegramTransport } from "../telegram/mockTransport";
import type { TelegramEventListener } from "../telegram/transport";
import type {
  CachedTelegramSnapshot,
  Chat,
  ChatProfile,
  ConnectionStatus,
  GlobalSearchInput,
  GlobalSearchPage,
  ForwardMessagesInput,
  ForumTopic,
  Message,
  MessagePermissions,
  SendMessageInput,
  SendFilesInput,
  SendEmojiAssetInput,
  SetChatDraftInput,
  TelegramAccount,
  TelegramAccountState,
  TelegramEvent,
} from "../telegram/types";
import { createTelegramStore, filterAndSortChats } from "./telegramStore";
import { cachedSnapshotFrom } from "./telegramStore.cache";

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

  it("returns pinned messages without injecting detached history into the active timeline", async () => {
    class DetachedPinnedTransport extends MockTelegramTransport {
      override async getPinnedMessages(chatId: string) {
        const source = mockSnapshot.messages.find((message) => message.chatId === chatId)!;
        return [{
          ...structuredClone(source),
          id: "detached-pinned-message",
          sentAt: "2025-01-01T00:00:00.000Z",
          isPinned: true,
        }];
      }
    }

    const store = createTelegramStore(new DetachedPinnedTransport());
    await store.getState().initialize();
    const messagesBefore = store.getState().messages;

    const pinned = await store.getState().loadPinnedMessages("chat-product");

    expect(pinned).toMatchObject([{ id: "detached-pinned-message", isPinned: true }]);
    expect(store.getState().messages).toBe(messagesBefore);
    expect(store.getState().messages.get("chat-product")?.some(
      (message) => message.id === "detached-pinned-message",
    )).toBe(false);
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

  it("persists offline attachments and uploads them once after restart", async () => {
    class TrackingAttachmentTransport extends MockTelegramTransport {
      uploads: SendFilesInput[] = [];

      override async sendFiles(input: SendFilesInput) {
        this.uploads.push(input);
        return super.sendFiles(input);
      }
    }

    const offlineTransport = new TrackingAttachmentTransport({
      connectionStatus: "waitingForNetwork",
    });
    const offlineStore = createTelegramStore(offlineTransport);
    await offlineStore.getState().initialize();
    const file = new File(["offline attachment"], "offline.txt", {
      type: "text/plain",
      lastModified: 1_775_000_000_000,
    });

    await expect(offlineStore.getState().sendFiles([{
      file,
      kind: "document",
    }], "offline caption")).resolves.toBe(true);
    expect(offlineTransport.uploads).toHaveLength(0);
    expect(offlineStore.getState().outbox).toMatchObject([{
      kind: "attachments",
      caption: "offline caption",
      status: "queued",
      attachments: [{ name: "offline.txt", size: file.size }],
    }]);
    expect(offlineStore.getState().messages.get("chat-product")?.at(-1)).toMatchObject({
      delivery: "sending",
      content: { kind: "file", fileName: "offline.txt", isUploading: true },
    });

    const persisted = await offlineTransport.loadCachedSnapshot();
    const restoredTransport = new TrackingAttachmentTransport({
      cachedSnapshot: persisted,
      connectionStatus: "waitingForNetwork",
    });
    const restoredStore = createTelegramStore(restoredTransport);
    await restoredStore.getState().initialize();
    expect(restoredStore.getState().outbox).toHaveLength(1);

    restoredTransport.setConnectionStatus("online");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(restoredTransport.uploads).toHaveLength(1);
    expect(restoredTransport.uploads[0]).toMatchObject({
      chatId: "chat-product",
      caption: "offline caption",
      attachments: [{ kind: "document", file: { name: "offline.txt", type: "text/plain" } }],
    });
    expect(restoredStore.getState().outbox).toHaveLength(0);
  });

  it("creates a group, selects it, and persists it in the chat map", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();

    const chatId = await store.getState().createChat({
      kind: "basicGroup",
      title: "QA 验收群",
      memberUserIds: ["u-mia"],
      permissionTemplate: "open",
    });

    expect(chatId).toBeDefined();
    expect(store.getState()).toMatchObject({
      activeChatId: chatId,
      chatCreationPending: false,
      chatFilter: "main",
    });
    expect(store.getState().chats.get(chatId!)).toMatchObject({
      kind: "group",
      title: "QA 验收群",
    });
    expect(store.getState().messages.get(chatId!)).toEqual([]);
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
      await vi.advanceTimersByTimeAsync(2_001);

      expect(transport.savedSnapshot).toMatchObject({
        version: 3,
        currentUserId: "self",
        activeChatId: "chat-product",
      });
      expect(transport.savedSnapshot?.folders.some((folder) => folder.id === "archive")).toBe(true);
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

  it("preserves cached messages absent from a history window until an explicit delete", async () => {
    const missingMessage: Message = {
      id: "75",
      chatId: "chat-product",
      senderId: "u-jules",
      outgoing: false,
      sentAt: "2026-08-01T11:15:00+08:00",
      delivery: "read",
      content: { kind: "text", text: "temporarily absent inside history window" },
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
    expect(messages).toHaveLength(61);
    expect(messages.some((message) => message.id === missingMessage.id)).toBe(true);
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
    expect(state.histories.get("chat-product")).toEqual({
      loading: false,
      hasMore: true,
      initialized: true,
    });
  });

  it("reuses initialized chat history when switching between conversations", async () => {
    class CountingHistoryTransport extends MockTelegramTransport {
      historyRequests = new Map<string, number>();

      override async loadChatHistory(chatId: string, limit = 30) {
        this.historyRequests.set(chatId, (this.historyRequests.get(chatId) ?? 0) + 1);
        return super.loadChatHistory(chatId, limit);
      }
    }

    const transport = new CountingHistoryTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();

    const initialProductRequests = transport.historyRequests.get("chat-product") ?? 0;
    await store.getState().selectChat("chat-mia");
    const initialMiaRequests = transport.historyRequests.get("chat-mia") ?? 0;

    await store.getState().selectChat("chat-product");
    await store.getState().selectChat("chat-mia");

    expect(transport.historyRequests.get("chat-product")).toBe(initialProductRequests);
    expect(transport.historyRequests.get("chat-mia")).toBe(initialMiaRequests);

    await store.getState().loadMoreHistory("chat-product");
    expect(transport.historyRequests.get("chat-product")).toBe(initialProductRequests + 1);
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

  it("keeps one visible outgoing message while TDLib confirms its permanent id", async () => {
    class SendingConfirmationTransport extends MockTelegramTransport {
      private eventListener?: TelegramEventListener;

      override async connect(listener: TelegramEventListener) {
        this.eventListener = listener;
        return super.connect(listener);
      }

      confirm() {
        const temporary: Message = {
          id: "-700",
          chatId: "chat-product",
          senderId: "self",
          outgoing: true,
          sentAt: "2026-08-07T08:40:00+08:00",
          delivery: "sending",
          content: { kind: "text", text: "atomic confirmation" },
        };
        this.eventListener?.({
          type: "message.upsert",
          message: temporary,
          animateEntrance: true,
        });
        this.eventListener?.({
          type: "message.replace",
          oldMessageId: temporary.id,
          message: { ...temporary, id: "700", delivery: "sent" },
        });
      }
    }

    const transport = new SendingConfirmationTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    transport.confirm();

    const matching = store.getState().messages.get("chat-product")?.filter(
      (message) => message.content.kind === "text" &&
        message.content.text === "atomic confirmation",
    );
    expect(matching).toHaveLength(1);
    expect(matching?.[0]).toMatchObject({
      id: "700",
      renderKey: "-700",
      delivery: "sent",
    });
    expect(store.getState().removingMessages.get("chat-product") ?? []).toEqual([]);
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
      store.getState().setSearchQuery("reg:pro.*");
      await vi.advanceTimersByTimeAsync(251);
      await store.getState().searchChatMessages("reg:^needle$");

      expect(transport.chatQueries).toEqual(["project"]);
      expect(transport.messageQueries).toEqual([
        { chatId: "chat-product", query: "reg:^needle$" },
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

  it("keeps forum topic context across drafts, search, rich sends, forwarding, and read state", async () => {
    class ForumTrackingTransport extends MockTelegramTransport {
      searches: Array<{ chatId: string; query: string; topicId?: string }> = [];
      stickerSends: SendEmojiAssetInput[] = [];
      forwards: ForwardMessagesInput[] = [];
      topicReads: Array<{ chatId: string; topicId: string; messageId: string }> = [];

      override async searchChatMessages(chatId: string, query: string, limit = 100, topicId?: string) {
        this.searches.push({ chatId, query, topicId });
        return super.searchChatMessages(chatId, query, limit, topicId);
      }

      override async sendSticker(input: SendEmojiAssetInput) {
        this.stickerSends.push(structuredClone(input));
        return super.sendSticker(input);
      }

      override async forwardMessages(input: ForwardMessagesInput) {
        this.forwards.push(structuredClone(input));
        return super.forwardMessages(input);
      }

      override async markForumTopicRead(chatId: string, topicId: string, messageId: string) {
        this.topicReads.push({ chatId, topicId, messageId });
        return super.markForumTopicRead(chatId, topicId, messageId);
      }
    }

    const transport = new ForumTrackingTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().selectChat("chat-forum");
    await store.getState().loadForumTopics("chat-forum");
    await store.getState().selectForumTopic("12");
    await vi.waitFor(() => expect(
      store.getState().messages.get("chat-forum")?.some((message) => message.id === "forum-release-1"),
    ).toBe(true));

    store.getState().updateChatDraft("chat-forum", "release draft");
    await store.getState().searchChatMessages("Windows");
    await store.getState().sendSticker({
      id: "sticker:forum",
      kind: "sticker",
      fileId: 71,
      fileName: "forum.webp",
    });
    await store.getState().forwardMessages("chat-forum", ["forum-release-1"], "chat-forum", "18");
    await store.getState().markActiveChatRead();

    expect(store.getState().drafts.get("chat-forum:topic:12")).toMatchObject({
      chatId: "chat-forum",
      topicId: "12",
      text: "release draft",
    });
    expect(transport.searches.at(-1)).toEqual({ chatId: "chat-forum", query: "Windows", topicId: "12" });
    expect(transport.stickerSends.at(-1)).toMatchObject({ chatId: "chat-forum", topicId: "12" });
    expect(transport.forwards.at(-1)).toMatchObject({ toChatId: "chat-forum", toTopicId: "18" });
    expect(transport.topicReads.at(-1)).toMatchObject({ chatId: "chat-forum", topicId: "12" });
  });

  it("returns to the last topic when a forum chat is opened again", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();

    await store.getState().selectChat("chat-forum");
    await vi.waitFor(() => expect(store.getState().activeTopicId).toBe("1"));
    await store.getState().selectForumTopic("12");
    await store.getState().selectChat("chat-mia");

    await store.getState().selectChat("chat-forum");
    expect(store.getState().activeTopicId).toBe("12");
    expect(store.getState().lastForumTopicIds.get("chat-forum")).toBe("12");
  });

  it("hydrates cached forum topics and their last selection before connecting", async () => {
    const liveTransport = new MockTelegramTransport();
    const liveStore = createTelegramStore(liveTransport);
    await liveStore.getState().initialize();
    await liveStore.getState().selectChat("chat-forum");
    await vi.waitFor(() => expect(liveStore.getState().forumTopics.get("chat-forum")).toHaveLength(3));
    await liveStore.getState().selectForumTopic("12");
    const cachedSnapshot = cachedSnapshotFrom(liveStore.getState());

    class DelayedForumTransport extends MockTelegramTransport {
      private releaseConnection?: () => void;
      private connectionGate = new Promise<void>((resolve) => {
        this.releaseConnection = resolve;
      });

      override async connect(listener: Parameters<MockTelegramTransport["connect"]>[0]) {
        await this.connectionGate;
        return super.connect(listener);
      }

      release() {
        this.releaseConnection?.();
      }
    }

    const transport = new DelayedForumTransport({ cachedSnapshot });
    const store = createTelegramStore(transport);
    const initialization = store.getState().initialize();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(store.getState().activeChatId).toBe("chat-forum");
    expect(store.getState().activeTopicId).toBe("12");
    expect(store.getState().forumTopics.get("chat-forum")?.find((topic) => topic.id === "12")?.name)
      .toBe("构建与发布");
    expect(store.getState().cacheHealth).toBe("healthy");

    transport.release();
    await initialization;
  });

  it("opens an explicit forum topic atomically and reuses fresh read topic state", async () => {
    const seedStore = createTelegramStore(new MockTelegramTransport());
    await seedStore.getState().initialize();
    await seedStore.getState().selectChat("chat-forum");
    await vi.waitFor(() => expect(seedStore.getState().forumTopics.get("chat-forum")).toHaveLength(3));
    await seedStore.getState().selectForumTopic("12");
    await seedStore.getState().selectChat("chat-mia");
    const cachedSnapshot = cachedSnapshotFrom(seedStore.getState());

    class CountingForumTransport extends MockTelegramTransport {
      topicLoads = 0;
      historyTopicIds: string[] = [];
      readTopicIds: string[] = [];

      override async getForumTopics(input: Parameters<MockTelegramTransport["getForumTopics"]>[0]) {
        this.topicLoads += 1;
        return super.getForumTopics(input);
      }

      override async loadForumTopicHistory(chatId: string, topicId: string, limit = 30) {
        this.historyTopicIds.push(topicId);
        return super.loadForumTopicHistory(chatId, topicId, limit);
      }

      override async markForumTopicRead(chatId: string, topicId: string, messageId: string) {
        this.readTopicIds.push(topicId);
        return super.markForumTopicRead(chatId, topicId, messageId);
      }

      resetCounts() {
        this.topicLoads = 0;
        this.historyTopicIds = [];
        this.readTopicIds = [];
      }
    }

    const transport = new CountingForumTransport({ cachedSnapshot });
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    transport.resetCounts();

    await store.getState().selectChat("chat-forum", { forumTopicId: "1" });
    await vi.waitFor(() => expect(
      store.getState().topicHistories.get("chat-forum:topic:1")?.initialized,
    ).toBe(true));
    await vi.waitFor(() => expect(store.getState().forumTopicsLoading.size).toBe(0));
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(store.getState().activeTopicId).toBe("1");
    expect(transport.historyTopicIds).toEqual(["1"]);
    expect(transport.topicLoads).toBe(1);

    transport.resetCounts();
    for (let index = 0; index < 10; index += 1) {
      await store.getState().selectChat("chat-mia");
      await store.getState().selectChat("chat-forum");
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(transport.historyTopicIds).toEqual([]);
    expect(transport.readTopicIds).toEqual([]);
    expect(transport.topicLoads).toBe(0);
  });

  it("bounds cached forum metadata by recency and serialized size", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();
    await store.getState().selectChat("chat-forum");
    await vi.waitFor(() => expect(store.getState().forumTopics.get("chat-forum")).toHaveLength(3));
    const template = store.getState().forumTopics.get("chat-forum")?.[0];
    expect(template).toBeDefined();

    const forumTopics = new Map<string, ForumTopic[]>();
    const lastForumTopicIds = new Map<string, string>();
    for (let index = 0; index < 25; index += 1) {
      const chatId = `forum-${index}`;
      const topicId = `topic-${index}`;
      forumTopics.set(chatId, [{
        ...template!,
        id: topicId,
        chatId,
        name: `话题 ${index} ${"长名称".repeat(20)}`,
        lastMessage: {
          ...mockSnapshot.messages[0],
          id: `message-${index}`,
          chatId,
          topicId,
        },
        draft: {
          chatId,
          topicId,
          text: `草稿 ${index}`,
          updatedAt: "2026-08-08T12:00:00+08:00",
        },
      }]);
      lastForumTopicIds.set(chatId, topicId);
    }
    store.setState({
      activeChatId: "forum-0",
      activeTopicId: "topic-0",
      forumTopics,
      lastForumTopicIds,
    });

    const snapshot = cachedSnapshotFrom(store.getState());
    const cachedChatIds = snapshot.forumTopics?.map((entry) => entry.chatId) ?? [];
    const serializedForumTopics = JSON.stringify(snapshot.forumTopics ?? []);

    expect(cachedChatIds).toHaveLength(20);
    expect(cachedChatIds[0]).toBe("forum-0");
    expect(cachedChatIds).toContain("forum-24");
    expect(cachedChatIds).not.toContain("forum-1");
    expect(new TextEncoder().encode(serializedForumTopics).byteLength).toBeLessThanOrEqual(256 * 1_024);
    for (const entry of snapshot.forumTopics ?? []) {
      expect(entry.topics[0]).not.toHaveProperty("lastMessage");
      expect(entry.topics[0]).not.toHaveProperty("draft");
    }

    store.setState({ activeChatId: "chat-mia" });
    expect(cachedSnapshotFrom(store.getState()).forumTopics).toHaveLength(20);

    const heavyForumTopics = new Map([...forumTopics].map(([chatId, topics]) => [
      chatId,
      Array.from({ length: 100 }, (_, topicIndex) => ({
        ...topics[0],
        id: `${topics[0].id}-${topicIndex}`,
        name: `${topics[0].name}-${topicIndex}-${"大容量话题".repeat(64)}`,
      })),
    ]));
    store.setState({ forumTopics: heavyForumTopics });
    const boundedSnapshot = cachedSnapshotFrom(store.getState());
    const boundedTopics = boundedSnapshot.forumTopics ?? [];
    expect(new TextEncoder().encode(JSON.stringify(boundedTopics)).byteLength)
      .toBeLessThanOrEqual(256 * 1_024);
    expect(boundedTopics.reduce((count, entry) => count + entry.topics.length, 0))
      .toBeLessThan(20 * 100);
  });

  it("reloads the active conversation when live metadata changes its forum mode", async () => {
    class ForumModeTransport extends MockTelegramTransport {
      eventListener?: TelegramEventListener;
      topicLoads: string[] = [];
      historyLoads: string[] = [];

      override async connect(listener: TelegramEventListener) {
        this.eventListener = listener;
        return super.connect(listener);
      }

      override async getForumTopics(input: Parameters<MockTelegramTransport["getForumTopics"]>[0]) {
        this.topicLoads.push(input.chatId);
        return super.getForumTopics(input);
      }

      override async loadChatHistory(chatId: string, limit?: number) {
        this.historyLoads.push(chatId);
        return super.loadChatHistory(chatId, limit);
      }

      publish(chat: Chat) {
        this.eventListener?.({ type: "chat.upsert", chat });
      }
    }

    const transport = new ForumModeTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().selectChat("chat-product");
    transport.topicLoads.length = 0;
    transport.historyLoads.length = 0;
    const product = store.getState().chats.get("chat-product")!;

    transport.publish({ ...product, isForum: true });
    await vi.waitFor(() => expect(transport.topicLoads).toEqual(["chat-product"]));
    expect(store.getState().chats.get("chat-product")?.isForum).toBe(true);

    await store.getState().selectForumTopic("42");
    const histories = new Map(store.getState().histories);
    histories.delete("chat-product");
    store.setState({ histories });
    transport.publish({ ...product, isForum: false });

    await vi.waitFor(() => expect(transport.historyLoads).toEqual(["chat-product"]));
    expect(store.getState()).toMatchObject({ activeChatId: "chat-product", activeTopicId: undefined });
  });

  it("tracks remote typing state, expires it, and sends local typing state", async () => {
    class TypingTransport extends MockTelegramTransport {
      eventListener?: TelegramEventListener;
      typingWrites: Array<{ chatId: string; typing: boolean }> = [];

      override async connect(listener: TelegramEventListener) {
        this.eventListener = listener;
        return super.connect(listener);
      }

      override async setChatTyping(chatId: string, typing: boolean) {
        this.typingWrites.push({ chatId, typing });
      }

      publish(typing: boolean) {
        this.eventListener?.({
          type: "chat.typingChanged",
          chatId: "chat-product",
          senderId: "u-jules",
          typing,
        });
      }
    }

    vi.useFakeTimers();
    try {
      const transport = new TypingTransport();
      const store = createTelegramStore(transport);
      await store.getState().initialize();

      transport.publish(true);
      expect(store.getState().typingUserIds.get("chat-product")).toEqual(["u-jules"]);
      await vi.advanceTimersByTimeAsync(5_999);
      expect(store.getState().typingUserIds.get("chat-product")).toEqual(["u-jules"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(store.getState().typingUserIds.has("chat-product")).toBe(false);

      await store.getState().setChatTyping("chat-product", true);
      await store.getState().setChatTyping("chat-product", false);
      expect(transport.typingWrites).toEqual([
        { chatId: "chat-product", typing: true },
        { chatId: "chat-product", typing: false },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a new draft typed while the previous message is sending", async () => {
    class DeferredSendTransport extends MockTelegramTransport {
      resolveSend?: () => void;
      private resolveStarted?: () => void;
      readonly sendStarted = new Promise<void>((resolve) => {
        this.resolveStarted = resolve;
      });

      override async sendMessage(_input: SendMessageInput) {
        this.resolveStarted?.();
        await new Promise<void>((resolve) => { this.resolveSend = resolve; });
      }
    }

    const transport = new DeferredSendTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    store.getState().updateChatDraft("chat-product", "first message");

    const sending = store.getState().sendMessage("first message");
    await transport.sendStarted;
    store.getState().updateChatDraft("chat-product", "next message");
    transport.resolveSend?.();

    await expect(sending).resolves.toBe(true);
    expect(store.getState().drafts.get("chat-product")?.text).toBe("next message");
  });

  it("loads cache usage and protects referenced files during cleanup", async () => {
    class TrackingCacheTransport extends MockTelegramTransport {
      cleanupInput?: Parameters<MockTelegramTransport["clearMediaCache"]>[0];

      override async clearMediaCache(input: Parameters<MockTelegramTransport["clearMediaCache"]>[0]) {
        this.cleanupInput = input;
        return super.clearMediaCache(input);
      }
    }
    const transport = new TrackingCacheTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();

    await store.getState().loadCacheUsage();
    expect(store.getState().cacheUsage?.total.files).toBe(18);
    expect(await store.getState().clearMediaCache(["image", "video"], 30)).toBe(true);

    expect(transport.cleanupInput).toMatchObject({
      categories: ["image", "video"],
      olderThanDays: 30,
    });
    expect(transport.cleanupInput?.protectedPaths).toContain("/mock-video.mp4");
    expect(store.getState().cacheCleanupResult?.removedFiles).toBe(11);
    expect(store.getState().cacheUsage?.total.files).toBe(7);
  });
});

describe("global search state", () => {
  it("drops stale pages and ignores a response after cancellation", async () => {
    class DelayedSearchTransport extends MockTelegramTransport {
      requests: Array<{
        input: GlobalSearchInput;
        resolve: (page: GlobalSearchPage) => void;
      }> = [];

      override searchGlobal(input: GlobalSearchInput) {
        return new Promise<GlobalSearchPage>((resolve) => {
          this.requests.push({ input, resolve });
        });
      }
    }
    const transport = new DelayedSearchTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const first = store.getState().searchGlobal("first", "all");
    const second = store.getState().searchGlobal("second", "media");

    transport.requests[0].resolve({
      chats: [mockSnapshot.chats[0]],
      messages: [mockSnapshot.messages[0]],
      totalCount: 1,
    });
    await first;
    expect(store.getState().globalSearch).toMatchObject({
      query: "second",
      filter: "media",
      messages: [],
      loading: true,
    });

    transport.requests[1].resolve({
      chats: [mockSnapshot.chats[1]],
      messages: [mockSnapshot.messages[1]],
      totalCount: 1,
    });
    await second;
    expect(store.getState().globalSearch.messages.map((message) => message.id)).toEqual([
      mockSnapshot.messages[1].id,
    ]);

    const cancelled = store.getState().searchGlobal("cancelled", "all");
    store.getState().cancelGlobalSearch();
    transport.requests[2].resolve({
      chats: [mockSnapshot.chats[0]],
      messages: [mockSnapshot.messages[0]],
      totalCount: 1,
    });
    await cancelled;
    expect(store.getState().globalSearch).toMatchObject({
      query: "cancelled",
      messages: [],
      loading: false,
    });
  });

  it("loads an opaque next page and deduplicates repeated messages", async () => {
    class PagedSearchTransport extends MockTelegramTransport {
      requests: GlobalSearchInput[] = [];

      override async searchGlobal(input: GlobalSearchInput): Promise<GlobalSearchPage> {
        this.requests.push(input);
        return input.offset
          ? {
              chats: [mockSnapshot.chats[0]],
              messages: [mockSnapshot.messages[0], mockSnapshot.messages[1]],
            }
          : {
              chats: [mockSnapshot.chats[0]],
              messages: [mockSnapshot.messages[0]],
              nextOffset: "opaque-next",
            };
      }
    }
    const transport = new PagedSearchTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();

    await store.getState().searchGlobal("project", "all");
    await store.getState().loadMoreGlobalSearch();

    expect(transport.requests.map(({ offset }) => offset)).toEqual([undefined, "opaque-next"]);
    expect(store.getState().globalSearch.messages.map(({ id }) => id)).toEqual([
      mockSnapshot.messages[0].id,
      mockSnapshot.messages[1].id,
    ]);
    expect(store.getState().globalSearch.totalCount).toBe(2);
    expect(store.getState().globalSearch.nextOffset).toBeUndefined();
  });
});

describe("profiles and contacts state", () => {
  it("updates the current account profile and mapped user", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();
    await store.getState().loadCurrentUserProfile();

    await expect(store.getState().updateCurrentUserProfile({
      firstName: "林",
      lastName: "曦",
      username: "linxi_notgram",
      bio: "桌面端设计",
    })).resolves.toBe(true);

    expect(store.getState().accountProfile).toMatchObject({
      target: { kind: "current" },
      value: {
        title: "林 曦",
        username: "linxi_notgram",
        bio: "桌面端设计",
        dataCenterId: 5,
      },
      updating: false,
    });
    expect(store.getState().users.get("self")).toMatchObject({
      displayName: "林 曦",
      username: "linxi_notgram",
    });
  });

  it("shows a cached chat profile and revalidates it after the drawer reopens", async () => {
    class CountingProfileTransport extends MockTelegramTransport {
      chatProfileCalls = 0;

      override async getChatProfile(chatId: string) {
        this.chatProfileCalls += 1;
        return super.getChatProfile(chatId);
      }
    }

    const transport = new CountingProfileTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().loadChatProfile("chat-product");
    store.getState().clearProfile();
    await store.getState().loadChatProfile("chat-product");

    expect(transport.chatProfileCalls).toBe(2);
    expect(store.getState().profile).toMatchObject({
      target: { kind: "chat", chatId: "chat-product" },
      value: { title: "产品讨论" },
      loading: false,
    });
  });

  it("persists profiles and revalidates them when the drawer opens", async () => {
    class CountingProfileTransport extends MockTelegramTransport {
      chatProfileCalls = 0;

      override async getChatProfile(chatId: string) {
        this.chatProfileCalls += 1;
        return super.getChatProfile(chatId);
      }
    }

    const transport = new CountingProfileTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await store.getState().loadChatProfile("chat-product");

    expect(transport.chatProfileCalls).toBe(1);
    expect(store.getState().profile.target).toMatchObject({ kind: "chat", chatId: "chat-product" });
    await expect(store.getState().rebuildCachedSnapshot()).resolves.toBe(true);
    const persisted = await transport.loadCachedSnapshot();
    expect(persisted?.profiles).toEqual([
      expect.objectContaining({ chatId: "chat-product", title: "产品讨论" }),
    ]);

    const restartedTransport = new CountingProfileTransport({ cachedSnapshot: persisted });
    const restartedStore = createTelegramStore(restartedTransport);
    await restartedStore.getState().initialize();
    await restartedStore.getState().loadChatProfile("chat-product");

    expect(restartedTransport.chatProfileCalls).toBe(1);
    expect(restartedStore.getState().profile.value).toMatchObject({ title: "产品讨论" });
  });

  it("discards a profile response after a newer target is requested", async () => {
    class DelayedProfileTransport extends MockTelegramTransport {
      requests: Array<{
        chatId: string;
        resolve: (profile: ChatProfile) => void;
      }> = [];

      override getChatProfile(chatId: string) {
        return new Promise<ChatProfile>((resolve) => {
          this.requests.push({ chatId, resolve });
        });
      }
    }
    const transport = new DelayedProfileTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const first = store.getState().loadChatProfile("chat-product");
    const second = store.getState().loadChatProfile("chat-mia");
    const product = await new MockTelegramTransport().getChatProfile("chat-product");
    const mia = await new MockTelegramTransport().getChatProfile("chat-mia");

    transport.requests[0].resolve(product);
    await first;
    expect(store.getState().profile).toMatchObject({
      target: { kind: "chat", chatId: "chat-mia" },
      loading: true,
    });

    transport.requests[1].resolve(mia);
    await second;
    expect(store.getState().profile).toMatchObject({
      target: { kind: "chat", chatId: "chat-mia" },
      value: { title: "Mia Chen" },
      loading: false,
    });
  });

  it("loads contacts and merges a newly resolved private chat", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();

    await store.getState().loadContacts();
    const chatId = await store.getState().startPrivateChat("u-jules");

    expect(store.getState().contacts.map(({ id }) => id)).toContain("u-jules");
    expect(store.getState().chats.get(chatId!)).toMatchObject({ peerId: "u-jules" });
    expect(store.getState().contactPendingUserId).toBeUndefined();
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

  it("loads and merges history context around an exact target", async () => {
    const source = mockSnapshot.messages.find((message) => message.chatId === "chat-product")!;
    const before = { ...source, id: "context-before", sentAt: "2026-07-29T10:00:00Z" };
    const target = { ...source, id: "context-target", sentAt: "2026-07-29T10:01:00Z" };
    const after = { ...source, id: "context-after", sentAt: "2026-07-29T10:02:00Z" };
    class ContextTransport extends MockTelegramTransport {
      contextRequests = 0;

      override async getMessageContext(chatId: string, messageId: string) {
        this.contextRequests += 1;
        return chatId === target.chatId && messageId === target.id
          ? [before, target, after]
          : [];
      }
    }
    const transport = new ContextTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();

    await expect(store.getState().loadMessage(target.chatId, target.id)).resolves.toBe(true);

    expect(transport.contextRequests).toBe(1);
    expect(store.getState().messages.get(target.chatId)).toEqual(
      expect.arrayContaining([before, target, after]),
    );
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
      version: 3,
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

  it("applies chat management changes from confirmed transport events", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();

    await expect(store.getState().setChatPinned("main", "chat-saved", true))
      .resolves.toBe(true);
    expect(store.getState().chats.get("chat-saved")).toMatchObject({
      pinned: true,
      pinnedFolderIds: ["main"],
    });

    await expect(store.getState().setChatMuted("chat-mia", true)).resolves.toBe(true);
    expect(store.getState().chats.get("chat-mia")?.muted).toBe(true);

    await expect(store.getState().setChatArchived("chat-saved", true)).resolves.toBe(true);
    expect(store.getState().chats.get("chat-saved")?.folderIds).toContain("archive");
    expect(store.getState().chats.get("chat-saved")?.folderIds).not.toContain("main");
    expect(store.getState().chatManagementPending.size).toBe(0);
  });

  it("deduplicates concurrent group management loads", async () => {
    let release: () => void = () => undefined;
    class DeferredGroupManagementTransport extends MockTelegramTransport {
      calls = 0;

      override async getChatManagement(chatId: string, memberOffset = 0) {
        this.calls += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return super.getChatManagement(chatId, memberOffset);
      }
    }

    const transport = new DeferredGroupManagementTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const first = store.getState().loadChatManagement("chat-product");
    const second = store.getState().loadChatManagement("chat-product");

    expect(transport.calls).toBe(1);
    expect(first).toBe(second);
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(right);
    expect(store.getState().groupManagementLoading).toBe(false);
  });

  it("leaves confirmed group chats and rejects non-group chats", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();

    await expect(store.getState().leaveGroup("chat-mia")).resolves.toBe(false);
    expect(store.getState().operationError).toBe("只能退出群组会话");

    await expect(store.getState().leaveGroup("chat-product")).resolves.toBe(true);
    expect(store.getState().chats.get("chat-product")?.folderIds).toEqual([]);
    expect(store.getState().activeChatId).not.toBe("chat-product");
    expect(store.getState().chatManagementPending.size).toBe(0);
  });

  it("serializes management changes per chat and clears pending state after failure", async () => {
    let releaseMute: () => void = () => undefined;
    class DeferredManagementTransport extends MockTelegramTransport {
      archiveCalls = 0;

      override async setChatMuted(chatId: string, muted: boolean) {
        await new Promise<void>((resolve) => {
          releaseMute = resolve;
        });
        await super.setChatMuted(chatId, muted);
      }

      override async setChatArchived(chatId: string, archived: boolean) {
        this.archiveCalls += 1;
        await super.setChatArchived(chatId, archived);
      }
    }

    const transport = new DeferredManagementTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const mute = store.getState().setChatMuted("chat-mia", true);

    expect(store.getState().chatManagementPending.has("chat-mia")).toBe(true);
    await expect(store.getState().setChatArchived("chat-mia", true)).resolves.toBe(false);
    expect(transport.archiveCalls).toBe(0);
    releaseMute();
    await expect(mute).resolves.toBe(true);
    expect(store.getState().chatManagementPending.has("chat-mia")).toBe(false);

    class FailedManagementTransport extends MockTelegramTransport {
      override async setChatMuted() {
        throw new Error("通知设置同步失败");
      }
    }
    const failedStore = createTelegramStore(new FailedManagementTransport());
    await failedStore.getState().initialize();
    await expect(failedStore.getState().setChatMuted("chat-mia", true)).resolves.toBe(false);
    expect(failedStore.getState().chats.get("chat-mia")?.muted).toBe(false);
    expect(failedStore.getState().chatManagementPending.size).toBe(0);
    expect(failedStore.getState().operationError).toBe("通知设置同步失败");
  });

  it("rejects unconfirmed updates and unsupported Saved Messages mute changes", async () => {
    class UnconfirmedManagementTransport extends MockTelegramTransport {
      override async setChatPinned() {}
    }
    const transport = new UnconfirmedManagementTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();

    await expect(store.getState().setChatPinned("main", "chat-saved", true))
      .resolves.toBe(false);
    expect(store.getState().chats.get("chat-saved")?.pinned).toBe(false);
    expect(store.getState().operationError).toBe("Telegram 未确认置顶状态");

    await expect(store.getState().setChatMuted("chat-saved", true)).resolves.toBe(false);
    expect(store.getState().operationError).toBe("收藏夹不支持静音");
  });

  it("manages folder structure only after transport events confirm every change", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();

    const folderId = await store.getState().createChatFolder("客户", ["chat-mia"]);
    expect(folderId).toMatch(/^folder:/);
    expect(store.getState().folders).toContainEqual({
      id: folderId,
      title: "客户",
      iconName: "Custom",
    });
    expect(store.getState().chats.get("chat-mia")?.folderIds).toContain(folderId);

    await expect(store.getState().renameChatFolder(folderId!, "重点客户"))
      .resolves.toBe(true);
    expect(store.getState().folders.find((folder) => folder.id === folderId)?.title)
      .toBe("重点客户");

    await expect(store.getState().setChatFolderMembership(folderId!, "chat-product", true))
      .resolves.toBe(true);
    expect(store.getState().chats.get("chat-product")?.folderIds).toContain(folderId);
    await expect(store.getState().setChatFolderMembership(folderId!, "chat-mia", false))
      .resolves.toBe(true);
    expect(store.getState().chats.get("chat-mia")?.folderIds).not.toContain(folderId);

    await expect(store.getState().deleteChatFolder(folderId!)).resolves.toBe(true);
    expect(store.getState().folders.some((folder) => folder.id === folderId)).toBe(false);
    expect([...store.getState().chats.values()].every(
      (chat) => !chat.folderIds.includes(folderId!),
    )).toBe(true);
    expect(store.getState().folderManagementPending).toBe(false);
  });

  it("marks every unread chat in a folder as read", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();

    expect(store.getState().chats.get("chat-release")?.unreadCount).toBe(8);
    expect(store.getState().chats.get("chat-mia")?.unreadCount).toBe(1);
    await expect(store.getState().markChatFolderRead("folder:work")).resolves.toBe(true);

    expect(store.getState().chats.get("chat-product")?.unreadCount).toBe(0);
    expect(store.getState().chats.get("chat-release")?.unreadCount).toBe(0);
    expect(store.getState().chats.get("chat-mia")?.unreadCount).toBe(1);
    expect(store.getState().folderManagementPending).toBe(false);
  });

  it("rejects folder operations without authoritative confirmation", async () => {
    class UnconfirmedFolderTransport extends MockTelegramTransport {
      override async createChatFolder(title: string) {
        return { id: "folder:99", title, iconName: "Custom" };
      }
    }
    const store = createTelegramStore(new UnconfirmedFolderTransport());
    await store.getState().initialize();

    await expect(store.getState().createChatFolder("未确认", ["chat-mia"]))
      .resolves.toBeUndefined();
    expect(store.getState().folders.some((folder) => folder.id === "folder:99")).toBe(false);
    expect(store.getState().operationError).toBe("Telegram 未确认新文件夹");
    expect(store.getState().folderManagementPending).toBe(false);
  });

  it("queues only live mentions and replies to the current user", async () => {
    class LiveEventTransport extends MockTelegramTransport {
      private events?: TelegramEventListener;

      override async connect(listener: TelegramEventListener) {
        this.events = listener;
        return super.connect(listener);
      }

      dispatch(event: TelegramEvent) {
        this.events?.(event);
      }
    }

    const transport = new LiveEventTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const template = store.getState().messages.get("chat-product")?.at(-1)!;
    const ownMessage: Message = {
      ...template,
      id: "attention-own",
      senderId: store.getState().currentUserId!,
      outgoing: true,
      sentAt: "2026-08-07T10:00:00.000Z",
      content: { kind: "text", text: "需要回复的消息" },
    };
    transport.dispatch({ type: "message.upsert", message: ownMessage, animateEntrance: true });

    transport.dispatch({
      type: "messages.upserted",
      messages: [{
        ...template,
        id: "attention-history",
        outgoing: false,
        containsUnreadMention: true,
        sentAt: "2026-08-07T10:01:00.000Z",
      }],
    });
    expect(store.getState().unreadAttentionMessageIds.size).toBe(0);

    const mention: Message = {
      ...template,
      id: "attention-mention",
      outgoing: false,
      containsUnreadMention: true,
      sentAt: "2026-08-07T10:02:00.000Z",
      content: { kind: "text", text: "@你 请查看" },
    };
    transport.dispatch({ type: "message.upsert", message: mention, animateEntrance: true });

    const unresolvedReply: Message = {
      ...template,
      id: "attention-reply",
      outgoing: false,
      containsUnreadMention: false,
      sentAt: "2026-08-07T10:03:00.000Z",
      replyTo: { kind: "message", messageId: "attention-own" },
      content: { kind: "text", text: "这是回复" },
    };
    transport.dispatch({ type: "message.upsert", message: unresolvedReply, animateEntrance: true });
    expect(store.getState().unreadAttentionMessageIds.get("chat-product"))
      .toEqual(["attention-mention", "attention-reply"]);

    const pendingHydration: Message = {
      ...unresolvedReply,
      id: "attention-hydrated-reply",
      replyTo: { kind: "message", messageId: "missing-own" },
    };
    transport.dispatch({ type: "message.upsert", message: pendingHydration, animateEntrance: true });
    expect(store.getState().unreadAttentionMessageIds.get("chat-product"))
      .toEqual(["attention-mention", "attention-reply"]);

    const hydratedReply: Message = {
      ...pendingHydration,
      replyTo: { kind: "message", messageId: "missing-own", outgoing: true },
    };
    transport.dispatch({ type: "message.upsert", message: hydratedReply });
    expect(store.getState().unreadAttentionMessageIds.get("chat-product"))
      .toEqual(["attention-mention", "attention-reply", "attention-hydrated-reply"]);

    store.getState().dismissMessageAttention("chat-product", "attention-hydrated-reply");
    store.getState().dismissMessageAttention("chat-product", "attention-reply");
    store.getState().dismissMessageAttention("chat-product", "attention-mention");
    expect(store.getState().unreadAttentionMessageIds.has("chat-product")).toBe(false);
  });
});
