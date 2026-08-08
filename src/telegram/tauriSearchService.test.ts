import { describe, expect, it, vi } from "vitest";
import { TauriSearchService, type TauriSearchServiceContext } from "./tauriSearchService";

const createHarness = () => {
  const rawChats = new Map();
  const context: TauriSearchServiceContext = {
    request: vi.fn(),
    rawChats,
    upsertChat: vi.fn(),
    mapChat: vi.fn((raw) => ({
      id: String(raw.id),
      kind: "direct" as const,
      title: "Result",
      avatar: { label: "R", color: "#888888" },
      folderIds: ["main"],
      isForum: false,
      preview: "",
      updatedAt: "2026-08-08T10:00:00.000Z",
      unreadCount: 0,
      pinned: false,
      muted: false,
    })),
    mapMessage: vi.fn(),
    emitMessage: vi.fn(),
    emitMessages: vi.fn(),
  };
  return { context, service: new TauriSearchService(context) };
};

describe("tauri search service", () => {
  it("bounds server chat search and hydrates returned chat ids", async () => {
    const harness = createHarness();
    vi.mocked(harness.context.request)
      .mockResolvedValueOnce({ "@type": "chats", chat_ids: ["42"] })
      .mockResolvedValueOnce({ "@type": "chat", id: "42" });

    await harness.service.searchChats("  product ", 500);

    expect(harness.context.request).toHaveBeenNthCalledWith(1, {
      "@type": "searchChatsOnServer",
      query: "product",
      limit: 100,
    });
    expect(harness.context.upsertChat).toHaveBeenCalledWith({ "@type": "chat", id: "42" });
  });

  it("short-circuits empty global queries without touching TDLib", async () => {
    const harness = createHarness();

    await expect(harness.service.searchGlobal({ query: "  ", filter: "all" }))
      .resolves.toEqual({ chats: [], messages: [], totalCount: 0 });
    expect(harness.context.request).not.toHaveBeenCalled();
  });
});
