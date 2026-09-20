import { describe, expect, it } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { createTelegramStore } from "./telegramStore";
import { cachedSnapshotFrom, migrateCachedSnapshot } from "./telegramStore.cache";
import type { TelegramEventListener } from "../telegram/transport";

describe("folder browsing without conversation selection", () => {
  it("retains the conversation and draft when switching folders", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();
    store.getState().selectChat("chat-mia");
    store.getState().updateChatDraft("chat-mia", "retained draft");
    store.getState().setChatFilter("folder:work");
    expect(store.getState().activeChatId).toBe("chat-mia");
    expect(store.getState().drafts.get("chat-mia")?.text).toBe("retained draft");
    store.getState().setChatFilter("main");
    expect(store.getState().activeChatId).toBe("chat-mia");
  });

  it("retains the conversation when an empty folder receives late data", async () => {
    class EventTransport extends MockTelegramTransport {
      emit?: TelegramEventListener;
      override async connect(listener: TelegramEventListener) { this.emit = listener; return super.connect(listener); }
    }
    const transport = new EventTransport();
    const store = createTelegramStore(transport);
    await store.getState().initialize();
    store.getState().selectChat("chat-product");
    store.setState(state => ({ folders: [...state.folders, { id: "folder:empty", title: "Empty", iconName: "Custom" }] }));
    store.getState().setChatFilter("folder:empty");
    expect(store.getState().activeChatId).toBe("chat-product");
    const chat = store.getState().chats.get("chat-mia")!;
    transport.emit?.({ type: "chat.upsert", chat: { ...chat, folderIds: [...chat.folderIds, "folder:empty"] } });
    expect(store.getState().activeChatId).toBe("chat-product");
  });

  it("restores the open conversation independently of the folder and ignores legacy folder memories", async () => {
    const store = createTelegramStore(new MockTelegramTransport());
    await store.getState().initialize();
    store.getState().selectChat("chat-mia");
    store.getState().setChatFilter("folder:work");
    const snapshot = cachedSnapshotFrom(store.getState());
    expect(snapshot).not.toHaveProperty("lastFolderChatIds");
    const legacy = migrateCachedSnapshot({
      ...snapshot,
      lastFolderChatIds: [{ folderId: "folder:work", chatId: "chat-design" }, null],
    }).snapshot!;
    const restored = createTelegramStore(new MockTelegramTransport({ cachedSnapshot: legacy }));
    await restored.getState().initialize();
    expect(restored.getState().chatFilter).toBe("folder:work");
    expect(restored.getState().activeChatId).toBe("chat-mia");
    expect(cachedSnapshotFrom(restored.getState())).not.toHaveProperty("lastFolderChatIds");
  });
});
