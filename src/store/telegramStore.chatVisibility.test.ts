import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../telegram/mockData";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { mapTdChat } from "../telegram/tdlibMapper";
import type { TelegramEventListener } from "../telegram/transport";
import type { CachedTelegramSnapshot, Chat } from "../telegram/types";
import { createTelegramStore } from "./telegramStore";
import { migrateCachedSnapshot } from "./telegramStore.cache";
import { filterAndSortChats, groupChatsByFolder } from "./telegramStore.selectors";

class VisibilityTransport extends MockTelegramTransport {
  publish!: TelegramEventListener;
  saved?: CachedTelegramSnapshot;
  override async connect(listener: TelegramEventListener) {
    this.publish = listener;
    return super.connect(listener);
  }
  override async saveCachedSnapshot(snapshot: CachedTelegramSnapshot) {
    this.saved = structuredClone(snapshot);
    await super.saveCachedSnapshot(snapshot);
  }
}

const cachedChat = (id: string): Chat => ({ ...mockSnapshot.chats[0], id,
  folderIds: ["main", "folder:work"], listOrderByFolder: { main: "900", "folder:work": "800" },
});
const cache = (...chats: Chat[]): CachedTelegramSnapshot => ({ version: 4, savedAt: "2026-10-13T00:00:00Z",
  currentUserId: mockSnapshot.currentUserId, users: mockSnapshot.users, folders: mockSnapshot.folders,
  chats, messages: [{ ...mockSnapshot.messages[0], chatId: chats[0].id }],
  drafts: [{ chatId: chats[0].id, text: "Keep this draft", updatedAt: "2026-10-13T00:00:00Z", pending: true }],
});

describe("chat list visibility and cached positions", () => {
  it("uses positions in both selectors while retaining membership and searchable history", () => {
    const chat = mapTdChat({ id: -7, title: "Left group", type: { "@type": "chatTypeSupergroup", supergroup_id: 7 },
      positions: [], chat_lists: [{ "@type": "chatListMain" }, { "@type": "chatListFolder", chat_folder_id: 12 }] })!;
    expect(chat.folderIds).toEqual(["main", "folder:12"]);
    expect(chat.visibleFolderIds).toEqual([]);
    expect(filterAndSortChats([chat], "main", "")).toEqual([]);
    expect(groupChatsByFolder([chat], [{ id: "main", title: "All", iconName: "All" }]).get("main")).toEqual([]);
    expect(filterAndSortChats([chat], "main", "Left group")).toEqual([chat]);
  });

  it.each<Record<string, string>>([{}, { main: "0" }, { main: "900" }])("migrates old native cache visibility from orders %j", orders => {
    const chat = cachedChat("-7");
    chat.listOrderByFolder = orders;
    const migrated = migrateCachedSnapshot(cache(chat)).snapshot!.chats[0];
    expect(migrated.folderIds).toEqual(chat.folderIds);
    expect(filterAndSortChats([migrated], "main", "").length).toBe(orders.main === "900" ? 1 : 0);
    expect(filterAndSortChats([migrated], "folder:work", "")).toEqual([]);
  });

  it("keeps cached rows after partial or failed sync, then retires unconfirmed positions without deleting local data", async () => {
    const transport = new VisibilityTransport({ cachedSnapshot: cache(cachedChat("-7"), cachedChat("-8")) });
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    const messages = store.getState().messages.get("-7");
    const drafts = store.getState().drafts.get("-7");
    const live = { ...cachedChat("-9"), visibleFolderIds: ["main"] };
    transport.publish({ type: "chat.upsert", chat: live });
    transport.publish({ type: "chats.upserted", chats: [] });
    transport.publish({ type: "sync.error", message: "OFFLINE" });
    expect(filterAndSortChats(store.getState().chats.values(), "main", "").map(chat => chat.id)).toContain("-7");
    transport.publish({ type: "chats.upserted", chats: [], initialSyncComplete: true });
    expect(store.getState().chats.get("-7")).toMatchObject({ folderIds: ["main", "folder:work"], visibleFolderIds: [] });
    expect(store.getState().chats.get("-9")).toBe(live);
    expect(store.getState().messages.get("-7")).toBe(messages);
    expect(store.getState().drafts.get("-7")).toBe(drafts);
    expect(groupChatsByFolder(store.getState().chats.values(), mockSnapshot.folders).get("main")!.map(chat => chat.id))
      .not.toContain("-7");
    await store.getState().rebuildCachedSnapshot();
    const restarted = createTelegramStore(new VisibilityTransport({ cachedSnapshot: transport.saved }));
    await restarted.getState().initialize();
    expect(filterAndSortChats(restarted.getState().chats.values(), "main", "").map(chat => chat.id)).not.toContain("-7");
    transport.publish({ type: "chat.upsert", chat: { ...cachedChat("-8"), visibleFolderIds: ["main"] } });
    expect(filterAndSortChats(store.getState().chats.values(), "main", "").map(chat => chat.id)).toContain("-8");
  });

  it("keeps cached rows confirmed by live updates", async () => {
    const transport = new VisibilityTransport({ cachedSnapshot: cache(cachedChat("-7")) });
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    transport.publish({ type: "chat.upsert", chat: { ...cachedChat("-7"), visibleFolderIds: ["main"] } });
    transport.publish({ type: "chats.upserted", chats: [], initialSyncComplete: true });
    expect(filterAndSortChats(store.getState().chats.values(), "main", "").map(chat => chat.id)).toContain("-7");
  });

  it("clears pending cache identities across accounts", async () => {
    const transport = new VisibilityTransport({ cachedSnapshot: cache(cachedChat("-7")) });
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    expect(filterAndSortChats(store.getState().chats.values(), "main", "").map(chat => chat.id)).toContain("-7");
    await store.getState().switchAccount("account-secondary");
    const live = { ...cachedChat("-7"), visibleFolderIds: ["main"] };
    store.setState({ chats: new Map(store.getState().chats).set(live.id, live) });
    transport.publish({ type: "chats.upserted", chats: [], initialSyncComplete: true });
    expect(store.getState().chats.get("-7")).toBe(live);
  });
});
