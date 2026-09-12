import { expect, test, type Page } from "@playwright/test";
import type { Message } from "../../src/telegram/types";

type PostKind = "text" | "photo" | "photoWithoutCaption" | "file" | "album";
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

test("channel metadata keeps one neutral color across post layouts, ownership, reactions, and themes", async ({ page }, testInfo) => {
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
          if (kind === "photo" || kind === "album") {
            await expect(page.locator(kind === "album" ? ".media-album-caption" : ".photo-caption-flow"))
              .toHaveCSS("padding-left", "13px");
          }
        }
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`channel-metadata-${theme}.png`) });
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
