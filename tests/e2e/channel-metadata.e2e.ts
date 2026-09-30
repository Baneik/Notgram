import { expect, test, type Page } from "@playwright/test";
import type { Message } from "../../src/telegram/types";

type PostKind = "text" | "photo" | "photoWithoutCaption" | "file" | "album";

test("visible channel posts refresh on reentry and scroll without reporting overscan", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await expect(page.locator('[data-message-id="release-post-1"]')).toBeVisible();
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const source = state.messages.get("chat-release")![0];
    const calls: Array<{ ids: string[]; inViewport: boolean[] }> = [];
    Object.assign(window, { channelViewCalls: calls });
    const rows = Array.from({ length: 40 }, (_, index): Message => ({
      ...source, id: `view-post-${index}`, isChannelPost: true, isPinned: false, replyTo: undefined,
      sentAt: new Date(Date.UTC(2026, 8, 30, 10, index)).toISOString(),
      content: { kind: "text", text: `Post ${index}\n` + "Channel update content.\n".repeat(5) },
      interaction: { viewCount: 1, forwardCount: 0, replyCount: 0, reactions: [] },
    }));
    telegramStore.setState({ messages: new Map(state.messages).set("chat-release", rows),
      viewChannelMessages: async (chatId, ids) => {
        const list = document.querySelector<HTMLElement>(".message-list")!;
        const bounds = list.getBoundingClientRect();
        calls.push({ ids, inViewport: ids.map(id => {
          const rect = list.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom;
        }) });
        const current = telegramStore.getState();
        telegramStore.setState({ messages: new Map(current.messages).set(chatId,
          current.messages.get(chatId)!.map(message => ids.includes(message.id) ? {
            ...message, interaction: { ...message.interaction!, viewCount: message.interaction!.viewCount + 1 },
          } : message)) });
        return true;
      },
    });
  });
  const readCalls = () => page.evaluate(() => (window as unknown as {
    channelViewCalls: Array<{ ids: string[]; inViewport: boolean[] }>;
  }).channelViewCalls);
  await expect.poll(async () => (await readCalls()).flatMap(call => call.ids).includes("view-post-39")).toBe(true);
  expect((await readCalls()).every(call => call.inViewport.every(Boolean))).toBe(true);
  const last = page.locator('.message-list [data-message-id="view-post-39"]');
  await expect(last.getByLabel("2 次观看", { exact: true })).toBeVisible();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator('.conversation-header')).toContainText("产品讨论");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await expect(last.getByLabel("3 次观看", { exact: true })).toBeVisible();
  const beforeScroll = new Set((await readCalls()).flatMap(call => call.ids));
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.locator(".message-list").hover();
  await page.mouse.wheel(0, -1000);
  await expect.poll(async () => (await readCalls()).flatMap(call => call.ids).some(id => !beforeScroll.has(id))).toBe(true);
  expect((await readCalls()).every(call => call.inViewport.every(Boolean))).toBe(true);
  const ids = (await readCalls()).flatMap(call => call.ids);
  expect(ids.filter(id => id === "view-post-39")).toHaveLength(2);
});

