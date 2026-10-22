import { expect, test, type Page } from "@playwright/test";
import type { telegramStore as Store } from "../../src/store/telegramStore";
import type { TelegramEvent } from "../../src/telegram/types";
import { chooseMessageMenuItem } from "./helpers";

interface ContextRuntime {
  store: typeof Store;
  dispatch: (event: TelegramEvent) => void;
  sends: unknown[][];
  edits: unknown[][];
}

const input = (page: Page) => page.getByRole("textbox", { name: "消息内容", exact: true });
const panel = (page: Page) => page.locator(".conversation .composer-context");

async function fixture(page: Page, editing = false, long = false) {
  const config = { target: long ? 9500 : 750, total: long ? 12000 : 1000, initial: long ? 2400 : 164, editing };
  await page.route(/\/src\/store\/telegramStore\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const context = globalThis.__composerContext ??= { sends: [], edits: [] };
      context.store = telegramStore;
      const { sendMessage, editMessage } = telegramStore.getState();
      telegramStore.setState({
        sendMessage: (...args) => { context.sends.push(args); return sendMessage(...args); },
        editMessage: (...args) => { context.edits.push(args); return editMessage(...args); },
      });
    }` });
  });
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const config = ${JSON.stringify(config)};
      const connect = MockTelegramTransport.prototype.connect;
      MockTelegramTransport.prototype.loadCachedSnapshot = async () => undefined;
      MockTelegramTransport.prototype.connect = async function(listener) {
        const base = this.snapshot.messages.find(m => m.chatId === "chat-product" && m.content.kind === "text");
        const make = id => ({ ...base, id: String(id), renderKey: undefined,
          senderId: id === config.target && config.editing ? "self" : "u-jules",
          outgoing: id === config.target && config.editing,
          sentAt: new Date(1700000000000 + id * 60000).toISOString(), delivery: "sent", isPending: false,
          interaction: undefined, mediaAlbumId: undefined,
          permissions: { ...base.permissions, canReply: true, canEdit: id === config.target && config.editing },
          replyTo: id === config.total ? { kind: "message", chatId: "chat-product", messageId: String(config.target),
            senderId: "u-jules", content: { kind: "text", text: "window source quote" } } : undefined,
          content: { kind: "text", text: "window message " + id + (id === config.target ? " source quote" : "") } });
        const source = Array.from({length: config.total}, (_, i) => make(i + 1));
        this.snapshot.messages = [...this.snapshot.messages.filter(m => m.chatId !== "chat-product"), ...source];
        this.snapshot.chats = this.snapshot.chats.map(c => c.id === "chat-product"
          ? { ...c, unreadCount: 0, lastReadInboxMessageId: String(config.total) } : c);
        (globalThis.__composerContext ??= { sends: [], edits: [] }).dispatch = listener;
        const snapshot = await connect.call(this, listener);
        return { ...snapshot, messages: source.slice(-config.initial) };
      };
    }` });
  });
  await page.goto("/");
  if ((page.viewportSize()?.width ?? 900) < 600) await page.getByRole("button", { name: /^产品讨论/ }).click();
  await expect(page.locator(".conversation .message-list")).toHaveAttribute("aria-busy", "false");
  await page.locator(".conversation .message-list").press("End");
  await expect(page.locator(`[data-message-id="${config.total}"]`)).toBeVisible();
  return config;
}

async function startContext(page: Page, target: number, total: number, editing = false, quote = false) {
  await page.locator(`[data-message-id="${total}"] .message-reply-preview`).click();
  const source = page.locator(`[data-message-id="${target}"]`);
  await expect(source).toBeVisible();
  await expect(page.locator(".conversation .message-list")).toHaveAttribute("aria-busy", "false");
  await source.locator(".message-bubble-shell").focus();
  if (quote) {
    await source.locator(".message-rich-text").evaluate(surface => {
      const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const start = node.textContent?.indexOf("source quote") ?? -1;
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start); range.setEnd(node, start + "source quote".length);
        getSelection()?.removeAllRanges(); getSelection()?.addRange(range);
        return;
      }
      throw new Error("Quote fixture is missing");
    });
  }
  await page.keyboard.press("Shift+F10");
  await chooseMessageMenuItem(page, editing ? "编辑" : "回复");
  await expect(panel(page)).toBeVisible();
  if (quote) await expect(panel(page).locator("small")).toHaveText("source quote");
}

