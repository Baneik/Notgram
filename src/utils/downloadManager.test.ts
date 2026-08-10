import { describe, expect, it } from "vitest";
import { collectManagedDownloads, formatDownloadSize } from "./downloadManager";
import type { Chat, Message } from "../telegram/types";

const chat: Chat = {
  id: "chat", kind: "group", folderIds: ["main"], title: "项目群",
  avatar: { label: "项", color: "#000" }, preview: "", updatedAt: new Date(0).toISOString(),
  unreadCount: 0, pinned: false, muted: false,
};

const message = (id: string, content: Message["content"]): Message => ({
  id, chatId: "chat", senderId: "user", outgoing: false,
  sentAt: `2026-08-09T00:00:0${id}.000Z`, delivery: "sent", content,
});

describe("download manager", () => {
  it("collects only explicit downloads, deduplicates files, and uses downloaded bytes", () => {
    const items = collectManagedDownloads(new Map([["chat", [
      message("1", { kind: "media", mediaType: "video", fileName: "demo.mp4", sizeLabel: "10 MB", fileId: 7, size: 10_000, downloadedSize: 2_500, canDownload: true, isDownloading: true, progress: 1 }),
      message("2", { kind: "file", fileName: "demo-copy.mp4", sizeLabel: "10 MB", fileId: 7, size: 10_000, canDownload: true }),
      message("3", { kind: "media", mediaType: "voice", fileName: "voice.ogg", sizeLabel: "1 KB", fileId: 9, canDownload: true }),
      message("5", { kind: "file", fileName: "automatic.zip", sizeLabel: "2 KB", fileId: 11, size: 2_000, isDownloaded: true }),
      message("4", { kind: "media", mediaType: "photo", fileName: "photo.jpg", sizeLabel: "1 KB", fileId: 10, canDownload: true }),
    ]]]), new Map([["chat", chat]]), [
      { accountId: "account", fileId: 7, fileName: "demo.mp4", requestedAt: "2026-08-09T01:00:00.000Z" },
      { accountId: "account", fileId: 9, fileName: "voice.ogg", requestedAt: "2026-08-09T02:00:00.000Z" },
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ fileId: 7, status: "downloading", chatTitle: "项目群", progress: 0.25, transferredSize: 2_500 });
    expect(items[1]).toMatchObject({ fileId: 9, kind: "voice", status: "pending", progress: 0 });
  });

  it("formats transfer sizes", () => {
    expect(formatDownloadSize(1536)).toBe("1.5 KB");
    expect(formatDownloadSize()).toBe("大小未知");
  });
});
