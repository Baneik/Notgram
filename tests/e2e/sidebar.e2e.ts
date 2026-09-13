import { expect, test } from "@playwright/test";
import { horizontalOverflow, openConversationMessageSearch } from "./helpers";

test("sidebar dragging and window resizing keep the responsive layout live", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("notgram.sidebar-width", "250"));
  await page.reload();
  await expect.poll(() => page.locator(".chat-sidebar").evaluate((element) =>
    Math.round(element.getBoundingClientRect().width),
  )).toBe(250);
  const resizer = page.getByRole("separator", { name: "调整会话列表宽度" });
  const before = await page.evaluate(() => ({
    stored: localStorage.getItem("notgram.sidebar-width"),
    width: getComputedStyle(document.documentElement).getPropertyValue("--chat-sidebar-width"),
  }));
  const bounds = await resizer.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + 80);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 42, bounds!.y + 80, { steps: 5 });
  await expect.poll(() => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--chat-sidebar-width"),
  )).not.toBe(before.width);
  expect(await page.evaluate(() => localStorage.getItem("notgram.sidebar-width")))
    .toBe(before.stored);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("notgram.sidebar-width")))
    .not.toBe(before.stored);

  for (const viewport of [
    { width: 940, height: 680 },
    { width: 780, height: 620 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.locator(".conversation")).toBeVisible();
    await expect(page.locator(".message-list-content .message-row").first()).toBeVisible();
    const layout = await page.locator(".app-shell").evaluate((shell) => ({
      width: shell.getBoundingClientRect().width,
      scrollWidth: shell.scrollWidth,
    }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
  }
});

test("chat list hides its scrollbar and the conversation title has no hover highlight", async ({ page }) => {
  await page.goto("/");
  const chatList = page.locator(".chat-list[data-active=true]");
  await expect(chatList).toHaveCSS("scrollbar-width", "none");

  const title = page.locator(".conversation-profile-trigger");
  const backgroundBeforeHover = await title.evaluate((element) => getComputedStyle(element).backgroundColor);
  await title.hover();
  await expect(title).toHaveCSS("background-color", backgroundBeforeHover);
});

test("chat pagination indicator does not change the bottom scroll geometry", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 420 });
  await page.goto("/");
  const chatList = page.locator(".chat-list[data-active=true]");
  await expect.poll(() => chatList.evaluate((element) =>
    element.scrollHeight - element.clientHeight
  )).toBeGreaterThan(100);
  await expect(page.locator(".chat-list-loading")).toHaveCount(0);

  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          chatLists: Map<string, { loading: boolean; hasMore: boolean }>;
        };
        setState: (patch: {
          chatLists?: Map<string, { loading: boolean; hasMore: boolean }>;
          loadMoreChats?: (chatListId?: string) => Promise<void>;
        }) => void;
      };
    };
    const setChatListState = (loading: boolean, hasMore: boolean) => {
      const chatLists = new Map(module.telegramStore.getState().chatLists);
      chatLists.set("main", { loading, hasMore });
      module.telegramStore.setState({ chatLists });
    };
    module.telegramStore.setState({
      loadMoreChats: async () => {
        setChatListState(true, true);
        await new Promise((resolve) => globalThis.setTimeout(resolve, 180));
        setChatListState(false, false);
      },
    });
    setChatListState(false, true);
  }, "/src/store/telegramStore.ts");

  await chatList.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const loading = page.locator(".chat-list-loading");
  await expect(loading).toBeVisible();
  await chatList.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
  });
  const during = await chatList.evaluate((element) => {
    const lastRow = element.querySelector<HTMLElement>(".chat-list[data-active=true] .chat-row:last-of-type");
    return {
      rowTop: lastRow?.getBoundingClientRect().top,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  });

  await expect(loading).toHaveCount(0);
  await expect.poll(() => chatList.evaluate((element) => element.scrollHeight))
    .toBe(during.scrollHeight);
  await expect.poll(() => chatList.evaluate((element) => element.scrollTop))
    .toBeCloseTo(during.scrollTop, 1);
  await expect.poll(() => chatList.locator(".chat-row").last().evaluate((element) =>
    element.getBoundingClientRect().top
  )).toBeCloseTo(during.rowTop ?? 0, 1);
});