for (const width of [1366, 390]) {
  test(`quoted reply stays visible after returning to latest and sends its local quote (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { target, total } = await fixture(page);
    await startContext(page, target, total, false, true);
    await input(page).fill("reply after navigation");
    await page.locator(".jump-to-latest").click();
    await expect(page.locator(`[data-message-id="${total}"]`)).toBeVisible();
    await expect(panel(page).locator("small")).toHaveText("source quote");
    // A normalized draft echo must not replace a locally selected quote.
    await page.evaluate(() => {
      const { store } = (window as unknown as { __composerContext: ContextRuntime }).__composerContext;
      const drafts = new Map(store.getState().drafts);
      const draft = drafts.get("chat-product")!;
      drafts.set("chat-product", { ...draft, replyQuote: undefined });
      store.setState({ drafts });
    });
    await expect(panel(page).locator("small")).toHaveText("source quote");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const sends = await page.evaluate(() => (window as unknown as { __composerContext: ContextRuntime }).__composerContext.sends);
    expect(sends.at(-1)?.slice(0, 3)).toEqual(["reply after navigation", String(target), { text: "source quote", position: 19 }]);
    await expect(panel(page)).toHaveCount(0);
  });

  test(`editing survives latest navigation, cancel restores the draft and save edits the source (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { target, total } = await fixture(page, true);
    await input(page).fill("previous draft");
    for (const save of [false, true]) {
      await startContext(page, target, total, true);
      await input(page).fill("unsaved edited content");
      await page.locator(".jump-to-latest").click();
      await expect(page.locator(`[data-message-id="${total}"]`)).toBeVisible();
      await expect(panel(page)).toHaveClass(/is-editing/);
      await expect(input(page)).toHaveJSProperty("value", "unsaved edited content");
      if (save) await page.getByRole("button", { name: "保存编辑", exact: true }).click();
      else await input(page).press("Escape");
      await expect(panel(page)).toHaveCount(0);
      await expect(input(page)).toHaveJSProperty("value", "previous draft");
    }
    const edits = await page.evaluate(() => (window as unknown as { __composerContext: ContextRuntime }).__composerContext.edits);
    expect(edits).toHaveLength(1);
    expect(edits[0].slice(0, 2)).toEqual([String(target), "unsaved edited content"]);
  });

  for (const editing of [false, true]) {
    test(`long downward paging preserves ${editing ? "edit" : "reply"} across retention splits (${width}px)`, async ({ page }) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width, height: 900 });
      const { target, total } = await fixture(page, editing, true);
      await startContext(page, target, total, editing, !editing);
      await input(page).fill("keep across retention");
      const list = page.locator(".conversation .message-list");
      await list.hover();
      for (let turn = 0; turn < 140; turn++) {
        await page.mouse.wheel(0, 25000);
        await page.waitForTimeout(160);
        if (await page.locator(`[data-message-id="${total}"]`).isVisible()) break;
      }
      await expect(page.locator(`[data-message-id="${total}"]`)).toBeVisible();
      await expect(list).toHaveAttribute("aria-busy", "false");
      await expect(panel(page)).toHaveClass(editing ? /is-editing/ : /is-replying/);
      await expect(input(page)).toHaveJSProperty("value", "keep across retention");
      const membership = await page.evaluate(target => {
        const state = (window as unknown as { __composerContext: ContextRuntime }).__composerContext.store.getState();
        const view = state.histories.get("chat-product")!.view!;
        return { cached: state.messages.get("chat-product")!.some(message => message.id === target),
          inView: view.messageIds ? view.messageIds.has(target) : !view.excludedIds.has(target) };
      }, String(target));
      expect(membership).toEqual({ cached: true, inView: false });
      if (editing) await input(page).press("Escape");
      else {
        await page.getByRole("button", { name: "取消回复", exact: true }).click();
        expect(await page.evaluate(() => (window as unknown as { __composerContext: ContextRuntime })
          .__composerContext.store.getState().drafts.get("chat-product")?.replyToMessageId)).toBeUndefined();
      }
      await expect(panel(page)).toHaveCount(0);
    });
  }
}

for (const editing of [false, true]) {
  test(`cache misses preserve ${editing ? "editing" : "reply"}, explicit deletion revokes it`, async ({ page }) => {
    const { target, total } = await fixture(page, editing);
    await startContext(page, target, total, editing);
    await input(page).fill("keep this input");
    await page.locator(".jump-to-latest").click();
    await page.evaluate(target => {
      const { store } = (window as unknown as { __composerContext: ContextRuntime }).__composerContext;
      const state = store.getState();
      store.setState({ messages: new Map(state.messages).set("chat-product", state.messages.get("chat-product")!
        .filter(message => message.id !== target)) });
    }, String(target));
    await expect(panel(page)).toBeVisible();
    await expect(input(page)).toHaveJSProperty("value", "keep this input");
    await page.evaluate(target => {
      const { dispatch } = (window as unknown as { __composerContext: ContextRuntime }).__composerContext;
      dispatch({ type: "message.remove", chatId: "chat-product", messageId: target, permanent: true, source: "local" });
    }, String(target));
    await expect(panel(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __composerContext: ContextRuntime })
      .__composerContext.store.getState().drafts.get("chat-product")?.replyToMessageId)).toBeUndefined();
  });
}

