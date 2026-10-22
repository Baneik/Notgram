import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockTelegramTransport } from "../telegram/mockTransport";
import { createTelegramStore } from "./telegramStore";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function fixture() {
  const transport = new MockTelegramTransport();
  const store = createTelegramStore(transport);
  await store.getState().initialize();
  return { transport, store };
}

describe("folder operation completion", () => {
  it.each([true, false])("keeps confirmed channel membership=%s when the UI cache cannot be saved", async included => {
    const { transport, store } = await fixture();
    await transport.setChatFolderMembership("folder:work", "chat-release", !included);
    vi.spyOn(transport, "saveCachedSnapshot").mockRejectedValue(new Error("UI cache record limit exceeded"));
    expect(await store.getState().setChatFolderMembership("folder:work", "chat-release", included)).toBe(true);
    expect(store.getState().chats.get("chat-release")!.folderIds.includes("folder:work")).toBe(included);
    expect(store.getState().operationError).toBeUndefined();
    expect(store.getState().cacheHealth).toBe("invalid");
    expect(store.getState().folderManagementPending).toBe(false);
  });

  it.each(["create", "rename", "delete"])("keeps a confirmed %s result when the cache write fails", async operation => {
    const { transport, store } = await fixture();
    vi.spyOn(transport, "saveCachedSnapshot").mockRejectedValue(new Error("disk unavailable"));
    if (operation === "create") {
      const id = await store.getState().createChatFolder("Customers", []);
      expect(id).toBeDefined();
      expect(store.getState().folders.find(folder => folder.id === id)?.title).toBe("Customers");
    } else if (operation === "rename") {
      expect(await store.getState().renameChatFolder("folder:work", "Customers")).toBe(true);
      expect(store.getState().folders.find(folder => folder.id === "folder:work")?.title).toBe("Customers");
    } else {
      expect(await store.getState().deleteChatFolder("folder:work")).toBe(true);
      expect(store.getState().folders.some(folder => folder.id === "folder:work")).toBe(false);
    }
    expect(store.getState().operationError).toBeUndefined();
    expect(store.getState().cacheHealth).toBe("invalid");
    expect(store.getState().folderManagementPending).toBe(false);
  });

  it("still reports transport rejection and an unconfirmed membership", async () => {
    const { transport, store } = await fixture();
    await transport.setChatFolderMembership("folder:work", "chat-release", false);
    const membership = vi.spyOn(transport, "setChatFolderMembership").mockRejectedValueOnce(new Error("Telegram rejected membership"));
    const cache = vi.spyOn(transport, "saveCachedSnapshot");
    expect(await store.getState().setChatFolderMembership("folder:work", "chat-release", true)).toBe(false);
    expect(store.getState().operationError).toBe("Telegram rejected membership");
    membership.mockResolvedValueOnce();
    expect(await store.getState().setChatFolderMembership("folder:work", "chat-release", true)).toBe(false);
    expect(store.getState().operationError).toBe("Telegram 未确认文件夹成员状态");
    expect(cache).not.toHaveBeenCalled();
  });

  it.each([false, true])("ignores a previous account's folder completion (failure: %s)", async failure => {
    const { transport, store } = await fixture();
    let finish!: () => void;
    vi.spyOn(transport, "setChatFolderMembership").mockImplementation(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      if (failure) throw new Error("old account error");
    });
    const operation = store.getState().setChatFolderMembership("folder:work", "chat-release", true);
    expect(await store.getState().switchAccount("account-secondary")).toBe(true);
    store.setState({ folderManagementPending: true, operationError: "new operation" });
    const cache = vi.spyOn(transport, "saveCachedSnapshot");
    finish();
    expect(await operation).toBe(false);
    expect(store.getState().operationError).toBe("new operation");
    expect(store.getState().folderManagementPending).toBe(true);
    expect(cache).not.toHaveBeenCalled();
  });
});
