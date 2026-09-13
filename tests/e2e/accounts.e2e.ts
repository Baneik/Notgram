import { expect, test } from "@playwright/test";
import { horizontalOverflow } from "./helpers";

test("authorization defaults to QR login and exposes proxy-only settings", { tag: "@smoke" }, async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 780 });
  await page.goto("/?auth=1&connection=syncing");

  await expect(page.locator(".auth-brand img")).toBeVisible();
  await expect(page.locator(".auth-brand")).toContainText("Notgram");
  await expect(page.getByLabel("Telegram 登录二维码")).toBeVisible();
  await expect(page.getByRole("heading", { name: "使用二维码登录" })).toBeVisible();
  await expect(page.getByText(/\d{2}:\d{2} 后失效/)).toBeVisible();
  await expect(page.getByText("正在同步消息", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "使用手机号登录" })).toBeVisible();
  await expect(horizontalOverflow(page)).resolves.toBe(false);

  const settingsButton = page.getByRole("button", { name: "设置" });
  const settingsBounds = await settingsButton.boundingBox();
  expect(settingsBounds).not.toBeNull();
  expect(settingsBounds?.x).toBeGreaterThan(920);
  expect(settingsBounds?.y).toBeGreaterThan(700);
  await settingsButton.click();

  const settings = page.getByRole("dialog", { name: "登录设置" });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("radio")).toHaveCount(3);
  await expect(settings.locator(".settings-category")).toHaveCount(0);
  await expect(settings.getByText("存储路径", { exact: true })).toHaveCount(0);
  await settings.getByRole("button", { name: "关闭" }).click();
  await expect(page.locator(".login-settings-dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "使用手机号登录" }).click();
  await expect(page.getByRole("heading", { name: "手机号登录" })).toBeVisible();
  const country = page.getByRole("combobox", { name: "国家或地区" });
  await expect(country).toHaveValue("中国");
  await expect(page.locator(".auth-country-code")).toHaveText("+86");
  await country.fill("+81");
  const japan = page.getByRole("option", { name: /日本 JP \+81/ });
  await expect(japan).toBeVisible();
  await japan.click();
  await expect(country).toHaveValue("日本");
  await page.getByLabel("号码").fill("90 1234 5678");
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.getByRole("heading", { name: "输入验证码" })).toBeVisible();
  await expect(page.getByText("+819012345678", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?auth=1");
  await page.getByRole("button", { name: "使用手机号登录" }).click();
  await expect(page.getByRole("combobox", { name: "国家或地区" })).toBeVisible();
  await expect(horizontalOverflow(page)).resolves.toBe(false);
});

test("the navigation rail separates account switching from the bottom settings entry", { tag: "@smoke" }, async ({ page }) => {
  await page.goto("/");

  const accountButton = page.locator(".rail-account");
  const settingsButton = page.getByRole("button", { name: "设置", exact: true });
  await expect(accountButton).toHaveRole("button");
  await expect(accountButton).toHaveAccessibleName("切换账号");
  await expect(accountButton).toContainText("林然");
  await expect(accountButton.locator(".avatar")).toBeVisible();
  await expect(page.getByRole("button", { name: "联系人", exact: true })).toHaveCount(0);
  await expect(page.locator(".contacts-view")).toHaveCount(0);
  await expect(page.locator(".rail-footer")).toBeVisible();
  expect((await settingsButton.boundingBox())!.y).toBeGreaterThan((await accountButton.boundingBox())!.y);
  await expect(page.locator(".rail-brand")).toHaveCount(0);
  await expect(page.locator(".window-chrome")).toBeVisible();
  await expect(page.locator(".window-chrome")).not.toContainText("Notgram");
  await expect(page.locator(".window-controls > button")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "最小化窗口" })).toBeVisible();
  await expect(page.getByRole("button", { name: "最大化窗口" })).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭窗口" })).toBeVisible();
  await expect(page.locator(".rail-settings")).toHaveCount(1);
  await expect(page.locator(".rail-connection")).toHaveCount(0);
  await expect(page.locator(".sidebar-heading .connection-status")).toHaveCount(0);
  const conversationStatus = page.locator(".conversation-title > .conversation-header-status");
  await expect(conversationStatus).toHaveCount(1);
  await expect(conversationStatus).not.toHaveText("");

  const contextMenu = await page.locator(".app-shell").evaluate((element) => {
    let propagated = false;
    element.addEventListener("contextmenu", () => { propagated = true; }, { once: true });
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      button: 2,
      cancelable: true,
    });
    const dispatched = element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, dispatched, propagated };
  });
  expect(contextMenu).toEqual({ defaultPrevented: true, dispatched: false, propagated: true });

  const shortcut = await page.locator("body").evaluate((element) => {
    let propagated = false;
    window.addEventListener("keydown", () => { propagated = true; }, { once: true });
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
      shiftKey: true,
    });
    const dispatched = element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, dispatched, propagated };
  });
  expect(shortcut).toEqual({ defaultPrevented: true, dispatched: false, propagated: false });

  await accountButton.click();
  await expect(page.getByRole("menu", { name: "切换账号" })).toBeVisible();
  await page.keyboard.press("Escape");
  await settingsButton.click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
});

