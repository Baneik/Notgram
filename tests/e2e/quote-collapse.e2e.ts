import { expect, test, type Page } from "@playwright/test";
import { revealVirtualMessage } from "./helpers";

const installQuoteHistory = async (page: Page, surface = "text", quoteIndex = 25) => {
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
        const quote = Array.from({length:70}, (_,i) => "Quoted line " + i + ": keep the collapse control at the pointer.").join("\\n");
        const text = "Before the quote\\n" + quote + "\\nAfter the quote";
        const entities = [{kind:"blockquote",offset:17,length:quote.length}];
        const source = Array.from({length:51}, (_,i) => ({
          id:"collapse-"+i, chatId:"chat-product", senderId:i%2?"u-mia":"u-chen", outgoing:false,
          sentAt:new Date(1700000000000+i*1000).toISOString(), delivery:"read",
          content:i===${quoteIndex} ? {kind:"text",text,entities} : {kind:"text",text:"Surrounding message " + i}
        }));
        if (${JSON.stringify(surface)} !== "text") {
          source[${quoteIndex}].content = {...photo.content,width:600,height:320,caption:text,captionEntities:entities};
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
