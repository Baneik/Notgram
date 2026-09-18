import { expect, test, type Page } from "@playwright/test";
import { revealVirtualMessage } from "./helpers";

const installQuoteHistory = async (page: Page, surface = "text", quoteIndex = 25, lines = 70, lineText = "keep the collapse control at the pointer.") => {
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const connect = MockTelegramTransport.prototype.connect;
      const loadChatHistory = MockTelegramTransport.prototype.loadChatHistory;
      MockTelegramTransport.prototype.loadChatHistory = function(chatId, limit, request) {
        return loadChatHistory.call(this, chatId, chatId === "chat-product" ? 100 : limit, request);
      };
      MockTelegramTransport.prototype.loadCachedSnapshot = async () => undefined;
      MockTelegramTransport.prototype.connect = async function(listener) {
        const photo = this.snapshot.messages.find(m => m.content.kind === "media" && m.content.mediaType === "photo");
        const quote = Array.from({length:${lines}}, (_,i) => "Line " + i + ": " + ${JSON.stringify(lineText)}).join("\\n");
        const text = "Before the quote\\n" + quote + "\\nAfter the quote";
        const entities = [{kind:"blockquote",offset:17,length:quote.length}];
        if (${JSON.stringify(surface)} === "segmented") {
          entities.length = 0;
          let offset = 17;
          for (const line of quote.split("\\n")) {
            entities.push({kind:"blockquote",offset,length:line.length+1});
            offset += line.length+1;
          }
          entities.push({kind:"bold",offset:17,length:4});
        }
        const source = Array.from({length:51}, (_,i) => ({
          id:"collapse-"+i, chatId:"chat-product", senderId:i%2?"u-mia":"u-chen", outgoing:false,
          sentAt:new Date(1700000000000+i*1000).toISOString(), delivery:"read",
          content:i===${quoteIndex} ? {kind:"text",text,entities} : {kind:"text",text:"Surrounding message " + i}
        }));
        if (["photo", "album"].includes(${JSON.stringify(surface)})) {
          source[${quoteIndex}].content = {...photo.content,width:600,height:320,caption:text,captionEntities:entities};
        }
        if (${JSON.stringify(surface)} === "markdown") {
          source[${quoteIndex}].content = {kind:"text",text:"Before the quote\\n\\n" + quote.split("\\n").map(line => "> " + line).join("\\n") + "\\n\\nAfter the quote"};
        }
        if (${JSON.stringify(surface)} === "rich") {
          source[${quoteIndex}].content = {kind:"rich",text,isRtl:false,isFull:true,blocks:[
            {kind:"paragraph",text:[{text:"Before the quote"}]},
            {kind:"quote",pull:false,blocks:[{kind:"paragraph",text:[{text:quote}]}]},
            {kind:"paragraph",text:[{text:"After the quote"}]}
          ]};
        }
        if (${JSON.stringify(surface)} === "album") {
          source[${quoteIndex - 1}].content = {...photo.content,width:600,height:320,caption:undefined};
          source[${quoteIndex - 1}].mediaAlbumId = source[${quoteIndex}].mediaAlbumId = "collapse-album";
        }
        this.snapshot.messages = [...this.snapshot.messages.filter(m=>m.chatId!=="chat-product"),...source];
        this.snapshot.chats = this.snapshot.chats.map(c=>c.id==="chat-product"?{...c,unreadCount:0,lastReadInboxMessageId:"collapse-50"}:c);
        return connect.call(this,listener);
      };
    }` });
  });
};

const openQuote = async (page: Page, quoteIndex = 25) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await revealVirtualMessage(page, `collapse-${quoteIndex}`);
  const quote = page.locator(".message-list .rich-blockquote");
  await expect(quote).toHaveAttribute("data-quote-state", "collapsed");
  await page.locator(".message-list").evaluate(element =>
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 })));
  return quote;
};

const showCollapseButton = async (page: Page) => {
  const button = page.locator(".message-list .rich-blockquote-collapse");
  await button.evaluate(async element => {
    // Let Virtuoso measure expansion before scrolling across the enlarged block.
    for (let frame = 0; frame < 12; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    element.closest(".message-list")!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 1 }));
    element.scrollIntoView({ block: "center", behavior: "instant" });
  });
  return button;
};

const recordCollapse = async (page: Page, keyboard = false) => {
  await page.evaluate(({ keyboard }) => {
    const state = window as typeof window & { collapseFrames?: Promise<Array<{ error: number; top: number; hidden: boolean }>> };
    document.addEventListener("click", function record(event) {
      const button = (event.target as Element).closest(".rich-blockquote-collapse");
      if (!button) return;
      document.removeEventListener("click", record, true);
      const rect = button.getBoundingClientRect();
      const pointer = keyboard ? (rect.top + rect.bottom) / 2 : event.clientY;
      const list = button.closest<HTMLElement>(".message-list")!;
      state.collapseFrames = new Promise(resolve => {
        const frames: Array<{ error: number; top: number; hidden: boolean }> = [];
        const start = performance.now();
        const sample = () => requestAnimationFrame(() => setTimeout(() => {
          const icon = list.querySelector(".rich-blockquote-expand > svg");
          const bounds = icon?.getBoundingClientRect();
          frames.push({ error: bounds ? (bounds.top + bounds.bottom) / 2 - pointer : 1e6,
            top: list.scrollTop, hidden: list.classList.contains("is-jump-transitioning") });
          if (performance.now() - start < 1000) sample();
          else resolve(frames);
        }, 0));
        sample();
      });
    }, true);
  }, { keyboard });
};

const collapseFrames = (page: Page) => page.evaluate(() => (
  window as typeof window & { collapseFrames?: Promise<Array<{ error: number; top: number; hidden: boolean }>> }
).collapseFrames!);

for (const scenario of [
  { name: "text", surface: "text", scale: 100, width: 1280, reduced: false },
  { name: "zoom", surface: "text", scale: 125, width: 1280, reduced: false },
  { name: "narrow", surface: "text", scale: 100, width: 580, reduced: false },
  { name: "reduced motion", surface: "text", scale: 100, width: 1280, reduced: true },
  { name: "photo caption", surface: "photo", scale: 100, width: 1280, reduced: false },
  { name: "album caption", surface: "album", scale: 100, width: 1280, reduced: false },
  { name: "markdown", surface: "markdown", scale: 100, width: 1280, reduced: false },
  { name: "rich", surface: "rich", scale: 125, width: 1280, reduced: false },
  { name: "adjacent quoted segments", surface: "segmented", scale: 100, width: 1280, reduced: false },
]) test(`quote collapse stays at the pointer on every painted frame (${scenario.name})`, async ({ page }) => {
  await page.setViewportSize({ width: scenario.width, height: 800 });
  await page.addInitScript(({ scale, reduced }) => localStorage.setItem("notgram:preferences:v1",
    JSON.stringify({ interfaceScale: scale, reduceMotion: reduced })), scenario);
  await installQuoteHistory(page, scenario.surface);
  const quote = await openQuote(page);
  for (let cycle = 0; cycle < 2; cycle++) {
    await quote.getByRole("button", { name: /展开引用/ }).click();
    await expect(quote).toHaveAttribute("data-quote-state", "expanded");
    const button = await showCollapseButton(page);
    await recordCollapse(page);
    await button.click();
    const frames = await collapseFrames(page);
    expect(frames.length).toBeGreaterThan(10);
    expect(Math.max(...frames.map(frame => Math.abs(frame.error))), JSON.stringify(frames)).toBeLessThanOrEqual(1);
    expect(frames.every(frame => !frame.hidden)).toBe(true);
    expect(Math.max(...frames.map(frame => frame.error)) - Math.min(...frames.map(frame => frame.error)),
      JSON.stringify(frames)).toBeLessThanOrEqual(1);
    await expect(page.getByRole("button", { name: /^返回跳转前位置/ })).toHaveCount(0);
  }
});

test("keyboard collapse keeps the former control location", async ({ page }) => {
  await installQuoteHistory(page);
  const quote = await openQuote(page);
  await quote.getByRole("button", { name: /展开引用/ }).click();
  const button = await showCollapseButton(page);
  await button.focus();
  await recordCollapse(page, true);
  await button.press("Enter");
  const frames = await collapseFrames(page);
  expect(Math.max(...frames.map(frame => Math.abs(frame.error))), JSON.stringify(frames)).toBeLessThanOrEqual(1);
});

test("scroll input immediately takes over after quote collapse", async ({ page }) => {
  await installQuoteHistory(page);
  const quote = await openQuote(page);
  await quote.getByRole("button", { name: /展开引用/ }).click();
  const button = await showCollapseButton(page);
  await button.click();
  const list = page.locator(".message-list");
  const icon = quote.locator(".rich-blockquote-expand > svg");
  const start = await icon.evaluate(async element => {
    await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    return element.getBoundingClientRect().top;
  });
  await page.mouse.wheel(0, -240);
  await expect.poll(() => icon.evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThan(start + 100);
  const position = await list.evaluate(async element => {
    const samples: number[] = [];
    for (let frame = 0; frame < 45; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      samples.push(element.querySelector(".rich-blockquote-expand > svg")?.getBoundingClientRect().top ?? 1e6);
    }
    return samples;
  });
  expect(Math.max(...position.slice(15)) - Math.min(...position.slice(15))).toBeLessThanOrEqual(1);
  expect(position.at(-1)!).toBeGreaterThan(start + 100);
});

test("switching chats cancels quote collapse positioning", async ({ page }) => {
  await installQuoteHistory(page);
  const quote = await openQuote(page);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  const list = page.locator(".message-list");
  await expect(list).toHaveAttribute("aria-busy", "false");
  await page.locator(".jump-to-latest").click();
  await expect.poll(() => list.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(quote).toHaveAttribute("data-quote-state", "collapsed");
  await quote.getByRole("button", { name: /展开引用/ }).click();
  await (await showCollapseButton(page)).click();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(list).toHaveAttribute("aria-busy", "false");
  const distances = await list.evaluate(async element => {
    const samples: number[] = [];
    for (let frame = 0; frame < 45; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      samples.push(element.scrollHeight - element.clientHeight - element.scrollTop);
    }
    return samples;
  });
  expect(Math.max(...distances.map(Math.abs))).toBeLessThanOrEqual(1);
});

for (const quoteIndex of [0, 50]) test(`quote collapse stays stable at a history boundary (${quoteIndex})`, async ({ page }) => {
  await installQuoteHistory(page, "text", quoteIndex);
  const quote = await openQuote(page, quoteIndex);
  await quote.getByRole("button", { name: /展开引用/ }).click();
  const button = await showCollapseButton(page);
  await recordCollapse(page);
  await button.click();
  const frames = await collapseFrames(page);
  expect(Math.max(...frames.map(frame => frame.error)) - Math.min(...frames.map(frame => frame.error)),
    JSON.stringify(frames)).toBeLessThanOrEqual(1);
  expect(frames.every(frame => !frame.hidden)).toBe(true);
  // At the start of history the browser can only place the control at the
  // closest reachable point. It must never keep chasing a negative scrollTop.
  if (quoteIndex === 0) expect(frames.at(-1)!.top).toBe(0);
  else expect(Math.max(...frames.map(frame => Math.abs(frame.error))), JSON.stringify(frames)).toBeLessThanOrEqual(1);
});

for (const surface of ["text", "markdown", "rich", "segmented"]) {
  test(`local quote folding respects the exact displayed-line threshold (${surface})`, async ({ page, context }) => {
    await installQuoteHistory(page, surface, 25, 10, "short");
    await page.goto("/");
    await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
    await revealVirtualMessage(page, "collapse-25");
    const quote = page.locator(".message-list .rich-blockquote");
    await expect(quote).toHaveAttribute("data-quote-line-count", "10");
    await expect(quote).toHaveAttribute("data-quote-state", "static");
    if (surface === "segmented") await expect(quote.locator("strong")).toHaveText("Line");
    const settings = await context.newPage();
    await settings.goto("/windows/settings-window.html");
    await settings.getByRole("button", { name: "聊天设置", exact: true }).click();
    const threshold = settings.getByRole("spinbutton", { name: "引用自动折叠阈值" });
    await expect(threshold).toHaveValue("10");
    await threshold.fill("9");
    await expect(quote).toHaveAttribute("data-quote-state", "collapsed");
    await threshold.fill("1");
    await expect.poll(() => quote.evaluate(element => {
      const content = element.querySelector(".rich-blockquote-content")!;
      return element.getBoundingClientRect().height / parseFloat(getComputedStyle(content).lineHeight);
    })).toBeLessThanOrEqual(1.01);
    await threshold.fill("9");
    await quote.getByRole("button", { name: /展开引用/ }).click();
    await expect(quote).toHaveAttribute("data-quote-state", "expanded");
    await quote.getByRole("button", { name: "收起引用" }).click();
    await expect(quote).toHaveAttribute("data-quote-state", "collapsed");
    await threshold.fill("20");
    await expect(quote).toHaveAttribute("data-quote-state", "static");
    await settings.reload();
    await settings.getByRole("button", { name: "聊天设置", exact: true }).click();
    await expect(threshold).toHaveValue("20");
    await settings.getByRole("button", { name: "恢复显示默认值" }).click();
    await expect(threshold).toHaveValue("10");
    await expect(quote).toHaveAttribute("data-quote-state", "static");
    await settings.close();
  });
}

test("local quote folding counts soft-wrapped lines and preserves manual expansion on resize", async ({ page }) => {
  await installQuoteHistory(page, "markdown", 25, 1, "A softly wrapped quote. ".repeat(65));
  const quote = await openQuote(page);
  await expect.poll(async () => Number(await quote.getAttribute("data-quote-line-count"))).toBeGreaterThan(10);
  await quote.getByRole("button", { name: /展开引用/ }).click();
  await page.setViewportSize({ width: 580, height: 800 });
  await expect(quote).toHaveAttribute("data-quote-state", "expanded");
  const button = await showCollapseButton(page);
  await button.click();
  await expect(quote).toHaveAttribute("data-quote-state", "collapsed");
});
