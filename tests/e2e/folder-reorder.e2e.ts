import { expect, test, type Page } from "@playwright/test";

const buttons = (page: Page) => page.locator(".rail-actions [data-folder-id]");
const order = (page: Page) => buttons(page).evaluateAll((elements) => elements.map((element) => element.getAttribute("data-folder-id")));
const savedOrder = (page: Page) => page.evaluate(async (modulePath) => {
  const { telegramStore } = await import(modulePath) as typeof import("../../src/store/telegramStore");
  return telegramStore.getState().folders.filter((folder) => folder.id !== "archive").map((folder) => folder.id);
}, "/src/store/telegramStore.ts");

const startSwap = async (page: Page, horizontal = false) => {
  const first = await buttons(page).nth(0).boundingBox();
  const second = await buttons(page).nth(1).boundingBox();
  if (!first || !second) throw new Error("Folder buttons are missing");
  const target = { x: first.x + (horizontal ? 4 : first.width / 2), y: first.y + (horizontal ? first.height / 2 : 4) };
  await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y);
  await expect.poll(() => order(page)).toEqual(["folder:work", "main"]);
  return { target, first, second };
};

const settled = async (page: Page) => {
  await expect(page.locator("html")).not.toHaveClass(/is-reordering-folders/);
  await expect(page.locator(".rail-actions .is-dragging, .rail-actions .drop-before, .rail-actions .drop-after")).toHaveCount(0);
  await expect.poll(() => buttons(page).evaluateAll((elements) => elements.every((element) => {
    const style = getComputedStyle(element);
    return style.transform === "none" && style.opacity === "1" && style.filter === "none" &&
      style.willChange !== "transform" && element.getAnimations().length === 0;
  }))).toBe(true);
};

