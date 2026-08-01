import { expect, test, type Page } from "@playwright/test";

const horizontalOverflow = async (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll("body *")].some((element) => {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
  }));

const messageListMetrics = (page: Page) => page.locator(".message-list").evaluate((element) => ({
  scrollTop: element.scrollTop,
  scrollHeight: element.scrollHeight,
  clientHeight: element.clientHeight,
  distanceBottom: element.scrollHeight - element.clientHeight - element.scrollTop,
}));

const visibleMessageAnchor = (page: Page) => page.locator(".message-list").evaluate((element) => {
  const listBounds = element.getBoundingClientRect();
  const row = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find((candidate) => candidate.getBoundingClientRect().bottom > listBounds.top + 1);
  return {
    id: row?.dataset.messageId,
    offset: row ? row.getBoundingClientRect().top - listBounds.top : 0,
    scrollTop: element.scrollTop,
  };
});

const scrollAwayFromBottom = (page: Page) => page.locator(".message-list").evaluate((element) => {
  const maximum = element.scrollHeight - element.clientHeight;
  element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -500 }));
  element.scrollTop = Math.max(100, Math.floor(maximum * 0.45));
  element.dispatchEvent(new Event("scroll"));
});

test("desktop messaging, reactions, and preferences remain usable", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".chat-row")).not.toHaveCount(0);
  await expect(page.locator(".message-day")).not.toHaveCount(0);

  const visibleBubble = page.locator(".message-bubble-shell").last();
  await visibleBubble.hover();
  await visibleBubble.locator(".reaction-add").click();
  await visibleBubble.locator(".reaction-picker button").first().click();
  await expect(visibleBubble.locator(".message-reactions > button")).toHaveCount(1);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /聊天设置/ }).click();
  await page.getByRole("switch", { name: "紧凑会话密度" }).check();
  await expect(page.locator("html")).toHaveClass(/compact-chat/);
  expect(await horizontalOverflow(page)).toBe(false);
});

test("mobile chat switching has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator(".chat-row").first().click();

  await expect(page.locator(".conversation")).toBeVisible();
  await expect(page.locator(".mobile-back")).toBeVisible();
  await expect(page.locator(".message-row")).not.toHaveCount(0);
  expect(await horizontalOverflow(page)).toBe(false);
});

test("photo messages stay inside their aligned bubble at responsive widths", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const photoRow = page.locator('[data-message-id="p-5"]');
  await expect(photoRow).toBeVisible();

  for (const viewport of [
    { width: 1220, height: 780 },
    { width: 680, height: 620 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await photoRow.scrollIntoViewIfNeeded();
    const aligned = await photoRow.evaluate((row) => {
      const shell = row.querySelector<HTMLElement>(".message-bubble-shell");
      const media = row.querySelector<HTMLElement>(".photo-message");
      const image = row.querySelector<HTMLElement>(".photo-preview img");
      const stack = row.closest<HTMLElement>(".message-group-stack");
      if (!shell || !media || !image || !stack) return false;
      const shellBounds = shell.getBoundingClientRect();
      const mediaBounds = media.getBoundingClientRect();
      const imageBounds = image.getBoundingClientRect();
      const stackBounds = stack.getBoundingClientRect();
      const within = (inner: DOMRect, outer: DOMRect) =>
        inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
      return within(shellBounds, stackBounds) &&
        within(mediaBounds, shellBounds) &&
        Math.abs(imageBounds.left - mediaBounds.left) <= 1 &&
        Math.abs(imageBounds.right - mediaBounds.right) <= 1;
    });
    expect(aligned).toBe(true);
  }
});

test("conversation scroll state follows, restores, counts, and resets to latest", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-row")).not.toHaveCount(0);
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);

  await scrollAwayFromBottom(page);
  const savedAnchor = await visibleMessageAnchor(page);
  expect(savedAnchor.id).toBeTruthy();

  await page.getByRole("button", { name: /Mia Chen/ }).click();
  await expect(page.locator(".conversation-title h2")).toHaveText("Mia Chen");
  await page.getByRole("button", { name: /产品讨论/ }).click();
  await expect(page.locator(".conversation-title h2")).toHaveText("产品讨论");
  await expect.poll(async () => (await visibleMessageAnchor(page)).id).toBe(savedAnchor.id);
  await expect.poll(async () => Math.abs(
    (await visibleMessageAnchor(page)).offset - savedAnchor.offset,
  )).toBeLessThanOrEqual(2);

  const restored = await visibleMessageAnchor(page);
  for (const text of ["滚动定位测试一", "滚动定位测试二"]) {
    await page.getByRole("textbox", { name: "消息内容" }).fill(text);
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveValue("");
  }

  const jumpButton = page.getByRole("button", { name: "跳到最新消息，2 条新消息" });
  await expect(jumpButton).toBeVisible();
  const afterMessages = await visibleMessageAnchor(page);
  expect(afterMessages.id).toBe(restored.id);
  expect(Math.abs(afterMessages.offset - restored.offset)).toBeLessThanOrEqual(2);

  await jumpButton.click();
  await expect(jumpButton).toBeHidden();
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);

  await page.getByRole("textbox", { name: "消息内容" }).fill("底部自动跟随测试");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);

  await scrollAwayFromBottom(page);
  await page.getByRole("button", { name: /Mia Chen/ }).click();
  await page.getByRole("button", { name: /产品讨论/ }).dblclick();
  await expect(page.locator(".conversation-title h2")).toHaveText("产品讨论");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);
});
