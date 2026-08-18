import { expect, test, type Page } from "@playwright/test";

const injectNotifications = async (
  page: Page,
  options: { reduceMotion?: boolean } = {},
) => {
  await page.evaluate(async ({ modulePath, reduceMotion }) => {
    const module = await import(modulePath) as {
      replaceDesktopNotificationWindowSnapshot: (value: unknown) => void;
    };
    const createdAtMs = Date.now();
    module.replaceDesktopNotificationWindowSnapshot({
      revision: 1,
      items: [{
        id: "notification-1",
        title: "产品讨论",
        body: "设计稿已经更新，可以直接查看对应消息。",
        themeId: "notgram-dark",
        reduceMotion,
        createdAtMs,
        route: { accountId: "default", chatId: "chat-product", messageId: "p-5" },
      }, {
        id: "notification-2",
        title: "超长会话名称用于验证通知标题不会挤压关闭按钮和消息内容",
        body: "这是一段很长的通知内容，用于验证桌面通知在有限宽度内能够稳定换行并限制为两行，不会造成水平溢出。",
        themeId: "notgram-dark",
        reduceMotion,
        createdAtMs,
        route: { accountId: "default", chatId: "chat-mia", messageId: "m-9" },
      }],
    });
  }, {
    modulePath: "/src/notifications/notificationWindowStore.ts",
    reduceMotion: options.reduceMotion ?? false,
  });
};

test("desktop notifications stack, animate, and keep controls within the window", async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 440 });
  await page.goto("/notification-window.html");
  await expect(page.getByRole("region", { name: "桌面通知" })).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await injectNotifications(page);

  const cards = page.locator(".desktop-notification-card");
  await expect(cards).toHaveCount(2);
  await expect(page.getByRole("button", { name: "打开 产品讨论 的消息" })).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭通知" })).toHaveCount(2);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "notgram-dark");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "full");

  await expect.poll(() => cards.evaluateAll((elements) => elements.every((element) => {
    const bounds = element.getBoundingClientRect();
    const title = element.querySelector<HTMLElement>(".desktop-notification-copy strong")!;
    const body = element.querySelector<HTMLElement>(".desktop-notification-copy > span")!;
    const close = element.querySelector<HTMLElement>(".desktop-notification-close")!;
    return bounds.left >= 0 && bounds.right <= 380 && bounds.height >= 84 &&
      title.getBoundingClientRect().right <= close.getBoundingClientRect().left &&
      body.getBoundingClientRect().right <= close.getBoundingClientRect().left &&
      getComputedStyle(element).animationName === "motion-toast-in";
  }))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const firstClose = page.getByRole("button", { name: "关闭通知" }).first();
  expect(await firstClose.evaluate((button) => new Promise<boolean>((resolve) => {
    const card = button.closest(".desktop-notification-card");
    if (!card) {
      resolve(false);
      return;
    }
    const observer = new MutationObserver(() => {
      if (!card.classList.contains("is-exiting")) return;
      observer.disconnect();
      resolve(true);
    });
    observer.observe(card, { attributes: true, attributeFilter: ["class"] });
    (button as HTMLButtonElement).click();
    globalThis.setTimeout(() => {
      observer.disconnect();
      resolve(card.classList.contains("is-exiting"));
    }, 300);
  }))).toBe(true);
  await expect(cards).toHaveCount(1);

  await page.getByRole("button", { name: /打开 超长会话名称/ }).click();
  await expect(cards).toHaveCount(0);
});

test("desktop notifications honor reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 440 });
  await page.goto("/notification-window.html");
  await expect(page.getByRole("region", { name: "桌面通知" })).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await injectNotifications(page, { reduceMotion: true });
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  await page.getByRole("button", { name: "关闭通知" }).first().click();
  await expect(page.locator(".desktop-notification-card")).toHaveCount(1);
});
