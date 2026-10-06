import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await expect(page.getByRole("log", { name: "消息列表" })).toHaveAttribute("aria-busy", "false");
});

test("popover reversals continue from the visible frame", async ({ page }) => {
  const samples = await page.evaluate(async () => {
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const trigger = document.querySelector<HTMLButtonElement>('.conversation-actions [aria-label="更多操作"]')!;
    const opacity = () => Number(getComputedStyle(document.querySelector(".chat-action-menu")!).opacity);
    trigger.click();
    for (let frame = 0; frame < 30; frame++) {
      await nextFrame();
      if (opacity() > 0.25 && opacity() < 0.9) break;
    }
    const beforeClose = opacity();
    trigger.click();
    await nextFrame();
    const afterClose = opacity();
    await nextFrame();
    const beforeReopen = opacity();
    trigger.click();
    await nextFrame();
    const afterReopen = opacity();
    return { beforeClose, afterClose, beforeReopen, afterReopen };
  });
  expect(samples.beforeClose).toBeGreaterThan(0.25);
  expect(samples.beforeClose).toBeLessThan(0.9);
  expect(samples.afterClose, JSON.stringify(samples)).toBeLessThanOrEqual(samples.beforeClose + 0.04);
  expect(samples.afterReopen, JSON.stringify(samples)).toBeGreaterThanOrEqual(samples.beforeReopen - 0.04);
  await expect(page.getByRole("menu", { name: "会话操作" })).toBeVisible();
  await page.getByRole("button", { name: "更多操作" }).click();
  await expect(page.locator(".chat-action-menu")).toHaveCount(0);
  await expect(page.locator('.motion-presence[data-motion-state="exiting"]')).toHaveCount(0);
});

test("modal opacity belongs to its surface and independent scrim", async ({ page }) => {
  const samples = await page.evaluate(async () => {
    document.querySelector<HTMLButtonElement>(".rail-settings")!.click();
    for (let frame = 0; frame < 30; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const surface = document.querySelector(".settings-dialog");
      if (!surface) continue;
      const opacity = Number(getComputedStyle(surface).opacity);
      if (opacity > 0.2 && opacity < 0.9) {
        return {
          surface: opacity,
          parent: getComputedStyle(surface.parentElement!).opacity,
          detail: getComputedStyle(document.querySelector(".settings-detail")!).opacity,
          scrim: Number(getComputedStyle(surface.parentElement!, "::before").opacity),
        };
      }
    }
    throw new Error("Modal entrance did not produce a visible intermediate frame");
  });
  expect(samples.parent).toBe("1");
  expect(samples.detail).toBe("1");
  expect(samples.scrim).toBeGreaterThan(0);
  expect(samples.scrim).toBeLessThan(1);
});

test("settings content transitions preserve its container and latest selection", async ({ page }) => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
  const result = await page.evaluate(async () => {
    const container = document.querySelector(".settings-detail")!;
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".settings-category")];
    buttons.find((button) => button.textContent === "通知与声音")!.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const moving = document.getAnimations().some((animation) =>
      animation.playState === "running" && animation.effect instanceof KeyframeEffect &&
      animation.effect.target?.closest(".settings-detail") === container);
    for (const label of ["聊天设置", "快捷键", "我的账号"]) {
      buttons.find((button) => button.textContent === label)!.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return { moving, sameContainer: container === document.querySelector(".settings-detail") };
  });
  expect(result).toEqual({ moving: true, sameContainer: true });
  await page.getByRole("button", { name: "我的账号", exact: true }).click();
  await expect(page.locator(".settings-detail-header h3")).toHaveText("我的账号");
  await expect(page.locator(".settings-category[aria-current=page]")).toBeFocused();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".settings-dialog")).toHaveCount(0);
});

test("picker expands from its lower anchor and moves a shared tab indicator", async ({ page }) => {
  await page.getByRole("button", { name: "表情", exact: true }).click();
  await expect(page.locator(".emoji-picker")).toBeVisible();
  const result = await page.evaluate(async () => {
    const picker = document.querySelector<HTMLElement>(".emoji-picker")!;
    const size = picker.getBoundingClientRect();
    const origin = getComputedStyle(picker).transformOrigin.split(" ").map(Number.parseFloat);
    document.querySelector<HTMLButtonElement>('.emoji-picker-tabs [role=tab]')!.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const movingIndicator = document.getAnimations().some((animation) =>
      animation.playState === "running" && animation.effect instanceof KeyframeEffect &&
      animation.effect.target?.classList.contains("motion-selection-indicator"));
    return { originY: origin[1], height: size.height, movingIndicator };
  });
  expect(result.originY).toBeGreaterThan(result.height * 0.9);
  expect(result.movingIndicator).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator(".emoji-picker")).toHaveCount(0);
  await expect(page.locator(".conversation > .composer-wrap .composer-input")).toBeFocused();
});

