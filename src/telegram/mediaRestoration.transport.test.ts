import { afterEach, expect, it, vi } from "vitest";
import { TauriTelegramTransport } from "./tauriTransport";
import type { TdObject } from "./tdlibMapper";
import type { TelegramEvent } from "./types";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

type Internal = {
  request: (request: TdObject) => Promise<TdObject>;
  hydrationGeneration: number;
  sessionGeneration: number;
  listener: (event: TelegramEvent) => void;
  upsertUser: (user: TdObject) => void;
  upsertChat: (chat: TdObject) => void;
  finishInitialChatSync: () => void;
  handleUpdateBatch: (updates: TdObject[], offset?: number, budget?: number) => number;
  emitMessage: (message: TdObject) => void;
  rawUsers: Map<string, TdObject>;
  rawChats: Map<string, TdObject>;
  rawMessages: Map<string, Map<string, TdObject>>;
  resetSessionState: () => void;
};
const file = (id = 7, path = ""): TdObject => ({ "@type": "file", id, size: 4_000,
  remote: { id: `remote-${id}`, unique_id: `unique-${id}` },
  local: { path, can_be_downloaded: true, is_downloading_completed: Boolean(path) },
});
const rawMessage = (id: number): TdObject => ({ "@type": "message", id, chat_id: 17,
  sender_id: { "@type": "messageSenderUser", user_id: 11 }, date: 1_700_000_000,
  content: { "@type": "messageDocument", document: { file_name: "original.txt", document: file() } },
});

it("shares an in-flight file lookup and accepts it after a conversation generation changes", async () => {
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as Internal;
  let finish!: (value: TdObject) => void;
  const request = vi.fn(() => new Promise<TdObject>(resolve => { finish = resolve; }));
  internal.request = request;
  const first = transport.resolveRemoteFile("remote-7");
  const shared = transport.resolveRemoteFile("remote-7");
  internal.hydrationGeneration++;
  finish(file(7, "C:/cache/7"));
  expect(await first).toMatchObject({ fileId: 7, localPath: "C:/cache/7" });
  expect(await shared).toEqual(await first);
  expect(request).toHaveBeenCalledTimes(1);
});

it("does not share a previous runtime's request or let its cleanup remove a new lookup", async () => {
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as Internal;
  const finishes: Array<(value: TdObject) => void> = [];
  const request = vi.fn(() => new Promise<TdObject>(resolve => finishes.push(resolve)));
  internal.request = request;
  const old = transport.resolveRemoteFile("remote-7");
  internal.sessionGeneration++;
  const current = transport.resolveRemoteFile("remote-7");
  finishes[0](file());
  await expect(old).rejects.toThrow("TDLib session superseded");
  const shared = transport.resolveRemoteFile("remote-7");
  expect(request).toHaveBeenCalledTimes(2);
  finishes[1](file(7, "C:/cache/current"));
  expect(await current).toEqual(await shared);
});

it("updates only avatar owners, including replacement and removal, without scanning unrelated users or chats", () => {
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as Internal;
  const events: TelegramEvent[] = [];
  internal.listener = event => events.push(event);
  internal.finishInitialChatSync();
  const user = (id: number, photoId: number) => ({ "@type": "user", id, first_name: String(id), profile_photo: { small: file(photoId) } });
  const chat = (id: number, photoId: number) => ({ "@type": "chat", id, title: String(id),
    type: { "@type": "chatTypePrivate", user_id: id }, photo: { small: file(photoId) } });
  internal.upsertUser(user(11, 7));
  internal.upsertChat(chat(17, 7));
  for (let id = 100; id < 1_100; id++) {
    internal.upsertUser(user(id, id));
    internal.upsertChat(chat(id, id));
  }
  let unrelatedReads = 0;
  for (let id = 100; id < 1_100; id++) {
    const rawUser = internal.rawUsers.get(String(id))!;
    const rawChat = internal.rawChats.get(String(id))!;
    const profile = rawUser.profile_photo;
    const photo = rawChat.photo;
    Object.defineProperty(rawUser, "profile_photo", { enumerable: true, get: () => { unrelatedReads++; return profile; } });
    Object.defineProperty(rawChat, "photo", { enumerable: true, get: () => { unrelatedReads++; return photo; } });
  }
  events.length = 0;
  internal.handleUpdateBatch([{ "@type": "updateFile", file: file(7, "C:/cache/avatar") }]);
  expect(unrelatedReads).toBe(0);
  expect(events.filter(event => event.type === "chat.upsert" || event.type === "user.upsert")).toHaveLength(2);
  internal.upsertUser(user(11, 8));
  internal.upsertChat({ ...chat(17, 7), photo: undefined });
  events.length = 0;
  internal.handleUpdateBatch([{ "@type": "updateFile", file: file(7, "C:/cache/old-avatar") }]);
  expect(events.map(event => event.type)).toEqual(["file.updated"]);
});

it("defers raw file maintenance when the delivery budget is exhausted and does not resurrect deleted raw messages", async () => {
  vi.useFakeTimers();
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as Internal;
  for (let id = 1; id <= 200; id++) internal.emitMessage(rawMessage(id));
  const events: TelegramEvent[] = [];
  internal.listener = event => events.push(event);
  internal.handleUpdateBatch([{ "@type": "updateFile", file: file(7, "C:/cache/completed") }, { "@type": "unknown" }], 0, 0);
  internal.rawMessages.get("17")!.delete("100");
  internal.emitMessage({ ...rawMessage(101), content: { "@type": "messageText", text: { text: "new edit", entities: [] } } });
  await vi.advanceTimersByTimeAsync(50);
  expect(internal.rawMessages.get("17")?.has("100")).toBe(false);
  expect(internal.rawMessages.get("17")?.get("101")?.content).toMatchObject({ text: { text: "new edit" } });
  const raw = internal.rawMessages.get("17")!.get("199")!;
  expect(raw.content).toMatchObject({ document: { document: { local: { path: "C:/cache/completed" } } } });
  expect(events.filter(event => event.type === "message.upsert" || event.type === "messages.upserted")).toHaveLength(1);
  internal.resetSessionState();
});
