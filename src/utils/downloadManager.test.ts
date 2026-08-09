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
  it("collects supported media and deduplicates completed files", () => {
    const items = collectManagedDownloads(new Map([["chat", [
      message("1", { kind: "media", mediaType: "video", fileName: "demo.mp4", sizeLabel: "10 MB", fileId: 7, size: 10_000, canDownload: true, isDownloading: true, progress: 0.4 }),
      message("2", { kind: "file", fileName: "demo.mp4", sizeLabel: "10 MB", fileId: 7, size: 10_000, isDownloaded: true }),
      message("3", { kind: "media", mediaType: "voice", fileName: "voice.ogg", sizeLabel: "1 KB", fileId: 9, canDownload: true }),
      message("4", { kind: "media", mediaType: "photo", fileName: "photo.jpg", sizeLabel: "1 KB", fileId: 10, canDownload: true }),
    ]]]), new Map([["chat", chat]]));

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ fileId: 7, status: "completed", chatTitle: "项目群" });
    expect(items[1]).toMatchObject({ fileId: 9, kind: "voice", status: "pending" });
  });

  it("formats transfer sizes", () => {
    expect(formatDownloadSize(1536)).toBe("1.5 KB");
    expect(formatDownloadSize()).toBe("大小未知");
  });
});
