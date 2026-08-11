import { describe, expect, it, vi } from "vitest";
import {
  collectManagedDownloads,
  createManagedDownloadRequest,
  formatDownloadSize,
  readManagedDownloadRequests,
  writeManagedDownloadRequests,
} from "./downloadManager";
import type { Chat, Message } from "../telegram/types";

const chat: Chat = {
  id: "chat", kind: "group", folderIds: ["main"], title: "项目群",
  avatar: { label: "项", color: "#000" }, preview: "", updatedAt: new Date(0).toISOString(),
  unreadCount: 0, unreadMentionCount: 0, pinned: false, muted: false,
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

  it("keeps persisted task records visible when their messages are not loaded", () => {
    const items = collectManagedDownloads(new Map(), new Map(), [{
      accountId: "account",
      fileId: 12,
      fileName: "archive.zip",
      requestedAt: "2026-08-09T03:00:00.000Z",
      chatId: "chat",
      chatTitle: "项目群",
      messageId: "12",
      sentAt: "2026-08-09T00:00:00.000Z",
      kind: "file",
      size: 4_096,
      status: "completed",
    }]);

    expect(items).toEqual([expect.objectContaining({
      fileId: 12,
      status: "completed",
      chatTitle: "项目群",
      progress: 1,
      transferredSize: 4_096,
    })]);
  });

  it("captures source metadata when creating a managed task", () => {
    const source = message("7", {
      kind: "media",
      mediaType: "audio",
      fileName: "episode.mp3",
      sizeLabel: "8 MB",
      fileId: 18,
      size: 8_000_000,
      canDownload: true,
    });
    const record = createManagedDownloadRequest(
      "account",
      18,
      "episode.mp3",
      new Map([["chat", [source]]]),
      new Map([["chat", chat]]),
    );

    expect(record).toMatchObject({
      accountId: "account",
      chatId: "chat",
      chatTitle: "项目群",
      messageId: "7",
      kind: "audio",
      size: 8_000_000,
      status: "pending",
    });
  });

  it("persists completed history but requeues interrupted work after restart", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    });
    try {
      writeManagedDownloadRequests([
        {
          accountId: "account",
          fileId: 20,
          fileName: "active.zip",
          requestedAt: "2026-08-09T04:00:00.000Z",
          status: "downloading",
        },
        {
          accountId: "account",
          fileId: 21,
          fileName: "done.zip",
          requestedAt: "2026-08-09T05:00:00.000Z",
          status: "completed",
        },
      ]);
      const restored = readManagedDownloadRequests();
      expect(restored.get("account:20")?.status).toBe("pending");
      expect(restored.get("account:21")?.status).toBe("completed");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
