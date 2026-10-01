import { expect, test } from "@playwright/test";
import { installSessionSwitchFixture } from "./fixtures/sessionSwitchFixture";

test("first mount restores valid measured rows and rejects edits or resized geometry", async ({ page }) => {
  await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n(${installSessionSwitchFixture.toString()})(MockTelegramTransport);` });
  });
  await page.route(/\/src\/hooks\/useConversationScroll\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    const source = await response.text();
    const body = source.replace(/const restoreStateFrom = [\s\S]*?;\r?\n/, value => value + `
      (globalThis.__restoreEvents ??= []).push({ key:currentScrollKey, restored:Boolean(restoreStateFrom), mounted:Boolean(messageListRef.current),
        savedWidth:storedSnapshot?.viewportWidth,width:viewportGeometry.width,savedGeometry:storedSnapshot?.geometryKey,geometry:measuredGeometryKey,
        messagesMatch:matchesMeasuredMessages(storedSnapshot?.messages,visibleMessages),layoutMatch:matchesVirtualMessageLayout(storedSnapshot?.messageItemIndexes,messageItemIndexes),
        first:storedSnapshot?.firstMessageId===firstVisibleMessageId,last:storedSnapshot?.lastMessageId===lastVisibleMessageId,
        blocks:storedSnapshot?.virtualItemCount===virtualItemCount,memory:Boolean(storedMemory),pendingLatest:Boolean(pendingLatestRequest),target:Boolean(requestedTargetId) });
    `);
    if (body === source) throw new Error("Restore instrumentation did not match the hook");
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  const product = page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]');
  const mia = page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]');
  const settle = async () => {
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("[data-conversation-switch-snapshot]")).toHaveCount(0);
  };
  await settle(); await mia.click(); await settle(); await product.click(); await settle();
  const clear = () => page.evaluate(() => { (globalThis as typeof globalThis & { __restoreEvents: unknown[] }).__restoreEvents = []; });
  const firstRestore = () => page.evaluate(() => (globalThis as typeof globalThis & {
    __restoreEvents: Array<{ key: string; restored: boolean; mounted: boolean }>;
  }).__restoreEvents.find(event => !event.mounted));
  await clear(); await mia.click(); await settle();
  const restored = await firstRestore();
  expect(restored?.restored, JSON.stringify(restored)).toBe(true);
  await product.click(); await settle();
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set("chat-mia", messages.get("chat-mia")!.map(message => message.id === "chat-mia-perf-59"
      ? { ...message, content: { kind: "text", text: "A changed cached message. ".repeat(60) } } : message));
    telegramStore.setState({ messages });
  });
  await clear(); await mia.click(); await settle();
  expect((await firstRestore())?.restored).toBe(false);
  await product.click(); await settle();
  await page.setViewportSize({ width: 1060, height: 720 });
  await expect.poll(() => page.locator(".conversation-surface").evaluate(e => e.clientWidth)).toBeLessThan(800);
  await clear(); await mia.click(); await settle();
  expect((await firstRestore())?.restored).toBe(false);
  await expect(page.locator('[data-message-id="chat-mia-perf-59"] .message-rich-text')).toContainText("A changed cached message.");
});

test("text geometry invalidates when content, typography and metadata change", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const row = page.locator('[data-message-id="p-rich-entities"]');
  await expect(row.locator(".message-text-flow")).toBeVisible();
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set("chat-product", messages.get("chat-product")!.map(message => message.id === "p-rich-entities"
      ? { ...message, outgoing: true, senderId: "self", delivery: "read", editedAt: "2026-10-01T02:00:00Z", content: { kind: "text", text: "而且现在服务端已有自动重试的能力了，加一个异常匹配的事情" } } : message));
    telegramStore.setState({ messages });
  });
  await expect(row.locator(".message-rich-text")).toHaveText("而且现在服务端已有自动重试的能力了，加一个异常匹配的事情");
  await row.evaluate(element => { element.closest<HTMLElement>(".message-group")!.style.width = "648px"; });
  await expect(row.locator(".message-text-flow")).toHaveClass(/is-meta-wrapped/);
  await row.evaluate(element => { element.closest<HTMLElement>(".message-group")!.style.width = "900px"; });
  await expect(row.locator(".message-text-flow")).not.toHaveClass(/is-meta-wrapped/);
  await row.evaluate(element => { element.closest<HTMLElement>(".message-group")!.style.fontSize = "20px";
    element.querySelector<HTMLElement>(".message-rich-text")!.style.fontSize = "20px"; });
  const geometry = await row.evaluate(element => {
    const meta = element.querySelector(".message-meta")!.getBoundingClientRect();
    const bubble = element.querySelector(".message-bubble")!.getBoundingClientRect();
    return { bottom: bubble.bottom - meta.bottom, right: bubble.right - meta.right };
  });
  expect(geometry.bottom).toBeGreaterThanOrEqual(-1);
  expect(geometry.right).toBeGreaterThanOrEqual(0);
});
