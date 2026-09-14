import { expect, test } from "@playwright/test";
import type { TelegramState } from "../../src/store/telegramStore.types";
import type { TelegramEvent } from "../../src/telegram/types";
import type { TdObject } from "../../src/telegram/tdlibMapper";
import type { NativeUpdateBatch } from "../../src/telegram/tdUpdateStream";

test("a leased native backlog yields to input and preserves message edits and deletions", async ({ page }) => {
  await page.route("**/src/telegram/mockTransport.ts", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const connect = MockTelegramTransport.prototype.connect;
      MockTelegramTransport.prototype.connect = function(listener, ...args) {
        globalThis.__trayDispatch = listener;
        return connect.call(this, listener, ...args);
      };
    }` });
  });
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async paths => {
    const [{ telegramStore }, { TauriTelegramTransport }, { TdUpdateStream }, { preferencesStore }] = await Promise.all([
      import(paths.store), import(paths.transport), import(paths.stream), import(paths.preferences),
    ]);
    preferencesStore.setState({ notificationsEnabled: false });
    const runtime = window as typeof window & {
      __trayDispatch: (event: TelegramEvent) => void;
      __trayRun: { processed: number; total: number; done: boolean; error?: string; yields: number; longestSlice: number };
    };
    const transport = new TauriTelegramTransport() as unknown as {
      listener: (event: TelegramEvent) => void;
      request: (request: TdObject) => Promise<TdObject>;
      finishInitialChatSync: () => void;
      handleUpdateBatch: (updates: TdObject[], offset: number, budget: number) => number;
    };
    transport.finishInitialChatSync();
    transport.listener = runtime.__trayDispatch;
    transport.request = async () => ({ "@type": "ok" });
    const updates: TdObject[] = [{ "@type": "updateNewChat", chat: {
      "@type": "chat", id: 7, title: "Queue regression", type: { "@type": "chatTypePrivate", user_id: 77 }, positions: [],
    } }];
    for (let id = 1; id <= 1000; id++) {
      updates.push({ "@type": "updateNewMessage", message: {
        "@type": "message", id, chat_id: 7, date: 1_700_000_000 + id,
        sender_id: { "@type": "messageSenderUser", user_id: 77 },
        content: { "@type": "messageText", text: { text: `original ${id}`, entities: [] } },
      } });
      updates.push({ "@type": "updateMessageContent", chat_id: 7, message_id: id,
        new_content: { "@type": "messageText", text: { text: `edited ${id}`, entities: [] } } });
      if (id % 3 === 0) updates.push({ "@type": "updateDeleteMessages", chat_id: 7,
        message_ids: [id], is_permanent: true, from_cache: false });
    }
    const run: typeof runtime.__trayRun = { processed: 0, total: updates.length, done: false, yields: 0, longestSlice: 0 };
    runtime.__trayRun = run;
    const packets = Array.from({ length: Math.ceil(updates.length / 64) }, (_, index) => updates.slice(index * 64, (index + 1) * 64));
    const stream = new TdUpdateStream((batch: TdObject[], offset: number, budget: number) => {
      const started = performance.now();
      const count = transport.handleUpdateBatch(batch, offset, budget);
      run.longestSlice = Math.max(run.longestSlice, performance.now() - started);
      run.processed += count;
      return count;
    }, (error: unknown) => { run.error = String(error); }, () => undefined, {
      open: async () => 1, close: async () => undefined, listen: async () => () => undefined,
      take: async (_id: number, ack: number): Promise<NativeUpdateBatch> => {
        if (!packets[ack]) { run.done = true; setTimeout(() => stream.dispose(), 0); }
        return { streamId: 1, sequence: packets[ack] ? ack + 1 : ack, updates: packets[ack] ?? [],
          pendingCount: Math.max(0, updates.length - (ack + 1) * 64), oldestAgeMs: 3_600_000 };
      },
      yield: () => { run.yields += 1; return new Promise<void>(resolve => setTimeout(resolve, 0)); },
    });
    await stream.start();
    if (!(telegramStore.getState() as TelegramState).activeChatId) throw new Error("No active conversation");
  }, { store: "/src/store/telegramStore.ts", transport: "/src/telegram/tauriTransport.ts",
    stream: "/src/telegram/tdUpdateStream.ts", preferences: "/src/store/preferencesStore.ts" });

  await page.getByRole("searchbox", { name: "搜索会话和消息" }).fill("responsive during replay");
  const atInput = await page.evaluate(() => (window as typeof window & { __trayRun: { processed: number; total: number } }).__trayRun);
  expect(atInput.processed).toBeLessThan(atInput.total);
  await expect(page.getByRole("searchbox", { name: "搜索会话和消息" })).toHaveValue("responsive during replay");
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __trayRun: { done: boolean } }).__trayRun.done)).toBe(true);
  const result = await page.evaluate(async path => {
    const { telegramStore } = await import(path) as { telegramStore: { getState: () => TelegramState } };
    const messages = telegramStore.getState().messages.get("7") ?? [];
    return {
      run: (window as typeof window & { __trayRun: { error?: string; yields: number; longestSlice: number } }).__trayRun,
      wrong: messages.filter(message => Number(message.id) % 3 === 0 || message.content.kind !== "text" || message.content.text !== `edited ${message.id}`).length,
      count: messages.length,
    };
  }, "/src/store/telegramStore.ts");
  expect(result.run.error).toBeUndefined();
  expect(result.run.yields).toBeGreaterThan(36);
  expect(result.count).toBe(667);
  expect(result.wrong).toBe(0);
  test.info().annotations.push({ type: "queue-slice-ms", description: result.run.longestSlice.toFixed(2) });
});