for (const width of [1080, 390]) {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`folder preview commits after settling under the pointer (${width}, ${reducedMotion})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.emulateMedia({ reducedMotion });
      await page.goto("/");
      const { target } = await startSwap(page, width < 720);
      await expect.poll(() => buttons(page).evaluateAll((elements) => elements.every((element) => element.getAnimations().length === 0))).toBe(true);
      // The pointer now hits the dragged button itself. Small moves must keep the preview valid.
      for (let delta = 1; delta <= 3; delta += 1) {
        await page.mouse.move(target.x + delta, target.y + delta);
        await expect.poll(() => order(page)).toEqual(["folder:work", "main"]);
      }
      await page.mouse.up();
      await expect.poll(() => savedOrder(page)).toEqual(["folder:work", "main"]);
      await settled(page);
      await expect(page.locator('[data-folder-id="main"]')).toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: "工作", exact: true }).click();
      await expect(page.locator('[data-folder-id="folder:work"]')).toHaveAttribute("aria-pressed", "true");
      await page.locator('[data-folder-id="main"]').focus();
      await page.keyboard.press("Enter");
      await expect(page.locator('[data-folder-id="main"]')).toHaveAttribute("aria-pressed", "true");
    });
  }
}

test("folder preview reverses direction during motion and can return to its starting order", async ({ page }) => {
  await page.goto("/");
  const { target, second } = await startSwap(page);
  for (let cycle = 0; cycle < 4; cycle += 1) {
    await page.mouse.move(second.x + second.width / 2, second.y + second.height - 4);
    await expect.poll(() => order(page)).toEqual(["main", "folder:work"]);
    await page.mouse.move(target.x, target.y);
    await expect.poll(() => order(page)).toEqual(["folder:work", "main"]);
  }
  await page.mouse.move(second.x + second.width / 2, second.y + second.height - 4);
  await page.mouse.up();
  await expect.poll(() => savedOrder(page)).toEqual(["main", "folder:work"]);
  await settled(page);
});

for (const reason of ["escape", "blur", "pointercancel", "capture loss", "outside", "resize", "hidden", "account pending", "folder removal"] as const) {
  test(`folder dragging cleans up on ${reason}`, async ({ page }) => {
    await page.goto("/");
    await startSwap(page);
    if (reason === "escape") await page.keyboard.press("Escape");
    if (reason === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    if (reason === "pointercancel") await page.locator(".rail-actions").dispatchEvent("pointercancel", { pointerId: 1 });
    if (reason === "capture loss") await page.locator(".rail-actions").evaluate((element) => element.releasePointerCapture(1));
    if (reason === "outside") await page.mouse.move(650, 350);
    if (reason === "resize") await page.setViewportSize({ width: 390, height: 700 });
    if (reason === "hidden") await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    if (reason === "account pending" || reason === "folder removal") await page.evaluate(async ({ modulePath, reason }) => {
      const { telegramStore } = await import(modulePath) as typeof import("../../src/store/telegramStore");
      if (reason === "account pending") telegramStore.setState({ accountPending: true });
      else telegramStore.setState({ folders: telegramStore.getState().folders.filter((folder) => folder.id !== "folder:work") });
    }, { modulePath: "/src/store/telegramStore.ts", reason });
    await page.mouse.up();
    await settled(page);
    await expect.poll(() => savedOrder(page)).toEqual(reason === "folder removal" ? ["main"] : ["main", "folder:work"]);
    if (reason !== "folder removal" && reason !== "account pending" && reason !== "hidden") {
      await page.setViewportSize({ width: 1080, height: 700 });
      await startSwap(page);
      await page.mouse.up();
      await expect.poll(() => savedOrder(page)).toEqual(["folder:work", "main"]);
      await settled(page);
    }
  });
}

test("unmounting the folder rail releases the drag session", async ({ page }) => {
  await page.goto("/");
  await startSwap(page);
  await page.evaluate(async (modulePath) => {
    const { telegramStore } = await import(modulePath) as typeof import("../../src/store/telegramStore");
    telegramStore.setState({ authorization: { kind: "waitPhoneNumber" } });
  }, "/src/store/telegramStore.ts");
  await expect(page.locator(".rail-actions")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveClass(/is-reordering-folders/);
  await page.mouse.up();
  await page.evaluate(async (modulePath) => {
    const { telegramStore } = await import(modulePath) as typeof import("../../src/store/telegramStore");
    telegramStore.setState({ authorization: { kind: "ready" } });
  }, "/src/store/telegramStore.ts");
  await expect.poll(() => order(page)).toEqual(["main", "folder:work"]);
  await startSwap(page);
  await page.mouse.up();
  await expect.poll(() => savedOrder(page)).toEqual(["folder:work", "main"]);
  await settled(page);
});

for (const failure of [false, true]) {
  test(`folder order remains visible during delayed synchronization and ${failure ? "rolls back on failure" : "persists on success"}`, async ({ page }) => {
    await page.goto("/");
    await expect(buttons(page)).toHaveCount(2);
    await page.evaluate(async ({ modulePath, failure }) => {
      const { MockTelegramTransport } = await import(modulePath) as typeof import("../../src/telegram/mockTransport");
      const original = MockTelegramTransport.prototype.reorderChatFolders;
      MockTelegramTransport.prototype.reorderChatFolders = async function (ids) {
        await new Promise<void>((resolve) => {
          (window as typeof window & { releaseFolderReorder?: () => void }).releaseFolderReorder = resolve;
        });
        if (failure) throw new Error("Folder reorder rejected");
        await original.call(this, ids);
      };
    }, { modulePath: "/src/telegram/mockTransport.ts", failure });
    await startSwap(page);
    await page.mouse.up();
    await settled(page);
    await expect.poll(() => order(page)).toEqual(["folder:work", "main"]);
    await expect(page.locator(".rail-actions .is-folder-draggable")).toHaveCount(0);
    await page.evaluate(() => (window as typeof window & { releaseFolderReorder?: () => void }).releaseFolderReorder?.());
    await expect(page.locator(".rail-actions .is-folder-draggable")).toHaveCount(2);
    await expect.poll(() => savedOrder(page)).toEqual(failure ? ["main", "folder:work"] : ["folder:work", "main"]);
    await settled(page);
    if (failure) await expect(page.getByText("Folder reorder rejected", { exact: true })).toBeVisible();
  });
}

for (const width of [1080, 390]) {
  test(`folder dragging scrolls an overflowing rail (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 460 });
    await page.goto("/");
    await expect(buttons(page)).toHaveCount(2);
    await page.evaluate(async (modulePath) => {
      const { telegramStore } = await import(modulePath) as typeof import("../../src/store/telegramStore");
      for (let index = 0; index < 9; index += 1) await telegramStore.getState().createChatFolder(`Folder ${index}`, ["chat-mia"]);
    }, "/src/store/telegramStore.ts");
    const initial = await savedOrder(page);
    const rail = page.locator(".rail-actions");
    const first = await buttons(page).first().boundingBox();
    const bounds = await rail.boundingBox();
    if (!first || !bounds) throw new Error("Folder rail is missing");
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(width < 720 ? bounds.x + bounds.width - 3 : bounds.x + bounds.width / 2,
      width < 720 ? bounds.y + bounds.height / 2 : bounds.y + bounds.height - 3);
    await expect.poll(async () => (await order(page)).at(-1), { timeout: 10_000 }).toBe("main");
    await page.mouse.up();
    await expect.poll(() => savedOrder(page)).toEqual([...initial.slice(1), "main"]);
    await settled(page);
  });
}

test("touch folder dragging commits and clears pointer capture", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto("/");
  const first = await buttons(page).nth(0).boundingBox();
  const second = await buttons(page).nth(1).boundingBox();
  if (!first || !second) throw new Error("Folder buttons are missing");
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: second.x + second.width / 2, y: second.y + second.height / 2 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: first.x + 4, y: first.y + first.height / 2 }] });
  await expect.poll(() => order(page)).toEqual(["folder:work", "main"]);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => savedOrder(page)).toEqual(["folder:work", "main"]);
  await settled(page);
  await session.detach();
});