test("scrolled chat list stays visually stable during refreshes and context menus", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 420 });
  await page.goto("/");
  const chatList = page.locator(".chat-list[data-active=true]");
  await expect.poll(() => chatList.evaluate((element) =>
    element.scrollHeight - element.clientHeight
  )).toBeGreaterThan(100);
  await chatList.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(page.locator(".chat-list-loading")).toHaveCount(0);
  await chatList.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
  });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  const anchor = await chatList.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>(".chat-list[data-active=true] .chat-row[data-chat-id]")]
      .find((candidate) => {
        const rowBounds = candidate.getBoundingClientRect();
        return rowBounds.top >= bounds.top && rowBounds.bottom <= bounds.bottom;
      });
    return {
      id: row?.dataset.chatId,
      top: row?.getBoundingClientRect().top,
      scrollTop: element.scrollTop,
    };
  });
  expect(anchor.id).toBeTruthy();

  await page.evaluate(() => {
    const diagnosticWindow = window as typeof window & { __notgramChatRowMotion?: string[] };
    const originalAnimate = Element.prototype.animate;
    diagnosticWindow.__notgramChatRowMotion = [];
    Element.prototype.animate = function (keyframes, options) {
      if (this instanceof HTMLElement && this.matches(".chat-list[data-active=true] .chat-row[data-motion-key]")) {
        const frames = Array.isArray(keyframes) ? keyframes : [];
        diagnosticWindow.__notgramChatRowMotion?.push(String(frames[0]?.transform ?? ""));
      }
      return originalAnimate.call(this, keyframes, options);
    };
  });

  const anchorRow = page.locator(`.chat-list[data-active=true] .chat-row[data-chat-id="${anchor.id}"]`);
  await anchorRow.click({ button: "right" });
  await expect(page.locator(".context-menu-surface")).toBeVisible();
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { chats: Map<string, unknown> };
        setState: (patch: { chats: Map<string, unknown> }) => void;
      };
    };
    module.telegramStore.setState({ chats: new Map(module.telegramStore.getState().chats) });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }, "/src/store/telegramStore.ts");

  expect(await page.evaluate(() => (
    window as typeof window & { __notgramChatRowMotion?: string[] }
  ).__notgramChatRowMotion)).toEqual([]);
  await expect.poll(() => chatList.evaluate((element) => element.scrollTop))
    .toBeCloseTo(anchor.scrollTop, 1);
  await expect.poll(() => anchorRow.evaluate((element) => element.getBoundingClientRect().top))
    .toBeCloseTo(anchor.top ?? 0, 1);

  await page.keyboard.press("Escape");
  await expect(page.locator(".context-menu-surface")).toBeHidden();
  await expect.poll(() => chatList.evaluate((element) => element.scrollTop))
    .toBeCloseTo(anchor.scrollTop, 1);
});

test("muted chats use a neutral unread badge", async ({ page }) => {
  await page.goto("/");
  const mutedRow = page.getByRole("button", { name: /Release Notes/ });
  const regularRow = page.getByRole("button", { name: /Mia Chen/ });
  const mutedBadge = mutedRow.locator(".unread-count");
  const regularBadge = regularRow.locator(".unread-count");

  await expect(mutedBadge).toHaveClass(/is-muted/);
  await expect(mutedBadge).toHaveCSS("background-color", "rgb(154, 167, 171)");
  await expect(regularBadge).not.toHaveCSS("background-color", "rgb(154, 167, 171)");
  await expect(page.locator(".chat-list[data-active=true] .chat-row .lucide-volume-x")).toHaveCount(0);
});

test("mention and reply unread counts use theme-specific attention colors", async ({ page }) => {
  await page.goto("/");
  const badge = page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"] .unread-count');

  await expect(badge).toHaveText("4");
  await expect(badge).toHaveClass(/has-attention/);
  await expect(badge).toHaveAttribute("aria-label", "4 条未读消息，其中包含提及或回复");
  await expect(badge).toHaveCSS("background-color", "rgb(190, 98, 88)");
  await expect(badge).toHaveCSS("color", "rgb(255, 255, 255)");

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "notgram-dark";
    document.documentElement.style.colorScheme = "dark";
  });
  await expect(badge).toHaveCSS("background-color", "rgb(242, 184, 75)");
  await expect(badge).toHaveCSS("color", "rgb(35, 23, 0)");
});

