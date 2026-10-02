import { expect, test, type Page } from "@playwright/test";

const installNativeNotificationMock = async (
  page: Page,
  options: { pauseSubscription?: boolean; pauseFrames?: boolean; showFailures?: number; nullAvatarPath?: boolean; dismissFailures?: number } = {},
) => {
  await page.addInitScript((options) => {
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<number, number>();
    const pendingSubscriptions: (() => void)[] = [];
    let nextCallback = 0;
    let revision = 0;
    let items: unknown[] = [];
    let showAttempts = 0;
    let snapshotReads = 0;
    let dismissAttempts = 0;
    const snapshot = () => ({ revision, items });
    Object.assign(window, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (id: number) => listeners.delete(id) },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "desktop-notifications" }, currentWebview: { label: "desktop-notifications" } },
        transformCallback: (callback: (event: unknown) => void) => {
          callbacks.set(++nextCallback, callback);
          return nextCallback;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (command: string, args: { event?: string; handler?: number; eventId?: number; id?: string }) => {
          if (command === "plugin:window|scale_factor") return 1;
          if (command === "plugin:event|listen") {
            const id = args.handler!;
            if (args.event === "notgram://desktop-notifications-changed") {
              const subscribe = () => listeners.set(id, id);
              if (options.pauseSubscription) {
                await new Promise<void>((resolve) => pendingSubscriptions.push(() => { subscribe(); resolve(); }));
              } else subscribe();
            }
            return id;
          }
          if (command === "plugin:event|unlisten") {
            listeners.delete(args.eventId!);
            return;
          }
          if (command === "notgram_desktop_notification_snapshot") {
            snapshotReads += 1;
            return snapshot();
          }
          if (command === "notgram_show_notification_window") {
            showAttempts += 1;
            if (showAttempts <= (options.showFailures ?? 0)) throw new Error("Transient show failure");
            return items.length > 0;
          }
          if (command === "notgram_dismiss_notification") {
            dismissAttempts += 1;
            if (dismissAttempts <= (options.dismissFailures ?? 0)) throw new Error("Transient dismiss failure");
            items = items.filter((item) => (item as { id: string }).id !== args.id);
            revision += 1;
            return snapshot();
          }
        },
      },
      __notificationNative: {
        get pendingSubscriptions() { return pendingSubscriptions.length; },
        get showAttempts() { return showAttempts; },
        get snapshotReads() { return snapshotReads; },
        releaseSubscriptions: () => pendingSubscriptions.splice(0).forEach((release) => release()),
        push: (updatedAtMs = Date.now(), emit = true) => {
          revision += 1;
          items = [{
            id: "native-notification", title: "Native chat", body: "Native message",
            avatar: { label: "N", color: "#4e86b0", ...(options.nullAvatarPath ? { imagePath: null } : {}) },
            themeId: "notgram-dark", reduceMotion: true, updatedAtMs,
            route: { accountId: "default", chatId: "native-chat", messageId: "1", topicId: null },
          }];
          if (emit) for (const [id, handler] of listeners) callbacks.get(handler)?.({ id, payload: snapshot() });
        },
      },
    });
    if (options.pauseFrames) {
      window.requestAnimationFrame = () => 1;
      window.cancelAnimationFrame = () => undefined;
    }
  }, options);
};

type NativeNotificationMock = {
  pendingSubscriptions: number;
  showAttempts: number;
  snapshotReads: number;
  releaseSubscriptions: () => void;
  push: (updatedAtMs?: number, emit?: boolean) => void;
};

const nativeState = (page: Page) => page.evaluate(() => {
  const state = (window as typeof window & { __notificationNative: NativeNotificationMock }).__notificationNative;
  return { pendingSubscriptions: state.pendingSubscriptions, showAttempts: state.showAttempts, snapshotReads: state.snapshotReads };
});

test("native notifications with a null avatar path display their fallback avatar", async ({ page }) => {
  await installNativeNotificationMock(page, { nullAvatarPath: true });
  await page.goto("/windows/notification-window.html");
  await expect.poll(async () => (await nativeState(page)).snapshotReads).toBeGreaterThan(0);
  await page.evaluate(() => (window as typeof window & { __notificationNative: NativeNotificationMock }).__notificationNative.push());
  await expect(page.locator(".desktop-notification-card")).toHaveCount(1);
  await expect.poll(async () => (await nativeState(page)).showAttempts).toBeGreaterThan(0);
});