test("fully hiding a reply source clears its panel and stored quote without losing the input", async ({ page }) => {
  const { target, total } = await fixture(page);
  await startContext(page, target, total, false, true);
  await input(page).fill("retain draft text");
  await page.locator(".jump-to-latest").click();
  await page.evaluate(async () => {
    const { localUserBlocksStore } = await import("/src/store/localUserBlocks.ts" as string) as typeof import("../../src/store/localUserBlocks");
    const state = (window as unknown as { __composerContext: ContextRuntime }).__composerContext.store.getState();
    const user = state.users.get("u-jules")!;
    localUserBlocksStore.getState().blockUser(state.activeAccountId!, user);
    localUserBlocksStore.getState().setUserMode(state.activeAccountId!, user.id, "hide");
  });
  await expect(panel(page)).toHaveCount(0);
  await expect(input(page)).toHaveJSProperty("value", "retain draft text");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const sends = await page.evaluate(() => (window as unknown as { __composerContext: ContextRuntime }).__composerContext.sends);
  expect(sends.at(-1)?.slice(0, 3)).toEqual(["retain draft text", undefined, undefined]);
});

test("reply drafts restore outside the timeline and ignore deletions in another chat", async ({ page }) => {
  const { target, total } = await fixture(page);
  await startContext(page, target, total, false, true);
  await input(page).fill("reply draft to restore");
  await page.locator(".jump-to-latest").click();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(panel(page)).toHaveCount(0);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator(`[data-message-id="${total}"]`)).toBeVisible();
  await expect(panel(page).locator("small")).toHaveText("source quote");
  await expect(input(page)).toHaveJSProperty("value", "reply draft to restore");
  await page.evaluate(target => {
    (window as unknown as { __composerContext: ContextRuntime }).__composerContext.dispatch({
      type: "message.remove", chatId: "chat-mia", messageId: target, immediate: true, permanent: true, source: "local",
    });
  }, String(target));
  await expect(panel(page).locator("small")).toHaveText("source quote");
  await page.getByRole("button", { name: "取消回复", exact: true }).click();
  await expect(input(page)).toHaveJSProperty("value", "reply draft to restore");
});

test("replies to retained deleted sources keep their local quote conversion outside the timeline", async ({ page }) => {
  const { target, total } = await fixture(page);
  await startContext(page, target, total, false, true);
  await input(page).fill("local archive reply");
  await page.evaluate(target => {
    const { store, dispatch } = (window as unknown as { __composerContext: ContextRuntime }).__composerContext;
    const source = store.getState().messages.get("chat-product")!.find(message => message.id === target)!;
    dispatch({ type: "message.upsert", message: { ...source, isLocallyDeleted: true, permissions: undefined } });
  }, String(target));
  await page.locator(".jump-to-latest").click();
  await expect(page.locator(`[data-message-id="${total}"]`)).toBeVisible();
  await expect(panel(page).locator("small")).toHaveText("source quote");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const sends = await page.evaluate(() => (window as unknown as { __composerContext: ContextRuntime }).__composerContext.sends);
  expect(sends.at(-1)?.[0]).toContain("source quote");
  expect(sends.at(-1)?.[0]).toContain("local archive reply");
  expect(sends.at(-1)?.slice(1, 3)).toEqual([undefined, undefined]);
});

test("a pinned reply draft can restore from separately loaded pinned messages", async ({ page }) => {
  const { target, total } = await fixture(page);
  await startContext(page, target, total, false, true);
  await input(page).fill("pinned reply draft");
  await page.locator(".jump-to-latest").click();
  await page.evaluate(target => {
    const { store } = (window as unknown as { __composerContext: ContextRuntime }).__composerContext;
    const state = store.getState();
    const source = { ...state.messages.get("chat-product")!.find(message => message.id === target)!, isPinned: true };
    store.setState({ messages: new Map(state.messages).set("chat-product", state.messages.get("chat-product")!
      .filter(message => message.id !== target)),
    loadPinnedMessages: async chatId => chatId === source.chatId ? [source] : [] });
  }, String(target));
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(panel(page).locator("small")).toHaveText("source quote");
  await expect(input(page)).toHaveJSProperty("value", "pinned reply draft");
  expect(await page.evaluate(target => (window as unknown as { __composerContext: ContextRuntime })
    .__composerContext.store.getState().messages.get("chat-product")!.some(message => message.id === target), String(target))).toBe(false);
});
