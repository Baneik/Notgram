import { expect, test, type Page } from "@playwright/test";
import { chooseMessageMenuItem, revealVirtualMessage } from "./helpers";

const searchInput = (page: Page) => page.getByRole("searchbox", { name: "搜索会话和消息" });

async function openConversation(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  if (width < 768) await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
}

async function openDiscussion(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await page.locator('[data-message-id="release-post-1"]').getByRole("button", { name: "2 条评论" }).click();
  const discussion = page.locator(".channel-discussion-panel");
  await expect(discussion.locator('[data-message-id="release-comment-1"]')).toBeVisible();
  return discussion;
}

for (const width of [1366, 390]) {
  for (const entry of ["shortcut", "avatar"] as const) {
    test(`Escape closes scoped search after changing members and clicking results (${entry}, ${width}px)`, async ({ page }) => {
      await openConversation(page, width);
      if (entry === "shortcut") await page.keyboard.press("Control+F");
      else {
        await page.locator(".message-sender-avatar").last().click({ button: "right" });
        await page.getByRole("menuitem", { name: /^搜索 .* 的消息$/ }).click();
      }
      const scope = page.getByRole("group", { name: "搜索范围：产品讨论" });
      await expect(scope).toBeVisible();
      await searchInput(page).fill("产品讨论历史消息");
      await page.locator(".chat-search-member-trigger").click();
      await page.getByRole("dialog", { name: "选择成员" }).getByRole("button", { name: "Jules", exact: true }).click();
      const result = page.locator(".chat-search-results-panel [data-search-message-id]").first();
      await expect(result).toBeVisible();
      await result.click();
      // Narrow layouts show the conversation after opening a result. Return to search.
      if (width < 768) {
        await page.keyboard.press("Control+K");
        await page.locator(".chat-search-member-trigger").focus();
      }
      await page.keyboard.press("Escape");
      await expect(scope).toHaveCount(0);
      await expect(searchInput(page)).toHaveValue("");
      await expect(page.locator(".chat-search-results-panel")).toHaveCount(0);
    });
  }

  for (const discussion of [false, true]) {
    test(`Escape cancels a ${discussion ? "discussion" : "conversation"} reply and preserves its draft (${width}px)`, async ({ page }) => {
      if (discussion) await openDiscussion(page, width);
      else {
        await openConversation(page, width);
        await revealVirtualMessage(page, "p-2");
      }
      const surface = page.locator(discussion ? ".channel-discussion-panel" : ".conversation");
      const message = surface.locator(`[data-message-id="${discussion ? "release-comment-1" : "p-2"}"]`);
      await message.locator(".message-bubble-shell").click({ button: "right" });
      await chooseMessageMenuItem(page, "回复");
      const context = surface.locator(".composer-context.is-replying");
      const input = surface.getByRole("textbox", { name: "消息内容" });
      await expect(context).toBeVisible();
      await input.fill("Escape 保留草稿");
      await page.keyboard.press("Escape");
      await expect(context).toHaveCount(0);
      await expect(input).toHaveJSProperty("value", "Escape 保留草稿");
      await expect(input).toBeFocused();
      await expect.poll(() => page.evaluate(async () => {
        const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
        return [...telegramStore.getState().drafts.values()].find(draft => draft.text === "Escape 保留草稿");
      })).toMatchObject({ text: "Escape 保留草稿", replyToMessageId: undefined, replyQuote: undefined });
      if (discussion) {
        await expect(surface).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(surface).toHaveCount(0);
      }
    });
  }

  test(`Escape closes a discussion with focus on its header (${width}px)`, async ({ page }) => {
    const discussion = await openDiscussion(page, width);
    await discussion.getByRole("button", { name: "返回频道" }).focus();
    await page.keyboard.press("Escape");
    await expect(discussion).toHaveCount(0);
    await expect(page.locator('[data-message-id="release-post-1"]')).toBeVisible();
  });
}

test("Escape dismisses the member picker before search and ignores composition", async ({ page }) => {
  await openConversation(page, 1366);
  await page.keyboard.press("Control+F");
  const scope = page.getByRole("group", { name: "搜索范围：产品讨论" });
  await searchInput(page).fill("产品讨论历史消息");
  await page.locator(".chat-search-member-trigger").click();
  const picker = page.getByRole("dialog", { name: "选择成员" });
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(scope).toBeVisible();
  await page.locator(".chat-search-member-trigger").dispatchEvent("keydown", { key: "Escape", isComposing: true });
  await expect(scope).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(scope).toHaveCount(0);
});

test("Escape dismisses discussion emoji and forwarding before leaving the discussion", async ({ page }) => {
  const discussion = await openDiscussion(page, 1366);
  await discussion.getByRole("button", { name: "表情", exact: true }).click();
  await expect(discussion.locator(".emoji-picker")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(discussion.locator(".emoji-picker")).toBeHidden();
  await expect(discussion).toBeVisible();
  const message = discussion.locator('[data-message-id="release-comment-1"]');
  await message.locator(".message-bubble-shell").click({ button: "right" });
  await chooseMessageMenuItem(page, "转发");
  await expect(page.getByRole("dialog", { name: "转发 1 条消息", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "转发 1 条消息", exact: true })).toHaveCount(0);
  await expect(discussion).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(discussion).toHaveCount(0);
});
