import { afterEach, describe, expect, it, vi } from "vitest";
import { readClipboardContent, waitForClipboardFocus } from "./clipboard";

afterEach(() => vi.unstubAllGlobals());

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