test("pinned chats keep their per-folder order through dragging, folder switches, and restart", { tag: "@smoke" }, async ({ page }) => {
  await page.goto("/");
  const product = page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]');
  const mia = page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]');

  const source = await product.boundingBox();
  const target = await mia.boundingBox();
  expect(source).toBeTruthy();
  expect(target).toBeTruthy();
  await page.mouse.move(source!.x + 30, source!.y + source!.height / 2);
  await page.mouse.down();
  await page.mouse.move(source!.x + 30, source!.y + source!.height / 2 + 12, { steps: 3 });
  await expect(product).toHaveClass(/is-dragging/);
  await page.mouse.move(target!.x + 30, target!.y + target!.height - 5, { steps: 8 });
  await expect(mia).toHaveClass(/drop-after/);
  await page.mouse.up();

  await expect(page.locator(".chat-list[data-active=true] .chat-row").first()).toContainText("Mia Chen");
  await expect(page.locator(".chat-list[data-active=true] .chat-row").nth(1)).toContainText("产品讨论");
  for (let index = 0; index < 5; index += 1) {
    await page.locator('.rail-actions [data-folder-id="folder:work"]').click();
    await expect(page.locator(".chat-list[data-active=true] .chat-row").first()).toHaveAttribute("data-chat-id", "chat-product");
    await expect(product).toHaveAttribute("data-pinned", "true");
    await page.locator('.rail-actions [data-folder-id="main"]').click();
    await expect(page.locator(".chat-list[data-active=true] .chat-row").first()).toHaveAttribute("data-chat-id", "chat-mia");
    await expect(product).toHaveAttribute("data-pinned", "true");
    await expect(mia).toHaveAttribute("data-pinned", "true");
  }
  await page.reload();
  await expect(page.locator(".chat-list[data-active=true] .chat-row").first()).toHaveAttribute("data-chat-id", "chat-mia");
  await expect(page.locator(".chat-list[data-active=true] .chat-row").nth(1)).toHaveAttribute("data-chat-id", "chat-product");
  await expect(product).toHaveAttribute("data-pinned", "true");
  await expect(mia).toHaveAttribute("data-pinned", "true");
  await page.locator('.rail-actions [data-folder-id="folder:work"]').click();
  await expect(page.locator(".chat-list[data-active=true] .chat-row").first()).toHaveAttribute("data-chat-id", "chat-product");
  await expect(product).toHaveAttribute("data-pinned", "true");
});

