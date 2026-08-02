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

test("forced colors preserve selection, focus, and custom switches", async ({ page }) => {
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
  expect(focusStyle.outlineStyle).not.toBe("none");
  expect(focusStyle.outlineWidth).not.toBe("0px");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /诊断与隐私/ }).click();
  const crashSwitch = page.getByRole("switch", { name: "保留脱敏崩溃报告" });
  await expect(crashSwitch).toBeVisible();
  await expect.poll(() => crashSwitch.evaluate(
    (element) => getComputedStyle(element).forcedColorAdjust,
  )).toBe("none");
  await expect(viewportOverflow(page)).resolves.toEqual([]);
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
