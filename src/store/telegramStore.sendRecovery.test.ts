import { afterEach, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { RetryableSendError, TdRequestError } from "../telegram/sendErrors";
import type { OutgoingAttachment } from "../telegram/types";
import { createTelegramStore } from "./telegramStore";
import { migrateLocalUnsentState } from "./telegramStore.cache";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("durably queues an online rejection and sends once after recovery without losing a newer draft", async () => {
  const transport = new MockTelegramTransport();
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  const source = store.getState().messages.get("chat-product")!.find(message => message.content.kind === "text")!;
  const quote = { text: source.content.kind === "text" ? source.content.text.slice(0, 3) : "", position: 0 };
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const sends = vi.spyOn(transport, "sendMessage").mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
  const pending = store.getState().sendMessage("original", source.id, quote, undefined, true);
  await vi.advanceTimersByTimeAsync(0);
  const drafts = new Map(store.getState().drafts);
  drafts.set("chat-product", { chatId: "chat-product", text: "newer draft", updatedAt: new Date().toISOString() });
  store.setState({ drafts });
  reject(new RetryableSendError(new Error("temporary"), 5_000));
  expect(await pending).toBe(true);
  expect(store.getState().outbox[0]).toMatchObject({ text: "original", status: "queued", disableNotification: true });
  expect(store.getState().drafts.get("chat-product")?.text).toBe("newer draft");
  await vi.advanceTimersByTimeAsync(6_000);
  expect(sends).toHaveBeenCalledTimes(2);
  expect(sends).toHaveBeenLastCalledWith(expect.objectContaining({
    text: "original", clearDraft: false, replyToMessageId: source.id, replyQuote: quote, disableNotification: true,
  }));
  expect(store.getState().outbox).toHaveLength(0);
  expect(store.getState().messages.get("chat-product")?.filter(message => message.content.kind === "text" && message.content.text === "original")).toHaveLength(1);
});

it("does not duplicate an online send whose acknowledgement timed out", async () => {
  const transport = new MockTelegramTransport();
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  vi.useFakeTimers();
  const sends = vi.spyOn(transport, "sendMessage").mockRejectedValueOnce(new TdRequestError("timeout", "unknown"));
  expect(await store.getState().sendMessage("uncertain")).toBe(false);
  transport.setConnectionStatus("recovering");
  transport.setConnectionStatus("online");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(sends).toHaveBeenCalledTimes(1);
  expect(store.getState().outbox).toHaveLength(0);
});

it("does not enqueue an old account's delayed rejection after switching away and back", async () => {
  const transport = new MockTelegramTransport();
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  let reject!: (error: Error) => void;
  vi.spyOn(transport, "sendMessage").mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
  const pending = store.getState().sendMessage("old account");
  await vi.waitFor(() => expect(reject).toBeDefined());
  const account = store.getState().activeAccountId;
  await store.getState().switchAccount("account-secondary");
  await store.getState().switchAccount(account);
  reject(new RetryableSendError(new Error("temporary"), 5_000));
  expect(await pending).toBe(false);
  expect(store.getState().outbox).toHaveLength(0);
});

it("queues only the unaccepted online attachments and does not repeat their caption", async () => {
  const transport = new MockTelegramTransport();
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  vi.useFakeTimers();
  const attachments: OutgoingAttachment[] = ["a.txt", "b.txt"].map(name => ({ kind: "document", file: new File([name], name, { type: "text/plain" }) }));
  const sends = vi.spyOn(transport, "sendFiles").mockImplementationOnce(async input => {
    await input.onGroupAccepted?.([input.attachments[0]]);
    throw new RetryableSendError(new Error("temporary"), 5_000);
  }).mockResolvedValue(true);
  expect(await store.getState().sendFiles(attachments, "caption", undefined, "reply", undefined, true)).toBe(true);
  expect(store.getState().outbox[0]).toMatchObject({ caption: undefined, attachments: [{ name: "b.txt" }], disableNotification: true });
  await vi.advanceTimersByTimeAsync(6_000);
  await vi.waitFor(() => expect(sends).toHaveBeenCalledTimes(2));
  expect(sends.mock.calls[1][0].attachments.map(attachment => attachment.file.name)).toEqual(["b.txt"]);
  expect(sends.mock.calls[1][0]).toMatchObject({ caption: undefined, replyToMessageId: "reply", disableNotification: true });
  expect(store.getState().outbox).toHaveLength(0);
});

it("restores a safe retry deadline and preserves the review requirement for interrupted sends", () => {
  const base = { id: "one", chatId: "7", text: "text", createdAt: new Date().toISOString(), retryAt: Date.now() + 60_000, retryAttempt: 2 };
  const local = migrateLocalUnsentState({ currentUserId: "self", savedAt: new Date().toISOString(), drafts: [], localAttachmentDrafts: [],
    outbox: [{ ...base, status: "queued" }, { ...base, id: "two", status: "sending" }] });
  expect(local?.outbox).toMatchObject([{ status: "queued", retryAt: base.retryAt }, { status: "failed" }]);
});
