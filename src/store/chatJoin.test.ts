import { describe, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import type { JoinChatResult, TelegramSnapshot } from "../telegram/types";
import { createTelegramStore } from "./telegramStore";
import { chatJoinKey } from "../telegram/chatJoin";

class JoinTransport extends MockTelegramTransport {
  join = vi.fn<() => Promise<JoinChatResult>>(async () => ({ kind: "requested" }));
  override async joinChat() { return this.join(); }
  snapshotForJoin() { return (this as unknown as { snapshot: TelegramSnapshot }).snapshot; }
}

async function setup() {
  const transport = new JoinTransport();
  const chat = transport.snapshotForJoin().chats.find(chat => chat.id === "chat-product")!;
  chat.isMember = false;
  chat.joinByRequest = true;
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  store.getState().selectChat(chat.id);
  return { store, transport, chat };
}

describe("joining state and account isolation", () => {
  it("coalesces duplicate applications and blocks sends before approval", async () => {
    const { store, transport } = await setup();
    let finish!: (result: JoinChatResult) => void;
    transport.join.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = store.getState().joinChat({ chatId: "chat-product" });
    expect(await store.getState().joinChat({ chatId: "chat-product" })).toBeUndefined();
    finish({ kind: "requested" });
    expect(await first).toEqual({ kind: "requested" });
    expect(await store.getState().sendMessage("Must not send")).toBe(false);
    expect(store.getState().outbox).toHaveLength(0);
    expect(store.getState().chats.get("chat-product")?.isMember).toBe(false);
    expect(store.getState().chatJoinStates.get("chat:chat-product")).toBe("requested");
    expect(await store.getState().joinChat({ chatId: "chat-product" })).toBeUndefined();
    expect(transport.join).toHaveBeenCalledOnce();
    await transport.disconnect();
  });

  it("applies approval and later departure from transport updates, allowing another join", async () => {
    const { store, transport, chat } = await setup();
    await store.getState().joinChat({ chatId: chat.id });
    chat.isMember = true;
    await store.getState().refreshChatMembership(chat.id);
    expect(store.getState().chatJoinStates.has(chatJoinKey({ chatId: chat.id }))).toBe(false);
    chat.isMember = false;
    await store.getState().refreshChatMembership(chat.id);
    expect(await store.getState().joinChat({ chatId: chat.id })).toEqual({ kind: "requested" });
    expect(transport.join).toHaveBeenCalledTimes(2);
    await transport.disconnect();
  });

  it("keeps failed requests retryable with a useful error", async () => {
    const { store, transport } = await setup();
    transport.join.mockRejectedValueOnce(new Error("INVITE_HASH_EXPIRED (400)"));
    expect(await store.getState().joinChat({ chatId: "chat-product" })).toBeUndefined();
    expect(store.getState().operationError).toBe("邀请链接无效或已过期");
    expect(store.getState().chatJoinStates.size).toBe(0);
    expect(await store.getState().joinChat({ chatId: "chat-product" })).toEqual({ kind: "requested" });
    await transport.disconnect();
  });

  it("ignores a late result across an actual account transition", async () => {
    const { store, transport } = await setup();
    let finish!: (result: JoinChatResult) => void;
    transport.join.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = store.getState().joinChat({ chatId: "chat-product" });
    await store.getState().addAccount();
    finish({ kind: "requested" });
    expect(await pending).toBeUndefined();
    expect(store.getState().chatJoinStates.size).toBe(0);
    await transport.disconnect();
  });
});
