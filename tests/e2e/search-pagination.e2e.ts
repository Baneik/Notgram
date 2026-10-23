import { expect, test, type Page } from "@playwright/test";

type Scope = "global" | "chat";
interface PaginationFixture {
  messageCount?: number;
  nativeTerminal?: boolean;
  pageSize?: number;
  failure?: boolean;
  delayed?: boolean;
  repeatedCursor?: boolean;
}
interface PaginationHarness {
  __searchPaginationCalls: Array<{ cursor?: string; query?: string }>;
  __releaseSearchPage?: () => void;
}

const query = "滚动搜索测试";
const fixture = async (page: Page, scope: Scope, options: PaginationFixture = {}) => {
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const options = ${JSON.stringify(options)};
      const connect = MockTelegramTransport.prototype.connect;
      const globalSearch = MockTelegramTransport.prototype.searchGlobal;
      const chatSearch = MockTelegramTransport.prototype.searchChatMessages;
      let paginationAttempts = 0;
      globalThis.__searchPaginationCalls = [];
      MockTelegramTransport.prototype.loadCachedSnapshot = async () => undefined;
      MockTelegramTransport.prototype.connect = async function(listener) {
        const base = this.snapshot.messages.find(m => m.chatId === "chat-product" && m.content.kind === "text");
        this.snapshot.messages = [...this.snapshot.messages, ...Array.from({ length: options.messageCount ?? 96 }, (_, index) => ({
          ...base, id: "scroll-search-" + index, renderKey: undefined, senderId: "u-mia", outgoing: false,
          sentAt: new Date(1700000000000 + index * 1000).toISOString(), isPinned: false,
          content: { kind: "text", text: "${query} " + index + " · 一段较长的正文，检查窄侧栏中的字号与省略效果" }
        }))];
        return connect.call(this, listener);
      };
      const beforeSearch = async (cursor, query) => {
        globalThis.__searchPaginationCalls.push({ cursor, query });
        if (!cursor) return;
        paginationAttempts++;
        if (options.failure && paginationAttempts === 1) throw new Error("Synthetic pagination failure");
        if (options.delayed && paginationAttempts === 1) {
          await new Promise(resolve => { globalThis.__releaseSearchPage = resolve; });
        }
      };
      MockTelegramTransport.prototype.searchGlobal = async function(input) {
        await beforeSearch(input.offset, input.query);
        const result = await globalSearch.call(this, { ...input, limit: options.pageSize ?? input.limit });
        if (options.repeatedCursor && input.offset) result.nextOffset = input.offset;
        return result;
      };
      MockTelegramTransport.prototype.searchChatMessages = async function(input) {
        await beforeSearch(input.fromMessageId, input.query);
        const result = await chatSearch.call(this, { ...input, limit: options.pageSize ?? input.limit });
        if (options.nativeTerminal) {
          const { TauriSearchService } = await import("/src/telegram/tauriSearchService.ts");
          const service = new TauriSearchService({
            request: async () => ({
              "@type": "foundChatMessages", total_count: result.totalCount,
              messages: result.messages, next_from_message_id: 0
            }),
            rawChats: new Map(), rawUsers: new Map(),
            upsertChat: () => {}, upsertUser: () => {}, mapChat: () => undefined,
            mapMessage: raw => ({ ...raw, chatId: "7" }), emitMessages: () => {}
          });
          const native = await service.searchChatMessages({ ...input, chatId: "7", senderId: "11" });
          return { ...native, messages: native.messages.map(message => ({ ...message, chatId: input.chatId })) };
        }
        if (options.repeatedCursor && input.fromMessageId) result.nextFromMessageId = input.fromMessageId;
        return result;
      };
    }` });
  });
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  if (scope === "chat") await page.keyboard.press("Control+F");
  await page.getByRole("searchbox", { name: "搜索会话和消息" }).fill(query);
  const list = page.locator(".global-search-results");
  const results = list.locator("[data-search-message-id]");
  await expect(results.first()).toBeVisible();
  return { list, results };
};

const calls = (page: Page) => page.evaluate(() => (
  globalThis as unknown as PaginationHarness
).__searchPaginationCalls);
const release = (page: Page) => page.evaluate(() => (
  globalThis as unknown as PaginationHarness
).__releaseSearchPage?.());

test("member search with two native results stops loading at the TDLib zero cursor", async ({ page }) => {
  const { list, results } = await fixture(page, "chat", { messageCount: 2, nativeTerminal: true });
  await expect(results).toHaveCount(2);
  await page.locator(".chat-search-member-trigger").click();
  await page.getByRole("dialog", { name: "选择成员" }).getByRole("button", { name: "Mia Chen", exact: true }).click();
  await expect(results).toHaveCount(2);
  await expect.poll(async () => (await calls(page)).length).toBe(2);
  await expect(list).toHaveAttribute("aria-busy", "false");
  await expect(list.locator(".global-search-pagination")).toHaveCount(0);
  await page.waitForTimeout(500);
  expect((await calls(page)).filter(call => call.cursor)).toHaveLength(0);
  await expect(list.getByRole("status", { name: "正在加载" })).toHaveCount(0);
});

for (const scope of ["global", "chat"] as const) {
  test(`${scope} search loads after entering the sentinel margin before reaching the bottom`, async ({ page }) => {
    const { list, results } = await fixture(page, scope);
    await expect(results).toHaveCount(30);
    await list.evaluate(element => { element.scrollTop = element.scrollHeight - element.clientHeight - 104; });
    // The sentinel is inside its 96px margin because the list has bottom padding.
    await page.waitForTimeout(200);
    await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(results).toHaveCount(60);
    expect(await calls(page)).toHaveLength(2);
  });

  test(`${scope} search loads at the bottom once, retains the reading position, and stops at the last page`, async ({ page }, testInfo) => {
    if (scope === "chat") {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript(() => {
        localStorage.setItem("notgram:preferences:v1", JSON.stringify({ themeId: "notgram-dark", interfaceScale: 125 }));
      });
    }
    const { list, results } = await fixture(page, scope, { delayed: true });
    await expect(results).toHaveCount(30);
    await expect(page.getByRole("button", { name: "加载更多" })).toHaveCount(0);
    const first = results.first();
    await expect(first.locator("strong")).toHaveCSS("font-size", "13px");
    await expect(first.locator("small")).toHaveCSS("font-size", "12px");
    await page.waitForTimeout(250);
    expect(await calls(page)).toHaveLength(1);
    expect(await list.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await page.locator(".global-search-results-panel").screenshot({ path: testInfo.outputPath("search-results.png") });

    await list.hover();
    await page.mouse.wheel(0, 10_000);
    await expect.poll(async () => (await calls(page)).length).toBe(2);
    await expect(list).toHaveAttribute("aria-busy", "true");
    await expect(list.getByRole("status", { name: "正在加载" })).toBeVisible();
    const scrollTop = await list.evaluate(element => element.scrollTop);
    const lastId = await results.last().getAttribute("data-search-message-id");
    const lastOffset = await results.last().evaluate(element => element.getBoundingClientRect().top);
    await list.evaluate(element => {
      for (let index = 0; index < 10; index++) element.dispatchEvent(new Event("scroll"));
    });
    expect(await calls(page)).toHaveLength(2);
    await release(page);
    await expect(results).toHaveCount(60);
    await expect(list).toHaveAttribute("aria-busy", "false");
    expect(Math.abs(await list.evaluate(element => element.scrollTop) - scrollTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(await list.locator(`[data-search-message-id="${lastId}"]`).evaluate(element => element.getBoundingClientRect().top) - lastOffset)).toBeLessThanOrEqual(1);
    for (const count of [90, 96]) {
      await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect(results).toHaveCount(count);
    }
    await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.waitForTimeout(250);
    expect(await calls(page)).toHaveLength(4);
    const ids = await results.evaluateAll(elements => elements.map(element => element.getAttribute("data-search-message-id")));
    expect(new Set(ids).size).toBe(96);
  });

  test(`${scope} search keeps results after a failed page and retries the same cursor`, async ({ page }) => {
    const { list, results } = await fixture(page, scope, { failure: true });
    await expect(results).toHaveCount(30);
    await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(list.getByRole("alert")).toContainText("Synthetic pagination failure");
    await expect(results).toHaveCount(30);
    await page.waitForTimeout(300);
    expect(await calls(page)).toHaveLength(2);
    await list.getByRole("button", { name: "重试" }).click();
    await expect(results).toHaveCount(60);
    await expect(list.getByRole("alert")).toHaveCount(0);
    const requests = await calls(page);
    expect(requests).toHaveLength(3);
    expect(requests[2].cursor).toBe(requests[1].cursor);
  });

  test(`${scope} search fills a short first page and ignores a late page after the query changes`, async ({ page }) => {
    const { results } = await fixture(page, scope, { pageSize: 2, delayed: true });
    await expect(results).toHaveCount(2);
    await expect.poll(async () => (await calls(page)).length).toBe(2);
    await page.getByRole("searchbox", { name: "搜索会话和消息" }).fill(`${query} 95`);
    await expect(results).toHaveCount(1);
    await expect(results.first()).toHaveAttribute("data-search-message-id", "scroll-search-95");
    await release(page);
    await page.waitForTimeout(300);
    await expect(results).toHaveCount(1);
    expect(await calls(page)).toHaveLength(3);
  });

  test(`${scope} search automatically fills the viewport when pages are short`, async ({ page }) => {
    const { list, results } = await fixture(page, scope, { pageSize: 2 });
    await expect.poll(() => list.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(96);
    await expect(list).toHaveAttribute("aria-busy", "false");
    const loaded = await results.count();
    expect(loaded).toBeGreaterThan(2);
    expect(loaded).toBeLessThan(96);
    const requestCount = (await calls(page)).length;
    await page.waitForTimeout(300);
    expect(await calls(page)).toHaveLength(requestCount);
    await expect(results).toHaveCount(loaded);
  });

  test(`${scope} search stops automatic pagination when the server repeats its cursor`, async ({ page }) => {
    const { results } = await fixture(page, scope, { pageSize: 2, repeatedCursor: true });
    await expect(results).toHaveCount(4);
    await page.waitForTimeout(300);
    expect(await calls(page)).toHaveLength(2);
  });
}
