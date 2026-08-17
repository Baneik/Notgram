import { expect, test, type Page } from "@playwright/test";

const horizontalOverflow = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll<HTMLElement>("body *")].some((element) => {
    if (element.closest(".rail-actions")) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && (bounds.left < -1 || bounds.right > innerWidth + 1);
  }));

const revealVirtualMessage = async (page: Page, messageId: string) => {
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await messageList.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -1,
    }));
  });
  await expect.poll(() => messageList.evaluate((element, targetId) => {
    const target = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((row) => row.dataset.messageId === targetId);
    if (target) {
      target.scrollIntoView({ block: "center", behavior: "auto" });
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
      return true;
    }
    element.scrollTop = Math.max(0, element.scrollTop - Math.max(320, element.clientHeight * 0.75));
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    return false;
  }, messageId)).toBe(true);
  const row = page.locator(`[data-message-id="${messageId}"]`);
  await expect(row).toBeVisible();
  return row;
};

const waitForStableFrame = async (page: Page) => {
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator("[data-conversation-switch-snapshot]")).toHaveCount(0);
  await expect(page.locator('.motion-presence[data-motion-state="exiting"]')).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect.poll(() => page.locator(".stable-image").evaluateAll((images) => {
    const visible = images.filter((image) => {
      const bounds = image.getBoundingClientRect();
      const style = getComputedStyle(image);
      return bounds.width > 0 && bounds.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    return visible.length === 0 || visible.every((element) => {
      const image = element as HTMLImageElement;
      return image.dataset.imageState === "ready" || (image.complete && image.naturalWidth === 0);
    });
  })).toBe(true);
};

test("async feedback suppresses short flashes and holds visible loading feedback", async ({ page }) => {
  await page.goto("/");
  const search = page.getByPlaceholder("搜索会话和消息");
  const loading = page.locator('[aria-label="正在搜索"]');
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { globalSearch: Record<string, unknown> };
        setState: (state: { globalSearch: Record<string, unknown> }) => void;
      };
    };
    const runtime = globalThis as typeof globalThis & {
      __motionLoadingMounted?: () => boolean;
      __settleMotionSearch?: (query: string) => void;
    };
    runtime.__settleMotionSearch = (query) => module.telegramStore.setState({
      globalSearch: {
        ...module.telegramStore.getState().globalSearch,
        query,
        filter: "all",
        chats: [],
        messages: [],
        totalCount: 0,
        nextOffset: undefined,
        loading: false,
        error: undefined,
      },
    });
    let loadingMounted = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector('[aria-label="正在搜索"]')) loadingMounted = true;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    runtime.__motionLoadingMounted = () => loadingMounted;
  }, "/src/store/telegramStore.ts");
  const settleSearch = (query: string) => page.evaluate((searchQuery) => (
    globalThis as typeof globalThis & { __settleMotionSearch?: (value: string) => void }
  ).__settleMotionSearch?.(searchQuery), query);

  const quickQuery = "motion-quick-result";
  await page.evaluate((query) => {
    const input = document.querySelector<HTMLInputElement>('input[placeholder="搜索会话和消息"]');
    if (!input) throw new Error("Search input is unavailable");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    globalThis.setTimeout(() => (
      globalThis as typeof globalThis & { __settleMotionSearch?: (value: string) => void }
    ).__settleMotionSearch?.(query), 40);
  }, quickQuery);
  await page.waitForTimeout(220);
  expect(await loading.count()).toBe(0);
  expect(await page.evaluate(() => (
    globalThis as typeof globalThis & { __motionLoadingMounted?: () => boolean }
  ).__motionLoadingMounted?.())).toBe(false);
  await expect(page.getByText("没有搜索结果", { exact: true })).toBeVisible();

  const longQuery = "motion-long-result";
  await search.fill(longQuery);
  await expect(loading).toBeVisible({ timeout: 400 });
  await settleSearch(longQuery);

  await page.waitForTimeout(150);
  await expect(loading).toBeVisible();
  await expect(page.getByText("没有搜索结果", { exact: true })).toBeVisible({ timeout: 700 });
  await expect(loading).toHaveCount(0);
});

