import { expect, test, type Page } from "@playwright/test";

const injectNotifications = async (
  page: Page,
  options: { reduceMotion?: boolean } = {},
) => {
  await page.evaluate(async ({ modulePath, reduceMotion }) => {
    const module = await import(modulePath) as {
      replaceDesktopNotificationWindowSnapshot: (value: unknown) => void;
    };
    const updatedAtMs = Date.now();
    module.replaceDesktopNotificationWindowSnapshot({
      revision: 1,
      items: [{
        id: "notification-1",
        title: "产品讨论",
        body: "设计稿已经更新，可以直接查看对应消息。",
        avatar: { label: "产", color: "#4e86b0" },
        themeId: "notgram-dark",
        reduceMotion,
        updatedAtMs,
        route: { accountId: "default", chatId: "chat-product", messageId: "p-5" },
      }, {
        id: "notification-2",
        title: "超长会话名称用于验证通知标题不会挤压关闭按钮和消息内容",
        body: "这是一段很长的通知内容，用于验证桌面通知在有限宽度内能够稳定换行并限制为两行，不会造成水平溢出。",
        avatar: { label: "M", color: "#498363" },
        themeId: "notgram-dark",
        reduceMotion,
        updatedAtMs,
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
  await expect(page.locator(".desktop-notification-source")).toHaveCount(2);
  await expect(page.locator(".desktop-notification-avatar")).toHaveCount(2);

  await expect.poll(() => cards.evaluateAll((elements) => elements.every((element) => {
    const bounds = element.getBoundingClientRect();
    const title = element.querySelector<HTMLElement>(".desktop-notification-copy strong")!;
    const body = element.querySelector<HTMLElement>(".desktop-notification-message")!;
    const close = element.querySelector<HTMLElement>(".desktop-notification-close")!;
    const avatar = element.querySelector<HTMLElement>(".desktop-notification-avatar")!;
    return bounds.left >= 0 && bounds.right <= 380 && bounds.height >= 84 &&
      title.getBoundingClientRect().right <= bounds.right &&
      body.getBoundingClientRect().right <= bounds.right &&
      close.getBoundingClientRect().right <= bounds.right &&
      avatar.getBoundingClientRect().width === 40 &&
      avatar.getBoundingClientRect().height === 40 &&
      Number.parseInt(getComputedStyle(title).fontWeight, 10) >= 700 &&
      getComputedStyle(body).color === getComputedStyle(title).color &&
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

test("a conversation notification reuses its card and expires ten seconds after the latest message", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-08-19T03:00:00.000Z") });
  await page.setViewportSize({ width: 380, height: 220 });
  await page.goto("/notification-window.html");
  await expect(page.getByRole("region", { name: "桌面通知" })).toBeVisible();

  const replaceConversationNotification = async (revision: number, body: string) => {
    await page.evaluate(async ({ modulePath, revision, body }) => {
      const module = await import(modulePath) as {
        replaceDesktopNotificationWindowSnapshot: (value: unknown) => void;
      };
      module.replaceDesktopNotificationWindowSnapshot({
        revision,
        items: [{
          id: "notification-chat-product",
          title: "产品讨论",
          body,
          avatar: { label: "产", color: "#4e86b0" },
          themeId: "notgram-dark",
          reduceMotion: false,
          updatedAtMs: Date.now(),
          route: {
            accountId: "default",
            chatId: "chat-product",
            messageId: `message-${revision}`,
          },
        }],
      });
    }, {
      modulePath: "/src/notifications/notificationWindowStore.ts",
      revision,
      body,
    });
  };

  await replaceConversationNotification(10, "第一条消息");
  const card = page.locator(".desktop-notification-card");
  await expect(card).toHaveCount(1);
  await card.evaluate((element) => { element.setAttribute("data-card-instance", "retained"); });

  await page.clock.fastForward(9_000);
  await replaceConversationNotification(11, "同一会话的最新消息");
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-card-instance", "retained");
  await expect(page.locator(".desktop-notification-message")).toHaveText("同一会话的最新消息");
  await expect(page.getByRole("button", { name: "打开 产品讨论 的消息" })).toBeVisible();

  await page.clock.fastForward(9_999);
  await expect(card).toHaveCount(1);
  await page.clock.fastForward(1);
  await expect(card).toHaveClass(/is-exiting/);
  await page.clock.fastForward(120);
  await expect(card).toHaveCount(0);
});
