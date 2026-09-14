import { afterEach, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { mockSnapshot } from "../telegram/mockData";
import { createTelegramStore } from "./telegramStore";
import { cachedSnapshotFrom } from "./telegramStore.cache";
import { shouldAutoDownload } from "../media/autoDownload";
import type { TelegramEventListener } from "../telegram/transport";
import type { CachedTelegramSnapshot, Message, MessageFileState, TelegramEvent } from "../telegram/types";

afterEach(() => vi.useRealTimers());

const photo = (id = "old-photo", chatId = "chat-product"): Message => ({ ...mockSnapshot.messages[0],
  id, chatId, sentAt: "2026-09-07T00:00:00Z", canSave: true,
  content: { kind: "media", mediaType: "photo", fileName: "photo.jpg", sizeLabel: "83 KB", size: 85479,
    width: 589, height: 1280, fileId: 91, remoteId: id, remoteUniqueId: `${id}-unique`,
    canDownload: true, isDownloaded: false, isDownloading: true },
});

class CachedTransport extends MockTelegramTransport {
  events?: TelegramEventListener;
  override async connect(listener: TelegramEventListener) { this.events = listener; return super.connect(listener); }
  override async loadChatHistory() { return { messages: [], messageIds: [], loadedCount: 0, hasMore: false }; }
  dispatch(event: TelegramEvent) { this.events?.(event); }
}

const fixture = (messages = [photo()], connectionStatus: "online" | "offline" = "online") => {
  const snapshot: CachedTelegramSnapshot = { ...mockSnapshot, version: 4, savedAt: new Date().toISOString(),
    messages, activeChatId: "chat-product" };
  const transport = new CachedTransport({ cachedSnapshot: snapshot, connectionStatus });
  const store = createTelegramStore(transport);
  const read = (id = "old-photo", chatId = "chat-product") => store.getState().messages.get(chatId)?.find(message => message.id === id)!;
  return { transport, store, read };
};

it("rebinds an ordinary cached photo before automatic/manual download and applies completion without raw history", async () => {
  const { transport, store, read } = fixture();
  let finish!: (file: MessageFileState) => void;
  vi.spyOn(transport, "resolveRemoteFile").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const cache = vi.spyOn(transport, "cacheFile").mockResolvedValue();
  const download = vi.spyOn(transport, "downloadFile").mockResolvedValue();
  await store.getState().initialize();
  expect(read().content).toMatchObject({ fileId: undefined, canDownload: false, isDownloading: false });
  transport.dispatch({ type: "file.updated", file: { fileId: 91, remoteId: "unrelated", sizeLabel: "1 KB",
    localPath: "C:/cache/wrong.jpg", isDownloaded: true } });
  expect(read().content).toMatchObject({ fileId: undefined, isDownloaded: false });
  finish({ fileId: 191, remoteId: "old-photo", remoteUniqueId: "old-photo-unique", size: 85479,
    sizeLabel: "83 KB", canDownload: true, isDownloaded: false, isDownloading: false });
  await vi.waitFor(() => expect(read().content).toMatchObject({ fileId: 191, canDownload: true }));
  expect(shouldAutoDownload(read().content, { images: true, videos: false, audio: false, files: false, limitMb: 10 })).toBe(true);
  await store.getState().cacheFile(191, 18);
  await store.getState().downloadFile(191, "photo.jpg");
  expect(cache).toHaveBeenCalledWith(191, 18);
  expect(download).toHaveBeenCalledWith(191, "photo.jpg", undefined);
  const completed: MessageFileState = { fileId: 191, remoteId: "old-photo", remoteUniqueId: "old-photo-unique",
    sizeLabel: "83 KB", size: 85479, localPath: "C:/cache/photo.jpg", isDownloaded: true, isDownloading: false };
  transport.dispatch({ type: "file.updated", file: completed });
  expect(read().content).toMatchObject({ localPath: "C:/cache/photo.jpg", isDownloaded: true });
  const current = read();
  transport.dispatch({ type: "file.updated", file: completed });
  expect(read()).toBe(current);
  const saved = cachedSnapshotFrom(store.getState()).messages.find(message => message.id === "old-photo")!;
  expect(saved.content).toMatchObject({ fileId: undefined, remoteId: "old-photo", localPath: "C:/cache/photo.jpg" });
});

it("defers ordinary media restoration in other chats until selected", async () => {
  const { transport, store, read } = fixture([photo(), photo("other-photo", "chat-mia")]);
  const resolve = vi.spyOn(transport, "resolveRemoteFile").mockImplementation(async remoteId => ({
    fileId: remoteId === "old-photo" ? 191 : 192, remoteId, remoteUniqueId: `${remoteId}-unique`, sizeLabel: "83 KB", canDownload: true,
  }));
  await store.getState().initialize();
  await vi.waitFor(() => expect(read().content).toMatchObject({ fileId: 191 }));
  expect(resolve.mock.calls.map(args => args[0])).toEqual(["old-photo"]);
  store.getState().selectChat("chat-mia", { deferHistory: true });
  await vi.waitFor(() => expect(read("other-photo", "chat-mia").content).toMatchObject({ fileId: 192 }));
});

it("keeps an offline preview, then rebinds on reconnect", async () => {
  const original = photo();
  original.content = { ...original.content as Extract<Message["content"], { kind: "media" }>,
    localPath: "C:/cache/photo.jpg", isDownloaded: true };
  const { transport, store, read } = fixture([original], "offline");
  const resolve = vi.spyOn(transport, "resolveRemoteFile").mockResolvedValue({ fileId: 191, remoteId: "old-photo",
    remoteUniqueId: "old-photo-unique", sizeLabel: "83 KB", localPath: undefined, isDownloaded: false, canDownload: true });
  await store.getState().initialize();
  expect(resolve).not.toHaveBeenCalled();
  expect(read().content).toMatchObject({ fileId: undefined, localPath: "C:/cache/photo.jpg", isDownloaded: true });
  transport.setConnectionStatus("online");
  await vi.waitFor(() => expect(read().content).toMatchObject({ fileId: 191, localPath: undefined, isDownloaded: false }));
});

it.each(["missing", "failed", "mismatched"])("refreshes the source message when persistent identity is %s", async reason => {
  const original = photo();
  if (reason === "missing") original.content = { ...original.content as Extract<Message["content"], { kind: "media" }>,
    remoteId: undefined, remoteUniqueId: undefined };
  const { transport, store, read } = fixture([original]);
  vi.spyOn(transport, "resolveRemoteFile").mockImplementation(async () => {
    if (reason === "failed") throw new Error("Remote reference unavailable");
    return { fileId: 999, remoteId: "wrong", remoteUniqueId: "wrong", sizeLabel: "1 KB" };
  });
  const fresh = photo();
  fresh.content = { ...fresh.content as Extract<Message["content"], { kind: "media" }>, fileId: 191, isDownloading: false };
  const getMessage = vi.spyOn(transport, "getMessage").mockResolvedValue(fresh);
  await store.getState().initialize();
  await vi.waitFor(() => expect(read().content).toMatchObject({ fileId: 191 }));
  expect(getMessage).toHaveBeenCalledWith("chat-product", "old-photo");
});

it("keeps concrete native saving errors in the operation feedback", async () => {
  const { transport, store } = fixture([], "offline");
  await store.getState().initialize();
  vi.spyOn(transport, "downloadFile").mockRejectedValue("Downloaded file is outside the active TDLib files directory");
  await expect(store.getState().downloadFile(191, "photo.jpg")).rejects.toBe("Downloaded file is outside the active TDLib files directory");
  expect(store.getState().operationError).toBe("Downloaded file is outside the active TDLib files directory");
  vi.spyOn(transport, "saveFileToDownloads").mockRejectedValue("This message cannot be saved or has expired");
  await store.getState().saveFileToDownloads("C:/cache/photo.jpg", "photo.jpg");
  expect(store.getState().operationError).toBe("This message cannot be saved or has expired");
});
