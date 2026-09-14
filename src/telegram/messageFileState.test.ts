import { expect, it } from "vitest";
import { mockSnapshot } from "./mockData";
import { bindMessageFile, messageFiles, messageFilesForCache, updateMessageFile } from "./messageFileState";
import { migrateCachedSnapshot } from "../store/telegramStore.cache";
import type { Message, MessageFileState } from "./types";

const photo = (): Message => ({ ...mockSnapshot.messages[0], canSave: true, content: {
  kind: "media", mediaType: "photo", fileName: "photo.jpg", sizeLabel: "83 KB", size: 85479,
  fileId: 91, remoteId: "remote-photo", remoteUniqueId: "unique-photo", canDownload: true,
  isDownloading: true, thumbnailFileId: 92, thumbnailRemoteId: "remote-thumb",
  thumbnailRemoteUniqueId: "unique-thumb", thumbnailIsDownloading: true, thumbnailPath: "C:/cache/thumb.jpg",
} });
const completed: MessageFileState = { fileId: 191, remoteId: "new-photo-reference", remoteUniqueId: "unique-photo",
  sizeLabel: "83 KB", size: 85479, localPath: "C:/cache/photo.jpg", isDownloaded: true,
  isDownloading: false, canDownload: true, downloadedSize: 85479, progress: 1 };

it("does not restore a downloaded flag without a usable local path", () => {
  const message = photo();
  message.content = { ...message.content as Extract<Message["content"], { kind: "media" }>, isDownloaded: true, downloadedSize: 85479 };
  expect(messageFilesForCache(message).content).toMatchObject({ isDownloaded: false, downloadedSize: undefined });
});

it("migrates ordinary legacy snapshots without carrying runtime handles into a new session", () => {
  const restored = migrateCachedSnapshot({ ...mockSnapshot, version: 4, savedAt: new Date().toISOString(), messages: [photo()] })
    .snapshot!.messages[0];
  expect(restored.content).toMatchObject({ fileId: undefined, thumbnailFileId: undefined,
    remoteId: "remote-photo", remoteUniqueId: "unique-photo", isDownloading: false,
    thumbnailIsDownloading: false, thumbnailPath: "C:/cache/thumb.jpg", canDownload: false });
  expect(updateMessageFile(restored, { ...completed, fileId: 91 })).toBe(restored);
  expect(bindMessageFile(restored, "remote-photo", { ...completed, remoteUniqueId: "wrong" })).toBe(restored);
  const bound = bindMessageFile(restored, "remote-photo", completed);
  expect(bound.content).toMatchObject({ fileId: 191, isDownloaded: true, localPath: "C:/cache/photo.jpg" });
  expect(updateMessageFile(bound, completed)).toBe(bound);
});

it("binds a thumbnail independently and preserves image geometry", () => {
  const original = photo();
  original.content = { ...original.content as Extract<Message["content"], { kind: "media" }>, width: 589, height: 1280 };
  const bound = bindMessageFile(messageFilesForCache(original), "remote-thumb", {
    fileId: 192, remoteId: "remote-thumb", remoteUniqueId: "unique-thumb", sizeLabel: "1 KB",
    isDownloaded: true, localPath: "C:/cache/new-thumb.jpg",
  });
  expect(bound.content).toMatchObject({ fileId: undefined, thumbnailFileId: 192,
    thumbnailPath: "C:/cache/new-thumb.jpg", width: 589, height: 1280 });
});

it.each([false, true])("honors cache eviction while preserving only archive-owned copies (retained: %s)", retained => {
  const bound = bindMessageFile(messageFilesForCache({ ...photo(), isLocallyDeleted: retained }), "remote-photo", completed);
  const evicted = updateMessageFile(bound, { ...completed, localPath: undefined, isDownloaded: false, downloadedSize: 0, progress: undefined });
  expect(evicted.content).toMatchObject({ localPath: retained ? completed.localPath : undefined, isDownloaded: retained });
});

it("clears and rebinds nested article media and quoted media without changing text or unrelated nodes", () => {
  const message: Message = { ...photo(), replyTo: { kind: "message", messageId: "quote", content: photo().content },
    content: { kind: "rich", text: "article", isFull: true, isRtl: false, blocks: [
      { kind: "paragraph", text: [{ text: "unchanged" }] },
      { kind: "list", ordered: false, items: [{ hasCheckbox: false, checked: false, blocks: [
        { kind: "media", media: { ...photo().content as Extract<Message["content"], { kind: "media" }>,
          mediaType: "photo", hasSpoiler: false, autoplay: false, loop: false, caption: undefined } },
      ] }] },
    ] } };
  const restored = messageFilesForCache(message);
  expect(messageFiles(restored)).toHaveLength(2);
  expect(messageFiles(restored).every(file => file.fileId === undefined && file.thumbnailFileId === undefined)).toBe(true);
  const bound = bindMessageFile(restored, "remote-photo", completed);
  expect(messageFiles(bound).every(file => file.fileId === 191 && file.isDownloaded)).toBe(true);
  if (bound.content.kind !== "rich" || message.content.kind !== "rich") throw new Error("Expected article");
  expect(bound.content.blocks[0]).toBe(message.content.blocks[0]);
  expect(bound.content.text).toBe("article");
});
