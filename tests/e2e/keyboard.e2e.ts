import { expect, test, type Page } from "@playwright/test";

const openReady = async (page: Page) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "消息内容" });
  await expect(input).toBeFocused();
  await expect(page.getByRole("log", { name: "消息列表" })).toHaveAttribute("aria-busy", "false");
  return input;
};

for (const key of ["Tab", "Shift+Tab", "Control+Tab"]) {
  test(`${key} without completion preserves the draft and allows select-all deletion`, async ({ page }) => {
    const input = await openReady(page);
    await input.evaluate(element => {
      element.dataset.blurCount = "0";
      element.addEventListener("blur", () => { element.dataset.blurCount = String(Number(element.dataset.blurCount) + 1); });
    });
    for (const draft of ["ordinary text", "@zzzznomatchzzzz", "/zzzznomatchzzzz"]) {
      await input.fill(draft);
      await expect(page.locator(".mention-suggestion-panel, .bot-suggestion-panel")).toHaveCount(0);
      await page.keyboard.press(key);
      await expect(input).toBeFocused();
      await expect(input).toHaveAttribute("data-blur-count", "0");
      await expect(input).toHaveJSProperty("value", draft);
      await expect(input).toHaveJSProperty("selectionStart", draft.length);
      await expect(input).toHaveJSProperty("selectionEnd", draft.length);
      await page.keyboard.press("Control+a");
      expect(await input.evaluate(element => {
        const selection = getSelection();
        return Boolean(selection?.anchorNode && selection.focusNode &&
          element.contains(selection.anchorNode) && element.contains(selection.focusNode));
      })).toBe(true);
      await page.keyboard.press("Backspace");
      await expect(input).toHaveJSProperty("value", "");
    }
  });
}

test("plain Tab explicitly completes mentions and commands without sending", async ({ page }) => {
  const input = await openReady(page);
  const outgoing = page.locator(".message-row.is-outgoing");
  const count = await outgoing.count();
  for (const [query, panel, completed] of [
    ["@mia", ".mention-suggestion-panel", "@Mia Chen "],
    ["/he", ".bot-suggestion-panel", "/help@notgram_bot "],
  ]) {
    await input.fill(query);
    await expect(page.locator(panel)).toBeVisible();
    for (const key of ["Shift+Tab", "Control+Tab"]) {
      await page.keyboard.press(key);
      await expect(input).toBeFocused();
      await expect(input).toHaveJSProperty("value", query);
    }
    await page.keyboard.press("Tab");
    await expect(input).toHaveJSProperty("value", completed);
    await expect(input).toBeFocused();
    await expect(outgoing).toHaveCount(count);
  }
});

test("Tab during an empty pending mention query does not queue a late completion", async ({ page }) => {
  const input = await openReady(page);
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const mia = telegramStore.getState().users.get("u-mia")!;
    telegramStore.setState({ getChatMentionSuggestions: async () => {
      document.body.dataset.tabQuery = "pending";
      await new Promise<void>(resolve => Reflect.set(window, "finishTabQuery", resolve));
      document.body.dataset.tabQuery = "complete";
      return [mia];
    } });
  });
  await input.fill("@zzzznomatchzzzz");
  await expect(page.locator("body")).toHaveAttribute("data-tab-query", "pending");
  await expect(page.locator(".mention-suggestion-panel")).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await expect(input).toHaveJSProperty("value", "");
  await page.evaluate(() => Reflect.get(window, "finishTabQuery")());
  await expect(page.locator("body")).toHaveAttribute("data-tab-query", "complete");
  await expect(input).toBeFocused();
  await expect(input).toHaveJSProperty("value", "");
  await expect(page.locator(".mention-suggestion-panel")).toHaveCount(0);
});

test("Tab stays local to search, buttons, and unclaimed focus", async ({ page }) => {
  await openReady(page);
  const search = page.getByRole("searchbox", { name: "搜索会话和消息" });
  await search.fill("Mia");
  for (const key of ["Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("Mia");
  }
  await search.fill("");
  const emoji = page.getByRole("button", { name: "表情", exact: true });
  await emoji.focus();
  for (const key of ["Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    await expect(emoji).toBeFocused();
  }
  await emoji.evaluate(element => element.blur());
  for (const key of ["Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  }
});

test("discussion Tab completion and unmatched drafts stay in their own editor", async ({ page }) => {
  await openReady(page);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await page.locator('[data-message-id="release-post-1"] .channel-post-discussion').click();
  const panel = page.locator(".channel-discussion-panel");
  const input = panel.getByRole("textbox", { name: "消息内容" });
  await expect(input).toBeFocused();
  await input.fill("@mia");
  await expect(panel.locator('[data-mention-user-id="u-mia"]')).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(input).toHaveJSProperty("value", "@Mia Chen ");
  await input.fill("@zzzznomatchzzzz");
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await expect(input).toHaveJSProperty("value", "");
});

test("composing Tab cannot accept an app suggestion", async ({ page }) => {
  const input = await openReady(page);
  await input.fill("@mia");
  await expect(page.locator('[data-mention-user-id="u-mia"]')).toBeVisible();
  await input.dispatchEvent("keydown", { key: "Tab", code: "Tab", keyCode: 229, isComposing: true });
  await expect(input).toHaveJSProperty("value", "@mia");
  await expect(input).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(input).toHaveJSProperty("value", "@Mia Chen ");
});
