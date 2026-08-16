import { expect, test, type Page } from "@playwright/test";

const viewportOverflow = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll<HTMLElement>("body *")]
    .filter((element) => {
      if (element.closest(".rail-actions")) return false;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && (bounds.left < -1 || bounds.right > innerWidth + 1);
    })
    .map((element) => element.className || element.tagName)
    .slice(0, 10));

test("forced colors preserve selection and custom switches without focus frames", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => matchMedia("(forced-colors: active)").matches))
    .toBe(true);

  const activeChat = page.locator(".chat-row.is-active");
  await expect(activeChat).toBeVisible();
  await activeChat.focus();
  const focusStyle = await activeChat.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focusStyle.outlineStyle).toBe("none");
  expect(focusStyle.outlineWidth).toBe("0px");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /诊断与隐私/ }).click();
  const crashSwitch = page.getByRole("switch", { name: "保留脱敏崩溃报告" });
  await expect(crashSwitch).toBeVisible();
  await expect.poll(() => crashSwitch.evaluate(
    (element) => getComputedStyle(element).forcedColorAdjust,
  )).toBe("none");
  await expect(viewportOverflow(page)).resolves.toEqual([]);
});

test("reduced motion is applied from the system and app preferences", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => ({
    className: document.documentElement.className,
    motion: document.documentElement.dataset.motion,
  }))).toEqual({ className: expect.stringContaining("reduce-motion"), motion: "reduced" });

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "电池和动画", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  const motionStyle = await dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      animationDurationMs: Number.parseFloat(style.animationDuration) || 0,
      transitionDurationMs: Number.parseFloat(style.transitionDuration) || 0,
    };
  });
  expect(motionStyle.animationDurationMs).toBeLessThan(0.01);
  expect(motionStyle.transitionDurationMs).toBeLessThan(0.01);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.motion)).toBe("full");
  const reducedMotion = page.getByRole("switch", { name: "减少动态效果" });
  await reducedMotion.click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.motion)).toBe("reduced");
});

test("reduced motion freezes continuous audio visualization", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.evaluate(() => {
    HTMLMediaElement.prototype.play = function play() {
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
  });

  await page.getByRole("button", { name: "播放 产品语音.m4a" }).click();
  const spectrum = page.locator('[data-message-id="p-audio"] .audio-spectrum');
  await expect(spectrum).toHaveAttribute("data-motion-active", "false");
  await page.waitForTimeout(200);
  const firstFrame = await spectrum.evaluate((element) =>
    (element as HTMLCanvasElement).toDataURL());
  await page.waitForTimeout(180);
  const secondFrame = await spectrum.evaluate((element) =>
    (element as HTMLCanvasElement).toDataURL());
  expect(secondFrame).toBe(firstFrame);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.motion)).toBe("full");
  await expect(spectrum).toHaveAttribute("data-motion-active", "true");
});

test("presence transitions survive interrupted popover exits and finish toast exits", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");

  const moreActions = page.getByRole("button", { name: "更多操作" });
  await moreActions.click();
  const popoverPresence = page.locator('.motion-presence:has(.chat-action-menu)');
  await expect(popoverPresence).toHaveAttribute("data-motion-state", "entered");
  await moreActions.click();
  await expect(popoverPresence).toHaveAttribute("data-motion-state", "exiting");
  await moreActions.click();
  await expect(popoverPresence).toHaveAttribute("data-motion-state", "entered");
  await page.waitForTimeout(180);
  await expect(page.getByRole("menu", { name: "会话操作" })).toBeVisible();

  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: { setState: (state: { operationError: string }) => void };
    };
    module.telegramStore.setState({ operationError: "动效退出测试" });
  }, "/src/store/telegramStore.ts");
  const toastPresence = page.locator('.motion-presence:has(.operation-error)');
  await expect(page.getByText("动效退出测试")).toBeVisible();
  await page.getByRole("button", { name: "关闭操作提示" }).click();
  await expect(toastPresence).toHaveAttribute("data-motion-state", "exiting");
  await expect(toastPresence.locator(".operation-error")).toHaveCSS(
    "animation-name",
    "motion-toast-out",
  );
  await expect(toastPresence).toHaveCount(0);
});

test("long unbroken content remains contained on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await page.goto("/");
  await page.locator(".chat-row").first().click();
  await expect(page.locator(".conversation")).toBeVisible();

  const longToken = "NotgramLongUnbrokenText".repeat(24);
  await page.evaluate((text) => {
    const title = document.querySelector<HTMLElement>(".conversation-title strong");
    const message = document.querySelector<HTMLElement>(".message-bubble p");
    const connection = document.querySelector<HTMLElement>(".connection-status span");
    if (title) title.textContent = text;
    if (message) message.textContent = text;
    if (connection) connection.textContent = text;
  }, longToken);

  const message = page.locator(".message-bubble p").first();
  await expect(message).toBeVisible();
  expect(await message.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
    .toBe(true);
  await expect(viewportOverflow(page)).resolves.toEqual([]);

  await page.getByRole("button", { name: "返回会话列表" }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.evaluate((text) => {
    const label = document.querySelector<HTMLElement>(".settings-category span");
    if (label) label.textContent = text;
  }, longToken);
  await expect(viewportOverflow(page)).resolves.toEqual([]);
});

test("primary workflows expose named controls in the accessibility tree", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('.chat-row[aria-current="true"]')).toHaveCount(1);

  const session = await page.context().newCDPSession(page);
  const initialTree = await session.send("Accessibility.getFullAXTree") as {
    nodes: Array<{
      ignored?: boolean;
      role?: { value?: string };
      name?: { value?: string };
    }>;
  };
  expect(initialTree.nodes.some((node) =>
    node.role?.value === "navigation" && node.name?.value === "聊天文件夹")).toBe(true);
  expect(initialTree.nodes.some((node) =>
    node.role?.value === "complementary" && node.name?.value === "会话列表")).toBe(true);
  expect(initialTree.nodes.some((node) =>
    node.role?.value === "log" && node.name?.value === "消息列表")).toBe(true);
  expect(initialTree.nodes.some((node) =>
    node.role?.value === "textbox" && node.name?.value === "消息内容")).toBe(true);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
  const tree = await session.send("Accessibility.getFullAXTree") as typeof initialTree;
  const interactiveRoles = new Set([
    "button",
    "checkbox",
    "combobox",
    "link",
    "menuitem",
    "searchbox",
    "slider",
    "switch",
    "tab",
    "textbox",
  ]);
  const unnamed = tree.nodes.filter((node) =>
    !node.ignored
    && interactiveRoles.has(node.role?.value ?? "")
    && !(node.name?.value ?? "").trim());
  expect(unnamed).toEqual([]);
  expect(tree.nodes.some((node) =>
    node.role?.value === "dialog" && node.name?.value === "设置")).toBe(true);
  expect(tree.nodes.some((node) =>
    node.role?.value === "button" && node.name?.value?.includes("诊断与隐私"))).toBe(true);

  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
});