test("mobile conversation handoff keeps only the active layer interactive", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/");

  const sidebar = page.locator(".chat-sidebar");
  const conversation = page.locator(".conversation").first();
  await page.locator(".chat-row").first().click();
  await expect(page.locator(".app-shell")).toHaveClass(/mobile-chat-open/);
  await expect.poll(() => sidebar.evaluate((element) => {
    const node = element as HTMLElement & { inert?: boolean };
    return { inert: node.inert === true, opacity: getComputedStyle(element).opacity };
  })).toEqual({ inert: true, opacity: "0" });
  await expect.poll(() => conversation.evaluate((element) => {
    const node = element as HTMLElement & { inert?: boolean };
    return { inert: node.inert === true, opacity: getComputedStyle(element).opacity };
  })).toEqual({ inert: false, opacity: "1" });
  await expect(page.getByRole("button", { name: "返回会话列表" })).toBeFocused();

  await page.getByRole("button", { name: "返回会话列表" }).click();
  await expect(page.locator(".app-shell")).not.toHaveClass(/mobile-chat-open/);
  await expect.poll(() => sidebar.evaluate((element) => {
    const node = element as HTMLElement & { inert?: boolean };
    return { inert: node.inert === true, opacity: getComputedStyle(element).opacity };
  })).toEqual({ inert: false, opacity: "1" });
  await expect.poll(() => conversation.evaluate((element) => {
    const node = element as HTMLElement & { inert?: boolean };
    return { inert: node.inert === true, opacity: getComputedStyle(element).opacity };
  })).toEqual({ inert: true, opacity: "0" });
  await expect(page.locator(".chat-row").first()).toBeFocused();
});

test("mobile settings handoff preserves layers and restores focus", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 600, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();

  const categories = page.locator(".settings-categories");
  const detail = page.locator(".settings-detail");
  const accountCategory = page.getByRole("button", { name: "我的账号" });
  await expect.poll(() => detail.evaluate((element) => ({
    inert: (element as HTMLElement & { inert?: boolean }).inert === true,
    opacity: getComputedStyle(element).opacity,
  }))).toEqual({ inert: true, opacity: "0" });

  await accountCategory.click();
  await expect.poll(() => categories.evaluate((element) => ({
    inert: (element as HTMLElement & { inert?: boolean }).inert === true,
    opacity: getComputedStyle(element).opacity,
  }))).toEqual({ inert: true, opacity: "0" });
  await expect.poll(() => detail.evaluate((element) => ({
    inert: (element as HTMLElement & { inert?: boolean }).inert === true,
    opacity: getComputedStyle(element).opacity,
  }))).toEqual({ inert: false, opacity: "1" });
  const back = page.getByRole("button", { name: "返回设置分类" });
  await expect(back).toBeFocused();

  await back.click();
  await expect.poll(() => categories.evaluate((element) => ({
    inert: (element as HTMLElement & { inert?: boolean }).inert === true,
    opacity: getComputedStyle(element).opacity,
  }))).toEqual({ inert: false, opacity: "1" });
  await expect(accountCategory).toBeFocused();
});

test("images remain hidden until their current source finishes decoding", async ({ page }) => {
  await page.addInitScript(() => {
    let released = false;
    const pending: Array<() => void> = [];
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      value() {
        if (released) return Promise.resolve();
        return new Promise<void>((resolve) => pending.push(resolve));
      },
    });
    (globalThis as typeof globalThis & { __releaseImageDecode?: () => void }).__releaseImageDecode = () => {
      released = true;
      pending.splice(0).forEach((resolve) => resolve());
    };
  });
  await page.goto("/");

  const image = page.locator(".stable-image").first();
  await expect(image).toHaveAttribute("data-image-state", "decoding");
  await expect(image).toHaveCSS("opacity", "0");
  await page.evaluate(() => (
    globalThis as typeof globalThis & { __releaseImageDecode?: () => void }
  ).__releaseImageDecode?.());
  await expect(image).toHaveAttribute("data-image-state", "ready");
  await expect(image).toHaveCSS("opacity", "1");
});

