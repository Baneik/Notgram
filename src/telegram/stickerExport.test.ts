import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TauriTelegramTransport } from "./tauriTransport";
import { stickerExportFileName } from "./stickerExport";
import type { EmojiPickerAsset } from "./types";
import type { TdObject } from "./tdlibMapper";
import type { FileDownloadQueue } from "./fileDownloadQueue";

vi.mock("@tauri-apps/api/core", async importOriginal => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn(),
}));

const asset = (fileId = 1, mimeType = "image/webp"): EmojiPickerAsset => ({
  id: `sticker-${fileId}`, kind: "sticker", fileId, mimeType, fileName: "sticker.webp",
  remoteId: `remote-${fileId}`, remoteUniqueId: `unique-${fileId}`,
  localPath: "C:/stale/old.webp", previewPath: "C:/cache/thumbnail.jpg",
});
const directory = { directory: "C:/Exports", accountId: "account-1" };
const harness = () => {
  const transport = new TauriTelegramTransport();
  const internal = transport as unknown as { request: (value: TdObject) => Promise<TdObject>; sessionGeneration: number; fileDownloads: FileDownloadQueue };
  const request = vi.fn(async (value: TdObject): Promise<TdObject> => {
    const id = String(value.remote_file_id).split("-").at(-1);
    return { id: Number(id) + 100, remote: { unique_id: `unique-${id}` },
      local: { path: `C:/cache/original-${id}`, is_downloading_completed: true } };
  });
  internal.request = request;
  vi.mocked(invoke).mockImplementation(async cmd => cmd === "telegram_choose_sticker_export_directory" ? directory : undefined);
  return { transport, internal, request };
};
afterEach(() => vi.resetAllMocks());

describe("sticker export", () => {
  it("does no file reads or downloads when the native folder dialog is cancelled", async () => {
    const { transport, request } = harness();
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await expect(transport.exportStickers([asset()], "pack")).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("exports rebound originals in pack order with their original formats", async () => {
    const { transport, request } = harness();
    await expect(transport.exportStickers([asset(), asset(2, "application/x-tgsticker"), asset(3, "video/webm")], "Cute pack")).resolves.toBe(true);
    expect(request.mock.calls.map(([value]) => value)).toEqual([1, 2, 3].map(id => ({
      "@type": "getRemoteFile", remote_file_id: `remote-${id}`, file_type: null,
    })));
    expect(invoke).toHaveBeenLastCalledWith("telegram_export_stickers", {
      ...directory, name: "Cute pack", files: [
        { sourcePath: "C:/cache/original-1", fileName: "Cute pack_001.webp" },
        { sourcePath: "C:/cache/original-2", fileName: "Cute pack_002.tgs" },
        { sourcePath: "C:/cache/original-3", fileName: "Cute pack_003.webm" },
      ],
    });
  });

  it("does not write a partial pack when one original cannot be loaded", async () => {
    const { transport, request } = harness();
    request.mockRejectedValueOnce(new Error("download failed"));
    await expect(transport.exportStickers([asset(), asset(2)], "pack")).rejects.toThrow("download failed");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects a rebound file with the wrong unique identity", async () => {
    const { transport, request } = harness();
    request.mockResolvedValueOnce({ id: 999, remote: { unique_id: "unrelated" }, local: { path: "C:/cache/wrong", is_downloading_completed: true } });
    await expect(transport.exportStickers([asset()], "pack")).rejects.toThrow("identity changed");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("cancels when the account changes while choosing the folder", async () => {
    const { transport, internal, request } = harness();
    vi.mocked(invoke).mockImplementationOnce(async () => { internal.sessionGeneration++; return directory; });
    await expect(transport.exportStickers([asset()], "pack")).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not download or write a file after an account change during rebinding", async () => {
    const { transport, internal, request } = harness();
    const download = vi.spyOn(internal.fileDownloads, "cache");
    request.mockImplementationOnce(async () => { internal.sessionGeneration++; return { id: 999, local: {} }; });
    await expect(transport.exportStickers([asset()], "pack")).resolves.toBe(false);
    expect(download).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("fetches an uncached original through the shared download queue", async () => {
    const { transport, internal, request } = harness();
    const download = vi.spyOn(internal.fileDownloads, "cache").mockResolvedValue();
    request.mockResolvedValueOnce({ id: 101, remote: { unique_id: "unique-1" }, local: {} })
      .mockResolvedValueOnce({ id: 101, local: { is_downloading_completed: true, path: "C:/cache/downloaded.tgs" } });
    await expect(transport.exportStickers([asset(1, "application/x-tgsticker")], "pack_001")).resolves.toBe(true);
    expect(download).toHaveBeenCalledExactlyOnceWith(101, 24);
    expect(invoke).toHaveBeenLastCalledWith("telegram_export_stickers", {
      ...directory, name: "pack_001", files: [{ sourcePath: "C:/cache/downloaded.tgs", fileName: "pack_001.tgs" }],
    });
  });

  it("limits simultaneous original reads to four", async () => {
    const { transport, request } = harness();
    let active = 0;
    let peak = 0;
    request.mockImplementation(async value => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      const id = String(value.remote_file_id).split("-").at(-1);
      return { id: Number(id), remote: { unique_id: `unique-${id}` }, local: { is_downloading_completed: true, path: `C:/cache/${id}` } };
    });
    await transport.exportStickers(Array.from({ length: 11 }, (_, i) => asset(i + 1)), "pack");
    expect(peak).toBe(4);
    expect(request).toHaveBeenCalledTimes(11);
  });

  it("preserves numbering and extensions for long Unicode pack names", () => {
    const first = stickerExportFileName(asset(), "可爱贴纸".repeat(100), 0, 100);
    const second = stickerExportFileName(asset(), "可爱贴纸".repeat(100), 1, 100);
    expect(first).toHaveLength(99);
    expect(first).toMatch(/_001\.webp$/);
    expect(second).toMatch(/_002\.webp$/);
  });
});
