import { describe, expect, it, vi } from "vitest";
import { mockSnapshot } from "../telegram/mockData";
import { mapTdMessage } from "../telegram/tdlibMapper";
import { messageCanBeCached, messageCanBeSaved } from "../telegram/messageLifecycle";
import { migrateCachedSnapshot } from "./telegramStore.cache";
import { TdRequestBroker } from "../telegram/tdRequestBroker";

const snapshot = () => ({ ...structuredClone(mockSnapshot), version: 4, savedAt: new Date().toISOString() });

describe("durable storage lifecycle", () => {
  it("retains local unsent data while discarding legacy message copies with unknown expiry", () => {
    const drafts = [{ chatId: "chat-product", text: "only local", updatedAt: new Date().toISOString() }];
    const outbox = [{ id: "pending", chatId: "chat-product", text: "not sent", createdAt: new Date().toISOString(), status: "queued" }];
    const migrated = migrateCachedSnapshot({ ...snapshot(), version: 3, drafts, outbox }).snapshot;
    expect(migrated?.messages).toEqual([]);
    expect(migrated?.drafts).toEqual(drafts);
    expect(migrated?.outbox).toEqual(outbox);
    expect(migrated?.chats.every((chat) => chat.preview === "")).toBe(true);
  });

  it("never automatically retries a send whose acknowledgement was interrupted", () => {
    const migrated = migrateCachedSnapshot({ ...snapshot(), outbox: [{
      id: "pending", chatId: "chat-product", text: "possibly sent", createdAt: new Date().toISOString(), status: "sending",
    }] }).snapshot;
    expect(migrated?.outbox?.[0]).toMatchObject({ status: "failed", text: "possibly sent" });
  });

  it("keeps TDLib expiry stable across remapping and excludes restricted content from snapshots", () => {
    const raw = { "@type": "message", id: 10, chat_id: 20, sender_id: { "@type": "messageSenderUser", user_id: 30 },
      date: 1788560000, auto_delete_in: 5, can_be_saved: false,
      content: { "@type": "messageText", text: { text: "ephemeral", entities: [] } } };
    const first = mapTdMessage(raw)!;
    const second = mapTdMessage(raw)!;
    expect(first.expiresAt).toBeDefined();
    expect(second.expiresAt).toBe(first.expiresAt);
    expect(first.canSave).toBe(false);
    expect(messageCanBeCached(first)).toBe(false);
    expect(messageCanBeSaved(first)).toBe(false);
    expect(migrateCachedSnapshot({ ...snapshot(), messages: [first] }).snapshot?.messages).toEqual([]);
  });

  it("rejects saving expired messages and caching messages restricted by loaded permissions", () => {
    const message = structuredClone(mockSnapshot.messages[0]);
    expect(messageCanBeSaved({ ...message, expiresAt: "2000-01-01T00:00:00Z" })).toBe(false);
    expect(messageCanBeCached({ ...message, permissions: { canSave: false } as typeof message.permissions })).toBe(false);
  });

  it("waits for TDLib to accept an attachment group after native staging completes", async () => {
    let extra = "";
    const broker = new TdRequestBroker(async (_command, args) => { extra = String(args?.extra); return true; });
    const accepted = vi.fn();
    const pending = broker.requestPreparedPastedFiles("1", [{ name: "test", mimeType: "text/plain", dataBase64: "YQ==", kind: "document" }], undefined, vi.fn()).then(accepted);
    await Promise.resolve(); await Promise.resolve();
    expect(accepted).not.toHaveBeenCalled();
    broker.settle({ "@type": "messages", "@extra": extra });
    await pending;
    expect(accepted).toHaveBeenCalledWith(true);
  });

  it("propagates TDLib attachment errors instead of acknowledging a staged upload", async () => {
    let broker!: TdRequestBroker;
    broker = new TdRequestBroker(async (_command, args) => {
      broker.settle({ "@type": "error", "@extra": args?.extra, code: 400, message: "UPLOAD_REJECTED" });
      return true;
    });
    await expect(broker.requestPreparedPastedFiles("1", [{ name: "test", mimeType: "text/plain", dataBase64: "YQ==", kind: "document" }], undefined, vi.fn())).rejects.toThrow("UPLOAD_REJECTED");
  });
});
