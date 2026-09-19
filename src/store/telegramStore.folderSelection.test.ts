import { describe, expect, it } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { createTelegramStore } from "./telegramStore";
import { cachedSnapshotFrom, migrateCachedSnapshot } from "./telegramStore.cache";
import type { CachedTelegramSnapshot } from "../telegram/types";
import type { TelegramEventListener } from "../telegram/transport";

describe("per-folder chat selection", () => {
  it("isolates folder memories across account switches", async () => {
    class AccountTransport extends MockTelegramTransport {
      account = "default";
      snapshots = new Map<string, CachedTelegramSnapshot>();
      override async getAccountState() {
        return { activeAccountId: this.account, accounts: ["default", "second"].map(id => ({
          id, userId: id, displayName: id, avatar: { label: id, color: "#3390ec" },
        })) };
      }
      override async registerCurrentAccount() { return this.getAccountState(); }
      override async selectAccount(id: string) { this.account = id; return this.getAccountState(); }
      override async saveCachedSnapshot(snapshot: CachedTelegramSnapshot) { this.snapshots.set(this.account, snapshot); }
      override async loadCachedSnapshot() { return this.snapshots.get(this.account); }
    }
    const store = createTelegramStore(new AccountTransport());
    await store.getState().initialize();
    store.getState().selectChat("chat-mia");
    expect(await store.getState().switchAccount("second")).toBe(true);
    expect(store.getState().lastFolderChatIds.size).toBe(0);
    store.getState().selectChat("chat-product");
    expect(await store.getState().switchAccount("default")).toBe(true);
    expect(store.getState().lastFolderChatIds.get("main")).toBe("chat-mia");
  });

  it("does not repopulate an empty folder with an unrelated server update", async () => {
    class EventTransport extends MockTelegramTransport {
      emit?: TelegramEventListener;
      override async connect(listener: TelegramEventListener) { this.emit = listener; return super.connect(listener); }
    }
    const transport = new EventTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    store.getState().clearChatSelection();
    transport.emit?.({ type: "chat.upsert", chat: store.getState().chats.get("chat-product")! });
    expect(store.getState().activeChatId).toBeUndefined();
  });

  it("remembers only member chats and round-trips through account cache", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();
    store.getState().selectChat("chat-mia");
    store.getState().setChatFilter("folder:work");
    store.getState().selectChat("chat-product");
    store.getState().selectChat("chat-mia"); // A search result outside the folder must not replace its selection.
    expect(store.getState().lastFolderChatIds.get("folder:work")).toBe("chat-product");
    expect(store.getState().lastFolderChatIds.get("main")).toBe("chat-mia");
    const snapshot = cachedSnapshotFrom(store.getState());
    const restored = createTelegramStore(new MockTelegramTransport({ cachedSnapshot: snapshot }));
    await restored.getState().initialize();
    expect(restored.getState().lastFolderChatIds).toEqual(store.getState().lastFolderChatIds);
  });
  it("drops deleted memberships and malformed cache entries", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();
    store.setState({ lastFolderChatIds: new Map([["main", "chat-mia"], ["folder:work", "chat-mia"], ["deleted", "chat-product"]]) });
    const snapshot = cachedSnapshotFrom(store.getState());
    expect(snapshot.lastFolderChatIds).toEqual([{ folderId: "main", chatId: "chat-mia" }]);
    expect(migrateCachedSnapshot({ ...snapshot, lastFolderChatIds: [null, { folderId: 7 }, ...snapshot.lastFolderChatIds!] }).snapshot?.lastFolderChatIds)
      .toEqual(snapshot.lastFolderChatIds);
  });
  it("clears an empty folder selection without forgetting another folder", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();
    store.getState().selectChat("chat-mia");
    store.getState().clearChatSelection();
    expect(store.getState().activeChatId).toBeUndefined();
    expect(store.getState().lastFolderChatIds.get("main")).toBe("chat-mia");
  });
});
