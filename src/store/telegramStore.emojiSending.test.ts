import { afterEach, expect, it, vi } from "vitest";
import { createTelegramStore } from "./telegramStore";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { migrateLocalUnsentState } from "./telegramStore.cache";
import type { EmojiPickerAsset } from "../telegram/types";

const asset: EmojiPickerAsset = { id: "fast-sticker", kind: "sticker", fileId: 99101,
  remoteId: "remote-fast-sticker", remoteUniqueId: "stable-fast-sticker", fileName: "sticker.webp", width: 512, height: 512 };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
afterEach(() => vi.restoreAllMocks());

const harness = async () => {
  const transport = new MockTelegramTransport();
  const saveLocalState = vi.fn(async (): Promise<void> => undefined);
  Object.assign(transport, { saveLocalState });
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  return { store, transport, saveLocalState };
};

it("immediately projects a sending sticker while persistence and TDLib are pending", async () => {
  const { store, transport, saveLocalState } = await harness();
  let persisted!: () => void;
  saveLocalState.mockImplementationOnce(() => new Promise<void>(resolve => { persisted = resolve; }));
  let accepted!: () => void;
  const send = vi.spyOn(transport, "sendSticker").mockImplementation(() => new Promise<void>(resolve => { accepted = resolve; }));
  const fullSnapshot = vi.spyOn(transport, "saveCachedSnapshot");
  const preview = "data:image/webp;base64,AAAA";
  const chatId = store.getState().activeChatId!;
  await expect(store.getState().sendSticker({ ...asset, previewDataUrl: preview })).resolves.toBe(true);
  expect(store.getState().outbox).toHaveLength(1);
  expect(store.getState().messages.get(chatId)?.at(-1)).toMatchObject({ delivery: "sending",
    content: { kind: "media", mediaType: "sticker", previewDataUrl: preview } });
  await flush();
  expect(send).not.toHaveBeenCalled();
  persisted(); await flush();
  expect(send).toHaveBeenCalledOnce();
  expect(fullSnapshot).not.toHaveBeenCalled();
  accepted(); await flush();
  expect(store.getState().outbox).toEqual([]);
  expect(store.getState().messages.get(chatId)?.some(message => message.id.startsWith("outbox:"))).toBe(false);
});

it("keeps failed emoji sends visible and reuses the existing retry action", async () => {
  const { store, transport } = await harness();
  const send = vi.spyOn(transport, "sendSticker").mockRejectedValueOnce(new Error("forbidden")).mockResolvedValue(undefined);
  await store.getState().sendSticker(asset); await flush();
  const failed = store.getState().outbox[0];
  expect(failed).toMatchObject({ kind: "emoji", status: "failed", error: "forbidden", emojiAsset: { remoteId: asset.remoteId } });
  const message = store.getState().messages.get(failed.chatId)?.find(message => message.id === `outbox:${failed.id}`);
  expect(message).toMatchObject({ canRetry: true, delivery: "failed" });
  await store.getState().retryMessage(message!.id, failed.chatId);
  expect(send).toHaveBeenCalledTimes(2);
  expect(store.getState().outbox).toEqual([]);
});

it("never submits a sticker if its durable local write fails", async () => {
  const { store, transport, saveLocalState } = await harness();
  saveLocalState.mockRejectedValue(new Error("disk full"));
  const send = vi.spyOn(transport, "sendSticker");
  await store.getState().sendSticker(asset); await flush();
  expect(send).not.toHaveBeenCalled();
  expect(store.getState().outbox[0].status).toBe("failed");
  expect(store.getState().cacheHealth).toBe("invalid");
});

it("captures the original topic, quote and notification preference before navigation", async () => {
  const { store, transport } = await harness();
  const send = vi.spyOn(transport, "sendSticker").mockResolvedValue(undefined);
  store.setState({ activeChatId: "chat-forum", activeTopicId: "12" });
  await store.getState().sendSticker(asset, "reply", { text: "quoted", position: 2 }, "chat-forum", true);
  store.setState({ activeTopicId: "18" }); await flush();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ chatId: "chat-forum", topicId: "12",
    replyToMessageId: "reply", replyQuote: { text: "quoted", position: 2 }, disableNotification: true }));
});

it("restores interrupted emoji sends as failed and rejects durable runtime-only identities", () => {
  const item = { id: "interrupted", chatId: "chat", text: "", kind: "emoji", emojiAsset: asset,
    createdAt: new Date().toISOString(), status: "sending" };
  const local = { savedAt: new Date().toISOString(), currentUserId: "self", drafts: [], localAttachmentDrafts: [], outbox: [item] };
  expect(migrateLocalUnsentState(local)?.outbox?.[0]).toMatchObject({ status: "failed", emojiAsset: { remoteId: asset.remoteId } });
  expect(() => migrateLocalUnsentState({ ...local, outbox: [{ ...item, emojiAsset: { ...asset, remoteId: undefined } }] })).toThrow();
});

it("does not apply a late failed send to another account", async () => {
  const { store, transport } = await harness();
  let reject!: (error: Error) => void;
  vi.spyOn(transport, "sendSticker").mockImplementation(() => new Promise((_, failed) => { reject = failed; }));
  await store.getState().sendSticker(asset); await flush();
  store.setState({ activeAccountId: "other", outbox: [], messages: new Map(), operationError: undefined });
  reject(new Error("old failure")); await flush();
  expect(store.getState().operationError).toBeUndefined();
  expect(store.getState().outbox).toEqual([]);
});

it("also accepts GIF sends immediately and retains failed GIFs for explicit retry", async () => {
  const { store, transport } = await harness();
  let reject!: (error: Error) => void;
  const send = vi.spyOn(transport, "sendAnimation").mockImplementation(() => new Promise((_, failed) => { reject = failed; }));
  await expect(store.getState().sendAnimation({ ...asset, kind: "animation", mimeType: "video/mp4" })).resolves.toBe(true);
  expect(store.getState().messages.get(store.getState().activeChatId!)?.at(-1)).toMatchObject({ delivery: "sending", content: { mediaType: "animation" } });
  await flush(); reject(new Error("connection lost after submission")); await flush();
  expect(store.getState().outbox[0].status).toBe("failed");
  expect(send).toHaveBeenCalledOnce();
});
