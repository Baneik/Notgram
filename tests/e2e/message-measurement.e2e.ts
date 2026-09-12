import { expect, test, type Page } from "@playwright/test";

const mixedHistory = async (page: Page, surface: "text" | "photo-caption" | "album-caption") => {
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n{
      const connect = MockTelegramTransport.prototype.connect;
      MockTelegramTransport.prototype.loadCachedSnapshot = async () => undefined;
      MockTelegramTransport.prototype.connect = async function(listener) {
        const photo = this.snapshot.messages.find(m => m.content.kind === "media" && m.content.mediaType === "photo");
        const quote = Array.from({length:24}, (_,i) => "Synthetic quoted paragraph " + i + ": preserve the viewport while measuring metadata.").join("\\n");
        const text = "Forwarded update\\n" + quote + "\\nSource link";
        const source = Array.from({length:31}, (_,i) => ({
          id:String(1000+i), chatId:"chat-product", senderId:["u-mia","u-chen","u-jules"][Math.floor(i/3)%3],
          outgoing:false, sentAt:new Date(1700000000000+i*1000).toISOString(), delivery:"read",
          content:i===16 ? {kind:"text",text,entities:[{kind:"blockquote",offset:17,length:quote.length}]} :
            [2,8,10,23].includes(i) ? {...photo.content,mediaType:i===2?"photo":"sticker",width:512,height:i===2?540:448} :
            {kind:"text",text:"Synthetic message " + i},
          replyTo:[4,12,18,22].includes(i) ? {kind:"message",origin:{kind:"hiddenUser",senderName:"Quoted sender"},content:{kind:"text",text:"Earlier message"}} : undefined
        }));
        if (${JSON.stringify(surface)} !== "text") {
          source[16].content = {...photo.content,width:600,height:320,caption:text,captionEntities:[{kind:"blockquote",offset:17,length:quote.length}]};
        }
        if (${JSON.stringify(surface)} === "album-caption") {
          source[15].content = {...photo.content,width:600,height:320,caption:undefined};
          source[15].mediaAlbumId = source[16].mediaAlbumId = "measurement-album";
        }
        this.snapshot.messages = [...this.snapshot.messages.filter(m=>m.chatId!=="chat-product"),...source];
        this.snapshot.chats = this.snapshot.chats.map(c=>c.id==="chat-product"?{...c,unreadCount:0,lastReadInboxMessageId:"1030"}:c);
        return connect.call(this,listener);
      };
    }` });
  });
};

const sampleBottom = (page: Page, duration = 1100) => page.locator(".message-list").evaluate(async (element, duration) => {
  const samples: Array<{ top: number; distance: number; gap: number }> = [];
  const start = performance.now();
  while (performance.now() - start < duration) {
    await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    const last = element.querySelector('[data-message-id="1030"]');
    if (!last) throw new Error("Missing latest message");
    samples.push({ top: element.scrollTop,
      distance: element.scrollHeight - element.clientHeight - element.scrollTop,
      gap: element.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom });
  }
  return samples;
}, duration);

const expectStableBottom = async (page: Page) => {
  const samples = await sampleBottom(page);
  expect(Math.max(...samples.map(s => Math.abs(s.distance))), JSON.stringify(samples)).toBeLessThanOrEqual(1);
  expect(Math.max(...samples.map(s => s.gap)) - Math.min(...samples.map(s => s.gap)), JSON.stringify(samples)).toBeLessThanOrEqual(1);
  expect(Math.min(...samples.map(s => s.gap))).toBeGreaterThanOrEqual(10);
};

for (const surface of ["text", "photo-caption", "album-caption"] as const) {
for (const width of [390, 1120]) test(`folded quotes in a mixed first page never disturb the latest viewport (${surface}, ${width}px)`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await mixedHistory(page, surface);
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  const list = page.locator(".message-list");
  await expect(list).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('.rich-blockquote')).toHaveAttribute("data-quote-state", "collapsed");
  await expectStableBottom(page);
  await list.hover();
  await page.mouse.wheel(0, 400);
  await expectStableBottom(page);
  await page.mouse.wheel(0, -500);
  await expect(page.locator(".jump-to-latest")).toBeVisible();
  await list.press("End");
  await expectStableBottom(page);
  await list.press("Home");
  await expect(page.locator(".jump-to-latest")).toBeVisible();
  await page.locator(".jump-to-latest").click();
  await expect.poll(() => list.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(1);
  await expectStableBottom(page);
  // Exercise the navigation boundary, including the narrow layout's back button.
  if (width === 390) await page.getByRole("button", { name: "返回会话列表" }).click();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.locator('[data-message-id="1030"]')).toHaveCount(0);
  if (width === 390) await page.getByRole("button", { name: "返回会话列表" }).click();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(list).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-message-id="1030"]')).toBeVisible();
  await expectStableBottom(page);
});
}

for (const surface of ["text", "photo-caption", "album-caption", "discussion"] as const) {
  for (const quote of [false, true]) test(`metadata remeasurement preserves scroll geometry without a bottom coordinator (${surface}, quote: ${quote})`, async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    const result = await page.evaluate(async ({ surface, quote }) => {
      const resources = performance.getEntriesByType("resource").map(entry => entry.name);
      const moduleUrl = (name: string) => resources.find(url => new URL(url).pathname.endsWith(`/deps/${name}.js`))!;
      const React = (await import(moduleUrl("react"))).default as typeof import("react");
      const { createRoot } = (await import(moduleUrl("react-dom_client"))).default as typeof import("react-dom/client");
      const { flushSync } = (await import(moduleUrl("react-dom"))).default as typeof import("react-dom");
      const { MessageTextFlow } = await import("/src/components/MessageTextFlow.tsx" as string) as typeof import("../../src/components/MessageTextFlow");
      const { MessageRichText } = await import("/src/components/MessageRichText.tsx" as string) as typeof import("../../src/components/MessageRichText");
      const { MessageMetadata } = await import("/src/components/MessageMetadata.tsx" as string) as typeof import("../../src/components/MessageMetadata");
      const host = document.createElement("div");
      if (surface === "discussion") host.className = "channel-discussion-messages";
      host.style.cssText = "position:fixed;inset:0 auto auto 0;width:320px;height:180px;overflow:auto;overflow-anchor:none;";
      document.body.append(host);
      const root = createRoot(host);
      const text = quote ? Array.from({ length: 18 }, (_,i) => `Synthetic quotation line ${i}`).join("\n") : "A naturally wrapped metadata line that must keep its current reading position.";
      const message: import("../../src/telegram/types").Message = {
        id:"measurement",chatId:"fixture",senderId:"self",outgoing:true,sentAt:"2026-08-01T09:48:00Z",delivery:"read",editedAt:"2026-08-01T09:49:00Z",
        content:{kind:"text",text},
      };
      const render = () => {
        const content = React.createElement(MessageTextFlow, {
          className: surface === "photo-caption" ? "photo-caption-flow" : surface === "album-caption" ? "media-album-caption" : undefined,
        },
        React.createElement(MessageRichText, { text, entities: quote ? [{kind:"blockquote",offset:0,length:text.length}] : [] }),
        React.createElement(MessageMetadata, { message, onRetry: async () => {} }));
        const bubble = React.createElement("div", {
          className: `message-bubble ${surface === "text" || surface === "discussion" ? "is-textual" : ""}`, style: { width: 220 },
        }, content);
        const shell = React.createElement("div", {
          className: surface === "album-caption" ? "media-album" : "message-bubble-shell",
        }, bubble);
        const group = React.createElement("div", {
          className: surface === "discussion" ? "message-group channel-discussion-message-group" : "message-group",
        }, React.createElement("article", { className: "message-row" }, shell));
        flushSync(() => root.render(React.createElement("div", null,
          React.createElement("div", { style: { height: 360 } }), group)));
      };
      const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      try {
        render();
        for (let i=0;i<12;i++) await frame();
        const wrapped = host.querySelector(".message-text-flow")!.classList.contains("is-meta-wrapped");
        const measurements: Array<{ before: number; after: number; heightBefore: number; heightAfter: number }> = [];
        // Both following and a reading anchor just above the bottom can be clamped
        // by a temporary measurement. No coordinator may conceal that mutation.
        for (const distance of [0, 8]) {
          host.scrollTop = host.scrollHeight - host.clientHeight - distance;
          for (let i=0;i<6;i++) {
            const before = host.scrollTop, heightBefore = host.scrollHeight;
            render();
            measurements.push({ before, after:host.scrollTop, heightBefore, heightAfter:host.scrollHeight });
            await frame();
          }
        }
        return { wrapped, measurements };
      } finally { root.unmount(); host.remove(); }
    }, { surface, quote });
    expect(result.wrapped).toBe(true);
    for (const sample of result.measurements) {
      expect(sample.after, JSON.stringify(result)).toBe(sample.before);
      expect(sample.heightAfter).toBe(sample.heightBefore);
    }
  });
}