test("background visibility pauses continuous motion and resumes it on return", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await page.evaluate(() => {
    HTMLMediaElement.prototype.play = function play() {
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    (globalThis as typeof globalThis & {
      __setMotionVisibility?: (next: DocumentVisibilityState) => void;
    }).__setMotionVisibility = (next) => {
      visibility = next;
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const spinner = document.createElement("span");
    spinner.dataset.motionTestSpinner = "true";
    spinner.className = "spin";
    document.body.append(spinner);
  });

  await page.getByRole("button", { name: "播放 产品语音.m4a" }).click();
  const spectrum = page.locator('[data-message-id="p-audio"] .audio-spectrum');
  const spinner = page.locator('[data-motion-test-spinner="true"]');
  await expect(spectrum).toHaveAttribute("data-motion-active", "true");
  await expect(page.locator("html")).toHaveAttribute("data-motion-runtime", "active");

  await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __setMotionVisibility?: (next: DocumentVisibilityState) => void;
    }
  ).__setMotionVisibility?.("hidden"));
  await expect(page.locator("html")).toHaveAttribute("data-motion-runtime", "paused");
  await expect(spectrum).toHaveAttribute("data-motion-active", "false");
  await expect(spinner).toHaveCSS("animation-play-state", "paused");
  const hiddenFrame = await spectrum.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  await page.waitForTimeout(180);
  expect(await spectrum.evaluate((element) => (element as HTMLCanvasElement).toDataURL()))
    .toBe(hiddenFrame);

  await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __setMotionVisibility?: (next: DocumentVisibilityState) => void;
    }
  ).__setMotionVisibility?.("visible"));
  await expect(page.locator("html")).toHaveAttribute("data-motion-runtime", "active");
  await expect(spectrum).toHaveAttribute("data-motion-active", "true");
  await expect(spinner).toHaveCSS("animation-play-state", "running");
});

test("rapid menus, jumps, conversation switches, scroll, and resize settle cleanly", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await expect(page.getByRole("log", { name: "消息列表" })).toHaveAttribute("aria-busy", "false");

  const moreActions = page.getByRole("button", { name: "更多操作" });
  const menu = page.getByRole("menu", { name: "会话操作" });
  await moreActions.click();
  await moreActions.click();
  await moreActions.click();
  await expect(menu).toBeVisible();
  await expect(page.locator('.motion-presence:has(.chat-action-menu)')).toHaveCount(1);

  await page.getByRole("log", { name: "消息列表" }).evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollTop - 320);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.setViewportSize({ width: 768, height: 720 });
  await expect(menu).toBeVisible();
  await page.setViewportSize({ width: 390, height: 720 });
  await expect(menu).toHaveCount(0);
  await expect(page.locator('.motion-presence[data-motion-state="exiting"]')).toHaveCount(0);
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await moreActions.click();
  await expect(menu).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(moreActions).toBeFocused();

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(async () => {
    for (const chatId of ["chat-mia", "chat-forum", "chat-product", "chat-mia", "chat-product"]) {
      document.querySelector<HTMLElement>(`[data-chat-id="${chatId}"]`)?.click();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 24));
    }
  });
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect(page.getByRole("log", { name: "消息列表" })).toHaveAttribute("aria-busy", "false");

  const source = await revealVirtualMessage(page, "p-channel-reply");
  await source.locator(".message-reply-preview").click();
  await expect(page.locator('[data-message-id="p-old-8"]')).toHaveClass(/is-notification-target/);
  await page.locator(".pinned-message-preview").click();
  await expect(page.locator('[data-message-id="p-4"]')).toBeVisible();
  await page.locator('[data-chat-id="chat-mia"]').click();
  await page.locator('[data-chat-id="chat-product"]').click();

  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect(page.locator(".message-list")).not.toHaveClass(/is-jump-transitioning/);
  await expect(page.locator("[data-conversation-switch-snapshot], [data-conversation-motion-snapshot]"))
    .toHaveCount(0, { timeout: 2_000 });
  await expect(page.locator('.motion-presence[data-motion-state="exiting"]'))
    .toHaveCount(0, { timeout: 2_000 });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator('.chat-row[aria-current="true"]')).toHaveCount(1);
  expect(await horizontalOverflow(page)).toBe(false);

  const unsafeKeyframeProperties = await page.evaluate(() => {
    const metadata = new Set(["offset", "computedOffset", "easing", "composite"]);
    return document.getAnimations().flatMap((animation) =>
      (animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : [])
        .flatMap((frame) => Object.keys(frame))
        .filter((property) => !metadata.has(property) && property !== "opacity" && property !== "transform"));
  });
  expect(unsafeKeyframeProperties).toEqual([]);
});

for (const width of [390, 768, 1280]) {
  for (const reducedMotion of [false, true]) {
    const motion = reducedMotion ? "reduced" : "full";
    test(`visual motion baseline at ${width}px with ${motion} motion`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
      await page.setViewportSize({ width, height: 720 });
      await page.goto("/");
      await page.locator('[data-chat-id="chat-product"]').click();
      await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
      await expect(page.locator("html")).toHaveAttribute(
        "data-motion",
        reducedMotion ? "reduced" : "full",
      );
      await waitForStableFrame(page);
      await expect(page).toHaveScreenshot(`motion-${width}-${motion}.png`, {
        animations: "disabled",
        caret: "hide",
        maxDiffPixelRatio: 0.002,
      });
    });
  }
}
