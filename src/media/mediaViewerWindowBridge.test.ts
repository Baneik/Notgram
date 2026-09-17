import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  createMediaViewerWindowId,
  mediaViewerWindowRoute,
  closeMediaViewerWindowSession,
  openMediaViewerWindow,
  syncMediaViewerWindow,
  type MediaViewerWindowMessage,
} from "./mediaViewerWindowBridge";
import type { PhotoMessage } from "../utils/mediaViewerModel";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => false), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));

describe("media viewer window routing", () => {
  it("creates identifiers accepted by the native window label validator", () => {
    const id = createMediaViewerWindowId();
    expect(id).toMatch(/^[a-zA-Z0-9]+$/);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it("routes descriptors to the standalone media viewer entry", () => {
    expect(mediaViewerWindowRoute("viewer123")).toBe("/windows/media-viewer-window.html?id=viewer123");
  });
});

class ViewerChannel {
  static current: ViewerChannel;
  onmessage?: (event: { data: MediaViewerWindowMessage }) => void;
  sent: MediaViewerWindowMessage[] = [];
  closed = false;
  constructor() { ViewerChannel.current = this; }
  postMessage(message: MediaViewerWindowMessage) { this.sent.push(message); }
  close() { this.closed = true; }
  receive(message: MediaViewerWindowMessage) { this.onmessage?.({ data: message }); }
}

const photos: PhotoMessage[] = Array.from({ length: 15 }, (_, index) => ({
  id: String(index), chatId: "chat", senderId: "sender", sentAt: "2026-09-14", outgoing: false, delivery: "read",
  content: { kind: "media", mediaType: "photo", fileName: `${index}.jpg`, sizeLabel: "1 MB", fileId: index + 1,
    thumbnailFileId: index + 101, canDownload: true, thumbnailCanDownload: true },
}));
let sessionId: string | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(isTauri).mockReturnValue(false);
  vi.mocked(invoke).mockReset();
  vi.stubGlobal("BroadcastChannel", ViewerChannel);
  vi.stubGlobal("open", () => ({}));
});
afterEach(() => {
  if (sessionId) closeMediaViewerWindowSession(sessionId);
  sessionId = undefined;
  vi.useRealTimers(); vi.unstubAllGlobals();
});

async function openSession(cache = vi.fn().mockResolvedValue(undefined), save = vi.fn().mockResolvedValue(undefined)) {
  const pending = openMediaViewerWindow({ messages: photos, activeMessageId: "6", colorTheme: "dark" }, vi.fn().mockResolvedValue(undefined), save, undefined, cache);
  const channel = ViewerChannel.current;
  return { pending, channel, cache };
}

describe("viewer session synchronization", () => {
  beforeEach(() => {
    vi.stubGlobal("open", (url: string) => { sessionId = new URL(url, "http://localhost").searchParams.get("id")!; return {}; });
  });
  it("coalesces file updates, tracks navigation, and caches only the settled selection", async () => {
    const { pending, channel, cache } = await openSession();
    channel.receive({ type: "ready", id: sessionId! });
    await pending;
    channel.receive({ type: "active", id: sessionId!, messageId: "6" });
    channel.receive({ type: "active", id: sessionId!, messageId: "10" });
    await vi.advanceTimersByTimeAsync(100);
    expect(cache).toHaveBeenCalledWith(11, 32);
    expect(cache).not.toHaveBeenCalledWith(7, 32);
    expect(cache.mock.calls.filter(([, priority]) => priority === 8)).toHaveLength(9);
    const changed = photos.map(photo => ({ ...photo, content: { ...photo.content, progress: 0.5 } }));
    syncMediaViewerWindow(changed, "dark");
    syncMediaViewerWindow(changed, "light");
    await vi.advanceTimersByTimeAsync(32);
    expect(channel.sent.filter(message => message.type === "sync")).toEqual([
      { type: "sync", id: sessionId, messages: changed, colorTheme: "light" },
    ]);
    channel.receive({ type: "ready", id: sessionId! });
    expect(channel.sent.at(-1)).toMatchObject({ type: "init", descriptor: { activeMessageId: "10" } });
    channel.receive({ type: "active", id: sessionId!, messageId: "missing" });
    await vi.advanceTimersByTimeAsync(100);
    expect(cache).toHaveBeenCalledTimes(10);
  });
  it("cancels queued work when the viewer closes", async () => {
    const { pending, channel, cache } = await openSession();
    channel.receive({ type: "ready", id: sessionId! }); await pending;
    channel.receive({ type: "active", id: sessionId!, messageId: "6" });
    syncMediaViewerWindow([...photos], "light");
    closeMediaViewerWindowSession(sessionId!);
    await vi.advanceTimersByTimeAsync(200);
    expect(cache).not.toHaveBeenCalled();
    expect(channel.sent.filter(message => message.type === "sync")).toHaveLength(0);
    expect(channel.closed).toBe(true);
  });
  it("reports failed file actions to the requesting viewer", async () => {
    const save = vi.fn().mockRejectedValue(new Error("save failed"));
    const { pending, channel } = await openSession(undefined, save);
    channel.receive({ type: "ready", id: sessionId! }); await pending;
    channel.receive({ type: "save", id: sessionId!, sourcePath: "/fixture.jpg", fileName: "fixture.jpg", requestId: 7 });
    await vi.advanceTimersByTimeAsync(0);
    expect(channel.sent.at(-1)).toEqual({ type: "action-result", id: sessionId, requestId: 7, failed: true });
  });
  it("settles an opening request when a newer viewer supersedes it", async () => {
    const first = await openSession();
    const second = await openSession();
    second.channel.receive({ type: "ready", id: sessionId! });
    await expect(first.pending).resolves.toBeUndefined();
    await expect(second.pending).resolves.toBe(sessionId);
    expect(first.channel.closed).toBe(true);
    expect(second.channel.closed).toBe(false);
  });
  it("cancels before native creation finishes and closes the late window", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    let finishCreation: () => void = () => undefined;
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === "notgram_open_media_viewer_window") {
        sessionId = (args as { id: string }).id;
        return new Promise(resolve => { finishCreation = () => resolve(undefined); });
      }
      return Promise.resolve(undefined);
    });
    const { pending, channel } = await openSession();
    closeMediaViewerWindowSession(sessionId!);
    await expect(pending).resolves.toBeUndefined();
    expect(channel.closed).toBe(true);
    finishCreation();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "notgram_close_media_viewer_window")).toHaveLength(2);
  });
});
