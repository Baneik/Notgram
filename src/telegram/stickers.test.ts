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
  it("downloads the thumbnail file independently from its animated sticker", async () => {
    const { transport, request } = harness();
    const pack = await transport.getStickerSet(rawSet.id);
    request.mockImplementation(async (input) => ({ "@type": "file", id: input.file_id,
      local: { path: "C:/cache/thumbnail.jpg", is_downloading_completed: true },
    }));
    request.mockClear();
    await expect(transport.loadEmojiAsset(emojiAssetPreview(pack.stickers[0])!)).resolves.toBe("C:/cache/thumbnail.jpg");
    expect(request.mock.calls.map(([input]) => input.file_id)).toEqual([72, 72]);
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
      { type: "emoji.catalogChanged" }, { type: "emoji.catalogChanged" },
    ]);
    internal.handleUpdate({ "@type": "updateRecentStickers", is_attached: true });
    internal.handleUpdate({ "@type": "updateInstalledStickerSets", sticker_type: { "@type": "stickerTypeMask" }, sticker_set_ids: [] });
    expect(events).toHaveLength(4);
  });
});
