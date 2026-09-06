import { afterEach, describe, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { mockSnapshot } from "../telegram/mockData";
import type { CachedTelegramSnapshot, LocalUnsentState } from "../telegram/types";
import { createTelegramStore } from "./telegramStore";

const initializeMetadata = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("./accountMetadata", async (importOriginal) => ({
  ...await importOriginal<typeof import("./accountMetadata")>(),
  initializeAccountMetadata: initializeMetadata,
}));

const localState = (): LocalUnsentState => ({
  currentUserId: "self", savedAt: "2026-09-01T00:00:00Z",
  drafts: [{ chatId: "chat-product", text: "only durable copy", updatedAt: "2026-09-01T00:00:00Z", pending: true }],
  localAttachmentDrafts: [],
  outbox: [{ id: "interrupted", chatId: "chat-product", text: "possibly sent", createdAt: "2026-09-01T00:00:00Z", status: "sending" }],
});

afterEach(() => { vi.useRealTimers(); initializeMetadata.mockReset().mockResolvedValue(); });

describe("independent local state recovery", () => {
  it.each(["invalid shape", "unsupported version", "read failure"])("preserves durable drafts after a cache %s", async (failure) => {
    vi.useFakeTimers();
    const local = localState();
    const transport = Object.assign(new MockTelegramTransport({ connectionStatus: "offline" }), {
      loadLocalState: vi.fn(async () => structuredClone(local)),
      saveLocalState: vi.fn(async () => {}),
      loadCachedSnapshot: vi.fn(async () => {
        if (failure === "read failure") throw new Error("damaged cache");
        return { ...structuredClone(mockSnapshot), savedAt: local.savedAt,
          version: failure === "unsupported version" ? 99 : 4,
          chats: failure === "invalid shape" ? null : [],
        } as unknown as CachedTelegramSnapshot;
      }),
    });
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getState().phase).toBe("ready");
    expect(store.getState().drafts.get("chat-product")?.text).toBe("only durable copy");
    expect(store.getState().outbox[0]).toMatchObject({ id: "interrupted", status: "failed" });
    expect(transport.saveLocalState).toHaveBeenCalledWith("default", expect.objectContaining({
      drafts: [expect.objectContaining({ chatId: "chat-product", text: "only durable copy" })],
      outbox: [expect.objectContaining({ id: "interrupted", status: "failed" })],
    }));
  });

  it("does not overwrite unreadable durable state with empty data", async () => {
    vi.useFakeTimers();
    const transport = Object.assign(new MockTelegramTransport(), {
      loadLocalState: vi.fn(async () => ({ ...localState(), outbox: null }) as unknown as LocalUnsentState),
      saveLocalState: vi.fn(async () => {}),
    });
    const connect = vi.spyOn(transport, "connect");
    const saveCache = vi.spyOn(transport, "saveCachedSnapshot");
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await vi.advanceTimersByTimeAsync(10001);
    expect(store.getState().phase).toBe("error");
    expect(connect).not.toHaveBeenCalled();
    expect(transport.saveLocalState).not.toHaveBeenCalled();
    expect(saveCache).not.toHaveBeenCalled();
  });

  it("connects when noncritical account metadata is unavailable", async () => {
    initializeMetadata.mockRejectedValueOnce(new Error("metadata unavailable"));
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();
    expect(store.getState().phase).toBe("ready");
    expect(store.getState().chats.size).toBeGreaterThan(0);
  });
});