for (const viewport of [
  { name: "1080p", width: 1920, height: 1080, scale: 100 },
  { name: "1366", width: 1366, height: 768, scale: 100 },
  { name: "1080p-125", width: 1920, height: 1080, scale: 125 },
  { name: "narrow", width: 390, height: 844, scale: 100 },
]) {
  for (const theme of ["notgram-light", "notgram-dark"] as const) {
    test(`metadata and reactions remain readable at ${viewport.name} in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
      await expect(page.locator('[data-message-id="release-post-1"]')).toBeVisible();
      await page.evaluate(async ({ theme, scale }) => {
        const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
        preferencesStore.getState().setPreference("themeId", theme);
        preferencesStore.getState().setPreference("interfaceScale", scale);
      }, { theme, scale: viewport.scale });
      await showPost(page, "album", false, true);
      await expect(page.locator(".conversation-switch-snapshot")).toHaveCount(0);
      const footer = page.locator(".media-album-footer");
      await expect(footer).toBeVisible();
      await expect(footer.locator(".message-meta")).toHaveCSS("font-size", "12px");
      const reaction = page.locator(".media-album-reactions .message-reactions > button");
      await expect(reaction.locator(".message-reaction-emoji")).toHaveCSS("font-size", "17px");
      await expect(reaction.locator(".message-reaction-count")).toHaveCSS("font-size", "12px");
      await expect(reaction).toHaveCSS("height", "28px");
      await expect.poll(() => page.locator(".message-list").evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const content = element.querySelector(".message-list-content")!.getBoundingClientRect();
        return content.left >= bounds.left && content.right <= bounds.right;
      })).toBe(true);
      const meta = await footer.locator(".message-meta").boundingBox();
      const album = await page.locator(".media-album").boundingBox();
      expect(meta!.x).toBeGreaterThanOrEqual(album!.x);
      expect(meta!.x + meta!.width).toBeLessThanOrEqual(album!.x + album!.width);
      await page.screenshot({ path: testInfo.outputPath("channel-readability.png") });
      await page.evaluate(async () => {
        const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
        telegramStore.getState().selectChat("chat-product");
      });
      await expect(page.locator(".conversation-header")).toContainText("产品讨论");
      await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
      await expect(page.locator(".conversation-switch-snapshot")).toHaveCount(0);
      await page.evaluate(async () => {
        const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
        const state = telegramStore.getState();
        const base = state.messages.get("chat-product")![0];
        telegramStore.setState({ messages: new Map(state.messages).set("chat-product", [{
          ...base, id: "readability-text", outgoing: false, isPinned: false, replyTo: undefined,
          content: { kind: "text", text: "华为今天要开发布会了，mate90起码8999吧" },
          interaction: { viewCount: 0, forwardCount: 0, replyCount: 0,
            reactions: [{ type: { kind: "emoji", emoji: "👍" }, totalCount: 12, chosen: false, recentSenderIds: [] }] },
        }]) });
      });
      const row = page.locator('.message-list [data-message-id="readability-text"]');
      await expect(row).toBeVisible();
      await expect(page.locator(".conversation-switch-snapshot")).toHaveCount(0);
      await expect(row.locator("time")).toHaveCSS("font-size", "12px");
      await expect.poll(() => page.locator(".message-list").evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const content = element.querySelector(".message-list-content")!.getBoundingClientRect();
        return content.left >= bounds.left && content.right <= bounds.right;
      })).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("chat-readability.png") });
    });
  }
}
async function showPost(page: Page, kind: PostKind, outgoing: boolean, reactions: boolean, delivery: Message["delivery"] = "sent") {
  await page.evaluate(async ({ kind, outgoing, reactions, delivery }) => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const source = state.messages.get("chat-release")!.find(message => message.id === "release-post-1")!;
    const photo = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#647d90"/></svg>');
    const base: Message = { ...source, outgoing, delivery, canRetry: true, isChannelPost: true,
      isPinned: false, editedAt: undefined, replyTo: undefined, authorSignature: "Editor",
      mediaAlbumId: kind === "album" ? "metadata-album" : undefined,
      interaction: { viewCount: 200, forwardCount: 12, replyCount: 2, hasDiscussion: true, reactions: reactions
        ? [{ type: { kind: "emoji", emoji: "👍" }, totalCount: 3, chosen: false, recentSenderIds: [] }] : [] },
      content: kind === "text" ? { kind: "text", text: "Channel post" }
        : kind === "file" ? { kind: "file", fileName: "notes.txt", sizeLabel: "1 KB", caption: "Caption" }
        : { kind: "media", mediaType: "photo", fileName: "photo.jpg", sizeLabel: "1 KB", previewDataUrl: photo, width: 400, height: 240,
          caption: kind === "photoWithoutCaption" ? undefined : "Caption" },
    };
    const messages = new Map(state.messages);
    messages.set(base.chatId, kind === "album" ? [base, { ...base, id: "album-tail", delivery,
      isPinned: true, editedAt: base.sentAt, interaction: undefined,
      content: { kind: "media", mediaType: "photo", fileName: "tail.jpg", sizeLabel: "1 KB", previewDataUrl: photo, width: 400, height: 240 },
    }] : [base]);
    telegramStore.setState({ messages });
  }, { kind, outgoing, reactions, delivery });
}

test("channel metadata keeps one neutral color across post layouts, ownership, reactions, and themes", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await expect(page.locator('[data-message-id="release-post-1"]')).toBeVisible();
  for (const theme of ["notgram-light", "notgram-dark"] as const) {
    await page.evaluate(async theme => {
      const { preferencesStore } = await (0, eval)('import("/src/store/preferencesStore.ts")') as typeof import("../../src/store/preferencesStore");
      preferencesStore.getState().setPreference("themeId", theme);
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const kind of ["text", "photo", "photoWithoutCaption", "file", "album"] as const) {
      for (const outgoing of [false, true]) {
        for (const reactions of [false, true]) {
          await showPost(page, kind, outgoing, reactions);
          const meta = page.locator(kind === "album" ? ".media-album-footer .message-meta" : '[data-message-id="release-post-1"] .message-meta');
          await expect(meta).toBeVisible();
          await expect.poll(() => meta.evaluate(element => {
            const reference = document.createElement("span");
            reference.style.color = "var(--color-text-secondary)";
            document.body.append(reference);
            const expected = getComputedStyle(reference).color;
            reference.remove();
            const selectors = [".message-meta-stats", ".message-meta-stats svg", ".message-channel-author", "time"];
            return [element, ...element.querySelectorAll(selectors.join(","))].every(node => getComputedStyle(node).color === expected);
          }), `${theme}, ${kind}, outgoing=${outgoing}, reactions=${reactions}`).toBe(true);
          await expect(meta).toHaveCSS("user-select", "none");
          await expect(meta).toHaveCSS("font-size", "12px");
          await expect(meta).toHaveCSS("border-top-width", "0px");
          if (kind === "album") await expect(page.locator(".media-album-footer")).toHaveCSS("border-top-width", "0px");
          if (kind === "photo" || kind === "album") {
            await expect(page.locator(kind === "album" ? ".media-album-caption" : ".photo-caption-flow"))
              .toHaveCSS("padding-left", "13px");
          }
        }
      }
    }
  }
});

test("album status includes every item without turning its counters into delivery indicators", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await expect(page.locator('[data-message-id="release-post-1"]')).toBeVisible();
  await showPost(page, "album", true, false);
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const messages = new Map(telegramStore.getState().messages);
    messages.set("chat-release", messages.get("chat-release")!.map(message => message.id === "album-tail" ? { ...message, delivery: "failed" } : message));
    const calls: string[] = [];
    (window as unknown as { metadataRetries: string[] }).metadataRetries = calls;
    telegramStore.setState({ messages, retryMessage: async id => { calls.push(id); } });
  });
  const footer = page.locator(".media-album-footer");
  await expect(footer).toContainText("已编辑");
  await expect(footer.getByLabel("已置顶")).toBeVisible();
  await expect(footer.locator('[data-delivery="failed"]')).toBeVisible();
  expect(await footer.evaluate(element => {
    const reference = document.createElement("span");
    document.body.append(reference);
    reference.style.color = "var(--color-status-danger)";
    const danger = getComputedStyle(reference).color;
    reference.style.color = "var(--color-text-secondary)";
    const neutral = getComputedStyle(reference).color;
    reference.remove();
    return getComputedStyle(element.querySelector(".message-retry svg")!).color === danger &&
      getComputedStyle(element.querySelector("time")!).color === neutral;
  })).toBe(true);
  await footer.getByRole("button", { name: "重试发送", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { metadataRetries: string[] }).metadataRetries)).toEqual(["album-tail"]);
  await showPost(page, "album", true, false, "sending");
  await expect(footer.locator('[data-delivery="sending"]')).toBeVisible();
  await expect(footer.locator(".lucide-check, .lucide-check-check")).toHaveCount(0);
  await showPost(page, "album", true, false, "read");
  await expect(footer.getByRole("img", { name: "帖子已发布" })).toBeVisible();
  await expect(footer.locator(".lucide-check-check")).toHaveCount(0);
});
