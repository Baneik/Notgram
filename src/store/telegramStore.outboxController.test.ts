import { afterEach, describe, expect, it, vi } from "vitest";
import { RetryableSendError, TdRequestError } from "../telegram/sendErrors";
import { attachmentOutbox } from "./attachmentOutbox";
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
  connectionStatus: "online" | "offline";
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
  return { controller, transport, flushCachedSnapshot, getState: () => state, set };
};

describe("telegram store outbox controller", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  it("preserves the no-clear-draft contract when a discussion reply is replayed", async () => {
    const harness = createHarness();
    harness.controller.setOutbox([{ ...item("thread-reply"), discussionThreadId: "root", replyToMessageId: "comment", clearDraft: false }]);
    await harness.controller.flushOutbox();
    expect(harness.transport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ clearDraft: false, replyToMessageId: "comment" }));
  });
  it("retains the last durable version when a new write fails", async () => {
    const harness = createHarness();
    harness.controller.setOutbox([item("unsent")]);
    harness.flushCachedSnapshot.mockRejectedValueOnce(new Error("disk full"));
    expect(await harness.controller.persistOutboxState()).toBe(false);
    expect(harness.transport.clearCachedSnapshot).not.toHaveBeenCalled();
    expect(harness.getState().outbox).toEqual([item("unsent")]);
  });
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
    expect(harness.flushCachedSnapshot).toHaveBeenCalledTimes(4);
  });

  it("preserves a partial reply quote while draining the queue", async () => {
    const harness = createHarness();
    harness.controller.setOutbox([{
      ...item("quoted"),
      replyToMessageId: "source-1",
      replyQuote: { text: "selected", position: 5 },
    }]);

    await harness.controller.flushOutbox();

    expect(harness.transport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      replyToMessageId: "source-1",
      replyQuote: { text: "selected", position: 5 },
    }));
  });
  it("does not send when the durable sending marker cannot be committed", async () => {
    const harness = createHarness();
    harness.controller.setOutbox([item("one")]);
    harness.flushCachedSnapshot.mockRejectedValueOnce(new Error("disk full"));
    await harness.controller.flushOutbox();
    expect(harness.transport.sendMessage).not.toHaveBeenCalled();
    expect(harness.getState().outbox[0].status).toBe("failed");
  });

  it("keeps the completed-send acknowledgement out of automatic retries when its write fails", async () => {
    const harness = createHarness();
    harness.controller.setOutbox([item("one")]);
    harness.flushCachedSnapshot.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disk full"));
    await harness.controller.flushOutbox();
    await harness.controller.flushOutbox();
    expect(harness.transport.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.getState().cacheHealth).toBe("invalid");
  });

  it("retries a confirmed rejection with backoff without another online event", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.controller.setOutbox([item("one"), item("two")]);
    vi.mocked(harness.transport.sendMessage).mockRejectedValueOnce(new RetryableSendError(new Error("temporary"), 5_000));
    await harness.controller.flushOutbox();
    expect(harness.getState().outbox[0]).toMatchObject({ status: "queued", retryAttempt: 1 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.transport.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.transport.sendMessage).toHaveBeenCalledTimes(3);
    expect(harness.getState().outbox).toEqual([]);
  });

  it("retains retry deadlines across reconnect and does not block a different chat", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.controller.setOutbox([item("one"), item("two"), { ...item("other"), chatId: "chat-2" }]);
    vi.mocked(harness.transport.sendMessage).mockRejectedValueOnce(new RetryableSendError(new Error("flood"), 60_000));
    await harness.controller.flushOutbox();
    expect(harness.transport.sendMessage).toHaveBeenCalledTimes(2);
    expect(harness.transport.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ chatId: "chat-2" }));
    harness.set({ connectionStatus: "offline" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.transport.sendMessage).toHaveBeenCalledTimes(2);
    harness.set({ connectionStatus: "online" });
    await harness.controller.flushOutbox();
    expect(harness.getState().outbox).toEqual([]);
  });

  it.each([new TdRequestError("timeout", "unknown"), new TdRequestError("permission", "rejected", 403), new Error("IPC disconnected")])(
    "keeps ambiguous and permanent failures for review: %s", async error => {
      vi.useFakeTimers();
      const harness = createHarness();
      harness.controller.setOutbox([item("one")]);
      vi.mocked(harness.transport.sendMessage).mockRejectedValueOnce(error);
      await harness.controller.flushOutbox();
      await vi.advanceTimersByTimeAsync(180_000);
      await harness.controller.flushOutbox();
      expect(harness.transport.sendMessage).toHaveBeenCalledTimes(1);
      expect(harness.getState().outbox[0].status).toBe("failed");
    },
  );

  it("cancels old timers and late responses when the account session resets", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.controller.setOutbox([item("one")]);
    let reject!: (error: Error) => void;
    vi.mocked(harness.transport.sendMessage).mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
    const old = harness.controller.flushOutbox();
    await vi.advanceTimersByTimeAsync(0);
    harness.controller.resetOutbox();
    harness.controller.setOutbox([item("new")]);
    await harness.controller.flushOutbox();
    reject(new RetryableSendError(new Error("temporary"), 5_000));
    await old;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.getState().outbox).toEqual([]);
    expect(harness.transport.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("retries only unaccepted attachment groups and consumes the caption once", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const attachments = [{ file: { name: "a" } }, { file: { name: "b" } }] as never;
    const metadata = [{ storageId: "a" }, { storageId: "b" }] as never;
    vi.spyOn(attachmentOutbox, "get").mockResolvedValue({ attachments, metadata } as never);
    vi.spyOn(attachmentOutbox, "remove").mockResolvedValue(undefined);
    harness.controller.setOutbox([{ ...item("files"), attachments: metadata, caption: "caption", replyToMessageId: "reply", topicId: "topic" }]);
    vi.mocked(harness.transport.sendFiles).mockImplementationOnce(async input => {
      await input.onGroupAccepted?.([input.attachments[0]]);
      throw new RetryableSendError(new Error("temporary"), 5_000);
    });
    await harness.controller.flushOutbox();
    expect(harness.getState().outbox[0]).toMatchObject({ acceptedAttachmentIds: ["a"], caption: undefined });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.transport.sendFiles).toHaveBeenLastCalledWith(expect.objectContaining({
      attachments: [{ file: { name: "b" } }], caption: undefined, replyToMessageId: "reply", topicId: "topic",
    }));
    expect(harness.getState().outbox).toEqual([]);
  });

});