test("the account avatar expands an inline account switcher with add account last", { tag: "@smoke" }, async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("notgram:accounts:v1")) return;
    window.localStorage.setItem("notgram:accounts:v1", JSON.stringify({
      activeAccountId: "default",
      accounts: [
        {
          id: "default",
          userId: "self",
          displayName: "林然",
          avatar: { label: "林", color: "#d16f45" },
        },
        {
          id: "account-secondary",
          userId: "secondary",
          displayName: "工作账号",
          avatar: {
            label: "工",
            color: "#4477aa",
            imagePath: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          },
        },
      ],
    }));
  });
  await page.goto("/");

  const accountEntry = page.locator(".rail-account");
  await accountEntry.click();
  let menu = page.getByRole("menu", { name: "切换账号" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio")).toHaveCount(1);
  await expect(menu.getByRole("menuitemradio", { name: "林然" })).toHaveCount(0);
  await expect(menu.getByRole("menuitemradio", { name: "工作账号" }))
    .toHaveAttribute("aria-checked", "false");
  await expect(menu.getByRole("menuitemradio", { name: "工作账号" }).locator(".avatar")).toContainText("工");
  await expect(menu.getByRole("menuitemradio", { name: "工作账号" }).locator(".avatar img"))
    .toHaveAttribute("src", /^data:image\/png;base64,/);
  const menuWidth = await menu.evaluate((element) => element.getBoundingClientRect().width);
  const accountWidth = await accountEntry.evaluate((element) => element.getBoundingClientRect().width);
  expect(Math.abs(menuWidth - accountWidth)).toBeLessThan(1);
  const menuItems = menu.getByRole("menuitemradio").or(menu.getByRole("menuitem"));
  await expect(menuItems.last()).toHaveText("添加新账号");
  await page.waitForTimeout(220);
  const firstPosition = await menu.boundingBox();
  const accountPosition = await accountEntry.boundingBox();
  expect(firstPosition).not.toBeNull();
  expect(accountPosition).not.toBeNull();
  expect((firstPosition?.y ?? 0)).toBeGreaterThan((accountPosition?.y ?? 0) + (accountPosition?.height ?? 0) - 1);
  expect(Math.abs((firstPosition?.x ?? 0) - (accountPosition?.x ?? 0))).toBeLessThan(1);

  await page.keyboard.press("Escape");
  await accountEntry.click({ button: "right", position: { x: 60, y: 60 } });
  menu = page.getByRole("menu", { name: "切换账号" });
  await page.waitForTimeout(220);
  const secondPosition = await menu.boundingBox();
  expect(secondPosition).not.toBeNull();
  expect(Math.abs((secondPosition?.x ?? 0) - (firstPosition?.x ?? 0))).toBeLessThan(1);
  expect(Math.abs((secondPosition?.y ?? 0) - (firstPosition?.y ?? 0))).toBeLessThan(1);

  let pageLoads = 0;
  page.on("load", () => { pageLoads += 1; });
  await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (!shell) throw new Error("Workspace shell is unavailable before account switch");
    (window as typeof window & { __notgramAccountSwitchShell?: HTMLElement }).__notgramAccountSwitchShell = shell;
  });
  await menu.getByRole("menuitemradio", { name: "工作账号" }).click();
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(window.localStorage.getItem("notgram:accounts:v1") ?? "{}");
    return state.activeAccountId;
  })).toBe("account-secondary");
  expect(pageLoads).toBe(0);
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".startup-screen")).toHaveCount(0);
  expect(await page.evaluate(() => {
    const previous = (window as typeof window & { __notgramAccountSwitchShell?: HTMLElement }).__notgramAccountSwitchShell;
    return Boolean(previous && document.querySelector(".app-shell") === previous);
  })).toBe(true);

  const previousAccountId = await page.evaluate(() => {
    const state = JSON.parse(window.localStorage.getItem("notgram:accounts:v1") ?? "{}");
    return state.activeAccountId as string;
  });
  await page.setViewportSize({ width: 390, height: 430 });
  await page.locator(".rail-account").click({ button: "right" });
  await page.getByRole("menu", { name: "切换账号" })
    .getByRole("menuitem", { name: "添加新账号" }).click();
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(window.localStorage.getItem("notgram:accounts:v1") ?? "{}");
    return state.activeAccountId as string;
  })).not.toBe(previousAccountId);
  await expect(page.locator(".auth-shell")).toBeVisible();
  const authShellBox = await page.locator(".auth-shell").boundingBox();
  const authBackBox = await page.getByRole("button", { name: "返回账号" }).boundingBox();
  expect(authShellBox).not.toBeNull();
  expect(authBackBox).not.toBeNull();
  expect(authBackBox!.y).toBeGreaterThanOrEqual(authShellBox!.y);
  expect(authBackBox!.y + authBackBox!.height).toBeLessThanOrEqual(authShellBox!.y + authShellBox!.height);
  await page.getByRole("button", { name: "返回账号" }).click();
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(window.localStorage.getItem("notgram:accounts:v1") ?? "{}");
    return state.activeAccountId as string;
  })).toBe(previousAccountId);
  await expect(page.locator(".app-shell")).toBeVisible();
});

test("account switcher keeps an interruptible exit transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");

  const accountEntry = page.locator(".rail-account");
  const menu = page.getByRole("menu", { name: "切换账号" });
  await accountEntry.click();
  await expect(menu).toBeVisible();

  await page.keyboard.press("Escape");
  const exitingPresence = page.locator('.motion-presence[data-motion-state="exiting"]');
  await expect(exitingPresence).toHaveAttribute("aria-hidden", "true");
  await expect(exitingPresence).toHaveAttribute("inert", "");
  await expect(exitingPresence.locator('[role="menu"]')).toHaveCount(1);

  await accountEntry.click();
  await expect(menu).toBeVisible();
  await expect(page.locator('.motion-presence[data-motion-state="exiting"]')).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(exitingPresence).toHaveCount(1);
  await page.waitForTimeout(260);
  await expect(page.locator('[role="menu"][aria-label="切换账号"]')).toHaveCount(0);
});
