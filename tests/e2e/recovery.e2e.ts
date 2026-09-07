import { expect, test } from "@playwright/test";
import type { TelegramState } from "../../src/store/telegramStore.types";
import type { ChatHistoryPage, Message, TelegramEvent } from "../../src/telegram/types";

for (const reason of ["reconnect", "wake"] as const) {
  test(`${reason} refreshes exhausted history and displays missed messages`, async ({ page }) => {
    await page.route("**/src/telegram/mockTransport.ts", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      await route.fulfill({ response, body: `${body}\n{
        const originalConnect = MockTelegramTransport.prototype.connect;
        MockTelegramTransport.prototype.connect = function(listener, ...options) {
          globalThis.__notgramRecoveryDispatch = listener;
          return originalConnect.call(this, listener, ...options);
        };
      }` });
    });
    await page.goto("/");
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(async (storePath) => {
      const { telegramStore } = await import(storePath) as { telegramStore: { getState: () => TelegramState } };
      await telegramStore.getState().loadMoreHistory("chat-product");
    }, "/src/store/telegramStore.ts");
    const latest = page.getByRole("button", { name: /^跳到最新消息/ });
    if (await latest.isVisible()) await latest.click();

    const previousIds = await page.evaluate(async ({ storePath, transportPath, reason }) => {
      const { telegramStore } = await import(storePath) as { telegramStore: { getState: () => TelegramState } };
      const { MockTelegramTransport } = await import(transportPath) as {
        MockTelegramTransport: { prototype: { loadChatHistory: (chatId: string, limit?: number) => Promise<ChatHistoryPage> } };
      };
      const state = telegramStore.getState();
      if (state.histories.get("chat-product")?.hasMore !== false) throw new Error("History did not reach its end");
      const previous = state.messages.get("chat-product")!;
      const missed: Message = {
        ...previous.at(-1)!,
        id: "missed-after-sleep",
        outgoing: false,
        sentAt: new Date(Date.now() + 60_000).toISOString(),
        content: { kind: "text", text: "休眠后补齐的消息" },
      };
      const original = MockTelegramTransport.prototype.loadChatHistory;
      MockTelegramTransport.prototype.loadChatHistory = async function (chatId, limit) {
        if (chatId !== "chat-product") return original.call(this, chatId, limit);
        const messages = [...previous, missed];
        return { messages, messageIds: messages.map((message) => message.id), loadedCount: 1, hasMore: false };
      };
      const dispatch = (window as typeof window & { __notgramRecoveryDispatch: (event: TelegramEvent) => void }).__notgramRecoveryDispatch;
      if (reason === "wake") dispatch({ type: "sync.required" });
      else {
        dispatch({ type: "connection.changed", status: "waitingForNetwork" });
        dispatch({ type: "connection.changed", status: "online" });
      }
      return previous.map((message) => message.id);
    }, { storePath: "/src/store/telegramStore.ts", transportPath: "/src/telegram/mockTransport.ts", reason });

    await expect(page.getByText("休眠后补齐的消息", { exact: true })).toBeVisible();
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    const actualIds = await page.evaluate(async (storePath) => {
      const { telegramStore } = await import(storePath) as { telegramStore: { getState: () => TelegramState } };
      return telegramStore.getState().messages.get("chat-product")?.map((message) => message.id);
    }, "/src/store/telegramStore.ts");
    expect(actualIds).toEqual(expect.arrayContaining([...previousIds, "missed-after-sleep"]));
  });
}
