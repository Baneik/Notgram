import { afterEach, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import type { TelegramEventListener } from "../telegram/transport";
import type { CachedTelegramSnapshot, Message, MessageFileState, TelegramEvent, SendMessageInput, TelegramAccount } from "../telegram/types";
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

it("retains a visible message after the transport has evicted its raw copy", async () => {
  const { store, transport, photo } = await fixture();
  transport.dispatch({ type: "message.upsert", message: photo });
  transport.dispatch({ type: "message.remove", chatId: photo.chatId, messageId: photo.id,
    permanent: true, source: "remote" });
  expect(store.getState().messages.get(photo.chatId)?.find(message => message.id === photo.id))
    .toMatchObject({ isLocallyDeleted: true, content: photo.content });
});

it("does not resurrect a deliberately removed archive from a delayed history response", async () => {
  const { store, transport, photo, archive } = await fixture();
  archive(photo);
  await store.getState().deleteMessage(photo.id, false, photo.chatId);
  transport.dispatch({ type: "messages.upserted", messages: [photo] });
  expect(store.getState().messages.get(photo.chatId)?.some(message => message.id === photo.id)).toBe(false);
});

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

it("starts caching an undownloaded sticker before a remote permanent deletion", async () => {
  const { store, transport, source, archive } = await fixture();
  const cache = vi.spyOn(transport, "cacheFile");
  const sticker: Message = {
    ...source,
    id: "retained-sticker",
    content: {
      kind: "media",
      mediaType: "sticker",
      fileName: "sticker.tgs",
      sizeLabel: "12 KB",
      fileId: 880,
      canDownload: true,
      isDownloaded: false,
      isDownloading: false,
      width: 512,
      height: 512,
      mimeType: "application/x-tgsticker",
    },
  };
  archive(sticker);
  expect(cache).toHaveBeenCalledWith(880, 48);
  expect(store.getState().messages.get(sticker.chatId)?.find(message => message.id === sticker.id))
    .toMatchObject({ isLocallyDeleted: true, content: { mediaType: "sticker", fileId: 880 } });
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

it.each([777, 778, 999])("ignores reused runtime ID %s when restoring a legacy archive", async fileId => {
  const { store: initial, photo, archive } = await fixture();
  archive(photo);
  const saved = cachedSnapshotFrom(initial.getState());
  expect(saved.locallyDeletedMessages?.[0].content).toMatchObject({ fileId: undefined, thumbnailFileId: undefined });
  // Old application versions persisted both numeric handles and active transfer flags.
  const snapshot: CachedTelegramSnapshot = JSON.parse(JSON.stringify({ ...saved, locallyDeletedMessages: [{
    ...saved.locallyDeletedMessages![0], content: { ...photo.content, thumbnailPath: "C:/cache/thumb.jpg",
      isDownloading: true, thumbnailIsDownloading: true, canDownload: true, thumbnailCanDownload: true },
  }] }));
  const transport = new RetainedTransport({ cachedSnapshot: snapshot });
  const resolve = vi.spyOn(transport, "resolveRemoteFile");
  const cache = vi.spyOn(transport, "cacheFile");
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  const read = () => store.getState().messages.get(photo.chatId)!.find(message => message.id === photo.id)!;
  const restored = read();
  expect(restored.content).toMatchObject({ fileId: undefined, thumbnailFileId: undefined,
    localPath: "C:/cache/photo.jpg", thumbnailPath: "C:/cache/thumb.jpg", isDownloaded: true,
    isDownloading: false, thumbnailIsDownloading: false, canDownload: false, thumbnailCanDownload: false });
  transport.dispatch({ type: "file.updated", file: { fileId, remoteId: "unrelated", remoteUniqueId: "other",
    sizeLabel: "4 KB", localPath: "C:/cache/unrelated.jpg", isDownloaded: true } });
  expect(read()).toBe(restored);
  expect(resolve).not.toHaveBeenCalled();
  expect(cache).not.toHaveBeenCalled();
  expect(cachedSnapshotFrom(store.getState()).locallyDeletedMessages?.[0].content)
    .toMatchObject({ localPath: "C:/cache/photo.jpg", thumbnailPath: "C:/cache/thumb.jpg" });
  const save = vi.spyOn(transport, "saveFileToDownloads");
  await store.getState().saveFileToDownloads("C:/cache/photo.jpg", "photo.jpg");
  expect(save).toHaveBeenCalledWith("C:/cache/photo.jpg", "photo.jpg");
  const copy = vi.spyOn(transport, "sendMediaCopy");
  expect(await store.getState().forwardMessages(photo.chatId, [photo.id], "chat-mia"))
    .toEqual({ forwardedCount: 0, failedMessageIds: [photo.id] });
  expect(copy).toHaveBeenCalledWith(expect.objectContaining({ content: expect.objectContaining({ fileId: undefined }) }));
});

const withRemoteIdentity = (photo: Message): Message => ({ ...photo, content: {
  ...photo.content as Extract<Message["content"], { kind: "media" }>,
  remoteId: "photo-remote", remoteUniqueId: "photo-unique",
  thumbnailRemoteId: "thumb-remote", thumbnailRemoteUniqueId: "thumb-unique",
} });

it("rebinds persisted photo and thumbnail identities independently before accepting updates or downloading", async () => {
  const { store: initial, photo, archive } = await fixture();
  archive({ ...withRemoteIdentity(photo), content: {
    ...withRemoteIdentity(photo).content as Extract<Message["content"], { kind: "media" }>,
    localPath: undefined, isDownloaded: false,
  } });
  const snapshot = JSON.parse(JSON.stringify(cachedSnapshotFrom(initial.getState())));
  const transport = new RetainedTransport({ cachedSnapshot: snapshot });
  const pending = new Map<string, (file: MessageFileState) => void>();
  vi.spyOn(transport, "resolveRemoteFile").mockImplementation(remoteId => new Promise(resolve => pending.set(remoteId, resolve)));
  const cache = vi.spyOn(transport, "cacheFile");
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  const read = () => store.getState().messages.get(photo.chatId)!.find(message => message.id === photo.id)!.content;
  expect(pending.size).toBe(2);
  expect(cache).not.toHaveBeenCalled();
  transport.dispatch({ type: "file.updated", file: { fileId: 777, remoteId: "other", remoteUniqueId: "other",
    sizeLabel: "4 KB", localPath: "C:/cache/other.jpg", isDownloaded: true } });
  expect(read()).toMatchObject({ fileId: undefined });
  expect(read()).not.toHaveProperty("localPath");
  pending.get("thumb-remote")!({ fileId: 1778, remoteId: "thumb-remote", remoteUniqueId: "thumb-unique",
    sizeLabel: "1 KB", localPath: "C:/cache/new-thumb.jpg", isDownloaded: true });
  await vi.waitFor(() => expect(read()).toMatchObject({ thumbnailFileId: 1778, thumbnailPath: "C:/cache/new-thumb.jpg" }));
  expect(cache).not.toHaveBeenCalled();
  // TDLib may return another valid remote ID for the same persistent unique ID.
  pending.get("photo-remote")!({ fileId: 1777, remoteId: "photo-remote-refreshed", remoteUniqueId: "photo-unique",
    sizeLabel: "4 KB", canDownload: true, isDownloaded: false });
  await vi.waitFor(() => expect(read()).toMatchObject({ fileId: 1777, remoteId: "photo-remote-refreshed" }));
  expect(cache).toHaveBeenCalledWith(1777, 48);
  expect(cache).not.toHaveBeenCalledWith(777, expect.anything());
  const before = read();
  transport.dispatch({ type: "file.updated", file: { fileId: 1777, remoteUniqueId: "wrong",
    sizeLabel: "4 KB", localPath: "C:/cache/wrong.jpg", isDownloaded: true } });
  expect(read()).toBe(before);
  transport.dispatch({ type: "file.updated", file: { fileId: 1777, remoteId: "photo-remote-refreshed", remoteUniqueId: "photo-unique",
    sizeLabel: "4 KB", localPath: "C:/cache/completed.jpg", isDownloaded: true } });
  expect(read()).toMatchObject({ localPath: "C:/cache/completed.jpg", thumbnailPath: "C:/cache/new-thumb.jpg" });
  const persisted = JSON.parse(JSON.stringify(cachedSnapshotFrom(store.getState()))).locallyDeletedMessages[0].content;
  expect(persisted).toMatchObject({ remoteId: "photo-remote-refreshed", remoteUniqueId: "photo-unique",
    thumbnailRemoteId: "thumb-remote", thumbnailRemoteUniqueId: "thumb-unique", localPath: "C:/cache/completed.jpg" });
  expect(persisted).not.toHaveProperty("fileId");
  expect(persisted).not.toHaveProperty("thumbnailFileId");
});

it.each(["wrong identity", "missing identity", "lookup failure"])("keeps local previews and disables unverified handles after %s", async failure => {
  const { store: initial, photo, archive } = await fixture();
  archive(withRemoteIdentity(photo));
  const transport = new RetainedTransport({ cachedSnapshot: cachedSnapshotFrom(initial.getState()) });
  vi.spyOn(transport, "resolveRemoteFile").mockImplementation(async remoteId => {
    if (failure === "lookup failure") throw new Error("inaccessible");
    return { fileId: 777, remoteId, remoteUniqueId: failure === "wrong identity" ? "wrong" : undefined,
      sizeLabel: "4 KB", localPath: "C:/cache/wrong.jpg", isDownloaded: true };
  });
  const cache = vi.spyOn(transport, "cacheFile");
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  expect(store.getState().messages.get(photo.chatId)!.find(message => message.id === photo.id)?.content)
    .toMatchObject({ fileId: undefined, thumbnailFileId: undefined, localPath: "C:/cache/photo.jpg", isDownloaded: true, canDownload: false });
  expect(cache).not.toHaveBeenCalled();
});

it("preserves completed local files when a verified lookup has lost its local state", async () => {
  const { store: initial, photo, archive } = await fixture();
  archive({ ...withRemoteIdentity(photo), content: { ...withRemoteIdentity(photo).content as Extract<Message["content"], { kind: "media" }>,
    thumbnailPath: "C:/cache/thumb.jpg" } });
  const transport = new RetainedTransport({ cachedSnapshot: cachedSnapshotFrom(initial.getState()) });
  vi.spyOn(transport, "resolveRemoteFile").mockImplementation(async remoteId => ({
    fileId: remoteId === "photo-remote" ? 1777 : 1778, remoteId,
    remoteUniqueId: remoteId === "photo-remote" ? "photo-unique" : "thumb-unique",
    sizeLabel: "4 KB", isDownloaded: false, isDownloading: false, localPath: undefined,
  }));
  const cache = vi.spyOn(transport, "cacheFile");
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  expect(store.getState().messages.get(photo.chatId)!.find(message => message.id === photo.id)?.content)
    .toMatchObject({ fileId: 1777, thumbnailFileId: 1778, localPath: "C:/cache/photo.jpg",
      thumbnailPath: "C:/cache/thumb.jpg", isDownloaded: true });
  expect(cache).not.toHaveBeenCalled();
  const download = vi.spyOn(transport, "downloadFile").mockResolvedValue();
  await store.getState().downloadFile(1777, "photo.jpg");
  expect(download).toHaveBeenCalledWith(1777, "photo.jpg", "C:/cache/photo.jpg");
});

it("does not recreate an archive deleted while its persistent file is being resolved", async () => {
  const { store: initial, photo, archive } = await fixture();
  archive(withRemoteIdentity(photo));
  const transport = new RetainedTransport({ cachedSnapshot: cachedSnapshotFrom(initial.getState()) });
  const finishes: Array<(file: MessageFileState | undefined) => void> = [];
  vi.spyOn(transport, "resolveRemoteFile").mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  await store.getState().deleteMessage(photo.id, false, photo.chatId);
  for (const finish of finishes) finish({ fileId: 1777, remoteId: "photo-remote", remoteUniqueId: "photo-unique", sizeLabel: "4 KB" });
  await Promise.resolve();
  transport.dispatch({ type: "file.updated", file: { fileId: 1777, remoteUniqueId: "photo-unique", sizeLabel: "4 KB", localPath: "C:/cache/new.jpg" } });
  expect(store.getState().messages.get(photo.chatId)!.some(message => message.id === photo.id)).toBe(false);
  expect(cachedSnapshotFrom(store.getState()).locallyDeletedMessages).toEqual([]);
});

it("discards lookups from the old account and restores the new account independently", async () => {
  const { store: initial, photo, archive } = await fixture();
  archive(withRemoteIdentity(photo));
  const snapshot = cachedSnapshotFrom(initial.getState());
  const accounts: TelegramAccount[] = ["default", "secondary"].map(id => ({ id, userId: id, displayName: id, avatar: { label: id, color: "#3390ec" } }));
  const pending = new Map<string, (file: MessageFileState | undefined) => void>();
  class SwitchingTransport extends RetainedTransport {
    active = "default";
    override async getAccountState() { return { activeAccountId: this.active, accounts }; }
    override async registerCurrentAccount() { return this.getAccountState(); }
    override async selectAccount(id: string) { this.active = id; return this.getAccountState(); }
    override async loadCachedSnapshot() { return structuredClone({ ...snapshot, accountId: this.active }); }
    override resolveRemoteFile(remoteId: string) {
      return new Promise<MessageFileState | undefined>(resolve => pending.set(`${this.active}:${remoteId}`, resolve));
    }
  }
  const transport = new SwitchingTransport();
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  expect(pending.size).toBe(2);
  expect(await store.getState().switchAccount("secondary")).toBe(true);
  expect(pending.size).toBe(4);
  const file: MessageFileState = { fileId: 1777, remoteId: "photo-remote", remoteUniqueId: "photo-unique", sizeLabel: "4 KB",
    localPath: "C:/cache/old-account.jpg", isDownloaded: true };
  pending.get("default:photo-remote")!(file);
  pending.get("default:thumb-remote")!(undefined);
  await Promise.resolve();
  const read = () => store.getState().messages.get(photo.chatId)!.find(message => message.id === photo.id)!.content;
  expect(read()).toMatchObject({ fileId: undefined, localPath: "C:/cache/photo.jpg" });
  pending.get("secondary:photo-remote")!({ ...file, fileId: 2777, localPath: "C:/cache/new-account.jpg" });
  pending.get("secondary:thumb-remote")!(undefined);
  await vi.waitFor(() => expect(read()).toMatchObject({ fileId: 2777, localPath: "C:/cache/new-account.jpg" }));
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
