import { describe, expect, it, vi } from "vitest";
import { createTelegramStore } from "./telegramStore";
import { MockTelegramTransport } from "../telegram/mockTransport";
import type { ChatReportResult } from "../telegram/types";
import { mockSnapshot } from "../telegram/mockData";

describe("report store boundary", () => {
  it("preserves server continuations instead of converting them into a success boolean", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    const request = vi.spyOn(transport, "reportChat");
    const input = { chatId: "chat-product", messageIds: [], optionId: "" };
    for (const result of [
      { kind: "options", title: "Report", options: [{ id: "AA==", title: "Other" }] },
      { kind: "text", optionId: "AA==", isOptional: false }, { kind: "messages" }, { kind: "ok" },
    ] satisfies ChatReportResult[]) {
      request.mockResolvedValueOnce(result);
      expect(await store.getState().reportChat(input)).toEqual(result);
    }
    request.mockRejectedValueOnce(new Error("offline"));
    await expect(store.getState().reportChat(input)).rejects.toThrow("offline");
    expect(store.getState().operationError).toBeUndefined();
  });

  it("uses an independent search cursor and excludes forbidden, deleted and cross-chat messages", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    const message = mockSnapshot.messages.find(message => message.chatId === "chat-product")!;
    const search = vi.spyOn(transport, "searchChatMessages").mockResolvedValue({
      messages: [
        { ...message, id: "yes" }, { ...message, id: "no" }, { ...message, id: "unknown" },
        { ...message, id: "deleted", isLocallyDeleted: true }, { ...message, id: "cross", chatId: "chat-other" },
      ], nextFromMessageId: "cursor-2", hasMore: true,
    });
    const properties = vi.spyOn(transport, "getMessageProperties").mockImplementation(async (_, id) => ({
      canReport: id === "unknown" ? undefined : id === "yes", canReply: false, canEdit: false,
      canDeleteOnlyForSelf: false, canDeleteForAllUsers: false, canForward: false,
    }));
    const before = store.getState();
    const page = await before.loadReportMessages({ chatId: message.chatId, query: "evidence", fromMessageId: "cursor-1" });
    expect(page.messages.map(message => message.id)).toEqual(["yes"]);
    expect(page).toMatchObject({ nextFromMessageId: "cursor-2", hasMore: true });
    expect(search).toHaveBeenCalledWith({ chatId: message.chatId, query: "evidence", fromMessageId: "cursor-1", limit: 30 });
    expect(properties).toHaveBeenCalledTimes(3);
    expect(store.getState().chatMessageSearch).toBe(before.chatMessageSearch);
    expect(store.getState().messages).toBe(before.messages);
  });

  it("rejects a report completion from an earlier account generation", async () => {
    const transport = new MockTelegramTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    let resolve!: (result: ChatReportResult) => void;
    vi.spyOn(transport, "reportChat").mockImplementation(() => new Promise(done => { resolve = done; }));
    try {
      const reporting = store.getState().reportChat({ chatId: "chat-product", messageIds: [], optionId: "" });
      const rejection = expect(reporting).rejects.toThrow("账号已切换");
      expect(await store.getState().switchAccount("account-secondary")).toBe(true);
      resolve({ kind: "ok" });
      await rejection;
    } finally { transport.disconnect(); }
  });
});
