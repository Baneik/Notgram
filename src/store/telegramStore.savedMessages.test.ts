import { afterEach, describe, expect, it, vi } from "vitest";
import { mockSnapshot } from "../telegram/mockData";
import { MockTelegramTransport } from "../telegram/mockTransport";
import type { TelegramEventListener } from "../telegram/transport";
import type { Chat } from "../telegram/types";
import { createTelegramStore } from "./telegramStore";

class SavedMessagesTransport extends MockTelegramTransport {
  saved = { ...structuredClone(mockSnapshot.chats.find(chat => chat.kind === "saved")!), unreadCount: 3 };
  reads: string[] = [];
  readGate?: Promise<void>;
  failRead = false;
  private publish?: TelegramEventListener;

  override async connect(listener: TelegramEventListener) {
    this.publish = listener;
    const snapshot = await super.connect(listener);
    return { ...snapshot, chats: snapshot.chats.map(chat => chat.kind === "saved" ? this.saved : chat) };
  }

  updateSaved(patch: Partial<Chat>) {
    this.saved = { ...this.saved, ...patch };
    this.publish?.({ type: "chat.upsert", chat: this.saved });
  }

  override async markChatRead(chatId: string) {
    if (chatId !== this.saved.id) return super.markChatRead(chatId);
    this.reads.push(chatId);
    const original = this.saved;
    await this.readGate;
    if (this.failRead) throw new Error("synthetic read failure");
    if (this.saved === original) this.updateSaved({ unreadCount: 0 });
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Saved Messages automatic reads", () => {
  it("reads the initial and live self-chat while hidden without looping on read updates", async () => {
    vi.useFakeTimers();
    const transport = new SavedMessagesTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    expect(store.getState().activeChatId).not.toBe(transport.saved.id);
    vi.stubGlobal("document", { visibilityState: "hidden" });
    await vi.advanceTimersByTimeAsync(121);
    expect(transport.reads).toEqual([transport.saved.id]);
    expect(store.getState().chats.get(transport.saved.id)?.unreadCount).toBe(0);

    transport.updateSaved({ unreadCount: 1 });
    transport.updateSaved({ unreadCount: 2 });
    await vi.advanceTimersByTimeAsync(121);
    expect(transport.reads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.reads).toHaveLength(2);
  });

  it("waits for connection recovery and preserves unread counts when marking fails", async () => {
    vi.useFakeTimers();
    const transport = new SavedMessagesTransport({ connectionStatus: "offline" });
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await vi.advanceTimersByTimeAsync(121);
    expect(transport.reads).toHaveLength(0);
    transport.failRead = true;
    transport.setConnectionStatus("online");
    await vi.advanceTimersByTimeAsync(121);
    expect(transport.reads).toHaveLength(1);
    expect(store.getState().chats.get(transport.saved.id)?.unreadCount).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.reads).toHaveLength(1);

    transport.failRead = false;
    transport.setConnectionStatus("offline");
    transport.setConnectionStatus("online");
    await vi.advanceTimersByTimeAsync(121);
    expect(store.getState().chats.get(transport.saved.id)?.unreadCount).toBe(0);
  });

  it("serializes another read when new messages arrive during an in-flight request", async () => {
    vi.useFakeTimers();
    const transport = new SavedMessagesTransport();
    let release!: () => void;
    transport.readGate = new Promise<void>(resolve => { release = resolve; });
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await vi.advanceTimersByTimeAsync(121);
    transport.updateSaved({ unreadCount: 4 });
    await vi.advanceTimersByTimeAsync(121);
    expect(transport.reads).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(121);
    expect(transport.reads).toHaveLength(2);
    expect(store.getState().chats.get(transport.saved.id)?.unreadCount).toBe(0);
  });

  it("discards queued reads and late failures after switching accounts", async () => {
    class AccountTransport extends SavedMessagesTransport {
      activeId = "default";
      override async getAccountState() {
        const state = await super.getAccountState();
        return { ...state, activeAccountId: this.activeId,
          accounts: [...state.accounts, { ...state.accounts[0], id: "secondary" }] };
      }
      override async registerCurrentAccount() { return this.getAccountState(); }
      override async loadCachedSnapshot() { return undefined; }
      override async selectAccount(id: string) {
        this.activeId = id;
        this.saved = { ...this.saved, unreadCount: 0 };
        return this.getAccountState();
      }
    }
    vi.useFakeTimers();
    const transport = new AccountTransport();
    let release!: () => void;
    transport.readGate = new Promise<void>(resolve => { release = resolve; });
    transport.failRead = true;
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    await vi.advanceTimersByTimeAsync(121);
    transport.updateSaved({ unreadCount: 4 });
    await vi.advanceTimersByTimeAsync(121);
    await expect(store.getState().switchAccount("secondary")).resolves.toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(121);
    expect(transport.reads).toHaveLength(1);
    expect(store.getState().operationError).toBeUndefined();
  });
});
