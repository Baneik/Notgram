import { expect, test, type Page } from "@playwright/test";

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

// Both motion preferences must settle to the same layout baseline.
for (const width of [390, 768, 1280]) {
  for (const reducedMotion of [false, true]) {
    const motion = reducedMotion ? "reduced" : "full";
    test(`visual motion baseline at ${width}px with ${motion} motion`, { tag: "@visual" }, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
      await page.setViewportSize({ width, height: 720 });
      await page.goto("/");
      await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
      await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
      await expect(page.locator("html")).toHaveAttribute(
        "data-motion",
        reducedMotion ? "reduced" : "full",
      );
      await waitForStableFrame(page);
      await expect(page).toHaveScreenshot(`motion-${width}.png`, {
        animations: "disabled",
        caret: "hide",
        maxDiffPixelRatio: 0.002,
      });
    });
  }
}