test("chat organization menu confirms pin, mute, and archive changes", async ({ page }) => {
  await page.goto("/");
  const moreButton = page.getByRole("button", { name: "更多操作" });
  const productRow = page.locator('.chat-list[data-active=true] .chat-row[data-chat-id="chat-product"]');

  await moreButton.click();
  const menu = page.getByRole("menu", { name: "会话操作" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "取消置顶" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(moreButton).toBeFocused();

  await moreButton.click();
  await openConversationMessageSearch(page);
  await expect(menu).toBeHidden();
  await page.getByRole("button", { name: "移除会话搜索范围" }).click();

  await moreButton.click();
  await expect(menu.getByRole("menuitem", { name: "取消置顶" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(productRow).toHaveAttribute("data-pinned", "false");

  await moreButton.click();
  await menu.getByRole("menuitem", { name: "置顶会话" }).click();
  await expect(productRow).toHaveAttribute("data-pinned", "true");

  await moreButton.click();
  await menu.getByRole("menuitem", { name: "静音通知" }).click();
  await expect(productRow).toHaveClass(/is-muted/);

  await moreButton.click();
  await expect(menu.getByRole("menuitem", { name: "取消静音" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "归档会话" }).click();
  await expect(productRow).toHaveCount(0);
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");

  await moreButton.click();
  await menu.getByRole("menuitem", { name: "移出归档" }).click();
  await expect(productRow).toHaveCount(1);

  await page.setViewportSize({ width: 390, height: 700 });
  await productRow.click();
  await moreButton.click();
  await expect(menu).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
});

test("chat context menu manages folders, pinning, and group exit", async ({ page }) => {
  await page.goto("/");
  const miaRow = page.locator('.chat-list[data-active=true] .chat-row[data-chat-id="chat-mia"]');

  await miaRow.click({ button: "right" });
  let menu = page.getByRole("menu", { name: "会话操作：Mia Chen" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").nth(0)).toHaveText("取消置顶");
  await expect(menu.getByRole("menuitem").nth(1)).toHaveText("分组");
  await expect(menu.getByRole("menuitem", { name: "退出群组" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "分组" }).click();
  await page.getByRole("menuitemcheckbox", { name: "添加到工作" }).click();

  await page.getByRole("button", { name: "工作", exact: true }).click();
  await expect(miaRow).toBeVisible();
  await miaRow.click({ button: "right" });
  menu = page.getByRole("menu", { name: "会话操作：Mia Chen" });
  await menu.getByRole("menuitem", { name: "分组" }).click();
  await page.getByRole("menuitemcheckbox", { name: "从工作" }).click();
  await expect(miaRow).toHaveCount(0);

  await page.getByRole("button", { name: "全部聊天", exact: true }).click();
  await miaRow.click({ button: "right" });
  await page.getByRole("menu", { name: "会话操作：Mia Chen" })
    .getByRole("menuitem", { name: "取消置顶", exact: true }).click();
  await expect(miaRow).toHaveAttribute("data-pinned", "false");
  await miaRow.click({ button: "right" });
  await page.getByRole("menu", { name: "会话操作：Mia Chen" })
    .getByRole("menuitem", { name: "置顶", exact: true }).click();
  await expect(miaRow).toHaveAttribute("data-pinned", "true");

  const productRow = page.locator('.chat-list[data-active=true] .chat-row[data-chat-id="chat-product"]');
  await productRow.click({ button: "right" });
  await page.getByRole("menu", { name: "会话操作：产品讨论" })
    .getByRole("menuitem", { name: "退出群组" }).click();
  const confirm = page.getByRole("dialog", { name: "退出“产品讨论”？" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "退出群组" }).click();
  await expect(productRow).toHaveCount(0);
  await expect(page.locator(".conversation-title strong")).not.toHaveText("产品讨论");
});

test("sidebar context menus close when content outside them scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 420 });
  await page.goto("/");
  await page.addStyleTag({
    content: ".chat-list[data-active=true] .chat-row { min-height: 92px; }",
  });

  const chatList = page.locator(".chat-list[data-active=true]");
  const scrollChatList = async () => {
    const metrics = await chatList.evaluate((element) => ({
      before: element.scrollTop,
      maximum: element.scrollHeight - element.clientHeight,
      height: element.clientHeight,
    }));
    expect(metrics.maximum).toBeGreaterThan(0);
    await chatList.hover({ position: { x: 20, y: metrics.height - 10 } });
    await page.mouse.wheel(0, metrics.before < metrics.maximum ? 80 : -80);
    await expect.poll(() => chatList.evaluate((element) => element.scrollTop))
      .not.toBe(metrics.before);
  };

  const productRow = page.locator('.chat-list[data-active=true] .chat-row[data-chat-id="chat-product"]');
  await productRow.scrollIntoViewIfNeeded();
  await productRow.click({ button: "right" });
  let menu = page.locator(".context-menu-surface");
  await expect(menu).toBeVisible();
  await scrollChatList();
  await expect(menu).toBeHidden();

  const workFolder = page.getByRole("button", { name: "工作", exact: true });
  await workFolder.click({ button: "right" });
  menu = page.locator(".context-menu-surface");
  await expect(menu).toBeVisible();
  await scrollChatList();
  await expect(menu).toBeHidden();

  await productRow.scrollIntoViewIfNeeded();
  await productRow.click({ button: "right" });
  menu = page.locator(".context-menu-surface");
  await menu.getByRole("menuitem", { name: "分组" }).click();
  const submenu = menu.locator(".chat-folder-submenu");
  await expect(submenu).toBeVisible();
  await expect(submenu).toHaveCSS("overflow-y", "hidden");
  expect(await submenu.evaluate((element) => element.scrollHeight <= element.clientHeight + 1))
    .toBe(true);
  await expect(menu).toBeVisible();

  await scrollChatList();
  await expect(menu).toBeHidden();
});

test("folder context menu edits, marks read, and deletes a custom folder", async ({ page }) => {
  await page.goto("/");
  const workButton = page.getByRole("button", { name: "工作", exact: true });
  await workButton.click();
  await expect(page.locator('.chat-list[data-active=true] .chat-row[data-chat-id="chat-release"] .unread-count')).toHaveText("8");

  await workButton.click({ button: "right" });
  let menu = page.getByRole("menu", { name: "分组操作：工作" });
  await expect(menu.getByRole("menuitem", { name: "编辑文件夹" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "标记为已读" }).click();
  await expect(page.locator(".chat-list[data-active=true] .unread-count")).toHaveCount(0);

  await workButton.click({ button: "right" });
  menu = page.getByRole("menu", { name: "分组操作：工作" });
  await menu.getByRole("menuitem", { name: "编辑文件夹" }).click();
  const manager = page.getByRole("dialog", { name: "聊天文件夹" });
  await expect(manager.getByLabel("名称")).toHaveValue("工作");
  await manager.getByRole("button", { name: "关闭" }).click();

  await workButton.click({ button: "right" });
  await page.getByRole("menu", { name: "分组操作：工作" })
    .getByRole("menuitem", { name: "删除" }).click();
  const confirm = page.getByRole("dialog", { name: "删除“工作”？" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "删除", exact: true }).click();
  await expect(workButton).toHaveCount(0);
});

test("folder buttons reorder by direct drag and stay fixed during chat organization", async ({ page }) => {
  await page.goto("/");
  const folderButtons = page.locator(".rail-button[data-folder-id]");
  const mainButton = page.getByRole("button", { name: "全部聊天", exact: true });
  const workButton = page.getByRole("button", { name: "工作", exact: true });
  const mainBounds = await mainButton.boundingBox();
  const workBounds = await workButton.boundingBox();
  expect(mainBounds).not.toBeNull();
  expect(workBounds).not.toBeNull();

  await page.mouse.move(
    (workBounds?.x ?? 0) + (workBounds?.width ?? 0) / 2,
    (workBounds?.y ?? 0) + (workBounds?.height ?? 0) / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    (mainBounds?.x ?? 0) + (mainBounds?.width ?? 0) / 2,
    (mainBounds?.y ?? 0) + 4,
    { steps: 8 },
  );
  await page.mouse.up();

  const reorderedNames = ["工作", "全部聊天"];
  await expect.poll(() => folderButtons.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label"))
  )).toEqual(reorderedNames);

  await mainButton.click();
  const miaRow = page.locator('.chat-list[data-active=true] .chat-row[data-chat-id="chat-mia"]');
  await miaRow.click({ button: "right" });
  await page.getByRole("menu", { name: "会话操作：Mia Chen" })
    .getByRole("menuitem", { name: "分组" }).click();
  await page.getByRole("menuitemcheckbox", { name: "添加到工作" }).click();
  await miaRow.click({ button: "right" });
  await page.getByRole("menu", { name: "会话操作：Mia Chen" })
    .getByRole("menuitem", { name: "取消置顶", exact: true }).click();

  await expect.poll(() => folderButtons.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label"))
  )).toEqual(reorderedNames);

  await page.setViewportSize({ width: 390, height: 700 });
  const mobileMainBounds = await mainButton.boundingBox();
  const mobileWorkBounds = await workButton.boundingBox();
  expect(mobileMainBounds).not.toBeNull();
  expect(mobileWorkBounds).not.toBeNull();
  await page.mouse.move(
    (mobileMainBounds?.x ?? 0) + (mobileMainBounds?.width ?? 0) / 2,
    (mobileMainBounds?.y ?? 0) + (mobileMainBounds?.height ?? 0) / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    (mobileWorkBounds?.x ?? 0) + 4,
    (mobileWorkBounds?.y ?? 0) + (mobileWorkBounds?.height ?? 0) / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect.poll(() => folderButtons.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label"))
  )).toEqual(["全部聊天", "工作"]);
  expect(await horizontalOverflow(page)).toBe(false);
});

test("conversation list keeps an independent scroll position for each folder", async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 520 });
  await page.goto("/");
  await page.addStyleTag({
    content: ".chat-list { height: 120px !important; min-height: 120px !important; max-height: 120px !important; }",
  });
  const chatList = page.locator(".chat-list[data-active=true]");
  await chatList.evaluate((element) => {
    const list = element as HTMLElement;
    list.scrollTop = 30;
    list.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const mainScrollTop = await chatList.evaluate((element) => element.scrollTop);
  expect(mainScrollTop).toBeGreaterThan(0);
  await page.evaluate(() => {
    const diagnosticWindow = window as typeof window & { __notgramFolderSwitchMotion?: string[] };
    const originalAnimate = Element.prototype.animate;
    diagnosticWindow.__notgramFolderSwitchMotion = [];
    Element.prototype.animate = function (keyframes, options) {
      if (this instanceof HTMLElement && this.matches(".chat-list[data-active=true] .chat-row[data-motion-key]")) {
        const frames = Array.isArray(keyframes) ? keyframes : [];
        diagnosticWindow.__notgramFolderSwitchMotion?.push(String(frames[0]?.transform ?? ""));
      }
      return originalAnimate.call(this, keyframes, options);
    };
  });

  await page.getByRole("button", { name: "工作", exact: true }).click();
  await expect(chatList).toBeVisible();
  await expect(chatList.locator(".chat-row")).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __notgramFolderSwitchMotion?: string[] }
  ).__notgramFolderSwitchMotion)).toEqual([]);
  await chatList.evaluate((element) => {
    const list = element as HTMLElement;
    list.scrollTop = 18;
    list.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const workScrollTop = await chatList.evaluate((element) => element.scrollTop);
  expect(workScrollTop).toBeGreaterThan(0);
  expect(workScrollTop).not.toBe(mainScrollTop);

  await page.getByRole("button", { name: "全部聊天", exact: true }).click();
  await expect.poll(() => chatList.evaluate((element) => element.scrollTop)).toBe(mainScrollTop);
  await page.getByRole("button", { name: "工作", exact: true }).click();
  await expect.poll(() => chatList.evaluate((element) => element.scrollTop)).toBe(workScrollTop);
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __notgramFolderSwitchMotion?: string[] }
  ).__notgramFolderSwitchMotion)).toEqual([]);
});

