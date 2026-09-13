import { expect, test, type Locator, type Page } from "@playwright/test";

const openManager = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("button", { name: "工作", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑文件夹", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "聊天文件夹" });
  await expect(dialog.getByRole("checkbox", { name: "产品讨论", exact: true })).toBeChecked();
  await expect.poll(() => dialog.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  return dialog;
};
const titles = (dialog: Locator) => dialog.locator(".folder-chat-title").allTextContents();

test("folder filters combine search and type while preserving draft selections and confirmed membership", async ({ page }) => {
  const dialog = await openManager(page);
  const filter = dialog.getByRole("combobox", { name: "聊天类型" });
  const search = dialog.getByRole("searchbox", { name: "筛选会话" });
  const initial = await titles(dialog);
  await filter.selectOption("group");
  await expect(dialog.locator(".folder-chat-kind")).toHaveText(["群聊", "群聊", "群聊"]);
  await search.fill("  NOTGRAM ");
  await expect.poll(() => titles(dialog)).toEqual(["Notgram 论坛"]);
  await filter.selectOption("channel");
  await expect(dialog.getByText("没有匹配的会话", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "清除筛选" }).click();
  await expect(filter).toHaveValue("all");
  await expect(search).toHaveValue("");
  await expect.poll(() => titles(dialog)).toEqual(initial);

  await filter.selectOption("uncategorized");
  await expect(dialog.getByRole("checkbox", { name: "陈默", exact: true })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "旧项目同步", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("checkbox", { name: "产品讨论", exact: true })).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: "陈默", exact: true }).check();
  await expect(dialog.getByRole("checkbox", { name: "陈默", exact: true })).toBeChecked();
  await filter.selectOption("channel");
  await expect.poll(() => titles(dialog)).toEqual(["Release Notes"]);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
  await filter.selectOption("uncategorized");
  await expect(dialog.getByRole("checkbox", { name: "Mia Chen", exact: true })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "陈默", exact: true })).toHaveCount(0);
  await filter.selectOption("all");
  await expect(dialog.getByRole("checkbox", { name: "陈默", exact: true })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "产品讨论", exact: true })).toBeChecked();
  await search.fill("Release");
  await dialog.getByRole("button", { name: "新建文件夹", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(filter).toHaveValue("all");
  await expect(dialog.locator('input[type="checkbox"]:checked')).toHaveCount(0);
});

test("folder selection stays ordered and scrolled during live updates and identifies bots by peer data", async ({ page }) => {
  const dialog = await openManager(page);
  await page.evaluate(async (modulePath) => {
    const { telegramStore } = await import(modulePath) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const template = state.chats.get("chat-mia")!;
    const chats = new Map(state.chats);
    for (let index = 40; index > 0; index -= 1) {
      const id = `folder-stable-${index}`;
      chats.set(id, { ...template, id, title: `Room ${index}`, folderIds: ["main"], pinned: false });
    }
    chats.set("folder-bot", { ...template, id: "folder-bot", title: "Assistant", peerId: "u-notgram-bot" });
    telegramStore.setState({ chats });
  }, "/src/store/telegramStore.ts");
  await expect(dialog.getByRole("checkbox", { name: "Room 40", exact: true })).toHaveCount(1);
  const before = await titles(dialog);
  const checks = await dialog.getByRole("checkbox").evaluateAll((elements) => elements.map((node) => (node as HTMLInputElement).checked));
  expect(checks.slice(0, 3)).toEqual([true, true, true]);
  expect(checks.slice(3).every((checked) => !checked)).toBe(true);
  expect(before.indexOf("Room 2")).toBeLessThan(before.indexOf("Room 10"));
  const list = dialog.locator(".folder-chat-list");
  await list.evaluate((element) => { element.scrollTop = 400; });
  const scrollTop = await list.evaluate((element) => element.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  await page.evaluate(async (modulePath) => {
    const { telegramStore } = await import(modulePath) as typeof import("../../src/store/telegramStore");
    telegramStore.setState({ chats: new Map([...telegramStore.getState().chats].reverse().map(([id, chat], index) => [
      id, { ...chat, updatedAt: new Date(Date.now() + index * 1000).toISOString(),
        preview: "New incoming message", unreadCount: index + 1, listOrderByFolder: { main: String(index + 1) } },
    ])) });
  }, "/src/store/telegramStore.ts");
  await expect.poll(() => titles(dialog)).toEqual(before);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(scrollTop);
  await dialog.getByRole("combobox").selectOption("bot");
  await expect.poll(() => titles(dialog)).toEqual(["Assistant"]);
  await dialog.getByRole("checkbox", { name: "Assistant", exact: true }).check();
  await dialog.getByRole("combobox").selectOption("direct");
  await expect(dialog.getByRole("checkbox", { name: "Mia Chen", exact: true })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "Assistant", exact: true })).toHaveCount(0);
  await dialog.getByRole("combobox").selectOption("all");
  await expect(dialog.getByRole("checkbox", { name: "Assistant", exact: true })).toBeChecked();
  expect((await titles(dialog)).indexOf("Assistant")).toBeLessThan(4);
  expect(await dialog.getByRole("checkbox").evaluateAll((elements) => elements.map((node) => (node as HTMLInputElement).checked)))
    .toEqual([true, true, true, true, ...Array(44).fill(false)]);
});

for (const width of [790, 390]) {
  test(`folder controls and list fit the available space (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 650 });
    const dialog = await openManager(page);
    expect(await dialog.evaluate((element) => [...element.querySelectorAll("*")].some((child) => {
      const rect = child.getBoundingClientRect();
      return rect.width > 0 && (rect.left < 0 || rect.right > innerWidth);
    }))).toBe(false);
    const bounds = (await dialog.boundingBox())!;
    const list = (await dialog.locator(".folder-chat-list").boundingBox())!;
    const search = (await dialog.locator(".folder-chat-search").boundingBox())!;
    const filter = (await dialog.getByRole("combobox").boundingBox())!;
    const save = (await dialog.getByRole("button", { name: "保存", exact: true }).boundingBox())!;
    expect(list.height).toBeGreaterThan(240);
    expect(search.y).toBe(filter.y);
    expect(search.x + search.width).toBeLessThan(filter.x);
    expect(save.y + save.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    await dialog.getByRole("searchbox").focus();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("combobox")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}
