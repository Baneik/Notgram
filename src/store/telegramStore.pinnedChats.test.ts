import { describe, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import type { TelegramEventListener } from "../telegram/transport";
import type { CachedTelegramSnapshot, Chat } from "../telegram/types";
import { createTelegramStore, filterAndSortChats } from "./telegramStore";
import { migrateCachedSnapshot } from "./telegramStore.cache";
import { mapTdChat } from "../telegram/tdlibMapper";

const pinnedIds = (chats: Iterable<Chat>, folder = "main") => filterAndSortChats(chats, folder, "")
  .filter(chat => chat.pinnedFolderIds?.includes(folder)).map(chat => chat.id);
const requestedOrder = ["chat-mia", "chat-product"];

class DelayedReorderTransport extends MockTelegramTransport {
  publish!: TelegramEventListener;
  release!: () => void;
  failure = false;
  acknowledgeOnly = false;
  failCache = false;
  saved?: CachedTelegramSnapshot;

  override async connect(listener: TelegramEventListener) {
    this.publish = listener;
    return super.connect(listener);
  }

  override async setPinnedChats(listId: string, ids: string[]) {
    await new Promise<void>(resolve => { this.release = resolve; });
    if (this.failure) throw new Error("reorder failed");
    if (!this.acknowledgeOnly) await super.setPinnedChats(listId, ids);
  }

  override async saveCachedSnapshot(snapshot: CachedTelegramSnapshot) {
    if (this.failCache) throw new Error("disk unavailable");
    this.saved = structuredClone(snapshot);
    await super.saveCachedSnapshot(snapshot);
  }
}

describe("pinned chat order ownership", () => {
  it.each(["connection", "authorization", "snapshot"])("loads an early-selected folder when %s becomes ready", async (readySource) => {
    class FolderTransport extends DelayedReorderTransport {
      lists: string[] = [];
      override async loadMoreChats(listId = "main") {
        this.lists.push(listId);
        return { loadedCount: 0, hasMore: false };
      }
    }
    const transport = new FolderTransport({ connectionStatus: readySource === "connection" ? "connecting" : "online" });
    const store = createTelegramStore(transport);
    if (readySource === "snapshot") store.setState({ chatFilter: "folder:work" });
    await store.getState().initialize();
    if (readySource === "authorization") {
      transport.publish({ type: "authorization.changed", state: { kind: "preparing" } });
    }
    if (readySource !== "snapshot") store.getState().setChatFilter("folder:work");
    if (readySource === "connection") transport.setConnectionStatus("online");
    if (readySource === "authorization") transport.publish({ type: "authorization.changed", state: { kind: "ready" } });
    await vi.waitFor(() => expect(transport.lists).toEqual(["folder:work"]));
    expect(store.getState().chatLists.get("folder:work")).toMatchObject({ loading: false, hasMore: false });
  });

  it.each([false, true])("keeps pending order stable and persists server order on failure=%s", async (failure) => {
    const transport = new DelayedReorderTransport();
    transport.failure = failure;
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const original = store.getState().chats.get("chat-product")!;
    const before = pinnedIds(store.getState().chats.values());
    const reordering = store.getState().reorderPinnedChats("main", requestedOrder);
    expect(pinnedIds(store.getState().chats.values())).toEqual(requestedOrder);
    transport.publish({ type: "chat.upsert", chat: { ...original, title: "Updated title", unreadCount: 42,
      listOrderByFolder: { ...original.listOrderByFolder, "folder:work": "987654321" },
    } });
    expect(pinnedIds(store.getState().chats.values())).toEqual(requestedOrder);
    await expect(store.getState().reorderPinnedChats("main", before)).resolves.toBe(false);
    // A cache write triggered by unrelated activity must not persist the preview.
    await store.getState().rebuildCachedSnapshot();
    expect(pinnedIds(transport.saved!.chats)).toEqual(before);
    transport.release();
    await expect(reordering).resolves.toBe(!failure);
    expect(pinnedIds(store.getState().chats.values())).toEqual(failure ? before : requestedOrder);
    expect(pinnedIds(transport.saved!.chats)).toEqual(failure ? before : requestedOrder);
    if (failure) expect(store.getState().chats.get("chat-product")).toMatchObject({
      title: "Updated title", unreadCount: 42, listOrderByFolder: { "folder:work": "987654321" },
    });
  });

  it("requires the confirmed order rather than accepting an acknowledgement", async () => {
    const transport = new DelayedReorderTransport();
    transport.acknowledgeOnly = true;
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const before = pinnedIds(store.getState().chats.values());
    const reordering = store.getState().reorderPinnedChats("main", requestedOrder);
    transport.release();
    await expect(reordering).resolves.toBe(false);
    expect(pinnedIds(store.getState().chats.values())).toEqual(before);
    expect(store.getState().operationError).toBe("Telegram 未确认置顶顺序");
  });

  it("preserves a remote unpin while a failed reorder is in flight", async () => {
    const transport = new DelayedReorderTransport();
    transport.failure = true;
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const reordering = store.getState().reorderPinnedChats("main", requestedOrder);
    await transport.setChatPinned("main", "chat-product", false);
    transport.release();
    await expect(reordering).resolves.toBe(false);
    expect(pinnedIds(store.getState().chats.values())).toEqual(["chat-mia"]);
    expect(pinnedIds(transport.saved!.chats)).toEqual(["chat-mia"]);
  });

  it.each([false, true])("ignores a previous account's pin reorder completion on failure=%s", async (failure) => {
    const transport = new DelayedReorderTransport();
    transport.failure = failure;
    transport.acknowledgeOnly = true;
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const reordering = store.getState().reorderPinnedChats("main", requestedOrder);
    await expect(store.getState().switchAccount("account-secondary")).resolves.toBe(true);
    const chats = store.getState().chats;
    store.setState({ operationError: "new account operation" });
    transport.release();
    await expect(reordering).resolves.toBe(false);
    expect(store.getState().chats).toBe(chats);
    expect(store.getState().operationError).toBe("new account operation");
  });

  it("keeps server-confirmed pins when the cache write fails", async () => {
    const transport = new DelayedReorderTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    transport.failCache = true;
    const reordering = store.getState().reorderPinnedChats("main", requestedOrder);
    transport.release();
    await expect(reordering).resolves.toBe(true);
    expect(pinnedIds(store.getState().chats.values())).toEqual(requestedOrder);
    expect(store.getState().cacheHealth).toBe("invalid");
    expect(store.getState().operationError).toBeUndefined();
  });

  it("keeps a confirmed pin toggle successful when saving the cache fails", async () => {
    const transport = new DelayedReorderTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    transport.failCache = true;
    await expect(store.getState().setChatPinned("main", "chat-saved", true)).resolves.toBe(true);
    expect(store.getState().chats.get("chat-saved")?.pinnedFolderIds).toContain("main");
    expect(store.getState().cacheHealth).toBe("invalid");
  });

  it.each([false, true])("ignores old-account pin toggle completions on failure=%s", async (failure) => {
    let release!: () => void;
    class ToggleTransport extends DelayedReorderTransport {
      override async setChatPinned() {
        await new Promise<void>(resolve => { release = resolve; });
        if (failure) throw new Error("old toggle failed");
      }
    }
    const store = createTelegramStore(new ToggleTransport());
    await store.getState().initialize();
    const toggling = store.getState().setChatPinned("main", "chat-saved", true);
    await store.getState().switchAccount("account-secondary");
    const pending = new Set(["chat-saved"]);
    store.setState({ chatManagementPending: pending, operationError: "new operation" });
    release();
    await expect(toggling).resolves.toBe(false);
    expect(store.getState().chatManagementPending).toBe(pending);
    expect(store.getState().operationError).toBe("new operation");
  });

  it("preserves exact per-folder orders through cache serialization and hydration", async () => {
    const transport = new DelayedReorderTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    for (const [index, id] of [7, 12].entries()) transport.publish({ type: "chat.upsert", chat: mapTdChat({
      id, title: `Chat ${id}`, type: { "@type": "chatTypePrivate", user_id: id },
      positions: [
        { list: { "@type": "chatListMain" }, order: String(9223372036854775806n - BigInt(index)), is_pinned: true },
        { list: { "@type": "chatListFolder", chat_folder_id: 12 }, order: String(9223372036854775805n + BigInt(index)), is_pinned: true },
      ],
    })! });
    await store.getState().rebuildCachedSnapshot();
    const snapshot = migrateCachedSnapshot(JSON.parse(JSON.stringify(transport.saved))).snapshot!;
    const restored = createTelegramStore(new MockTelegramTransport({ cachedSnapshot: snapshot }));
    await restored.getState().initialize();
    const chats = [...restored.getState().chats.values()].filter(chat => ["7", "12"].includes(chat.id));
    expect(pinnedIds(chats)).toEqual(["7", "12"]);
    expect(pinnedIds(chats, "folder:12")).toEqual(["12", "7"]);
    expect(chats.find(chat => chat.id === "7")?.listOrderByFolder?.main).toBe("9223372036854775806");
  });

  it("breaks equal server orders by descending numeric chat ID before message dates", () => {
    const chats = ["7", "12", "-1007", "-1012"].map((id, index) => ({
      ...mapTdChat({ id, title: id, positions: [{ list: { "@type": "chatListMain" }, order: "9223372036854775806", is_pinned: true }] })!,
      updatedAt: new Date(2026, 8, index + 1).toISOString(),
    }));
    expect(pinnedIds(chats)).toEqual(["12", "7", "-1007", "-1012"]);
  });
});
