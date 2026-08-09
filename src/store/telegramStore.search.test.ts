import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyGlobalSearch } from "./globalSearchState";
import { emptyChatMessageSearch } from "./chatMessageSearchState";
import {
  createSearchController,
  type SearchControllerOptions,
} from "./telegramStore.search";
import type { TelegramState } from "./telegramStore.types";
import type { Message } from "../telegram/types";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const resultMessage = (id: string): Message => ({
  id,
  chatId: "chat-1",
  senderId: "user-1",
  outgoing: false,
  sentAt: `2026-08-09T04:00:${id.padStart(2, "0")}.000Z`,
  delivery: "sent",
  content: { kind: "text", text: `result ${id}` },
});

const createHarness = (overrides: Record<string, unknown> = {}) => {
  let state: ReturnType<SearchControllerOptions["get"]> = {
    activeChatId: "chat-1",
    activeTopicId: undefined,
    authorization: { kind: "ready" as const },
    globalSearch: emptyGlobalSearch(),
    chatMessageSearch: emptyChatMessageSearch(),
    searchQuery: "",
    chatFilter: "main",
    ...overrides,
  };
  const set = ((patch: Partial<TelegramState> | ((value: TelegramState) => Partial<TelegramState>)) => {
    const next = typeof patch === "function" ? patch(state as TelegramState) : patch;
    state = { ...state, ...next };
  }) as SearchControllerOptions["set"];
  const transport = {
    searchChatMessages: vi.fn().mockResolvedValue(undefined),
    searchGlobal: vi.fn(),
    searchChats: vi.fn().mockResolvedValue(undefined),
  } as unknown as SearchControllerOptions["transport"];
  const controller = createSearchController({
    transport,
    get: () => state,
    set,
    loadChats: vi.fn().mockResolvedValue(undefined),
    onError: (error, fallback) => error instanceof Error ? error.message : fallback,
  });
  return { controller, transport, getState: () => state };
};

afterEach(() => vi.useRealTimers());

describe("telegram store search controller", () => {
  it("ignores an older global search response after a newer query starts", async () => {
    const first = deferred<{ chats: []; messages: []; totalCount: number }>();
    const second = deferred<{ chats: []; messages: []; totalCount: number }>();
    const harness = createHarness();
    vi.mocked(harness.transport.searchGlobal)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const older = harness.controller.searchGlobal("older", "message");
    const newer = harness.controller.searchGlobal("newer", "message");
    second.resolve({ chats: [], messages: [], totalCount: 0 });
    await newer;
    first.resolve({ chats: [], messages: [], totalCount: 1 });
    await older;

    expect(harness.getState().globalSearch.query).toBe("newer");
    expect(harness.getState().globalSearch.totalCount).toBe(0);
  });

  it("debounces chat search and keeps plain queries server-backed", async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    harness.controller.setSearchQuery("  product  ");
    await vi.advanceTimersByTimeAsync(249);
    expect(harness.transport.searchChats).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.transport.searchChats).toHaveBeenCalledWith("product", 50);

    harness.controller.setSearchQuery("product");
    await vi.advanceTimersByTimeAsync(300);
    expect(harness.transport.searchChats).toHaveBeenCalledTimes(2);
  });

  it("isolates stale chat-message searches and merges cursor pages without duplicates", async () => {
    const first = deferred<{ messages: Message[]; totalCount: number; nextFromMessageId?: string; hasMore: boolean }>();
    const second = deferred<{ messages: Message[]; totalCount: number; nextFromMessageId?: string; hasMore: boolean }>();
    const harness = createHarness();
    vi.mocked(harness.transport.searchChatMessages)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce({
        messages: [resultMessage("2"), resultMessage("1")],
        totalCount: 3,
        hasMore: false,
      });

    const stale = harness.controller.searchChatMessages({ chatId: "chat-1", query: "old" });
    const current = harness.controller.searchChatMessages({ chatId: "chat-1", query: "new" });
    second.resolve({ messages: [resultMessage("3"), resultMessage("2")], totalCount: 3, nextFromMessageId: "2", hasMore: true });
    await current;
    first.resolve({ messages: [resultMessage("9")], totalCount: 1, hasMore: false });
    await stale;
    await harness.controller.loadMoreChatMessages();

    expect(harness.getState().chatMessageSearch.input?.query).toBe("new");
    expect(harness.getState().chatMessageSearch.messages.map(({ id }) => id)).toEqual(["3", "2", "1"]);
    expect(harness.transport.searchChatMessages).toHaveBeenLastCalledWith(expect.objectContaining({
      query: "new",
      fromMessageId: "2",
      limit: 30,
    }));
  });
});
