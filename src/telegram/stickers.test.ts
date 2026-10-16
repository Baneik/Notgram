import { describe, expect, it, vi } from "vitest";
import { TauriTelegramTransport } from "./tauriTransport";
import type { TdObject } from "./tdlibMapper";
import type { TelegramEvent } from "./types";
import { knownUnsupportedTelegramLink, telegramStickerSetName } from "./telegramLinks";
import { emojiAssetPreview } from "../media/emojiAssetPreview";

const rawSet = {
  "@type": "stickerSet", id: "5368324170671202286", title: "Pack", name: "test_pack",
  sticker_type: { "@type": "stickerTypeRegular" }, is_installed: false, is_archived: false,
  stickers: [{ id: "5368324170671202287", set_id: "5368324170671202286", emoji: "🙂", width: 512, height: 512,
    format: { "@type": "stickerFormatTgs" },
    sticker: { id: 71, local: { is_downloading_completed: false } },
    thumbnail: { format: { "@type": "thumbnailFormatJpeg" }, file: { id: 72, local: { is_downloading_completed: false } } },
  }],
};
const harness = () => {
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as {
    request: (request: TdObject) => Promise<TdObject>;
    listener: (event: TelegramEvent) => void;
    handleUpdate: (update: TdObject) => void;
  };
  const request = vi.fn(async (_request: TdObject): Promise<TdObject> => rawSet);
  const events: TelegramEvent[] = [];
  internal.request = request;
  internal.listener = (event) => events.push(event);
  return { transport, internal, request, events };
};