test("folder manager creates, edits, and deletes confirmed server folders", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "工作", exact: true }).click({ button: "right" });
  await page.getByRole("menu", { name: "分组操作：工作" })
    .getByRole("menuitem", { name: "编辑文件夹" }).click();
  const dialog = page.getByRole("dialog", { name: "聊天文件夹" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "关闭" })).toBeFocused();

  await dialog.getByRole("button", { name: "新建文件夹" }).click();
  await dialog.getByLabel("名称").fill("客户");
  await dialog.getByRole("checkbox", { name: "Mia Chen" }).check();
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByRole("button", { name: "客户", exact: true })).toBeVisible();

  await dialog.getByLabel("名称").fill("客户团队");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByRole("button", { name: "客户团队", exact: true })).toBeVisible();

  await dialog.getByRole("checkbox", { name: "产品讨论" }).check();
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByRole("checkbox", { name: "产品讨论" })).toBeChecked();

  await page.setViewportSize({ width: 390, height: 700 });
  expect(await horizontalOverflow(page)).toBe(false);

  await dialog.getByRole("button", { name: "删除文件夹" }).click();
  await dialog.getByRole("button", { name: "删除文件夹" }).click();
  await expect(dialog.getByRole("button", { name: "客户团队", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(page.getByRole("button", { name: "客户团队", exact: true })).toHaveCount(0);
});
