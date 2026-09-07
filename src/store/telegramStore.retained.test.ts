import { afterEach, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import type { TelegramEventListener } from "../telegram/transport";
import type { CachedTelegramSnapshot, Message, TelegramEvent, SendMessageInput, TelegramAccount } from "../telegram/types";
import { createTelegramStore, type MessageChangeEvent } from "./telegramStore";
import { preferencesStore } from "./preferencesStore";
import { cachedSnapshotFrom } from "./telegramStore.cache";
import { ManagedDownloadIndex } from "../utils/downloadManager";
import { localMediaSource } from "../media/localMediaSource";
import { messageCanBeSaved } from "../telegram/messageLifecycle";

afterEach(() => preferencesStore.setState({ deletedMessageArchiveEnabled: false }));

class RetainedTransport extends MockTelegramTransport {
  private eventListener?: TelegramEventListener;
  override async connect(listener: TelegramEventListener) {
    this.eventListener = listener;
    return super.connect(listener);
  }
  dispatch(event: TelegramEvent) { this.eventListener?.(event); }
  override async cacheFile() {}
}

async function fixture(transport = new RetainedTransport()) {
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  preferencesStore.setState({ deletedMessageArchiveEnabled: true });
  const source = store.getState().messages.get("chat-product")!.find(message => message.id === "p-1")!;
  const photo: Message = { ...source, id: "retained-photo", outgoing: false, content: {
    kind: "media", mediaType: "photo", fileId: 777, thumbnailFileId: 778, fileName: "photo.jpg", sizeLabel: "4 KB",
    isDownloaded: true, localPath: "C:/cache/photo.jpg", downloadedSize: 4000,
  } };
  const archive = (message: Message, snapshot = message) => {
    transport.dispatch({ type: "message.upsert", message });
    transport.dispatch({ type: "message.remove", chatId: message.chatId, messageId: message.id,
      permanent: true, source: "remote", preservedMessage: snapshot });
  };
  return { store, transport, photo, source, archive };
}

it("keeps a loaded photo preview and saves its local file after deletion and late history replay", async () => {
  const { store, transport, photo, archive } = await fixture();
  const stale: Message = { ...photo, content: { ...photo.content as Extract<Message["content"], { kind: "media" }>,
    localPath: undefined, isDownloaded: false, isDownloading: true } };
  archive(photo, stale);
  const changes: MessageChangeEvent[] = [];
  store.getState().subscribeMessageChanges(event => changes.push(event));
  transport.dispatch({ type: "message.upsert", message: stale });
  transport.dispatch({ type: "messages.upserted", messages: [stale] });
  const retained = store.getState().messages.get(photo.chatId)!.find(message => message.id === photo.id)!;
  expect(retained).toMatchObject({ isLocallyDeleted: true,
    content: { localPath: "C:/cache/photo.jpg", isDownloaded: true, isDownloading: false, progress: 1 } });
  expect(localMediaSource((retained.content as typeof stale.content & { localPath: string }).localPath)).toBe("C:/cache/photo.jpg");
  expect(messageCanBeSaved(retained)).toBe(true);
  for (const event of changes.filter(event => event.type === "upsert")) {
    expect(event.messages[0]).toMatchObject({ isLocallyDeleted: true, content: retained.content });
  }
  const download = vi.spyOn(transport, "downloadFile").mockResolvedValue();
  await store.getState().downloadFile(777, "photo.jpg");
  expect(download).toHaveBeenCalledWith(777, "photo.jpg", "C:/cache/photo.jpg");
  expect(cachedSnapshotFrom(store.getState()).locallyDeletedMessages?.[0].content).toMatchObject({ localPath: "C:/cache/photo.jpg" });
});

it("finishes a photo and thumbnail download after their server message has gone", async () => {
  const { store, transport, photo, archive } = await fixture();
  archive({ ...photo, content: { ...photo.content as Extract<Message["content"], { kind: "media" }>,
    localPath: undefined, isDownloaded: false } });
  transport.dispatch({ type: "file.updated", file: { fileId: 777, sizeLabel: "4 KB", isDownloaded: false, isDownloading: true, downloadedSize: 2000, progress: 0.5 } });
  expect(store.getState().messages.get(photo.chatId)!.find(message => message.id === photo.id)?.content)
    .toMatchObject({ isDownloading: true, downloadedSize: 2000 });
  for (const fileId of [777, 778]) transport.dispatch({ type: "file.updated", file: {
    fileId, sizeLabel: "4 KB", localPath: `C:/cache/${fileId}.jpg`, isDownloaded: true, isDownloading: false, progress: 1,
  } });
  expect(store.getState().messages.get(photo.chatId)!.find(message => message.id === photo.id)).toMatchObject({
    isLocallyDeleted: true, content: { fileId: 777, sizeLabel: "4 KB", localPath: "C:/cache/777.jpg", thumbnailPath: "C:/cache/778.jpg", isDownloaded: true },
  });
});

it("restores file subscriptions from the retained snapshot", async () => {
  const { store: initial, photo, archive } = await fixture();
  archive(photo);
  const snapshot: CachedTelegramSnapshot = cachedSnapshotFrom(initial.getState());
  const transport = new RetainedTransport({ cachedSnapshot: snapshot });
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  transport.dispatch({ type: "file.updated", file: { fileId: 777, sizeLabel: "4 KB", localPath: "C:/cache/restored.jpg", isDownloaded: true } });
  expect(store.getState().messages.get(photo.chatId)!.find(message => message.id === photo.id)?.content)
    .toMatchObject({ localPath: "C:/cache/restored.jpg", isDownloaded: true });
});

it("removes retained files from incremental indexes and does not recreate them on later file updates", async () => {
  const { store, transport, photo, archive } = await fixture();
  archive(photo);
  const index = new ManagedDownloadIndex(store.getState().messages);
  const events: MessageChangeEvent[] = [];
  store.getState().subscribeMessageChanges(event => {
    events.push(event);
    if (event.type === "remove") index.remove(event.chatId, event.messageIds);
  });
  expect(index.createRequest("default", 777, "photo.jpg", store.getState().chats).messageId).toBe(photo.id);
  await store.getState().deleteMessage(photo.id, false, photo.chatId);
  expect(events).toContainEqual({ type: "remove", chatId: photo.chatId, messageIds: [photo.id] });
  expect(index.createRequest("default", 777, "photo.jpg", store.getState().chats).messageId).toBeUndefined();
  transport.dispatch({ type: "file.updated", file: { fileId: 777, sizeLabel: "4 KB", localPath: "C:/cache/photo.jpg", isDownloaded: true } });
  expect(store.getState().messages.get(photo.chatId)!.some(message => message.id === photo.id)).toBe(false);
});

it("sends retained media and live batches in their original order", async () => {
  const { store, transport, photo, archive } = await fixture();
  archive(photo);
  const calls: string[] = [];
  const forward = transport.forwardMessages.bind(transport);
  vi.spyOn(transport, "forwardMessages").mockImplementation(async input => { calls.push(...input.messageIds); return forward(input); });
  const copy = transport.sendMediaCopy.bind(transport);
  vi.spyOn(transport, "sendMediaCopy").mockImplementation(async input => { calls.push(photo.id); return copy(input); });
  const result = await store.getState().forwardMessages(photo.chatId, ["p-1", photo.id, "p-2", "p-3"], "chat-mia");
  expect(calls).toEqual(["p-1", photo.id, "p-2", "p-3"]);
  expect(result).toEqual({ forwardedCount: 4, failedMessageIds: [] });
  expect(store.getState().messages.get("chat-mia")!.some(message =>
    message.content.kind === "media" && message.content.fileId === 777)).toBe(true);
  expect(transport.forwardMessages).toHaveBeenCalledTimes(2);
});

it("reports an unavailable retained media file as a failure without sending its name as text", async () => {
  const { store, transport, photo, archive } = await fixture();
  archive({ ...photo, content: { ...photo.content as Extract<Message["content"], { kind: "media" }>, fileId: undefined } });
  const sendText = vi.spyOn(transport, "sendMessage");
  expect(await store.getState().forwardMessages(photo.chatId, [photo.id, "p-2"], "chat-mia"))
    .toEqual({ forwardedCount: 1, failedMessageIds: [photo.id] });
  expect(sendText).not.toHaveBeenCalled();
});

it.each([false, true])("cancels retained forwarding and its description on account switch (rejection: %s)", async reject => {
  const accounts: TelegramAccount[] = ["default", "secondary"].map(id => ({ id, userId: id, displayName: id, avatar: { label: id, color: "#3390ec" } }));
  let finish!: () => void;
  const gate = new Promise<void>((resolve, rejectPromise) => { finish = () => reject ? rejectPromise(new Error("runtime closed")) : resolve(); });
  class SwitchingTransport extends RetainedTransport {
    active = "default";
    sent: SendMessageInput[] = [];
    override async getAccountState() { return { activeAccountId: this.active, accounts }; }
    override async registerCurrentAccount() { return this.getAccountState(); }
    override async selectAccount(id: string) { this.active = id; return this.getAccountState(); }
    override async sendMessage(input: SendMessageInput) { this.sent.push(input); if (this.sent.length === 1) await gate; }
  }
  const transport = new SwitchingTransport();
  const { store, source, archive } = await fixture(transport);
  const ids = ["retained-first", "retained-second"];
  for (const id of ids) archive({ ...source, id, outgoing: false, content: { kind: "text", text: id } });
  const forwarding = store.getState().forwardMessages(source.chatId, ids, "chat-mia", undefined, "description");
  expect(transport.sent).toHaveLength(1);
  await store.getState().switchAccount("secondary");
  finish();
  expect(await forwarding).toBeUndefined();
  expect(transport.sent).toHaveLength(1);
  expect(store.getState().operationError).toBeUndefined();
});