describe("sticker contracts", () => {
  it("delivers stickers before a stalled GIF list and still delivers GIFs when ready", async () => {
    const { transport, request } = harness();
    let finish!: (value: TdObject) => void;
    request.mockImplementation(async input => input["@type"] === "getSavedAnimations"
      ? new Promise<TdObject>(resolve => { finish = resolve; })
      : input["@type"] === "getRecentStickers" ? { stickers: rawSet.stickers } : { sets: [] });
    const partial = vi.fn();
    const reading = transport.getEmojiPickerCatalog(partial);
    await vi.waitFor(() => expect(partial).toHaveBeenCalledOnce());
    expect(partial.mock.calls[0][0].recentStickers).toHaveLength(1);
    finish({ animations: [] });
    expect((await reading).recentStickers).toHaveLength(1);
  });

  it("persists remote identities and sends restored stickers without reading or downloading media", async () => {
    const { transport, request } = harness();
    request.mockResolvedValueOnce({ ...rawSet, stickers: [{ ...rawSet.stickers[0],
      sticker: { id: 71, remote: { id: "remote-sticker", unique_id: "stable-sticker" }, local: {} },
      thumbnail: { ...rawSet.stickers[0].thumbnail, file: { id: 72, remote: { id: "remote-thumbnail" }, local: {} } },
    }] });
    const set = await transport.getStickerSet(rawSet.id);
    expect(set.stickers[0]).toMatchObject({ remoteId: "remote-sticker", remoteUniqueId: "stable-sticker", previewRemoteId: "remote-thumbnail" });
    request.mockReset();
    request.mockResolvedValue({ "@type": "ok" });
    await transport.sendSticker({ chatId: "7", asset: set.stickers[0] });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({ "@type": "sendMessage",
      input_message_content: { sticker: { sticker: { "@type": "inputFileRemote", id: "remote-sticker" } } } });
  });

  it("resolves the current file ID for a persisted thumbnail independently of its old numeric ID", async () => {
    const { transport, request } = harness();
    request.mockResolvedValue({ "@type": "file", id: 993, local: { is_downloading_completed: true, path: "C:/cache/rebound.jpg" } });
    await expect(transport.loadEmojiAsset({ id: "persisted", kind: "sticker", fileId: 72, remoteId: "remote-thumbnail", fileName: "thumbnail" }, 16))
      .resolves.toBe("C:/cache/rebound.jpg");
    expect(request).toHaveBeenCalledExactlyOnceWith({ "@type": "getRemoteFile", remote_file_id: "remote-thumbnail", file_type: null });
  });
  it("loads the thumbnail file independently from its animated sticker", async () => {
    const { transport, request } = harness();
    const pack = await transport.getStickerSet(rawSet.id);
    request.mockImplementation(async (input) => ({ "@type": "file", id: input.file_id,
      local: { path: "C:/cache/thumbnail.jpg", is_downloading_completed: true },
    }));
    request.mockClear();
    await expect(transport.loadEmojiAsset(emojiAssetPreview(pack.stickers[0])!)).resolves.toBe("C:/cache/thumbnail.jpg");
    expect(request).toHaveBeenCalledExactlyOnceWith({ "@type": "getFile", file_id: 72 });
  });

  it("reads a locally cached sticker while all download slots are occupied", async () => {
    const { transport, internal, request } = harness();
    const queue = (internal as unknown as { fileDownloads: import("./fileDownloadQueue").FileDownloadQueue }).fileDownloads;
    request.mockImplementation(async (input) => ({ "@type": "file", id: input.file_id,
      local: input["@type"] === "getFile"
        ? { path: "C:/cache/sticker.webp", is_downloading_completed: true }
        : { is_downloading_completed: false, is_downloading_active: true },
    }));
    const downloads = Array.from({ length: 12 }, (_, index) => queue.cache(100 + index, 28).catch(() => undefined));
    request.mockClear();
    const loading = transport.loadEmojiAsset({ id: "cached", kind: "sticker", fileId: 71, fileName: "sticker.webp" }).catch(() => undefined);
    try {
      await Promise.resolve();
      expect(request).toHaveBeenCalledExactlyOnceWith({ "@type": "getFile", file_id: 71 });
      await expect(loading).resolves.toBe("C:/cache/sticker.webp");
    } finally {
      queue.reset();
      await Promise.all([...downloads, loading]);
    }
  });

  it("sends by file ID before a cold sticker download finishes", async () => {
    const { transport, internal, request } = harness();
    const queue = (internal as unknown as { fileDownloads: import("./fileDownloadQueue").FileDownloadQueue }).fileDownloads;
    request.mockImplementation(async (input) => input["@type"] === "sendMessage" ? { "@type": "ok" } : {
      "@type": "file", id: input.file_id, local: { is_downloading_completed: false, is_downloading_active: true },
    });
    const asset = { id: "cold", kind: "sticker" as const, fileId: 71, fileName: "sticker.webp" };
    const loading = transport.loadEmojiAsset(asset).catch(() => undefined);
    try {
      await Promise.resolve();
      await transport.sendSticker({ chatId: "7", asset, replyToMessageId: "12", topicId: "9", disableNotification: true });
      expect(queue.get(71)).toBeDefined();
      expect(request.mock.calls.find(([input]) => input["@type"] === "sendMessage")?.[0]).toMatchObject({
        chat_id: 7, topic_id: { "@type": "messageTopicForum", forum_topic_id: 9 },
        reply_to: { message_id: 12 }, options: { disable_notification: true },
        input_message_content: { sticker: { sticker: { "@type": "inputFileId", id: 71 } } },
      });
    } finally {
      queue.reset();
      await loading;
    }
  });
  it.each(["https://t.me/addstickers/test_pack", "telegram.me/addstickers/test_pack", "tg://addstickers?set=test_pack"])("resolves %s to the reusable pack preview", async (url) => {
    expect(telegramStickerSetName(url)).toBe("test_pack");
    expect(knownUnsupportedTelegramLink(url)).toBeUndefined();
    const { transport, request } = harness();
    await expect(transport.resolveTelegramLink(url)).resolves.toMatchObject({ kind: "stickerSet", stickerSet: {
      id: rawSet.id, isInstalled: false, stickers: [{ previewFileId: 72, previewMimeType: "image/jpeg" }],
    } });
    expect(request).toHaveBeenCalledExactlyOnceWith({ "@type": "searchStickerSet", name: "test_pack", ignore_cache: false });
  });

  it("keeps malformed links and custom emoji packs out of ordinary sticker installation", async () => {
    expect(telegramStickerSetName("https://t.me/addstickers/test/extra")).toBeUndefined();
    expect(telegramStickerSetName("tg://addstickers?set=../foo")).toBeUndefined();
    expect(knownUnsupportedTelegramLink("https://t.me/addemoji/test_pack")).toMatchObject({ kind: "unsupported" });
    const { transport, request } = harness();
    request.mockResolvedValue({ ...rawSet, sticker_type: { "@type": "stickerTypeCustomEmoji" } });
    await expect(transport.resolveTelegramLink("https://t.me/addstickers/test_pack")).resolves.toMatchObject({ kind: "unsupported" });
  });

  it("reads outline data without downloading sticker media, and supports removal", async () => {
    const { transport, request } = harness();
    request.mockResolvedValueOnce({ "@type": "text", text: "M0 0L512 512Z" });
    await expect(transport.getStickerOutline(71)).resolves.toBe("M0 0L512 512Z");
    expect(request).toHaveBeenLastCalledWith({ "@type": "getStickerOutlineSvgPath", sticker_file_id: 71, for_animated_emoji: false, for_clicked_animated_emoji_message: false });
    await transport.removeStickerSet(rawSet.id);
    expect(request).toHaveBeenLastCalledWith({ "@type": "changeStickerSet", set_id: rawSet.id, is_installed: false, is_archived: false });
    expect(request.mock.calls.some(([call]) => call["@type"] === "downloadFile")).toBe(false);
  });

  it("routes ordinary pack, installation, recent and saved animation changes", () => {
    const { internal, events } = harness();
    internal.handleUpdate({ "@type": "updateStickerSet", sticker_set: rawSet });
    internal.handleUpdate({ "@type": "updateInstalledStickerSets", sticker_type: { "@type": "stickerTypeRegular" }, sticker_set_ids: [rawSet.id] });
    internal.handleUpdate({ "@type": "updateRecentStickers", is_attached: false });
    internal.handleUpdate({ "@type": "updateSavedAnimations" });
    expect(events).toMatchObject([
      { type: "stickerSet.updated", stickerSet: { id: rawSet.id, isInstalled: false } },
      { type: "emoji.catalogChanged", installedStickerSetIds: [rawSet.id] },
      { type: "emoji.catalogChanged", section: "stickers" }, { type: "emoji.catalogChanged", section: "animations" },
    ]);
    internal.handleUpdate({ "@type": "updateRecentStickers", is_attached: true });
    internal.handleUpdate({ "@type": "updateInstalledStickerSets", sticker_type: { "@type": "stickerTypeMask" }, sticker_set_ids: [] });
    expect(events).toHaveLength(4);
  });
});
