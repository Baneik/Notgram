import { expect, test, type Page } from "@playwright/test";

const conversationFixture = async (page: Page) => {
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const connect = MockTelegramTransport.prototype.connect;
      MockTelegramTransport.prototype.loadCachedSnapshot = async () => undefined;
      MockTelegramTransport.prototype.connect = async function(listener) {
        const base = this.snapshot.messages.find(m => m.chatId === "chat-product" && m.content.kind === "text");
        const photo = this.snapshot.messages.find(m => m.content.kind === "media" && m.content.mediaType === "photo");
        const source = Array.from({length:43}, (_, i) => ({
          ...base, id:String(100+i), renderKey:undefined, senderId:i % 2 ? "u-jules" : "u-alex", outgoing:false,
          sentAt:new Date(1700000000000+i*1000).toISOString(), delivery:"read", isPinned:false,
          replyMarkup:undefined, forwardInfo:undefined, mediaAlbumId:undefined, interaction:undefined,
          replyTo:i===40 ? {kind:"message",messageId:"120",content:{kind:"text",text:"Synthetic referenced message"}} : undefined,
          content:i===38 ? photo.content : {kind:"text",text:Array.from({length:[3,12,26,1,4,10,1][i%7]}, (_,n)=>"Synthetic line "+n).join("\\n")}
        }));
        this.snapshot.messages = [...this.snapshot.messages.filter(m=>m.chatId!=="chat-product"),...source];
        this.snapshot.chats = this.snapshot.chats.map(c=>c.id==="chat-product" ? {...c,unreadCount:0,lastReadInboxMessageId:"142"} : c);
        globalThis.__indexDispatch=listener;
        return connect.call(this,listener);
      };
    }` });
  });
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.locator(".message-list").press("End");
  await expect(page.locator('[data-message-id="142"]')).toBeVisible();
  await page.waitForTimeout(700);
};

const measureConversation = (page: Page) => page.locator(".message-list").evaluate(element => {
  const rows = [...element.querySelectorAll<HTMLElement>("[data-index]")];
  const footer = element.querySelector(".message-list-end-sentinel")!.getBoundingClientRect();
  return { distance: element.scrollHeight - element.clientHeight - element.scrollTop,
    footerGap: element.getBoundingClientRect().bottom - footer.bottom,
    error: Math.max(0, ...rows.map(row => Math.abs(Number(row.dataset.knownSize) - row.getBoundingClientRect().height))) };
});

const expectBottom = async (page: Page) => {
  const geometry = await measureConversation(page);
  expect(geometry.error, JSON.stringify(geometry)).toBeLessThanOrEqual(0.1);
  expect(Math.abs(geometry.distance), JSON.stringify(geometry)).toBeLessThanOrEqual(1);
  // The accepted raw 1px edge tolerance plus scrollHeight's half-pixel rounding
  // can differ from the unrounded Footer rect by up to 1.5px.
  expect(Math.abs(geometry.footerGap), JSON.stringify(geometry)).toBeLessThanOrEqual(1.5);
};

for (const change of ["interior-removal", "prepend", "prefix-removal", "mixed-insertion"] as const) {
  test(`heterogeneous rows remeasure using the production index resolver (${change})`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/");
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    const result = await page.evaluate(async change => {
      const { resolveConversationVirtualIndex } = await import("/src/hooks/conversationScrollState.ts" as string) as typeof import("../../src/hooks/conversationScrollState");
      const resources = performance.getEntriesByType("resource").map(entry => entry.name);
      const moduleUrl = (name: string) => resources.find(url => new URL(url).pathname.endsWith(`/deps/${name}.js`))!;
      const React = (await import(moduleUrl("react"))).default as typeof import("react");
      const { createRoot } = (await import(moduleUrl("react-dom_client"))).default as typeof import("react-dom/client");
      const { Virtuoso } = await import(moduleUrl("react-virtuoso")) as typeof import("react-virtuoso");
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;top:0;left:0;width:722px;height:777px;background:white;z-index:99999";
      document.body.append(host);
      const root = createRoot(host);
      const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      let handle: import("react-virtuoso").VirtuosoHandle | null = null;
      let data = Array.from({ length: 43 }, (_, index) => ({ id: `row-${index}`,
        height: [99.2, 290, 548.3, 32.2, 99.2, 257.6, 31.8, 31.8, 99.2, 131.4, 123.1, 189.6, 121.4, 100.9, 80.2, 31.8, 54.2, 31.8][index % 18]! }));
      data[41]!.height = 54.2; data[42]!.height = 31.8;
      const origins: number[] = [];
      const render = () => {
        const firstItemIndex = resolveConversationVirtualIndex("heterogeneous-regression", data.map(item => item.id));
        origins.push(firstItemIndex);
        root.render(React.createElement(Virtuoso<{ id: string; height: number }>, {
          style: { height: "100%" }, ref: value => { handle = value; }, data, firstItemIndex,
          computeItemKey: (_, item) => item.id, defaultItemHeight: 52,
          itemSize: (el, field) => el.getBoundingClientRect()[field === "offsetHeight" ? "height" : "width"],
          initialTopMostItemIndex: { index: "LAST", align: "end" }, increaseViewportBy: { top: 640, bottom: 192 },
          itemContent: (_, item) => React.createElement("div", { style: { height: item.height } }, item.id),
        }));
      };
      const error = () => Math.max(0, ...[...host.querySelectorAll<HTMLElement>("[data-index]")]
        .map(row => Math.abs(Number(row.dataset.knownSize) - row.getBoundingClientRect().height)));
      try {
        render(); await pause(500);
        handle!.scrollToIndex({ index: "LAST", align: "end" }); await pause(400);
        const before = error();
        if (change === "interior-removal") data = data.filter(item => item.id !== "row-41");
        else if (change === "prefix-removal") data = data.slice(1);
        else if (change === "prepend") data = [{ id: "prefix", height: 243.8 }, ...data];
        else data = [{ id: "prefix", height: 243.8 }, ...data, { id: "tail", height: 42.2 }];
        render(); await pause(1800);
        return { before, after: error(), origins };
      } finally { root.unmount(); host.remove(); }
    }, change);
    expect(result.before).toBeLessThanOrEqual(0.1);
    expect(result.after, JSON.stringify(result)).toBeLessThanOrEqual(0.1);
    const delta = change === "prepend" ? -1 : change === "prefix-removal" ? 1 : 0;
    expect(result.origins[1]).toBe(result.origins[0]! + delta);
  });
}

test("late native scroll drift restores the bottom after the tracking pass has settled", async ({ page }) => {
  await page.goto("/");
  const list = page.locator(".message-list");
  await expect(list).toHaveAttribute("aria-busy", "false");
  await list.press("End");
  await page.waitForTimeout(900);
  const result = await list.evaluate(async element => {
    // Reproduce the observed endpoint state without attributing the native write
    // to a specific browser or virtualizer callback.
    element.scrollTop -= 17;
    await new Promise(resolve => setTimeout(resolve, 700));
    const footer = element.querySelector(".message-list-end-sentinel")!.getBoundingClientRect();
    return { distance: element.scrollHeight - element.clientHeight - element.scrollTop,
      footerGap: element.getBoundingClientRect().bottom - footer.bottom,
      error: Math.max(0, ...[...element.querySelectorAll<HTMLElement>("[data-index]")]
        .map(row => Math.abs(Number(row.dataset.knownSize) - row.getBoundingClientRect().height))) };
  });
  expect(result.error).toBeLessThanOrEqual(0.1);
  expect(Math.abs(result.distance), JSON.stringify(result)).toBeLessThanOrEqual(1);
  expect(Math.abs(result.footerGap)).toBeLessThanOrEqual(1);
});

for (const id of ["138", "140", "141", "142"]) {
  test(`retained message removal keeps heterogeneous conversation geometry (${id})`, async ({ page }) => {
    await conversationFixture(page);
    await page.evaluate(async id => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      const messages = new Map(telegramStore.getState().messages);
      messages.set("chat-product", messages.get("chat-product")!.map(m => m.id === id ? { ...m, isLocallyDeleted: true } : m));
      telegramStore.setState({ messages });
    }, id);
    await page.waitForTimeout(500);
    await expectBottom(page);
    const result = await page.evaluate(async id => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      const list = document.querySelector<HTMLElement>(".message-list")!;
      const survivor = list.querySelector<HTMLElement>('[data-message-id="142"]');
      const bottom = survivor?.getBoundingClientRect().bottom;
      const removed = await telegramStore.getState().deleteMessage(id, false, "chat-product");
      const samples: number[] = [];
      const changes: Array<{ shift: number; distance: number; gap: number }> = [];
      const start = performance.now();
      while (performance.now() - start < 1000) {
        await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        if (id !== "142") {
          const shift = survivor!.getBoundingClientRect().bottom - bottom!;
          samples.push(Math.abs(shift));
          if (changes.at(-1)?.shift !== shift) changes.push({ shift,
            distance: list.scrollHeight - list.clientHeight - list.scrollTop,
            gap: list.getBoundingClientRect().bottom - survivor!.getBoundingClientRect().bottom });
        }
      }
      return { removed, shift: Math.max(0, ...samples), changes, connected: id === "142" || survivor!.isConnected,
        remains: telegramStore.getState().messages.get("chat-product")!.some(m => m.id === id),
        ghosts: telegramStore.getState().removingMessages.get("chat-product")?.length ?? 0 };
    }, id);
    expect(result.removed).toBe(true);
    expect(result.remains).toBe(false);
    expect(result.ghosts).toBe(0);
    expect(result.connected).toBe(true);
    expect(result.shift, JSON.stringify(result)).toBeLessThanOrEqual(1);
    await expectBottom(page);
  });
}

for (const detached of [false, true]) {
  test(`internal history fill preserves the viewport and nodes (detached: ${detached})`, async ({ page }) => {
    await conversationFixture(page);
    if (detached) {
      await page.locator(".message-list").hover();
      await page.mouse.wheel(0, -250);
      await page.waitForTimeout(600);
    }
    const result = await page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      const dispatch = (window as unknown as { __indexDispatch: (event: import("../../src/telegram/types").TelegramEvent) => void }).__indexDispatch;
      const list = document.querySelector<HTMLElement>(".message-list")!;
      const bounds = list.getBoundingClientRect();
      const anchor = [...list.querySelectorAll<HTMLElement>("[data-message-id]")].find(row => row.getBoundingClientRect().top >= bounds.top)!;
      const top = anchor.getBoundingClientRect().top;
      const source = telegramStore.getState().messages.get("chat-product")!.find(m => m.id === "125")!;
      dispatch({ type: "messages.upserted", messages: [{ ...source, id: "history-fill", senderId: "u-jules",
        sentAt: new Date(Date.parse(source.sentAt) + 500).toISOString(), content: { kind: "text", text: "Internal history fill\nSecond line" } }] });
      const shifts: number[] = [];
      const start = performance.now();
      while (performance.now() - start < 900) {
        await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        shifts.push(Math.abs(anchor.getBoundingClientRect().top - top));
      }
      return { shift: Math.max(...shifts), connected: anchor.isConnected,
        present: telegramStore.getState().messages.get("chat-product")!.some(m => m.id === "history-fill") };
    });
    expect(result.present).toBe(true);
    expect(result.connected).toBe(true);
    expect(result.shift).toBeLessThanOrEqual(1);
    expect((await measureConversation(page)).error).toBeLessThanOrEqual(0.1);
    if (!detached) await expectBottom(page);
  });
}

for (const order of ["confirmation-first", "bot-first", "interior-bot"] as const) {
  test(`bot replies and send confirmation preserve the baseline without deleting the source (${order})`, async ({ page }) => {
    await conversationFixture(page);
    const result = await page.evaluate(async order => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
      const dispatch = (window as unknown as { __indexDispatch: (event: import("../../src/telegram/types").TelegramEvent) => void }).__indexDispatch;
      preferencesStore.setState({ deletedMessageArchiveEnabled: false });
      const state = telegramStore.getState();
      const source = state.messages.get("chat-product")!.find(m => m.id === "140")!;
      const last = state.messages.get("chat-product")!.at(-1)!;
      const sentAt = new Date(Date.parse(last.sentAt) + 1000).toISOString();
      const command = { ...last, id: "-1", renderKey: "pending-command", outgoing: true, senderId: state.currentUserId!,
        sentAt, delivery: "sending" as const, replyTo: { kind: "message" as const, messageId: source.id, content: source.content },
        content: { kind: "text" as const, text: "/check" } };
      const bot = { ...last, id: "151", senderId: "test-bot", outgoing: false,
        sentAt: order === "interior-bot" ? new Date(Date.parse(source.sentAt) + 500).toISOString() : sentAt,
        content: { kind: "text" as const, text: "Synthetic bot reply\nSource remains present" } };
      const users = new Map(state.users);
      users.set(bot.senderId, { ...users.values().next().value!, id: bot.senderId, isBot: true });
      telegramStore.setState({ users });
      const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      dispatch({ type: "message.upsert", message: command, animateEntrance: true });
      await pause(180);
      const pendingNode = document.querySelector('[data-message-id="-1"]');
      const confirm = () => dispatch({ type: "message.replace", oldMessageId: "-1", message: { ...command, id: "150", delivery: "sent" } });
      if (order === "confirmation-first") confirm();
      dispatch({ type: "message.upsert", message: bot, animateEntrance: true });
      await pause(180);
      if (order !== "confirmation-first") confirm();
      // Resolve the bot's quoted content later, independently of sending order.
      dispatch({ type: "message.upsert", message: { ...bot, replyTo: command.replyTo } });
      await pause(900);
      const list = document.querySelector<HTMLElement>(".message-list")!;
      const beforeExpiry = { distance: list.scrollHeight - list.clientHeight - list.scrollTop,
        error: Math.max(0, ...[...list.querySelectorAll<HTMLElement>("[data-index]")].map(row => Math.abs(Number(row.dataset.knownSize) - row.getBoundingClientRect().height))),
        sourceIntact: telegramStore.getState().messages.get("chat-product")!.find(m => m.id === source.id) === source,
        ghosts: telegramStore.getState().removingMessages.get("chat-product")?.length ?? 0,
        sameCommandNode: pendingNode !== null && pendingNode === document.querySelector('[data-message-id="150"]') };
      dispatch({ type: "message.remove", chatId: bot.chatId, messageId: bot.id, source: "remote", permanent: true });
      await pause(900);
      return beforeExpiry;
    }, order);
    expect(result.sourceIntact).toBe(true);
    expect(result.ghosts).toBe(0);
    expect(result.sameCommandNode).toBe(true);
    expect(result.error).toBeLessThanOrEqual(0.1);
    expect(Math.abs(result.distance)).toBeLessThanOrEqual(1);
    await expectBottom(page);
  });
}
