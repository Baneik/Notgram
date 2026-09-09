import { describe, expect, it, vi } from "vitest";
import { TauriTelegramTransport } from "./tauriTransport";
import { TdRequestBroker } from "./tdRequestBroker";
import type { TdObject } from "./tdlibMapper";
import type { Chat, TelegramEvent } from "./types";
import { filterAndSortChats } from "../store/telegramStore.selectors";

type Internal = {
  listener: (event: TelegramEvent) => void;
  request: (request: TdObject) => Promise<TdObject>;
  requestBroker: TdRequestBroker;
  upsertChat: (chat: TdObject) => void;
  mapChat: (chat: TdObject) => Chat;
  refreshChat: (id: string) => Promise<TdObject>;
  handleUpdateBatch: (updates: TdObject[]) => void;
  finishInitialChatSync: () => void;
  rawChats: Map<string, TdObject>;
};

const position = (folder: string, order: string, pinned = false): TdObject => ({
  list: folder === "main" ? { "@type": "chatListMain" }
    : folder === "archive" ? { "@type": "chatListArchive" }
      : { "@type": "chatListFolder", chat_folder_id: Number(folder) },
  order, is_pinned: pinned,
});
const chat = (id: number, positions = [position("main", "100")]): TdObject => ({
  "@type": "chat", id, title: `Chat ${id}`,
  type: { "@type": "chatTypePrivate", user_id: id }, positions,
});
const setup = () => {
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as Internal;
  const chats = new Map<string, Chat>();
  internal.listener = (event) => {
    if (event.type === "chat.upsert") chats.set(event.chat.id, event.chat);
    if (event.type === "chats.upserted") for (const value of event.chats) chats.set(value.id, value);
  };
  return { transport, internal, chats };
};

