import { expect, test } from "@playwright/test";

test("native context menu rows fill a consistently rounded popup frame", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "notgram-dark";
    const createPanel = (className: string, label: string) => {
      const panel = document.createElement("div");
      panel.className = `${className} context-menu-panel`;
      for (let index = 0; index < 5; index += 1) {
        const group = document.createElement("div");
        group.className = "native-context-menu-group";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${label}-${index}`;
        group.append(button);
        panel.append(group);
      }
      return panel;
    };
    const collapsedStage = document.createElement("div");
    collapsedStage.className = "native-context-menu-stage";
    collapsedStage.dataset.nativeMenuFixture = "collapsed";
    collapsedStage.style.cssText = "position:fixed;left:0;top:0;width:170px;height:236px;z-index:9999;--native-context-primary-width:146px";
    collapsedStage.append(createPanel("native-context-menu", "action"));
    document.body.append(collapsedStage);

    const expandedStage = document.createElement("div");
    expandedStage.className = "native-context-menu-stage";
    expandedStage.dataset.nativeMenuFixture = "expanded";
    expandedStage.style.cssText = "position:fixed;left:180px;top:0;width:308px;height:236px;z-index:9999;--native-context-primary-width:146px;--native-context-submenu-width:132px;--native-context-submenu-x:164px;--native-context-submenu-y:0px";
    expandedStage.append(createPanel("native-context-menu", "primary"));
    expandedStage.append(createPanel("native-context-menu-children", "child"));
    document.body.append(expandedStage);
  });

  const collapsedStage = page.locator('[data-native-menu-fixture="collapsed"]');
  const panel = collapsedStage.locator(".native-context-menu");
  const buttons = panel.locator("button");
  const metrics = await panel.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    const stageBounds = element.parentElement!.getBoundingClientRect();
    const rows = [...element.querySelectorAll("button")].map((button) =>
      button.getBoundingClientRect());
    return {
      animationDuration: style.animationDuration,
      borderRadius: style.borderRadius,
      gap: style.rowGap,
      overflow: style.overflow,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      firstInset: rows[0].top - bounds.top,
      lastInset: bounds.bottom - rows.at(-1)!.bottom,
      rowGaps: rows.slice(1).map((row, index) => row.top - rows[index].bottom),
      rightGutter: stageBounds.right - bounds.right,
      width: bounds.width,
      shadow: style.boxShadow,
    };
  });
  const expandedRightGutter = await page
    .locator('[data-native-menu-fixture="expanded"] .native-context-menu-children')
    .evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return element.parentElement!.getBoundingClientRect().right - bounds.right;
    });

  await expect(buttons).toHaveCount(5);
  expect(metrics.animationDuration).toBe("0.06s");
  expect(metrics.padding).toEqual(["0px", "0px", "0px", "0px"]);
  expect(metrics.gap).toBe("0px");
  expect(metrics.overflow).toBe("hidden");
  expect(metrics.borderRadius).toBe("8px");
  expect(metrics.firstInset).toBeCloseTo(1, 1);
  expect(metrics.lastInset).toBeCloseTo(1, 1);
  expect(metrics.rowGaps.every((gap) => Math.abs(gap) < 0.1)).toBe(true);
  expect(metrics.rightGutter).toBe(12);
  expect(metrics.width).toBe(146);
  expect(expandedRightGutter).toBe(12);
  expect(metrics.shadow).toContain("2px 6px");
});

test("native context menu entry reuses its mounted surface across sessions", async ({ page }) => {
  await page.goto("/windows/context-menu-window.html");
  const postMenu = (id: string, label: string) => page.evaluate(async ({ id, label }) => {
    const channel = new BroadcastChannel("notgram-context-menu-v2");
    channel.postMessage({
      type: "init",
      id,
      descriptor: {
        label: "复用菜单",
        colorTheme: "light",
        items: [{ id: "copy", label, icon: "copy" }],
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    channel.close();
  }, { id, label });

  await postMenu("firstsession", "第一次");
  const menu = page.getByRole("menu", { name: "复用菜单" });
  await expect(menu.getByRole("menuitem", { name: "第一次" })).toBeVisible();
  const mountedSurface = await menu.elementHandle();
  expect(mountedSurface).not.toBeNull();

  await postMenu("secondsession", "第二次");
  await expect(menu.getByRole("menuitem", { name: "第二次" })).toBeVisible();
  expect(await mountedSurface!.evaluate((element) =>
    element === document.querySelector(".native-context-menu")))
    .toBe(true);
});

test("native context menu does not paint initial focus as a permanent hover", async ({ page }) => {
  await page.goto("/windows/context-menu-window.html");
  await page.evaluate(async () => {
    const channel = new BroadcastChannel("notgram-context-menu-v2");
    channel.postMessage({
      type: "init",
      id: "focus-session",
      descriptor: {
        label: "焦点菜单",
        colorTheme: "light",
        items: [
          { id: "reply", label: "回复", icon: "reply" },
          { id: "copy", label: "复制", icon: "copy" },
        ],
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    channel.close();
  });

  const stage = page.locator(".native-context-menu-stage");
  const items = page.getByRole("menu", { name: "焦点菜单" }).getByRole("menuitem");
  await page.keyboard.press("Tab");
  await items.first().focus();
  await expect(items.first()).toBeFocused();
  await expect(stage).not.toHaveAttribute("data-keyboard-navigation", "true");
  await expect(items.first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await expect(stage).toHaveAttribute("data-keyboard-navigation", "true");
  await expect(items.nth(1)).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  await items.first().hover();
  await expect(stage).not.toHaveAttribute("data-keyboard-navigation", "true");
  await expect(items.nth(1)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(items.first()).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("native context menu entry renders account avatars and the trailing add action", async ({ page }) => {
  await page.goto("/windows/context-menu-window.html");
  await page.evaluate(async () => {
    const channel = new BroadcastChannel("notgram-context-menu-v2");
    channel.postMessage({
      type: "init",
      id: "accountsession",
      descriptor: {
        label: "切换账号",
        colorTheme: "light",
        items: [
          {
            id: "account:default",
            label: "林然",
            icon: "check",
            avatar: { label: "林", color: "#d16f45" },
            checked: true,
          },
          {
            id: "add-account",
            label: "添加新账号",
            icon: "user-plus",
            separatorBefore: true,
          },
        ],
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    channel.close();
  });

  const menu = page.getByRole("menu", { name: "切换账号" });
  const account = menu.getByRole("menuitem", { name: "林然" });
  await expect(account.locator(".native-account-menu-avatar")).toContainText("林");
  await expect(account.locator(".account-switcher-check")).toBeVisible();
  const add = menu.getByRole("menuitem", { name: "添加新账号" });
  await expect(add).toHaveClass(/has-separator/);
  await expect(add.locator("svg")).toBeVisible();
  await expect(menu.getByRole("menuitem").last()).toHaveText("添加新账号");
});

test("native forwarding submenu shows avatars and scrolls after five visible rows", async ({ page }) => {
  await page.goto("/windows/context-menu-window.html");
  await page.evaluate(async () => {
    const channel = new BroadcastChannel("notgram-context-menu-v2");
    channel.postMessage({
      type: "init",
      id: "forward-session",
      descriptor: {
        label: "消息操作",
        colorTheme: "light",
        items: [{
          id: "forward",
          label: "转发",
          icon: "forward",
          children: Array.from({ length: 10 }, (_, index) => ({
            id: `target-${index}`,
            label: `群组${index + 1}`,
            icon: "message",
            avatar: { label: String(index + 1), color: "#397a78" },
          })),
        }],
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    channel.close();
  });

  const menu = page.getByRole("menu", { name: "消息操作" });
  await expect(menu.getByRole("menuitem", { name: "转发", exact: true }).locator(".lucide-chevron-right"))
    .toBeVisible();
  await menu.getByRole("menuitem", { name: "转发", exact: true }).click();
  const submenu = page.getByRole("menu", { name: "转发" });
  await expect(submenu.getByRole("menuitemcheckbox")).toHaveCount(10);
  await expect(submenu.getByRole("menuitemcheckbox").first().locator(".native-context-menu-child-avatar"))
    .toContainText("1");
  expect(await submenu.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      overflowY: style.overflowY,
      scrollbarWidth: style.scrollbarWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    };
  })).toMatchObject({ overflowY: "auto", scrollbarWidth: "none" });
  expect(await submenu.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
});

test("nested context menus keep the primary anchor stable and leave transparent areas clickable", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 420 });
  await page.goto("/");
  await page.addStyleTag({
    content: ".chat-folder-submenu { height: min(360px, calc(100vh - 16px)); }",
  });

  const releaseRow = page.locator('.chat-list[data-active=true] .chat-row[data-chat-id="chat-release"]');
  await releaseRow.scrollIntoViewIfNeeded();
  const releaseBounds = await releaseRow.boundingBox();
  expect(releaseBounds).not.toBeNull();
  await releaseRow.click({
    button: "right",
    position: {
      x: Math.min(340, (releaseBounds?.width ?? 360) - 12),
      y: (releaseBounds?.height ?? 74) - 8,
    },
  });

  let menu = page.getByRole("menu", { name: "会话操作：Release Notes" });
  let primary = menu.locator("[data-context-menu-primary]");
  const before = await primary.boundingBox();
  expect(before).not.toBeNull();
  await menu.getByRole("menuitem", { name: "分组" }).click();
  const submenu = page.getByRole("menu", { name: "选择分组" });
  await expect(submenu).toBeVisible();
  await expect(submenu).toHaveCSS("overflow-y", "hidden");
  const after = await primary.boundingBox();
  const submenuBounds = await submenu.boundingBox();
  expect(after).not.toBeNull();
  expect(submenuBounds).not.toBeNull();
  expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(1);
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(1);
  expect((submenuBounds?.y ?? -1)).toBeGreaterThanOrEqual(8);
  expect((submenuBounds?.y ?? 0) + (submenuBounds?.height ?? 0)).toBeLessThanOrEqual(412);
  await expect(menu).toHaveAttribute("data-context-submenu-side", "left");

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await page.addStyleTag({
    content: ".chat-folder-submenu { height: 360px; }",
  });
  const productRow = page.locator('.chat-list[data-active=true] .chat-row[data-chat-id="chat-product"]');
  await productRow.click({ button: "right", position: { x: 50, y: 24 } });
  menu = page.getByRole("menu", { name: "会话操作：产品讨论" });
  await menu.getByRole("menuitem", { name: "分组" }).click();
  await expect(page.getByRole("menu", { name: "选择分组" })).toBeVisible();
  await expect(menu).toHaveAttribute("data-context-submenu-side", "right");

  const chenName = page.locator('.chat-list[data-active=true] .chat-row[data-chat-id="chat-chen"] strong');
  await chenName.click({ timeout: 1_000 });
  await expect(page.locator(".conversation-title strong")).toHaveText("陈默", { timeout: 1_000 });
  await expect(menu).toBeHidden();
});