test("reduced motion settles transient and navigation effects synchronously", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveClass(/reduce-motion/);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "聊天设置", exact: true }).click();
  expect(await page.evaluate(() => document.getAnimations().filter((animation) =>
    animation.playState === "running" && animation.effect instanceof KeyframeEffect &&
    animation.effect.target?.closest(".settings-dialog")).length)).toBe(0);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".settings-dialog")).toHaveCount(0);
  for (let index = 0; index < 6; index++) await page.getByRole("button", { name: "更多操作" }).click();
  await expect(page.locator(".chat-action-menu")).toHaveCount(0);
  await expect(page.locator('.motion-presence[data-motion-state="exiting"]')).toHaveCount(0);
});

test("modal reversals retain presentation while resetting the child session", async ({ page }) => {
  const samples = await page.evaluate(async () => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const trigger = document.querySelector<HTMLButtonElement>(".rail-settings")!;
    const opacity = () => Number(getComputedStyle(document.querySelector(".settings-dialog")!).opacity);
    trigger.focus({ preventScroll: true });
    trigger.click();
    for (let index = 0; index < 30; index++) {
      await frame();
      if (document.querySelector(".settings-dialog") && opacity() > 0.2 && opacity() < 0.9) break;
    }
    document.querySelectorAll<HTMLButtonElement>(".settings-category")[2].click();
    const beforeClose = opacity();
    document.querySelector<HTMLButtonElement>('.settings-dialog-header [aria-label="关闭"]')!.click();
    await frame();
    const afterClose = opacity();
    const oldSurface = document.querySelector(".settings-dialog");
    trigger.focus({ preventScroll: true });
    trigger.click();
    await frame();
    return { beforeClose, afterClose, afterReopen: opacity(), replaced: oldSurface !== document.querySelector(".settings-dialog") };
  });
  expect(samples.afterClose).toBeLessThanOrEqual(samples.beforeClose + 0.04);
  expect(samples.afterReopen).toBeGreaterThanOrEqual(samples.afterClose - 0.04);
  expect(samples.replaced).toBe(true);
  await expect(page.locator(".settings-detail-header h3")).toHaveText("我的账号");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".settings-dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();
});

test("backgrounding finishes an interrupted exit without stale layers", async ({ page }) => {
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.evaluate(async () => {
    document.querySelector<HTMLButtonElement>('.conversation-actions [aria-label="更多操作"]')!.click();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await expect(page.locator(".chat-action-menu")).toHaveCount(0);
  await expect(page.locator('.motion-presence[data-motion-state="exiting"]')).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".chat-action-menu")).toHaveCount(0);
});

test("CSS fallback retains bounded dismissal when element animation is unavailable", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: undefined }); });
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.locator(".settings-dialog")).toBeVisible();
  await expect(page.locator(".motion-presence[data-motion-managed]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".chat-action-menu")).toHaveCount(0);
});

test("a WebView rejecting pseudo-element animation keeps the dialog usable", async ({ page }) => {
  await page.addInitScript(() => {
    const animate = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = function (frames, options) {
      if (typeof options === "object" && options.pseudoElement) throw new Error("Unsupported pseudo-element animation");
      return animate.call(this, frames, options);
    };
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.locator(".settings-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const width of [1366, 390]) {
  test(`selection markers align after resize at ${width}px and 125% zoom`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(async () => {
      const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
      preferencesStore.setState({ interfaceScale: 125, themeId: "notgram-dark" });
    });
    if (width === 390) await page.locator(".chat-list[data-active=true] .chat-row").first().click();
    await page.getByRole("button", { name: "表情", exact: true }).click();
    await page.getByRole("tab", { name: "Emoji", exact: true }).click();
    await page.getByRole("tab", { name: "GIF 动态图", exact: true }).click();
    await page.setViewportSize({ width: width + 36, height: 900 });
    await expect.poll(() => page.evaluate(() => {
      const marker = document.querySelector(".emoji-picker-tabs .motion-selection-indicator")!.getBoundingClientRect();
      const selected = document.querySelector('.emoji-picker-tabs [aria-selected=true]')!.getBoundingClientRect();
      return marker.width > 0 && marker.left >= selected.left && marker.right <= selected.right && Math.abs(marker.bottom - selected.bottom) <= 3;
    })).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator(".emoji-picker")).toHaveCount(0);
  });
}