describe("TDLib chat position synchronization", () => {
  it.each([false, true])("keeps receive order for a chat reply and pin updates during startup=%s", async (startup) => {
    const { internal, chats } = setup();
    if (!startup) internal.finishInitialChatSync();
    internal.upsertChat(chat(7));
    const sent: TdObject[] = [];
    internal.requestBroker = new TdRequestBroker(async (_command, args) => {
      sent.push(args!.request as TdObject);
    });
    const refreshing = internal.refreshChat("7");
    internal.handleUpdateBatch([
      { ...chat(7), "@extra": sent[0]["@extra"] },
      { "@type": "updateChatPosition", chat_id: 7, position: position("main", "9223372036854775806", true) },
      { "@type": "updateChatPosition", chat_id: 7, position: position("12", "9223372036854775805", true) },
    ]);
    await refreshing;
    internal.finishInitialChatSync();
    expect(chats.get("7")).toMatchObject({
      pinnedFolderIds: ["main", "folder:12"],
      listOrderByFolder: { main: "9223372036854775806", "folder:12": "9223372036854775805" },
    });
    expect(internal.mapChat(internal.rawChats.get("7")!)).toEqual(chats.get("7"));
  });

  it("does not revive a removed position from a response resumed after a draft update", async () => {
    const { internal, chats } = setup();
    internal.finishInitialChatSync();
    const pinned = chat(7, [position("main", "900", true)]);
    internal.upsertChat(pinned);
    let request!: TdObject;
    internal.requestBroker = new TdRequestBroker(async (_command, args) => { request = args!.request as TdObject; });
    const refreshing = internal.refreshChat("7");
    internal.handleUpdateBatch([
      { ...pinned, "@extra": request["@extra"] },
      { "@type": "updateChatDraftMessage", chat_id: 7, draft_message: null, positions: [] },
    ]);
    await refreshing;
    expect(chats.get("7")).toMatchObject({ pinned: false, pinnedFolderIds: [], listOrderByFolder: {}, folderIds: [] });
  });

  it.each(["main", "archive", "folder:12"])("publishes current positions after a slow batch mate while loading %s", async (folder) => {
    const { transport, internal, chats } = setup();
    internal.finishInitialChatSync();
    internal.upsertChat(chat(7));
    let finish!: (raw: TdObject) => void;
    internal.request = vi.fn(async (request) => {
      if (request["@type"] === "getChats") return { chat_ids: [7, 8] };
      if (request["@type"] === "getChat") return new Promise<TdObject>(resolve => { finish = resolve; });
      return { "@type": "ok" };
    });
    const loading = transport.loadMoreChats(folder);
    await vi.waitFor(() => expect(finish).toBeDefined());
    internal.handleUpdateBatch([
      { "@type": "updateChatPosition", chat_id: 7, position: position("main", "800", true) },
      { "@type": "updateChatPosition", chat_id: 7, position: position("12", "700", true) },
    ]);
    finish(chat(8));
    await loading;
    expect(chats.get("7")).toMatchObject({ pinned: true, listOrderByFolder: { main: "800", "folder:12": "700" } });
    expect(filterAndSortChats(chats.values(), "folder:12", "").map(value => value.id)).toEqual(["7"]);
  });

  it("keeps updates received during basic-group metadata hydration", async () => {
    const { transport, internal, chats } = setup();
    internal.finishInitialChatSync();
    let finish!: (raw: TdObject) => void;
    internal.request = async (request) => {
      if (request["@type"] === "getChats") return { chat_ids: [7] };
      if (request["@type"] === "getChat") return { ...chat(7), type: { "@type": "chatTypeBasicGroup", basic_group_id: 70 } };
      if (request["@type"] === "getBasicGroup") return new Promise<TdObject>(resolve => { finish = resolve; });
      return { "@type": "ok" };
    };
    const loading = transport.loadMoreChats("main");
    await vi.waitFor(() => expect(finish).toBeDefined());
    internal.handleUpdateBatch([{ "@type": "updateChatPosition", chat_id: 7, position: position("main", "800", true) }]);
    finish({ "@type": "basicGroup", id: 70, member_count: 4 });
    await loading;
    expect(chats.get("7")).toMatchObject({ pinned: true, memberCount: 4, listOrderByFolder: { main: "800" } });
  });

  it.each(["updateChatLastMessage", "updateChatDraftMessage"])("uses complete snapshots from %s and deltas from updateChatPosition", (type) => {
    const { internal, chats } = setup();
    internal.finishInitialChatSync();
    internal.upsertChat({ ...chat(7, [position("main", "900", true), position("12", "800", true)]),
      chat_lists: [{ "@type": "chatListMain" }, { "@type": "chatListFolder", chat_folder_id: 12 }],
    });
    internal.handleUpdateBatch([{ "@type": type, chat_id: 7, positions: [position("12", "700")] }]);
    expect(chats.get("7")).toMatchObject({ pinned: false, pinnedFolderIds: [], folderIds: ["folder:12"], listOrderByFolder: { "folder:12": "700" } });
    internal.handleUpdateBatch([{ "@type": "updateChatPosition", chat_id: 7, position: position("main", "800", true) }]);
    expect(chats.get("7")?.listOrderByFolder).toEqual({ main: "800", "folder:12": "700" });
    internal.handleUpdateBatch([{ "@type": "updateChatPosition", chat_id: 7, position: position("12", "0") }]);
    expect(chats.get("7")?.folderIds).toEqual(["main"]);
  });

  it("does not display list membership before its first visible position", () => {
    const { internal, chats } = setup();
    internal.upsertChat({ ...chat(7, []), chat_lists: [{ "@type": "chatListMain" }] });
    internal.finishInitialChatSync();
    expect(filterAndSortChats(chats.values(), "main", "")).toEqual([]);
    internal.handleUpdateBatch([{ "@type": "updateChatPosition", chat_id: 7, position: position("main", "900", true) }]);
    expect(filterAndSortChats(chats.values(), "main", "")).toMatchObject([{ id: "7", pinned: true }]);
  });
});