test("native notifications arriving during listener setup are recovered by the initial snapshot", async ({ page }) => {
  await installNativeNotificationMock(page, { pauseSubscription: true });
  await page.goto("/windows/notification-window.html");
  await expect.poll(async () => (await nativeState(page)).pendingSubscriptions).toBeGreaterThan(0);
  await page.evaluate(() => {
    const state = (window as typeof window & { __notificationNative: NativeNotificationMock }).__notificationNative;
    state.push();
    state.releaseSubscriptions();
  });
  await expect(page.locator(".desktop-notification-card")).toHaveCount(1);
  await expect.poll(async () => (await nativeState(page)).showAttempts).toBeGreaterThan(0);
});

test("a hidden notification WebView can show without receiving animation frames", async ({ page }) => {
  await installNativeNotificationMock(page, { pauseFrames: true });
  await page.goto("/windows/notification-window.html");
  await expect.poll(async () => (await nativeState(page)).snapshotReads).toBeGreaterThan(0);
  await page.evaluate(() => (window as typeof window & { __notificationNative: NativeNotificationMock }).__notificationNative.push());
  await expect(page.locator(".desktop-notification-card")).toHaveCount(1);
  await expect.poll(async () => (await nativeState(page)).showAttempts).toBeGreaterThan(0);
});

test("native show failures retry and queued notifications get their full visible lifetime", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await installNativeNotificationMock(page, { showFailures: 2 });
  await page.goto("/windows/notification-window.html");
  await expect.poll(async () => (await nativeState(page)).snapshotReads).toBeGreaterThan(0);
  await page.evaluate(() => (window as typeof window & { __notificationNative: NativeNotificationMock }).__notificationNative.push(Date.now() - 60_000));
  await expect(page.locator(".desktop-notification-card")).toHaveCount(1);
  await page.clock.runFor(2000);
  await expect.poll(async () => (await nativeState(page)).showAttempts).toBeGreaterThanOrEqual(3);
  await expect(page.locator(".desktop-notification-card")).toHaveCount(1);
  await page.clock.runFor(8000);
  await expect(page.locator(".desktop-notification-card")).toHaveCount(1);
  await page.clock.runFor(2000);
  await expect(page.locator(".desktop-notification-card")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("snapshot polling recovers a dropped native event without renewing unchanged alerts", async ({ page }) => {
  await page.clock.install();
  await installNativeNotificationMock(page);
  await page.goto("/windows/notification-window.html");
  await expect.poll(async () => (await nativeState(page)).snapshotReads).toBeGreaterThan(0);
  await page.evaluate(() => (window as typeof window & { __notificationNative: NativeNotificationMock }).__notificationNative.push(Date.now(), false));
  await expect(page.locator(".desktop-notification-card")).toHaveCount(0);
  await page.clock.runFor(2000);
  const card = page.locator(".desktop-notification-card");
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-notification-presented", "true");
  const showAttempts = (await nativeState(page)).showAttempts;
  await page.clock.runFor(9000);
  await expect(card).toHaveCount(1);
  expect((await nativeState(page)).showAttempts).toBe(showAttempts);
  await page.clock.runFor(1001);
  await expect(card).toHaveCount(0);
});

test("a failed native dismissal retains the card for a later close attempt", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await installNativeNotificationMock(page, { dismissFailures: 1 });
  await page.goto("/windows/notification-window.html");
  await expect.poll(async () => (await nativeState(page)).snapshotReads).toBeGreaterThan(0);
  await page.evaluate(() => (window as typeof window & { __notificationNative: NativeNotificationMock }).__notificationNative.push());
  const card = page.locator(".desktop-notification-card");
  await expect(card).toHaveAttribute("data-notification-presented", "true");
  await page.getByRole("button", { name: "关闭通知" }).click();
  await page.clock.runFor(1);
  await expect(card).toHaveCount(1);
  await expect(card).not.toHaveClass(/is-exiting/);
  await page.getByRole("button", { name: "关闭通知" }).click();
  await page.clock.runFor(1);
  await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
});

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
  await page.goto("/windows/notification-window.html");
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
  await page.goto("/windows/notification-window.html");
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
  await page.goto("/windows/notification-window.html");
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
