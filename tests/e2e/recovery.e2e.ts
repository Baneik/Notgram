import { expect, test } from "@playwright/test";
import type { TelegramState } from "../../src/store/telegramStore.types";
import type { ChatHistoryPage, Message, TelegramEvent } from "../../src/telegram/types";

test("proxy recovery shows retry progress instead of blaming proxy settings", async ({ page }) => {
  await page.goto("/?connection=recovering");
  const progress = page.getByRole("status").filter({ hasText: "连接中断，正在自动重试" });
  await expect(progress.first()).toBeVisible();
  await expect(progress.first().locator(".spin")).toBeVisible();
  await expect(page.getByText("代理设置暂不可用，请检查连接设置", { exact: true })).toBeHidden();
});

test("system discovery errors explain the limitation and preserve unsaved proxy edits", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("button", { name: /高级设置/ }).click();
  await expect(settings.getByRole("radio", { name: "系统代理" })).toBeChecked();
  const updateDiscovery = () => page.evaluate(async (path) => {
    const { telegramStore } = await import(path) as {
      telegramStore: { getState: () => TelegramState; setState: (value: Partial<TelegramState>) => void };
    };
    const previous = telegramStore.getState().proxySettings!;
    telegramStore.setState({ proxySettings: { ...previous, revision: (previous.revision ?? 0) + 1,
      system: undefined, systemStatus: { kind: "unsupported" } } });
  }, "/src/store/telegramStore.ts");
  await updateDiscovery();
  await expect(settings.getByText("暂不支持此系统代理配置", { exact: true })).toBeVisible();
  await expect(settings.getByText("当前将使用直连", { exact: true })).toBeHidden();
  await settings.getByRole("radio", { name: "自定义" }).click();
  await settings.getByLabel("服务器").fill("edited.example.test");
  await updateDiscovery();
  await expect(settings.getByRole("radio", { name: "自定义" })).toBeChecked();
  await expect(settings.getByLabel("服务器")).toHaveValue("edited.example.test");
});

for (const reason of ["reconnect", "wake"] as const) {
  test(`${reason} refreshes exhausted history and displays missed messages`, async ({ page }) => {
    await page.route("**/src/telegram/mockTransport.ts", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      await route.fulfill({ response, body: `${body}\n{
        globalThis.__notgramRecoveryTransport = MockTelegramTransport;
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

    const previousIds = await page.evaluate(async ({ storePath, reason }) => {
      const { telegramStore } = await import(storePath) as { telegramStore: { getState: () => TelegramState } };
      // Use the class instrumented during startup, avoiding a second dynamic
      // module import through Vite's cyclic transport/store dependency graph.
      const runtime = window as typeof window & {
        __notgramRecoveryTransport: { prototype: { loadChatHistory: (chatId: string, limit?: number) => Promise<ChatHistoryPage> } };
        __notgramRecoveryDispatch: (event: TelegramEvent) => void;
      };
      const MockTelegramTransport = runtime.__notgramRecoveryTransport;
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
      const dispatch = runtime.__notgramRecoveryDispatch;
      if (reason === "wake") dispatch({ type: "sync.required" });
      else {
        dispatch({ type: "connection.changed", status: "waitingForNetwork" });
        dispatch({ type: "connection.changed", status: "online" });
      }
      return previous.map((message) => message.id);
    }, { storePath: "/src/store/telegramStore.ts", reason });

    await expect(page.getByText("休眠后补齐的消息", { exact: true })).toBeVisible();
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    const actualIds = await page.evaluate(async (storePath) => {
      const { telegramStore } = await import(storePath) as { telegramStore: { getState: () => TelegramState } };
      return telegramStore.getState().messages.get("chat-product")?.map((message) => message.id);
    }, "/src/store/telegramStore.ts");
    expect(actualIds).toEqual(expect.arrayContaining([...previousIds, "missed-after-sleep"]));
  });
}
