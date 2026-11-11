import { afterEach, describe, expect, it, vi } from "vitest";
import { copyMessageContent, readClipboardContent, waitForClipboardFocus } from "./clipboard";
import type { Message } from "../telegram/types";
import type { PhotoMessage } from "./mediaViewerModel";

afterEach(() => vi.unstubAllGlobals());

describe("message copying", () => {
  const photo: PhotoMessage = {
    id: "photo", chatId: "chat", senderId: "sender", outgoing: false, sentAt: "2026-11-11T00:00:00Z", delivery: "read",
    content: { kind: "media", mediaType: "photo", fileName: "photo.png", sizeLabel: "1 KB",
      localPath: "/original.png", thumbnailPath: "/thumbnail.png", caption: "Album caption" },
  };

  const clipboard = () => {
    const write = vi.fn(async (_items: unknown[]) => undefined);
    const writeText = vi.fn(async (_text: string) => undefined);
    const fetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["pixels"], { type: "image/png" }) }));
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("ClipboardItem", class { constructor(public data: Record<string, Blob>) {} });
    return { write, writeText, fetch };
  };

  it("copies the original image without a text alternative even when it has a caption", async () => {
    const { write, writeText, fetch } = clipboard();
    await copyMessageContent(photo);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/original.png");
    const item = write.mock.calls[0][0][0] as { data: Record<string, Blob> };
    expect(Object.keys(item.data)).toEqual(["image/png"]);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies shared album text explicitly without fetching an image", async () => {
    const { write, writeText, fetch } = clipboard();
    await copyMessageContent(photo, "text", "Shared caption\nsecond line");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("Shared caption\nsecond line");
    expect(fetch).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("reports an unavailable image instead of silently copying its caption", async () => {
    const { writeText, write } = clipboard();
    const message: Message = { ...photo, content: { ...photo.content, localPath: undefined, thumbnailPath: undefined } };
    await expect(copyMessageContent(message)).rejects.toThrow("image is unavailable");
    expect(writeText).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("does not replace a failed image write with its caption", async () => {
    const { write, writeText } = clipboard();
    write.mockRejectedValueOnce(new Error("Clipboard denied"));
    await expect(copyMessageContent(photo)).rejects.toThrow("Clipboard denied");
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each<Message>([
    { ...photo, canSave: false }, { ...photo, selfDestruct: true },
    { ...photo, expiresAt: "2020-01-01T00:00:00Z" },
  ])("preserves export restrictions for both image and explicit text", async message => {
    const { write, writeText, fetch } = clipboard();
    await expect(copyMessageContent(message)).rejects.toThrow("cannot be saved");
    await expect(copyMessageContent(message, "text", "caption")).rejects.toThrow("cannot be saved");
    expect(fetch).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(writeText).not.toHaveBeenCalled();
  });
});

describe("clipboard content", () => {
  it("falls back to text when a WebView denies the richer read API", async () => {
    vi.stubGlobal("navigator", { clipboard: {
      read: async () => { throw new DOMException("Denied", "NotAllowedError"); },
      readText: async () => "plain text\nsecond line",
    } });
    expect(await readClipboardContent()).toEqual({ text: "plain text\nsecond line", files: [] });
  });

  it("prefers one PNG representation and excludes an image item's text fallback", async () => {
    const getType = vi.fn(async (type: string) => new Blob(["image bytes"], { type }));
    vi.stubGlobal("navigator", { clipboard: {
      read: async () => [{ types: ["image/jpeg", "text/plain", "image/png"], getType }],
    } });
    const content = await readClipboardContent();
    expect(content.text).toBe("");
    expect(content.files).toHaveLength(1);
    expect(content.files[0].type).toBe("image/png");
    expect(getType).toHaveBeenCalledExactlyOnceWith("image/png");
  });

  it("reports a failed image read instead of replacing it with fallback text", async () => {
    const readText = vi.fn(async () => "image fallback");
    vi.stubGlobal("navigator", { clipboard: {
      read: async () => [{ types: ["image/png"], getType: async () => { throw new Error("Unreadable image"); } }],
      readText,
    } });
    await expect(readClipboardContent()).rejects.toThrow("Unreadable image");
    expect(readText).not.toHaveBeenCalled();
  });

  it("returns no content for an empty clipboard", async () => {
    vi.stubGlobal("navigator", { clipboard: { read: async () => [] } });
    expect(await readClipboardContent()).toEqual({ text: "", files: [] });
  });
});

describe("clipboard focus handoff", () => {
  it("waits until the document is both visible and focused", async () => {
    const window = new EventTarget();
    const document = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: (): boolean => false });
    vi.stubGlobal("window", window); vi.stubGlobal("document", document);
    let ready = false;
    const waiting = waitForClipboardFocus(new AbortController().signal).then(() => { ready = true; });
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve(); expect(ready).toBe(false);
    document.hasFocus = () => true;
    document.visibilityState = "hidden";
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve(); expect(ready).toBe(false);
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await waiting; expect(ready).toBe(true);
  });

  it("cancels a pending handoff when the originating operation is revoked", async () => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => false }));
    const controller = new AbortController();
    const waiting = waitForClipboardFocus(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});
