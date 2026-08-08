import { describe, expect, it, vi } from "vitest";
import type { QueuedOutgoingMessage } from "../telegram/types";
import {
  createOutboxController,
  type OutboxControllerOptions,
} from "./telegramStore.outboxController";
import type { TelegramState } from "./telegramStore.types";

const item = (id: string): QueuedOutgoingMessage => ({
  id,
  chatId: "chat-1",
  text: `message-${id}`,
  createdAt: "2026-08-08T10:00:00.000Z",
  status: "queued",
});

interface HarnessState extends Record<string, unknown> {
  authorization: { kind: "ready" };
  connectionStatus: "online";
  currentUserId: string;
  drafts: Map<string, unknown>;
  messages: Map<string, unknown>;
  outbox: QueuedOutgoingMessage[];
  operationError?: string;
  cacheHealth: "healthy" | "invalid";
}

const createHarness = () => {
  let state: HarnessState = {
    authorization: { kind: "ready" as const },
    connectionStatus: "online" as const,
    currentUserId: "user-1",
    drafts: new Map<string, unknown>(),
    messages: new Map<string, unknown>(),
    outbox: [] as QueuedOutgoingMessage[],
    operationError: undefined as string | undefined,
    cacheHealth: "healthy" as const,
  };
  const set = ((patch: Partial<TelegramState> | ((value: TelegramState) => Partial<TelegramState>)) => {
    const next = typeof patch === "function" ? patch(state as unknown as TelegramState) : patch;
    state = { ...state, ...next } as HarnessState;
  }) as OutboxControllerOptions["set"];
  const transport = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendFiles: vi.fn().mockResolvedValue(true),
    clearCachedSnapshot: vi.fn().mockResolvedValue(undefined),
  } as unknown as OutboxControllerOptions["transport"];
  const flushCachedSnapshot = vi.fn().mockResolvedValue(undefined);
  const controller = createOutboxController({
    transport,
    get: () => state as unknown as TelegramState,
    set,
    flushCachedSnapshot,
    topicKey: (chatId, topicId) => topicId ? `${chatId}:topic:${topicId}` : chatId,
    onError: (error, fallback) => error instanceof Error ? error.message : fallback,
  });
  return { controller, transport, flushCachedSnapshot, getState: () => state };
};

describe("telegram store outbox controller", () => {
  it("keeps the rendered message projection in sync with queue state", () => {
    const harness = createHarness();
    harness.controller.setOutbox([item("queued-1")]);

    expect(harness.getState().outbox).toEqual([item("queued-1")]);
    expect(harness.getState().messages.get("chat-1")).toMatchObject([
      { content: { kind: "text", text: "message-queued-1" } },
    ]);
  });

  it("drains queued text messages serially and persists every transition", async () => {
    const harness = createHarness();
    harness.controller.setOutbox([item("one"), item("two")]);

    await harness.controller.flushOutbox();

    expect(harness.transport.sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: "message-one" }));
    expect(harness.transport.sendMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: "message-two" }));
    expect(harness.getState().outbox).toEqual([]);
    expect(harness.flushCachedSnapshot).toHaveBeenCalledTimes(2);
  });
});
