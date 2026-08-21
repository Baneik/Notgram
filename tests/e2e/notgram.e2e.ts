import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ChatProfile, Message } from "../../src/telegram/types";

interface ConversationSwitchRecord {
  durationMs?: number;
  navigationKind?: number;
  cancelled?: boolean;
  [key: string]: number | boolean | undefined;
}

const horizontalOverflow = async (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll("body *")].some((element) => {
    if (element.closest(".rail-actions")) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
  }));

const conversationSwitchRecords = (page: Page): Promise<ConversationSwitchRecord[]> =>
  page.evaluate(async () => {
    const performanceModule = await (0, eval)('import("/src/utils/performanceMonitor.ts")') as {
      getPerformanceRecords: () => Array<{
        event: string;
        durationMs?: number;
        details: Record<string, number | boolean>;
      }>;
    };
    return performanceModule.getPerformanceRecords()
      .filter((record) => record.event === "ui_conversation_switch")
      .map((record) => ({ durationMs: record.durationMs, ...record.details }));
  });

const messageListMetrics = (page: Page) => page.locator(".message-list").evaluate((element) => ({
  scrollTop: element.scrollTop,
  scrollHeight: element.scrollHeight,
  clientHeight: element.clientHeight,
  distanceBottom: element.scrollHeight - element.clientHeight - element.scrollTop,
}));

const latestMessageBottomGap = (page: Page) => page.locator(".message-list").evaluate((element) => {
  const messages = element.querySelectorAll<HTMLElement>("[data-message-id]");
  const latest = messages.item(messages.length - 1);
  if (!latest) return Number.POSITIVE_INFINITY;
  return Math.abs(
    element.getBoundingClientRect().bottom - latest.getBoundingClientRect().bottom,
  );
});

const visibleMessageAnchor = (page: Page) => page.locator(".message-list").evaluate((element) => {
  const listBounds = element.getBoundingClientRect();
  const row = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      return bounds.bottom > listBounds.top + 1 && bounds.top < listBounds.bottom - 1;
    });
  return {
    id: row?.dataset.messageId,
    offset: row ? row.getBoundingClientRect().top - listBounds.top : 0,
    scrollTop: element.scrollTop,
  };
});

const scrollAwayFromBottom = async (page: Page) => {
  await expect.poll(async () => {
    const metrics = await messageListMetrics(page);
    return metrics.scrollHeight - metrics.clientHeight;
  }).toBeGreaterThan(200);
  const messageList = page.getByRole("log", { name: "消息列表" });
  await messageList.hover();
  await page.mouse.wheel(0, -1);
  await messageList.evaluate((element) => {
    const maximum = element.scrollHeight - element.clientHeight;
    element.scrollTop = Math.max(100, Math.floor(maximum * 0.45));
    element.dispatchEvent(new Event("scroll"));
  });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }));
};

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
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const row = page.locator(`[data-message-id="${messageId}"]`);
  await expect(row).toBeVisible();
  return row;
};

const openConversationMessageSearch = async (page: Page) => {
  const menu = page.getByRole("menu", { name: "会话操作" });
  if (!await menu.isVisible()) {
    await page.getByRole("button", { name: "更多操作" }).click();
  }
  await menu.getByRole("menuitem", { name: "搜索消息" }).click();
};

test("authorization defaults to QR login and exposes proxy-only settings", async ({ page }) => {
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

interface BottomGeometrySample {
  context: string;
  distanceBottom: number;
  latestGap: number;
}

const traceBottomGeometryWhileClicking = (
  trigger: Locator,
  frameCount = 30,
): Promise<BottomGeometrySample[]> => trigger.evaluate(async (element, frames) => {
  const read = (): BottomGeometrySample => {
    const list = document.querySelector<HTMLElement>(".message-list");
    const rows = list?.querySelectorAll<HTMLElement>("[data-message-id]");
    const latest = rows?.item((rows?.length ?? 1) - 1);
    const listBounds = list?.getBoundingClientRect();
    return {
      context: document.querySelector<HTMLElement>(".composer-context")?.className ?? "",
      distanceBottom: list
        ? list.scrollHeight - list.clientHeight - list.scrollTop
        : Number.POSITIVE_INFINITY,
      latestGap: listBounds && latest
        ? listBounds.bottom - latest.getBoundingClientRect().bottom
        : Number.POSITIVE_INFINITY,
    };
  };
  const samples = [read()];
  (element as HTMLElement).click();
  for (let frame = 0; frame < frames; frame += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => {
      globalThis.setTimeout(resolve, 0);
    }));
    samples.push(read());
  }
  return samples;
}, frameCount);

const expectStableFollowingGeometry = (
  samples: BottomGeometrySample[],
  contextClass: "is-editing" | "",
) => {
  const matching = samples.filter(({ context }) => contextClass
    ? context.includes(contextClass)
    : context === "");
  expect(matching.length, JSON.stringify(samples)).toBeGreaterThan(2);
  expect(
    Math.max(...matching.map(({ distanceBottom }) => Math.abs(distanceBottom))),
    JSON.stringify(samples),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.max(...matching.map(({ latestGap }) => Math.abs(latestGap - 12))),
    JSON.stringify(samples),
  ).toBeLessThanOrEqual(1.5);
};

test("forum groups reopen the last topic and expose compact horizontal navigation", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-chat-id="chat-forum"]').click();

  await expect(page.getByRole("region", { name: "常规 话题 对话" })).toBeVisible();
  await expect(page.locator(".conversation-title strong")).toHaveText("Notgram 论坛");
  await expect(page.getByRole("button", { name: "返回话题列表" })).toHaveCount(0);
  await expect(page.locator('[data-message-id="forum-general-1"]')).toBeVisible();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await conversationSwitchRecords(page))
    .filter((record) => record.navigationKind === 1 && record.cancelled !== true).length).toBe(1);
  const strip = page.getByRole("navigation", { name: "话题切换" });
  await expect(strip).toBeVisible();
  await expect(strip.getByRole("tab")).toHaveCount(3);
  await expect(strip.locator('[data-topic-id="12"] .forum-topic-tab-avatar')).toBeVisible();
  await expect(strip.locator('[data-topic-id="12"] .forum-topic-tab-name')).toHaveText("构建与发布");
  await expect(strip.locator('[data-topic-id="12"] .forum-topic-tab-count')).toHaveText("3");

  await page.addStyleTag({ content: ".forum-topic-tabs { max-width: 180px; }" });
  const wheelResult = await strip.locator(".forum-topic-tabs").evaluate((element) => {
    element.scrollLeft = 0;
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    element.dispatchEvent(event);
    return {
      defaultPrevented: event.defaultPrevented,
      maximumScrollLeft: element.scrollWidth - element.clientWidth,
      scrollLeft: element.scrollLeft,
    };
  });
  expect(wheelResult.maximumScrollLeft).toBeGreaterThan(0);
  expect(wheelResult.defaultPrevented).toBe(true);
  expect(wheelResult.scrollLeft).toBeGreaterThan(0);

  await strip.locator('[data-topic-id="12"]').click();
  await expect(page.getByRole("region", { name: "构建与发布 话题 对话" })).toBeVisible();
  await expect(page.locator(".conversation-title strong")).toHaveText("Notgram 论坛");
  await expect(page.locator('[data-message-id="forum-release-1"]')).toBeVisible();
  await expect.poll(async () => (await conversationSwitchRecords(page))
    .filter((record) => record.navigationKind === 4 && record.cancelled !== true).length).toBe(1);

  await page.locator('[data-chat-id="chat-mia"]').click();
  await page.locator('[data-chat-id="chat-forum"]').click();
  await expect(page.getByRole("region", { name: "构建与发布 话题 对话" })).toBeVisible();
  await expect(page.locator(".conversation-title strong")).toHaveText("Notgram 论坛");
  await expect(page.getByRole("button", { name: "返回话题列表" })).toHaveCount(0);
  await expect(page.locator('[data-message-id="forum-release-1"]')).toBeVisible();
});

test("non-forum group conversations keep messages that belong to a message thread", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator('[data-message-id="product-thread-1"]')).toBeVisible();
  await expect(page.getByText("群组线程消息也应显示在主会话中。", { exact: true })).toBeVisible();
});

test("the top bar keeps only window controls and the account entry opens settings", async ({ page }) => {
  await page.goto("/");

  const settingsButton = page.locator(".rail-account");
  await expect(settingsButton).toHaveRole("button");
  await expect(settingsButton).toHaveAccessibleName("设置");
  await expect(settingsButton).toContainText("林然");
  await expect(settingsButton.locator(".avatar")).toBeVisible();
  await expect(page.locator(".rail-footer")).toHaveCount(0);
  await expect(page.locator(".rail-brand")).toHaveCount(0);
  await expect(page.locator(".window-chrome")).toBeVisible();
  await expect(page.locator(".window-chrome")).not.toContainText("Notgram");
  await expect(page.locator(".window-controls > button")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "最小化窗口" })).toBeVisible();
  await expect(page.getByRole("button", { name: "最大化窗口" })).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭窗口" })).toBeVisible();
  await expect(page.locator(".rail-settings, .rail-connection")).toHaveCount(0);
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

  await settingsButton.click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
});

test("the account avatar opens a fixed account switcher with add account last", async ({ page }) => {
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
          avatar: { label: "工", color: "#4477aa" },
        },
      ],
    }));
  });
  await page.goto("/");

  const accountEntry = page.locator(".rail-account");
  await accountEntry.click({ button: "right", position: { x: 8, y: 8 } });
  let menu = page.getByRole("menu", { name: "切换账号" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio")).toHaveCount(2);
  await expect(menu.getByRole("menuitemradio", { name: "林然" })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemradio", { name: "工作账号" }).locator(".avatar")).toContainText("工");
  const menuItems = menu.getByRole("menuitemradio").or(menu.getByRole("menuitem"));
  await expect(menuItems.last()).toHaveText("添加新账号");
  const firstPosition = await menu.boundingBox();
  expect(firstPosition).not.toBeNull();

  await page.keyboard.press("Escape");
  await accountEntry.click({ button: "right", position: { x: 60, y: 60 } });
  menu = page.getByRole("menu", { name: "切换账号" });
  const secondPosition = await menu.boundingBox();
  expect(secondPosition).not.toBeNull();
  expect(Math.abs((secondPosition?.x ?? 0) - (firstPosition?.x ?? 0))).toBeLessThan(1);
  expect(Math.abs((secondPosition?.y ?? 0) - (firstPosition?.y ?? 0))).toBeLessThan(1);

  await menu.getByRole("menuitemradio", { name: "工作账号" }).click();
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(window.localStorage.getItem("notgram:accounts:v1") ?? "{}");
    return state.activeAccountId;
  })).toBe("account-secondary");

  const previousAccountId = await page.evaluate(() => {
    const state = JSON.parse(window.localStorage.getItem("notgram:accounts:v1") ?? "{}");
    return state.activeAccountId as string;
  });
  await page.locator(".rail-account").click({ button: "right" });
  await page.getByRole("menu", { name: "切换账号" })
    .getByRole("menuitem", { name: "添加新账号" }).click();
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(window.localStorage.getItem("notgram:accounts:v1") ?? "{}");
    return state.activeAccountId as string;
  })).not.toBe(previousAccountId);
  await expect(page.locator(".auth-shell")).toBeVisible();
  await page.getByRole("button", { name: "返回账号" }).click();
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(window.localStorage.getItem("notgram:accounts:v1") ?? "{}");
    return state.activeAccountId as string;
  })).toBe(previousAccountId);
  await expect(page.locator(".app-shell")).toBeVisible();
});

test("settings isolate wheel input from the covered conversation list", async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 520 });
  await page.goto("/");
  const chatList = page.locator(".chat-list");
  await chatList.evaluate((element) => {
    (element as HTMLElement).style.height = "120px";
    element.scrollTop = 24;
  });
  const before = await chatList.evaluate((element) => element.scrollTop);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const backdrop = page.locator(".dialog-backdrop");
  await expect(backdrop).toBeVisible();
  await backdrop.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 480 }));
  });
  await expect.poll(() => chatList.evaluate((element) => element.scrollTop)).toBe(before);
});

test("standalone settings update the still-interactive main window", async ({ page, context }) => {
  await page.goto("/");
  const settings = await context.newPage();
  await settings.goto("/settings-window.html");
  await expect(settings.locator(".settings-window-shell")).toBeVisible();
  await expect(settings.locator(".app-shell")).toHaveCount(0);
  await expect(settings.locator(".window-chrome")).toBeVisible();
  await expect(settings.locator(".window-chrome")).not.toContainText("设置");
  await expect(settings.locator(".window-controls > button")).toHaveCount(3);
  await expect(settings.getByRole("button", { name: "关闭", exact: true })).toHaveCount(0);
  const settingsTitle = settings.getByRole("heading", { name: "设置", exact: true });
  const accountCategory = settings.getByRole("button", { name: /我的账号/ });
  const chatCategory = settings.getByRole("button", { name: /聊天设置/ });
  await expect(settingsTitle).toBeFocused();
  await expect(settingsTitle).toHaveCSS("outline-style", "none");
  await expect(accountCategory).not.toBeFocused();
  await settings.keyboard.press("Tab");
  await expect(accountCategory).toBeFocused();
  expect(await accountCategory.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  await chatCategory.click();
  expect(await chatCategory.evaluate((element) => element.matches(":focus-visible"))).toBe(false);
  await settings.getByRole("spinbutton", { name: "消息字体大小" }).fill("19");
  await expect(page.locator(".message-rich-text").first()).toHaveCSS("font-size", "19px");

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await settings.close();
});

test("account settings only show and edit the current profile", async ({ page }) => {
  await page.goto("/settings-window.html");
  const accountCategory = page.getByRole("button", { name: "我的账号", exact: true });
  await expect(accountCategory).toHaveText("我的账号");
  await expect(accountCategory.locator("small")).toHaveCount(0);
  await expect(accountCategory).not.toContainText("林然");
  const categoryLayout = await page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>(".settings-categories");
    const buttons = [...document.querySelectorAll<HTMLElement>(".settings-category")];
    return {
      navWidth: nav?.getBoundingClientRect().width ?? 0,
      buttonWidths: buttons.map((button) => button.getBoundingClientRect().width),
    };
  });
  expect(categoryLayout.navWidth).toBeLessThan(180);
  expect(new Set(categoryLayout.buttonWidths.map(Math.round)).size).toBe(1);
  await expect(page.getByText("已登录账号", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "添加账号" })).toHaveCount(0);
  await expect(page.getByText("切换到此账号", { exact: true })).toHaveCount(0);

  const card = page.locator(".account-profile-card");
  await expect(card).toBeVisible();
  await expect(card.getByText("+86 100 0000 0000", { exact: true })).toBeVisible();
  await expect(card.getByText("self", { exact: true })).toBeVisible();
  await expect(card.getByText("DC5, Singapore, SG", { exact: true })).toBeVisible();
  await expect(card.getByText("@linran_notgram", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: "编辑账号资料" }).click();
  await card.getByLabel("名字").fill("林");
  await card.getByLabel("姓氏").fill("曦");
  await card.getByLabel("用户名").fill("linxi_notgram");
  await card.getByLabel("签名").fill("桌面端设计");
  await card.getByRole("button", { name: "保存资料" }).click();
  await expect(card.getByText("林 曦", { exact: true })).toBeVisible();
  await expect(card.getByText("@linxi_notgram", { exact: true })).toBeVisible();
  await expect(card.getByText("桌面端设计", { exact: true }).first()).toBeVisible();

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await card.locator('input[type="file"]').setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(card.locator(".account-profile-avatar img")).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
});

test("performance monitor captures and inspects a WebView main-thread stall", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const deadline = performance.now() + 90;
    while (performance.now() < deadline) {
      // Keep the WebView main thread busy long enough to emit a long-frame entry.
    }
  });

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /性能监控/ }).click();
  await expect(page.getByRole("heading", { name: "实时会话" })).toBeVisible();
  await expect(page.locator(".performance-entry")).not.toHaveCount(0);

  const stall = page.locator(".performance-entry")
    .filter({ hasText: /长动画帧|主线程长任务|掉帧/ })
    .first();
  await expect(stall).toBeVisible();
  await stall.getByRole("button").click();
  const stallDetails = stall.locator(".performance-entry-details");
  await expect(stallDetails).toContainText("总耗时");
  await expect(stallDetails).toContainText("耗时归属");
  await expect(stallDetails).toContainText("判断证据");
  await expect(stallDetails).toContainText("当前刷新率");
  await expect(stallDetails).toContainText("当前帧预算");
  await expect(stallDetails).toContainText("真实界面卡顿");

  const pause = page.getByRole("button", { name: "暂停刷新" });
  await pause.click();
  await expect(page.getByRole("button", { name: "继续刷新" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "清空性能记录" }).click();
  await expect(page.getByText("暂无性能采样")).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
});

test("performance monitor attributes a conversation switch to its slowest stage", async ({ page }) => {
  await page.goto("/");
  const title = page.locator(".conversation-title strong");
  const initialTitle = await title.innerText();
  const targetChatId = initialTitle === "产品讨论" ? "chat-mia" : "chat-product";

  await page.locator(`.chat-row[data-chat-id="${targetChatId}"]`).click();
  await expect(title).not.toHaveText(initialTitle);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /性能监控/ }).click();

  const switchEntry = page.locator(".performance-entry")
    .filter({ hasText: /会话切换 ·/ })
    .first();
  await expect(switchEntry).toBeVisible();
  await switchEntry.getByRole("button").click();
  const details = switchEntry.locator(".performance-entry-details");
  await expect(details).toContainText("最大瓶颈");
  await expect(details).toContainText("瓶颈耗时");
  await expect(details).toContainText("React 提交");
  await expect(details).toContainText("滚动定位");
  await expect(details).toContainText("耗时归属");
  await expect(details).toContainText("界面响应");
  await expect(details).toContainText("缺失阶段");
  await expect(details).not.toContainText("链路超时");
});

test("desktop messaging, context actions, and preferences remain usable", async ({ page }) => {
  await page.goto("/?blockedSenders=8");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".chat-row")).not.toHaveCount(0);
  await expect(page.locator(".message-bubble-shell")).not.toHaveCount(0);

  const visibleBubble = page.locator(".message-bubble-shell").last();
  await visibleBubble.click({ button: "right" });
  const messageMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(messageMenu.getByRole("button", { name: /^回应/ })).toHaveCount(0);
  await expect(messageMenu.getByRole("menuitem").nth(0)).toHaveText("回复");
  await expect(messageMenu.getByRole("menuitem").nth(1)).toHaveText("转发");
  await expect(messageMenu.getByRole("menuitem").nth(2)).toHaveText("复制");
  await page.keyboard.press("Escape");
  await expect(page.locator(".reaction-add, .message-action-trigger")).toHaveCount(0);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /聊天设置/ }).click();
  await page.getByRole("spinbutton", { name: "消息字体大小" }).fill("18");
  await expect(page.getByRole("spinbutton", { name: "消息字体大小" })).toHaveValue("18");
  await expect(page.locator(".message-rich-text").first()).toHaveCSS("font-size", "18px");
  await page.getByRole("spinbutton", { name: "界面缩放比例" }).fill("110");
  await expect(page.getByRole("spinbutton", { name: "界面缩放比例" })).toHaveValue("110");
  await expect(page.locator("html")).toHaveCSS("zoom", "1.1");
  await page.getByRole("spinbutton", { name: "会话列表行高" }).fill("56");
  await page.getByRole("spinbutton", { name: "消息组间距" }).fill("14");
  await page.getByRole("spinbutton", { name: "同组消息间距" }).fill("4");
  await page.getByRole("spinbutton", { name: "消息气泡纵向留白" }).fill("10");
  await expect(page.locator("html")).toHaveCSS("--chat-row-min-height", "56px");
  await expect(page.locator("html")).toHaveCSS("--message-group-spacing", "14px");
  await expect(page.locator("html")).toHaveCSS("--message-row-spacing", "4px");
  await expect(page.locator("html")).toHaveCSS("--message-bubble-padding-y", "10px");
  const lightTheme = page.getByRole("button", { name: "浅色", exact: true });
  const darkTheme = page.getByRole("button", { name: "深色", exact: true });
  await expect(lightTheme).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".conversation")).toHaveCSS("background-color", "rgb(232, 239, 237)");
  await darkTheme.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "notgram-dark");
  await expect(page.locator("html")).not.toHaveClass(/theme-dark/);
  await expect(darkTheme).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".settings-dialog")).toHaveCSS("background-color", "rgb(38, 43, 49)");
  await expect(page.locator(".conversation")).toHaveCSS("background-color", "rgb(24, 27, 31)");
  await expect(page.locator(".message-row.is-incoming:has(.message-rich-text) .message-bubble").first())
    .toHaveCSS("background-color", "rgb(37, 42, 48)");
  await expect(page.locator(".message-row.is-outgoing:has(.message-rich-text) .message-bubble").first())
    .toHaveCSS("background-color", "rgb(51, 69, 83)");
  await page.getByRole("button", { name: /高级设置/ }).click();
  await expect(page.getByLabel("缓存路径")).toHaveValue(
    "%LOCALAPPDATA%\\dev.notgram.desktop\\tdlib",
  );
  await expect(page.getByLabel("下载路径")).toHaveValue(
    "%USERPROFILE%\\Downloads\\downloads",
  );
  const cachePathHeight = await page.getByLabel("缓存路径")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).height));
  expect(cachePathHeight).toBeGreaterThanOrEqual(35);
  expect(cachePathHeight).toBeLessThanOrEqual(37);
  await page.getByRole("button", { name: "重建界面缓存" }).click();
  await expect(page.locator(".settings-dialog .cache-health"))
    .toContainText("缓存状态：刚刚重建");
  await page.getByRole("button", { name: /软件更新/ }).click();
  await expect(page.getByRole("heading", { name: /Notgram 0\.5\.0-rc\.3/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "检查更新" })).toBeDisabled();
  await page.getByRole("button", { name: /诊断与隐私/ }).click();
  await expect(page.getByRole("button", { name: "导出诊断包" })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "保留脱敏崩溃报告" })).toBeDisabled();
  await expect(page.getByText("浏览器预览不生成诊断包")).toBeVisible();
  const blockedList = page.locator(".settings-section", { hasText: "Telegram 黑名单" })
    .locator(".blocked-sender-list");
  await expect(blockedList).toHaveAttribute("aria-busy", "false");
  await expect(blockedList.locator(".blocked-sender-row")).toHaveCount(8);
  const blockedListHeight = await blockedList
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).height));
  expect(blockedListHeight).toBeGreaterThanOrEqual(183);
  expect(blockedListHeight).toBeLessThanOrEqual(185);
  await expect.poll(() => blockedList.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  expect(await horizontalOverflow(page)).toBe(false);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "notgram-dark");
  await expect(page.locator("html")).not.toHaveClass(/theme-dark/);
  await expect(page.locator(".conversation")).toHaveCSS("background-color", "rgb(24, 27, 31)");
});

test("custom proxy profiles persist and enable automatic switching", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("button", { name: /高级设置/ }).click();
  await settings.getByRole("radio", { name: "自定义" }).click();

  const proxyList = settings.getByRole("list", { name: "自定义代理" });
  await expect(proxyList.getByRole("listitem")).toHaveCount(1);
  await proxyList.getByRole("button", { name: "添加代理" }).click();
  await expect(proxyList.getByRole("listitem")).toHaveCount(2);

  await settings.getByLabel("名称").fill("备用节点");
  await settings.getByLabel("服务器").fill("proxy.example.test");
  await settings.getByLabel("端口").fill("1088");
  const autoSwitch = settings.getByRole("switch", { name: /自动切换/ });
  await expect(autoSwitch).toBeEnabled();
  await autoSwitch.check();

  await page.setViewportSize({ width: 390, height: 700 });
  expect(await horizontalOverflow(page)).toBe(false);
  await settings.getByRole("button", { name: "保存更改" }).click();
  await expect(settings).toBeHidden();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await settings.getByRole("button", { name: /高级设置/ }).click();
  await expect(settings.getByRole("radio", { name: "自定义" })).toBeChecked();
  await expect(settings.getByRole("list", { name: "自定义代理" }).getByRole("listitem"))
    .toHaveCount(2);
  await expect(settings.getByLabel("名称")).toHaveValue("备用节点");
  await expect(settings.getByRole("switch", { name: /自动切换/ })).toBeChecked();
  expect(await horizontalOverflow(page)).toBe(false);
});

test("composer keeps focus, typing status is visible, and previews name the sender", async ({ page }) => {
  await page.goto("/?typing=group");

  const composer = page.getByRole("textbox", { name: "消息内容" });
  const previewSender = page.locator('[data-chat-id="chat-product"] .chat-preview-sender');
  await expect(page.locator(".conversation-header-status")).toHaveText("Jules 正在输入...");
  await expect(page.locator('[data-chat-id="chat-product"] .chat-preview'))
    .toContainText("Jules: 我把交互稿更新到最新版本了");
  await expect(previewSender).toHaveText("Jules:");
  await expect(previewSender).toHaveCSS("color", "rgb(66, 120, 165)");
  await expect(page.locator('[data-chat-id="chat-mia"] .chat-preview-sender')).toHaveCount(0);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "notgram-dark";
  });
  await expect(previewSender).toHaveCSS("color", "rgb(120, 167, 200)");

  await composer.fill("发送后继续输入");
  await page.keyboard.press("Enter");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("");
  await composer.fill("第二条消息无需重新点击");
  await page.keyboard.press("Enter");
  await expect(composer).toBeFocused();
  await expect(page.getByText("第二条消息无需重新点击", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /Notgram/ }).click();
  const typingSwitch = page.getByRole("switch", { name: "发送输入状态" });
  await expect(typingSwitch).toBeChecked();
  await typingSwitch.uncheck();
  await expect(typingSwitch).not.toBeChecked();
});

test("multiline composer keeps the latest message visible and hides its scrollbar", async ({ page }) => {
  await page.goto("/");
  const messageList = page.getByRole("log", { name: "消息列表" });
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(13);

  const samples: Array<{
    inputHeight: number;
    latestBottom: number;
    listBottom: number;
    composerTop: number;
    distanceBottom: number;
  }> = [];
  for (let lineCount = 1; lineCount <= 18; lineCount += 1) {
    await composer.fill(Array.from({ length: lineCount }, (_, index) => `第 ${index + 1} 行内容`).join("\n"));
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => globalThis.setTimeout(resolve, 0));
    }));
    samples.push(await messageList.evaluate((list, textarea) => {
      const rows = list.querySelectorAll<HTMLElement>("[data-message-id]");
      const latest = rows.item(rows.length - 1);
      const input = textarea as HTMLTextAreaElement;
      const listBounds = list.getBoundingClientRect();
      return {
        inputHeight: input.getBoundingClientRect().height,
        latestBottom: latest?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY,
        listBottom: listBounds.bottom,
        composerTop: document.querySelector<HTMLElement>(".composer-wrap")
          ?.getBoundingClientRect().top ?? Number.NEGATIVE_INFINITY,
        distanceBottom: list.scrollHeight - list.clientHeight - list.scrollTop,
      };
    }, await composer.elementHandle()));
  }

  expect(samples.at(-1)?.inputHeight).toBe(290);
  for (const sample of samples.filter(({ inputHeight }) => inputHeight > 40)) {
    expect(sample.listBottom).toBeLessThanOrEqual(sample.composerTop + 1);
    expect(sample.latestBottom, JSON.stringify(samples)).toBeLessThanOrEqual(sample.listBottom + 1);
    expect(sample.distanceBottom, JSON.stringify(samples)).toBeLessThanOrEqual(13);
  }
  await expect.poll(() => composer.evaluate((element) => ({
    overflowY: getComputedStyle(element).overflowY,
    scrollbarWidth: getComputedStyle(element).scrollbarWidth,
  }))).toEqual({ overflowY: "auto", scrollbarWidth: "none" });

  const emojiButton = page.getByRole("button", { name: "表情" });
  const sendButton = page.getByRole("button", { name: "发送消息" });
  const [emojiBounds, sendBounds, sendIconBounds] = await Promise.all([
    emojiButton.boundingBox(),
    sendButton.boundingBox(),
    sendButton.locator("svg").boundingBox(),
  ]);
  expect(sendBounds?.width).toBe(30);
  expect(sendBounds!.width).toBeLessThan(emojiBounds!.width);
  expect(sendBounds!.width).toBeGreaterThan(sendIconBounds!.width);
  const buttonIsBrighterThanAccent = await sendButton.evaluate((element) => {
    const parseColor = (value: string) => {
      const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
      return value.startsWith("color(")
        ? channels
        : channels.map((channel) => channel / 255);
    };
    const probe = document.createElement("span");
    probe.style.background = "var(--accent)";
    document.body.append(probe);
    const buttonColor = parseColor(getComputedStyle(element).backgroundColor);
    const accentColor = parseColor(getComputedStyle(probe).backgroundColor);
    probe.remove();
    return buttonColor.reduce((sum, channel) => sum + channel, 0) >
      accentColor.reduce((sum, channel) => sum + channel, 0);
  });
  expect(buttonIsBrighterThanAccent).toBe(true);
  expect(await sendButton.evaluate((element) => getComputedStyle(element, "::before").opacity)).toBe("0");
  await sendButton.hover();
  await expect.poll(() => sendButton.evaluate((element) => getComputedStyle(element, "::before").opacity))
    .toBe("0.14");
});

test("live messages animate without replaying history rows", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".message-row.is-entering-incoming, .message-row.is-entering-outgoing"))
    .toHaveCount(0);

  const entranceReport = page.evaluate(() => new Promise<{
    className: string;
    awaitingEntranceObserved: boolean;
    rowBottom: number;
    listBottom: number;
    composerTop: number;
    opacity: number;
    animationDuration: string;
  }>((resolve) => {
    let awaitingEntranceObserved = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector(".message-row.is-awaiting-entrance")) {
        awaitingEntranceObserved = true;
      }
      const entering = document.querySelector<HTMLElement>(".message-row.is-entering-outgoing");
      if (!entering) return;
      const list = entering.closest<HTMLElement>(".message-list");
      const composer = document.querySelector<HTMLElement>(".composer-wrap");
      observer.disconnect();
      resolve({
        className: entering.className,
        awaitingEntranceObserved,
        rowBottom: entering.getBoundingClientRect().bottom,
        listBottom: list?.getBoundingClientRect().bottom ?? Number.NEGATIVE_INFINITY,
        composerTop: composer?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
        opacity: Number.parseFloat(getComputedStyle(entering).opacity),
        animationDuration: getComputedStyle(entering).animationDuration,
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    globalThis.setTimeout(() => {
      observer.disconnect();
      resolve({
        className: "",
        awaitingEntranceObserved,
        rowBottom: Number.POSITIVE_INFINITY,
        listBottom: Number.NEGATIVE_INFINITY,
        composerTop: Number.NEGATIVE_INFINITY,
        opacity: 0,
        animationDuration: "",
      });
    }, 2_000);
  }));
  await page.getByRole("textbox", { name: "消息内容" }).fill("动画消息测试");
  await page.getByRole("button", { name: "发送消息" }).click();

  const report = await entranceReport;
  expect(report.className).toContain("is-entering-outgoing");
  expect(report.awaitingEntranceObserved).toBe(false);
  expect(report.rowBottom).toBeLessThanOrEqual(report.listBottom + 1);
  expect(report.listBottom).toBeLessThanOrEqual(report.composerTop + 1);
  expect(report.opacity).toBeGreaterThanOrEqual(0.99);
  expect(report.animationDuration).toBe("0.12s");
  await expect(page.getByText("动画消息测试", { exact: true })).toBeVisible();
  await expect(page.locator(".message-row.is-entering-outgoing")).toHaveCount(0);
});

test("incoming messages do not wait for a bottom pin while reading away from latest", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("button", { name: /^跳到最新消息/ })).toBeVisible();

  const messageId = "m-detached-incoming";
  const report = await page.evaluate(async ({ entrancePath, storePath, targetId }) => {
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Message[]> };
        setState: (partial: { messages: Map<string, Message[]> }) => void;
      };
    };
    const entranceModule = await import(entrancePath) as {
      markMessageEntrance: (message: Message) => void;
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-mia") ?? [])];
    const latest = current.at(-1);
    if (!latest) throw new Error("Missing incoming fixture");
    const appended: Message = {
      ...latest,
      id: targetId,
      renderKey: undefined,
      outgoing: false,
      senderId: "u-mia",
      sentAt: new Date(Date.now() + 2_000).toISOString(),
      content: { kind: "text", text: "离开底部时收到的新消息立即显示" },
    };
    entranceModule.markMessageEntrance(appended);
    current.push(appended);
    messages.set("chat-mia", current);
    const startedAt = performance.now();
    storeModule.telegramStore.setState({ messages });
    let mountedAt: number | undefined;
    while (performance.now() - startedAt < 500) {
      const row = document.querySelector<HTMLElement>(`[data-message-id="${targetId}"]`);
      if (row) {
        mountedAt ??= performance.now();
        const style = getComputedStyle(row);
        if (style.visibility !== "hidden" && Number.parseFloat(style.opacity) > 0) {
          return {
            mountedAt: mountedAt - startedAt,
            visibleAt: performance.now() - startedAt,
            className: row.className,
          };
        }
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    throw new Error("Detached incoming message stayed hidden");
  }, {
    entrancePath: "/src/utils/messageEntrance.ts",
    storePath: "/src/store/telegramStore.ts",
    targetId: messageId,
  });

  expect(report.visibleAt, JSON.stringify(report)).toBeLessThan(250);
  expect(report.className).not.toContain("is-preparing-entrance");
});

test("new messages stay pinned without viewport rebound", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.fill("逐帧滚动稳定性测试");
  const samplesPromise = page.evaluate(() => new Promise<Array<{
    scrollTop: number;
    distanceBottom: number;
    rowBottom?: number;
    rowVisible: boolean;
    listBottom: number;
  }>>((resolve) => {
    const samples: Array<{
      scrollTop: number;
      distanceBottom: number;
      rowBottom?: number;
      rowVisible: boolean;
      listBottom: number;
    }> = [];
    let frames = 0;
    const sample = () => {
      const list = document.querySelector<HTMLElement>(".message-list");
      const row = [...document.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find((candidate) => candidate.textContent?.includes("逐帧滚动稳定性测试"));
      if (list) {
        samples.push({
          scrollTop: list.scrollTop,
          distanceBottom: list.scrollHeight - list.clientHeight - list.scrollTop,
          rowBottom: row?.getBoundingClientRect().bottom,
          rowVisible: Boolean(row && getComputedStyle(row).visibility !== "hidden"),
          listBottom: list.getBoundingClientRect().bottom,
        });
      }
      frames += 1;
      if (frames < 90) requestAnimationFrame(sample);
      else resolve(samples);
    };
    requestAnimationFrame(sample);
  }));

  await page.getByRole("button", { name: "发送消息" }).click();
  const samples = await samplesPromise;
  const afterAppend = samples.findIndex((sample) => sample.rowBottom !== undefined);
  expect(afterAppend).toBeGreaterThanOrEqual(0);
  const visibleSamples = samples.slice(afterAppend);
  const viewportRebounds = visibleSamples.slice(1).filter((sample, index) =>
    sample.scrollTop < visibleSamples[index].scrollTop - 8,
  );
  expect(viewportRebounds, JSON.stringify(visibleSamples)).toHaveLength(0);
  const animatedSamples = visibleSamples.filter((sample) => sample.rowVisible);
  expect(
    animatedSamples.every((sample) =>
      sample.rowBottom !== undefined && sample.rowBottom <= sample.listBottom + 1
    ),
    JSON.stringify(visibleSamples),
  ).toBe(true);
  const bubbleRebounds = animatedSamples.slice(1).filter((sample, index) =>
    sample.rowBottom !== undefined && animatedSamples[index].rowBottom !== undefined &&
    sample.rowBottom > animatedSamples[index].rowBottom! + 0.5,
  );
  expect(bubbleRebounds, JSON.stringify(animatedSamples)).toHaveLength(0);
  expect(visibleSamples.at(-1)?.distanceBottom).toBeLessThanOrEqual(13);
  expect(Math.abs(
    (visibleSamples.at(-1)?.listBottom ?? 0) - (visibleSamples.at(-1)?.rowBottom ?? 0),
  )).toBeLessThanOrEqual(13);
});

test("incoming animated messages remain visible while following latest", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: /^跳到最新消息/ }).click();
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);

  const appendIncoming = (id: string, text: string) => page.evaluate(async ({
    storePath,
    entrancePath,
    messageId,
    messageText,
  }) => {
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const entranceModule = await import(entrancePath) as {
      markMessageEntrance: (message: Record<string, unknown>) => void;
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-mia") ?? [])];
    const latest = current.at(-1);
    if (!latest) return;
    const appended = {
      ...latest,
      id: messageId,
      renderKey: undefined,
      outgoing: false,
      senderId: "u-mia",
      sentAt: new Date(Date.now() + 2_000).toISOString(),
      content: { kind: "text", text: messageText },
    };
    entranceModule.markMessageEntrance(appended);
    current.push(appended);
    messages.set("chat-mia", current);
    storeModule.telegramStore.setState({ messages });
  }, {
    storePath: "/src/store/telegramStore.ts",
    entrancePath: "/src/utils/messageEntrance.ts",
    messageId: id,
    messageText: text,
  });

  const samplesPromise = page.evaluate(() => new Promise<Array<{
    animationName: string;
    distanceBottom: number;
    rowBottom: number;
    listBottom: number;
    rowVisible: boolean;
    opacity: number;
  }>>((resolve) => {
    const samples: Array<{
      animationName: string;
      distanceBottom: number;
      rowBottom: number;
      listBottom: number;
      rowVisible: boolean;
      opacity: number;
    }> = [];
    let frames = 0;
    const sample = () => {
      const list = document.querySelector<HTMLElement>(".message-list");
      const row = document.querySelector<HTMLElement>('[data-message-id="m-live-incoming"]');
      if (!list || !row) {
        requestAnimationFrame(sample);
        return;
      }
      const style = getComputedStyle(row);
      samples.push({
        animationName: style.animationName,
        distanceBottom: list.scrollHeight - list.clientHeight - list.scrollTop,
        rowBottom: row.getBoundingClientRect().bottom,
        listBottom: list.getBoundingClientRect().bottom,
        rowVisible: style.visibility !== "hidden",
        opacity: Number.parseFloat(style.opacity),
      });
      frames += 1;
      if (frames < 24) requestAnimationFrame(sample);
      else resolve(samples);
    };
    requestAnimationFrame(sample);
  }));

  await appendIncoming("m-live-incoming", "实时收到的新消息需要完整播放入场动画");

  const samples = await samplesPromise;
  const animatedSamples = samples.filter(
    (sample) => sample.animationName === "message-enter-incoming",
  );
  expect(animatedSamples.length, JSON.stringify(samples)).toBeGreaterThan(0);
  expect(
    samples.filter((sample) => sample.rowVisible)
      .every((sample) => sample.rowBottom <= sample.listBottom + 1),
    JSON.stringify(samples),
  ).toBe(true);
  expect(
    animatedSamples.every((sample) => sample.rowBottom <= sample.listBottom + 1),
    JSON.stringify(samples),
  ).toBe(true);
  expect(
    animatedSamples.every((sample) => sample.distanceBottom <= 1),
    JSON.stringify(samples),
  ).toBe(true);
  expect(
    animatedSamples.every((sample) => sample.opacity >= 0.99),
    JSON.stringify(samples),
  ).toBe(true);
  expect(samples.at(-1)?.distanceBottom).toBeLessThanOrEqual(1);
  await appendIncoming("m-live-incoming-next", "下一条实时消息仍应自动跟随");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);
  await expect.poll(() => page.locator('[data-message-id="m-live-incoming-next"]')
    .evaluate((row) => {
      const list = row.closest<HTMLElement>(".message-list");
      return list ? list.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom : -1;
    })).toBeGreaterThanOrEqual(-1);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);
});

test("expired entrance metadata does not delay appended-message anchoring", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  const firstMountedFrame = page.evaluate(() => new Promise<{
    className: string;
    visibility: string;
    rowBottom: number;
    listBottom: number;
  }>((resolve) => {
    const observer = new MutationObserver(() => {
      const row = document.querySelector<HTMLElement>('[data-message-id="p-expired-entrance"]');
      const list = document.querySelector<HTMLElement>(".message-list");
      if (!row || !list) return;
      observer.disconnect();
      resolve({
        className: row.className,
        visibility: getComputedStyle(row).visibility,
        rowBottom: row.getBoundingClientRect().bottom,
        listBottom: list.getBoundingClientRect().bottom,
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  }));

  await page.evaluate(async ({ storePath, entrancePath }) => {
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const entranceModule = await import(entrancePath) as {
      markMessageEntrance: (message: Record<string, unknown>) => void;
    };
    const { telegramStore } = storeModule;
    const { markMessageEntrance } = entranceModule;
    const state = telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    if (!latest) return;
    const appended = {
      ...latest,
      id: "p-expired-entrance",
      renderKey: undefined,
      outgoing: false,
      senderId: "u-mia",
      sentAt: new Date(Date.now() + 2_000).toISOString(),
      content: { kind: "text", text: "延迟挂载的新消息" },
    };
    markMessageEntrance(appended);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_100));
    current.push(appended);
    messages.set("chat-product", current);
    telegramStore.setState({ messages });
  }, {
    storePath: "/src/store/telegramStore.ts",
    entrancePath: "/src/utils/messageEntrance.ts",
  });

  const report = await firstMountedFrame;
  expect(report.className).not.toContain("is-entering-");
  expect(
    report.visibility === "hidden" || report.rowBottom <= report.listBottom + 1,
    JSON.stringify(report),
  ).toBe(true);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator('[data-message-id="p-expired-entrance"]')).toBeVisible();
});

test("downward wheel input at the exact bottom never rebounds", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await page.waitForTimeout(400);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  const samplesPromise = page.evaluate(() => new Promise<number[]>((resolve) => {
    const samples: number[] = [];
    let frames = 0;
    const sample = () => {
      const list = document.querySelector<HTMLElement>(".message-list");
      if (list) samples.push(list.scrollHeight - list.clientHeight - list.scrollTop);
      frames += 1;
      if (frames < 45) requestAnimationFrame(sample);
      else resolve(samples);
    };
    requestAnimationFrame(sample);
  }));
  await messageList.hover();
  for (let attempt = 0; attempt < 8; attempt += 1) await page.mouse.wheel(0, 600);
  const samples = await samplesPromise;
  const directions = samples.slice(1)
    .map((sample, index) => sample - samples[index])
    .filter((delta) => Math.abs(delta) > 1)
    .map((delta) => Math.sign(delta));
  const reversals = directions.slice(1)
    .filter((direction, index) => direction !== directions[index]);
  expect(reversals, JSON.stringify(samples)).toHaveLength(0);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
});

test("blank message viewport clicks never force a bottom correction", async ({ page }) => {
  await page.goto("/");
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await page.waitForTimeout(400);

  const before = await messageList.evaluate((element) => {
    const maximum = element.scrollHeight - element.clientHeight;
    element.scrollTop = Math.max(0, maximum - 26);
    return element.scrollTop;
  });
  const bounds = await messageList.boundingBox();
  if (!bounds) throw new Error("Message viewport is not visible");
  await page.mouse.click(bounds.x + 3, bounds.y + bounds.height * 0.45);
  await page.waitForTimeout(120);

  await expect.poll(() => messageList.evaluate((element) => element.scrollTop))
    .toBeCloseTo(before, 0);
});

test("middle mouse scrolling detaches instead of fighting bottom following", async ({ page }) => {
  await page.goto("/");
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await page.waitForTimeout(400);
  const bounds = await messageList.boundingBox();
  if (!bounds) throw new Error("Message viewport is not visible");

  await page.mouse.click(bounds.x + 3, bounds.y + bounds.height * 0.45, {
    button: "middle",
  });
  await messageList.evaluate((element) => {
    const maximum = element.scrollHeight - element.clientHeight;
    element.scrollTop = Math.max(0, maximum - 420);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await messageList.evaluate((element) => {
    element.scrollTop = Math.min(
      element.scrollHeight - element.clientHeight,
      element.scrollTop + 180,
    );
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeGreaterThan(160);
  await page.waitForTimeout(120);

  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeGreaterThan(160);
  await expect.poll(() => page.evaluate(async () => {
    const state = await (0, eval)('import("/src/hooks/conversationScrollState.ts")') as {
      conversationScrollMemory: Map<string, { followLatest: boolean }>;
    };
    return [...state.conversationScrollMemory.values()].at(-1)?.followLatest;
  })).toBe(false);
});

test("primary pointer scrolling still detaches from latest messages", async ({ page }) => {
  await page.goto("/");
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  const bounds = await messageList.boundingBox();
  if (!bounds) throw new Error("Message viewport is not visible");

  await page.mouse.move(bounds.x + 3, bounds.y + bounds.height * 0.45);
  await page.mouse.down();
  await messageList.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollTop - 240);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeGreaterThan(32);
  await expect.poll(() => page.evaluate(async () => {
    const state = await (0, eval)('import("/src/hooks/conversationScrollState.ts")') as {
      conversationScrollMemory: Map<string, { followLatest: boolean }>;
    };
    return [...state.conversationScrollMemory.values()].at(-1)?.followLatest;
  })).toBe(false);
  await page.mouse.up();
  await page.waitForTimeout(120);

  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeGreaterThan(32);
  await expect(page.getByRole("button", { name: /跳到最新消息/ })).toBeVisible();
});

test("appended mixed-height row growth during downward wheel input stays pinned", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await page.waitForTimeout(400);

  await messageList.hover();
  await messageList.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    }));
  });

  const samplesPromise = page.evaluate(() => new Promise<Array<{
    scrollTop: number;
    distanceBottom: number;
  }>>((resolve) => {
    const samples: Array<{ scrollTop: number; distanceBottom: number }> = [];
    let frames = 0;
    const sample = () => {
      const list = document.querySelector<HTMLElement>(".message-list");
      if (list) {
        samples.push({
          scrollTop: list.scrollTop,
          distanceBottom: list.scrollHeight - list.clientHeight - list.scrollTop,
        });
      }
      frames += 1;
      if (frames < 90) requestAnimationFrame(sample);
      else resolve(samples);
    };
    requestAnimationFrame(sample);
  }));

  const growingMessage = "组合高度变化滚动稳定性测试";
  await page.getByRole("textbox", { name: "消息内容" }).fill(growingMessage);
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByText(growingMessage, { exact: true })).toBeVisible();
  await page.evaluate(async (messageText) => {
    const list = document.querySelector<HTMLElement>(".message-list");
    const row = [...document.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((candidate) => candidate.textContent?.includes(messageText));
    const lastItem = row?.closest<HTMLElement>("[data-index]");
    if (!list || !lastItem) throw new Error("Growing latest virtual item is not mounted");
    const spacer = document.createElement("div");
    spacer.dataset.delayedMeasurement = "true";
    spacer.style.height = "0px";
    lastItem.appendChild(spacer);
    for (let frame = 1; frame <= 16; frame += 1) {
      list.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 120,
      }));
      spacer.style.height = `${frame * 6}px`;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, growingMessage);

  const samples = await samplesPromise;
  const rebounds = samples.slice(1).filter((sample, index) =>
    sample.scrollTop < samples[index].scrollTop - 1 && sample.distanceBottom > 1
  );
  expect(rebounds, JSON.stringify(samples)).toHaveLength(0);
  expect(samples.at(-1)?.distanceBottom).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate(async () => {
    const state = await (0, eval)('import("/src/hooks/conversationScrollState.ts")') as {
      conversationScrollMemory: Map<string, { followLatest: boolean }>;
    };
    return [...state.conversationScrollMemory.values()].at(-1)?.followLatest;
  })).toBe(true);
});

test("history loading hides transient scrollbar geometry until anchoring settles", async ({ page }) => {
  await page.addInitScript(() => {
    const state = { observed: false };
    Object.assign(globalThis, { __notgramHistoryScrollbar: state });
    globalThis.addEventListener("DOMContentLoaded", () => {
      const observer = new MutationObserver(() => {
        if (document.querySelector(".message-list.is-history-adjusting")) state.observed = true;
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    });
  });
  await page.goto("/");

  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramHistoryScrollbar: { observed: boolean } }
  ).__notgramHistoryScrollbar.observed)).toBe(true);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".message-list")).not.toHaveClass(/is-history-adjusting/);
});

test("composer provides recent Emoji, installed stickers, and saved GIFs", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  const composerControls = await page.locator(".composer").evaluate((element) =>
    [...element.children].map((child) => child.getAttribute("aria-label") ?? child.tagName));
  expect(composerControls).toEqual(["添加附件", "消息内容", "表情", "发送消息"]);
  await page.getByRole("button", { name: "表情" }).click();
  const picker = page.getByRole("dialog", { name: "表情、贴纸与 GIF" });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("tab", { name: "贴纸" })).toHaveAttribute("aria-selected", "true");
  await expect(picker.getByRole("heading", { name: "最近使用" })).toBeVisible();
  const workStickerSet = picker.getByRole("button", { name: "工作日常" });
  await expect(workStickerSet.locator(".sticker-pack-cover img")).toHaveAttribute("data-image-state", "ready");
  await expect(picker.locator(".emoji-picker-type-mark")).toHaveCount(0);
  await workStickerSet.click();
  await expect(picker.getByRole("heading", { name: "工作日常" })).toBeVisible();
  await picker.getByRole("tab", { name: "Emoji" }).click();
  await picker.getByRole("button", { name: "插入 😀" }).click();
  await expect(composer).toHaveValue("😀");
  await expect(composer).toBeFocused();
  await picker.getByRole("button", { name: "关闭表情面板" }).click();
  await expect(composer).toBeFocused();

  await page.getByRole("button", { name: "表情" }).click();
  await expect(picker.getByRole("heading", { name: "最近使用" })).toBeVisible();
  const sticker = picker.getByRole("button", { name: /发送贴纸/ }).first();
  await expect(sticker).toBeVisible();
  await sticker.click();
  await expect(picker).toBeHidden();
  const sentSticker = page.locator('[data-media-type="sticker"]').last();
  await expect(sentSticker).toBeVisible();
  await expect(composer).toBeFocused();

  await sentSticker.getByRole("button", { name: "查看贴纸包" }).click();
  const stickerSetPreview = page.getByRole("dialog", { name: "工作日常" });
  await expect(stickerSetPreview).toBeVisible();
  await expect(stickerSetPreview.getByLabel("贴纸预览")).toBeVisible();
  const stickerOptions = stickerSetPreview.getByRole("button", { name: /预览贴纸/ });
  await expect(stickerOptions).toHaveCount(32);
  await expect(stickerOptions.first().locator('img[data-image-state="ready"]')).toBeVisible();
  const stickerGridGeometry = await stickerOptions.evaluateAll((options) => {
    const list = options[0]?.parentElement;
    const cells = options.map((option) => option.getBoundingClientRect());
    const visuals = options.map((option) => [...option.querySelectorAll<HTMLElement>(".emoji-asset-visual, img, video, .tgs-sticker, .tgs-sticker > svg")]
      .map((visual) => visual.getBoundingClientRect()));
    const overlaps = cells.some((cell, index) => cells.slice(index + 1).some((other) =>
      Math.min(cell.right, other.right) - Math.max(cell.left, other.left) > 0.5
      && Math.min(cell.bottom, other.bottom) - Math.max(cell.top, other.top) > 0.5));
    return {
      overlaps,
      squareCells: cells.every((cell) => Math.abs(cell.width - cell.height) <= 1),
      scrollable: Boolean(list && list.scrollHeight > list.clientHeight),
      visualsContained: visuals.every((items, index) => items.length > 0 && items.every((visual) =>
        visual.left >= cells[index].left
        && visual.top >= cells[index].top
        && visual.right <= cells[index].right
        && visual.bottom <= cells[index].bottom)),
    };
  });
  expect(stickerGridGeometry).toEqual({ overlaps: false, squareCells: true, scrollable: true, visualsContained: true });
  await stickerOptions.nth(1).click();
  await expect(stickerOptions.nth(1)).toHaveAttribute("aria-pressed", "true");
  const previewCoverage = await stickerSetPreview.getByLabel("贴纸预览").evaluate((stage) => {
    const visual = stage.querySelector<HTMLElement>(".emoji-asset-visual")?.getBoundingClientRect();
    const bounds = stage.getBoundingClientRect();
    const style = getComputedStyle(stage);
    const availableWidth = bounds.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const availableHeight = bounds.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    return {
      fillsWidth: Boolean(visual && Math.abs(visual.width - availableWidth) <= 1),
      fillsHeight: Boolean(visual && Math.abs(visual.height - availableHeight) <= 1),
      insideStage: Boolean(visual
        && visual.left >= bounds.left
        && visual.top >= bounds.top
        && visual.right <= bounds.right
        && visual.bottom <= bounds.bottom),
    };
  });
  expect(previewCoverage).toEqual({ fillsWidth: true, fillsHeight: true, insideStage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(stickerSetPreview).toBeVisible();
  const responsivePreviewGeometry = await stickerSetPreview.evaluate((dialog) => {
    const listElement = dialog.querySelector<HTMLElement>(".sticker-set-list");
    const stage = dialog.querySelector<HTMLElement>(".sticker-set-stage")?.getBoundingClientRect();
    const list = listElement?.getBoundingClientRect();
    const footer = dialog.querySelector<HTMLElement>(".sticker-set-footer")?.getBoundingClientRect();
    const bounds = dialog.getBoundingClientRect();
    return {
      insideViewport: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
      sideBySide: Boolean(stage && list && stage.right <= list.left + 1),
      footerBelow: Boolean(stage && list && footer && footer.top >= Math.max(stage.bottom, list.bottom) - 1),
      horizontalOverflow: dialog.scrollWidth > dialog.clientWidth + 1,
      listScrollable: Boolean(listElement && listElement.scrollHeight > listElement.clientHeight),
    };
  });
  expect(responsivePreviewGeometry).toEqual({
    insideViewport: true,
    sideBySide: true,
    footerBelow: true,
    horizontalOverflow: false,
    listScrollable: true,
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await stickerSetPreview.getByRole("button", { name: "添加贴纸" }).click();
  await expect(stickerSetPreview).toBeHidden();

  await page.getByRole("button", { name: "表情" }).click();
  await picker.getByRole("tab", { name: "GIF 动态图" }).click();
  const animation = picker.getByRole("button", { name: "发送 GIF" }).first();
  await expect(animation).toBeVisible();
  await animation.click();
  await expect(page.locator('[data-media-type="animation"]').last()).toBeVisible();
  await expect(composer).toBeFocused();
});

test("sticker picker uses deliberate hover intent and closes promptly", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "表情", exact: true });
  const picker = page.getByRole("dialog", { name: "表情、贴纸与 GIF" });

  await trigger.hover();
  await page.waitForTimeout(140);
  await expect(picker).toBeHidden();
  await expect(picker).toBeVisible({ timeout: 500 });

  const pickerBox = await picker.boundingBox();
  expect(pickerBox?.height).toBeGreaterThanOrEqual(600);
  await trigger.click();
  await expect(picker).toBeVisible();
  await picker.hover();
  await page.waitForTimeout(140);
  await expect(picker).toBeVisible();

  await page.getByRole("textbox", { name: "消息内容" }).hover();
  await expect(picker).toBeHidden({ timeout: 300 });

  await trigger.click();
  await expect(picker).toBeVisible();
  await page.getByRole("textbox", { name: "消息内容" }).fill("发送时关闭贴纸面板");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByText("发送时关闭贴纸面板", { exact: true })).toBeVisible();
});

test("message copy supports text and image clipboard payloads", async ({ page }) => {
  await page.addInitScript(() => {
    const clipboardState = { text: "", types: [] as string[] };
    class TestClipboardItem {
      types: string[];
      constructor(readonly data: Record<string, Blob>) {
        this.types = Object.keys(data);
      }
    }
    Object.defineProperty(globalThis, "ClipboardItem", { value: TestClipboardItem });
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => { clipboardState.text = text; },
        write: async (items: TestClipboardItem[]) => { clipboardState.types = items[0]?.types ?? []; },
      },
    });
    Object.assign(globalThis, { __notgramClipboardState: clipboardState });
  });
  await page.goto("/");

  await (await revealVirtualMessage(page, "p-2"))
    .locator(".message-bubble-shell")
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramClipboardState: { text: string } }
  ).__notgramClipboardState.text)).toBe("看到了。消息区再留一点呼吸感，信息密度就比较平衡。");

  await (await revealVirtualMessage(page, "p-tall"))
    .locator(".message-bubble-shell")
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramClipboardState: { types: string[] } }
  ).__notgramClipboardState.types)).toEqual(expect.arrayContaining(["image/png", "text/plain"]));
});

test("composer coalesces resizing and persists drafts without blocking input", async ({ page }) => {
  await page.goto("/");
  const composer = page.locator(".composer textarea");
  await expect(composer).toBeVisible();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const result = await composer.evaluate(async (textarea) => {
    const input = textarea as HTMLTextAreaElement;
    const text = "responsive-input-".repeat(12);
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (!valueSetter) throw new Error("Textarea value setter is unavailable");

    const observer = new MutationObserver(() => undefined);
    observer.observe(input, { attributes: true, attributeFilter: ["style"] });
    const startedAt = performance.now();
    for (const [index, character] of [...text].entries()) {
      valueSetter.call(input, input.value + character);
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: character,
        inputType: "insertText",
      }));
      if ((index + 1) % 24 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    const dispatchMs = performance.now() - startedAt;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const styleMutationCount = observer.takeRecords().length;
    observer.disconnect();
    return { dispatchMs, styleMutationCount, text, value: input.value };
  });

  expect(result.value).toBe(result.text);
  expect(result.dispatchMs).toBeLessThan(300);
  expect(result.styleMutationCount).toBeLessThanOrEqual(6);
  await expect.poll(() => page.evaluate(async ({ chatId, modulePath }) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { drafts: Map<string, { text: string }> };
      };
    };
    return storeModule.telegramStore.getState().drafts.get(chatId)?.text;
  }, {
    chatId: "chat-product",
    modulePath: "/src/store/telegramStore.ts",
  })).toBe(result.text);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
});

test("chat list shows draft previews only for inactive conversations", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  const productPreview = page.locator('[data-chat-id="chat-product"] .chat-preview');
  const firstDraft = "只在离开会话后显示的草稿";
  const secondDraft = `${firstDraft}，第二版`;

  await composer.fill(firstDraft);
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { drafts: Map<string, { text: string }> };
      };
    };
    return storeModule.telegramStore.getState().drafts.get("chat-product")?.text;
  }, "/src/store/telegramStore.ts")).toBe(firstDraft);
  await expect(productPreview).not.toHaveClass(/is-draft/);
  await expect(productPreview).not.toContainText(firstDraft);

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(productPreview).toHaveClass(/is-draft/);
  await expect(productPreview).toContainText(`草稿：${firstDraft}`);

  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(composer).toHaveValue(firstDraft);
  await expect(productPreview).not.toHaveClass(/is-draft/);
  await expect(productPreview).not.toContainText("草稿：");
  await composer.fill(secondDraft);
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { drafts: Map<string, { text: string }> };
      };
    };
    return storeModule.telegramStore.getState().drafts.get("chat-product")?.text;
  }, "/src/store/telegramStore.ts")).toBe(secondDraft);
  await expect(productPreview).not.toHaveClass(/is-draft/);
  await expect(productPreview).not.toContainText(firstDraft);
  await expect(productPreview).not.toContainText(secondDraft);

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(productPreview).toContainText(`草稿：${secondDraft}`);

  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(productPreview).not.toHaveClass(/is-draft/);
  await expect(productPreview).not.toContainText("草稿：");
  await composer.fill(" \n\t");
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { drafts: Map<string, { text: string }> };
      };
    };
    return storeModule.telegramStore.getState().drafts.get("chat-product")?.text;
  }, "/src/store/telegramStore.ts")).toBe(" \n\t");
  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(productPreview).not.toHaveClass(/is-draft/);
  await expect(productPreview).not.toContainText("草稿：");
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { drafts: Map<string, unknown> };
      };
    };
    return storeModule.telegramStore.getState().drafts.has("chat-product");
  }, "/src/store/telegramStore.ts")).toBe(false);
});

test("member mentions stay in their chat and the resulting draft can be cleared", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  const senderAvatar = page.locator(".message-sender-avatar").last();
  await expect(senderAvatar).toBeVisible();
  await senderAvatar.click({ button: "right" });
  const senderMenu = page.getByRole("menu", { name: "成员操作" });
  const mentionAction = senderMenu.getByRole("menuitem", { name: /^@/ });
  const mentionLabel = (await mentionAction.innerText()).trim();
  await mentionAction.click();

  await expect(composer).toHaveValue(`${mentionLabel} `);
  const mentionDraft = await composer.inputValue();
  await page.waitForTimeout(250);
  await expect(page.locator(".inline-query-panel")).toHaveCount(0);
  await expect(page.locator(".operation-error")).toHaveCount(0);

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(composer).toHaveValue("");
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(composer).toHaveValue(mentionDraft);
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { drafts: Map<string, { entities?: Array<{ kind: string; userId?: string }> }> };
      };
    };
    return storeModule.telegramStore.getState().drafts.get("chat-product")?.entities?.[0];
  }, "/src/store/telegramStore.ts")).toMatchObject({ kind: "mentionName", userId: expect.any(String) });

  await composer.fill("");
  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(composer).toHaveValue("");
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(composer).toHaveValue("");
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { drafts: Map<string, unknown> };
      };
    };
    return storeModule.telegramStore.getState().drafts.has("chat-product");
  }, "/src/store/telegramStore.ts")).toBe(false);
});

test("nickname mentions keep their stable profile click after sending", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  const senderAvatar = page.locator(".message-sender-avatar").last();
  await expect(senderAvatar).toBeVisible();
  await senderAvatar.click({ button: "right" });
  const mentionAction = page.getByRole("menu", { name: "成员操作" })
    .getByRole("menuitem", { name: /^@/ });
  const mentionLabel = (await mentionAction.innerText()).trim();
  await mentionAction.click();
  await expect(composer).toHaveValue(`${mentionLabel} `);
  await page.getByRole("button", { name: "发送消息" }).click();

  const sentMention = page.locator(".message-row.is-outgoing .message-rich-text a")
    .filter({ hasText: mentionLabel })
    .last();
  await expect(sentMention).toHaveText(mentionLabel);
  await sentMention.click();
  await expect(page.getByRole("dialog", { name: "资料" })).toBeVisible();
});

test("IME composition defers draft persistence and layout work until commit", async ({ page }) => {
  await page.goto("/");
  const composer = page.locator(".composer textarea");
  await expect(composer).toBeVisible();

  const result = await composer.evaluate(async (textarea) => {
    const input = textarea as HTMLTextAreaElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (!valueSetter) throw new Error("Textarea value setter is unavailable");
    input.focus();
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const observer = new MutationObserver(() => undefined);
    observer.observe(input, { attributes: true, attributeFilter: ["style"] });
    for (const value of ["n", "ni", "你"]) {
      input.dispatchEvent(new CompositionEvent("compositionupdate", {
        bubbles: true,
        data: value,
      }));
      valueSetter.call(input, value);
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: value,
        inputType: "insertCompositionText",
        isComposing: true,
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 850));
    const storeModule = await import("/src/store/telegramStore.ts" as string) as {
      telegramStore: {
        getState: () => { drafts: Map<string, { text: string }> };
      };
    };
    const duringCompositionDraft = storeModule.telegramStore
      .getState().drafts.get("chat-product")?.text;
    const styleMutationCount = observer.takeRecords().length;
    observer.disconnect();
    input.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "你",
    }));
    return { duringCompositionDraft, styleMutationCount, value: input.value };
  });

  expect(result.value).toBe("你");
  expect(result.duringCompositionDraft).toBeUndefined();
  expect(result.styleMutationCount).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { drafts: Map<string, { text: string }> };
      };
    };
    return storeModule.telegramStore.getState().drafts.get("chat-product")?.text;
  }, "/src/store/telegramStore.ts")).toBe("你");
});

test("private chats show incoming typing state", async ({ page }) => {
  await page.goto("/?typing=direct");
  await page.locator('[data-chat-id="chat-mia"]').click();
  const headerStatus = page.locator(".conversation-header-status");
  await expect(headerStatus).toHaveClass(/is-typing/);
  await expect(headerStatus).toHaveText("正在输入...");
  const titlePositionWhileTyping = await page.locator(".conversation-title strong").boundingBox();
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { typingUserIds: Map<string, string[]> };
        setState: (partial: { typingUserIds: Map<string, string[]> }) => void;
      };
    };
    const typingUserIds = new Map(module.telegramStore.getState().typingUserIds);
    typingUserIds.delete("chat-mia");
    module.telegramStore.setState({ typingUserIds });
  }, "/src/store/telegramStore.ts");
  await expect(headerStatus).not.toHaveClass(/is-typing/);
  await expect(headerStatus).not.toBeEmpty();
  const titlePositionWithoutTyping = await page.locator(".conversation-title strong").boundingBox();
  expect(Math.abs(
    titlePositionWhileTyping!.y - titlePositionWithoutTyping!.y,
  )).toBeLessThanOrEqual(0.5);
});

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

test("conversation suppresses horizontal scrolling and reveals its vertical scrollbar only while scrolling", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toBeVisible();
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect(messageList).not.toHaveClass(/is-history-adjusting/);
  await expect(messageList).not.toHaveClass(/is-scrolling/);
  await expect.poll(() => messageList.evaluate((element) => (
    getComputedStyle(element).scrollbarColor.startsWith("rgba(0, 0, 0, 0)")
  ))).toBe(true);

  const idle = await messageList.evaluate((element) => {
    const content = element.querySelector<HTMLElement>(".message-list-content");
    return {
      clientWidth: element.clientWidth,
      contentWidth: content?.getBoundingClientRect().width,
      horizontalOverflow: element.scrollWidth > (element as HTMLElement).offsetWidth,
      overflowX: getComputedStyle(element).overflowX,
    };
  });
  expect(idle.overflowX).toBe("hidden");
  expect(idle.horizontalOverflow).toBe(false);

  await messageList.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -160 }));
    element.scrollTop = Math.max(0, element.scrollTop - 160);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(messageList).toHaveClass(/is-scrolling/);
  await expect.poll(() => messageList.evaluate((element) => (
    getComputedStyle(element).scrollbarColor.startsWith("rgba(0, 0, 0, 0)")
  ))).toBe(false);

  const scrolling = await messageList.evaluate((element) => ({
    clientWidth: element.clientWidth,
    contentWidth: element.querySelector<HTMLElement>(".message-list-content")
      ?.getBoundingClientRect().width,
  }));
  expect(scrolling.clientWidth).toBe(idle.clientWidth);
  expect(scrolling.contentWidth).toBe(idle.contentWidth);

  await expect(messageList).not.toHaveClass(/is-scrolling/, { timeout: 2_000 });
  await expect.poll(() => messageList.evaluate((element) => element.clientWidth))
    .toBe(idle.clientWidth);
});

test("message viewport reaches the composer and keeps a scrollable bottom gap", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  const geometry = await page.evaluate(() => {
    const latest = document.querySelector<HTMLElement>('[data-message-id="p-video"]');
    const list = latest?.closest<HTMLElement>(".message-list");
    const composer = document.querySelector<HTMLElement>(".composer");
    const sentinel = list?.querySelector<HTMLElement>(".message-list-end-sentinel");
    if (!latest || !list || !composer || !sentinel) return null;
    return {
      latestGap: composer.getBoundingClientRect().top - latest.getBoundingClientRect().bottom,
      viewportGap: composer.getBoundingClientRect().top - list.getBoundingClientRect().bottom,
      bottomSpacer: sentinel.getBoundingClientRect().height,
      distanceBottom: list.scrollHeight - list.scrollTop - list.clientHeight,
    };
  });
  expect(geometry).not.toBeNull();
  expect(geometry!.viewportGap).toBeCloseTo(0, 1);
  expect(geometry!.bottomSpacer).toBeCloseTo(12, 1);
  expect(geometry!.latestGap).toBeGreaterThanOrEqual(0);
  expect(geometry!.latestGap).toBeLessThanOrEqual(geometry!.bottomSpacer + 1);
  expect(Math.abs(
    geometry!.latestGap + geometry!.distanceBottom - geometry!.bottomSpacer,
  )).toBeLessThanOrEqual(0.5);
});

test("a 99+ unread entry positions once without exposing intermediate jumps", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { chats: Map<string, { unreadCount: number }> };
        setState: (partial: { chats: Map<string, { unreadCount: number }> }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const chats = new Map(state.chats);
    const chat = chats.get("chat-chen");
    if (chat) chats.set("chat-chen", { ...chat, unreadCount: 120 });
    storeModule.telegramStore.setState({ chats });
  }, "/src/store/telegramStore.ts");
  await page.evaluate(() => {
    const diagnosticWindow = window as typeof window & {
      __notgramEntryFrames?: Array<{
        busy: string | null;
        placeholder: boolean;
        transitionCovered: boolean;
        snapshotCovered: boolean;
        snapshotMessageCount: number;
        snapshotVisibleMessageCount: number;
        messageCount: number;
        scrollTop: number;
      }>;
    };
    diagnosticWindow.__notgramEntryFrames = [];
    const startedAt = performance.now();
    const sample = () => {
      const activeChatId = document.querySelector<HTMLElement>(
        '.chat-row[aria-current="true"]',
      )?.dataset.chatId;
      const list = document.querySelector<HTMLElement>(".message-list");
      const shell = document.querySelector<HTMLElement>(".message-list-shell");
      if (activeChatId === "chat-chen" && list && shell) {
        diagnosticWindow.__notgramEntryFrames?.push({
          busy: list.getAttribute("aria-busy"),
          placeholder: Boolean(shell.querySelector(".message-positioning-placeholder")),
          transitionCovered: document.documentElement.classList.contains(
            "is-conversation-view-transition",
          ),
          snapshotCovered: Boolean(document.querySelector("[data-conversation-switch-snapshot]")),
          snapshotMessageCount: Number(document.querySelector<HTMLElement>(
            "[data-conversation-switch-snapshot]",
          )?.dataset.snapshotMessageCount ?? 0),
          snapshotVisibleMessageCount: Number(document.querySelector<HTMLElement>(
            "[data-conversation-switch-snapshot]",
          )?.dataset.snapshotVisibleMessageCount ?? 0),
          messageCount: list.querySelectorAll("[data-message-id]").length,
          scrollTop: Math.round(list.scrollTop),
        });
      }
      if (performance.now() - startedAt < 2_000) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  const serverChat = page.locator('[data-chat-id="chat-chen"]');
  await serverChat.click();
  await expect(serverChat).toHaveAttribute("aria-current", "true");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-message-id="c-old-25"]')).toBeVisible();

  const result = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".message-list")!;
    const target = document.querySelector<HTMLElement>('[data-message-id="c-old-25"]')!;
    const latest = document.querySelector<HTMLElement>('[data-message-id="c-2"]');
    const listBounds = list.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    const frames = (window as typeof window & {
      __notgramEntryFrames?: Array<{
        busy: string | null;
        placeholder: boolean;
        transitionCovered: boolean;
        snapshotCovered: boolean;
        snapshotMessageCount: number;
        snapshotVisibleMessageCount: number;
        messageCount: number;
        scrollTop: number;
      }>;
    }).__notgramEntryFrames ?? [];
    const placeholderFrames = frames.filter((frame) => frame.placeholder);
    const transitionCoveredFrames = frames.filter((frame) => frame.transitionCovered);
    const snapshotCoveredFrames = frames.filter((frame) => frame.snapshotCovered);
    const exposedPositions = new Set(
      frames.filter(
        (frame) => frame.busy === "false" && !frame.placeholder && !frame.transitionCovered &&
          !frame.snapshotCovered && frame.messageCount > 0,
      )
        .map((frame) => frame.scrollTop),
    );
    return {
      targetOffset: targetBounds.top - listBounds.top,
      listHeight: listBounds.height,
      latestVisible: Boolean(
        latest && latest.getBoundingClientRect().top < listBounds.bottom &&
        latest.getBoundingClientRect().bottom > listBounds.top,
      ),
      placeholderFrameCount: placeholderFrames.length,
      transitionCoveredFrameCount: transitionCoveredFrames.length,
      snapshotCoveredFrameCount: snapshotCoveredFrames.length,
      emptySnapshotFrameCount: snapshotCoveredFrames.filter(
        (frame) => frame.snapshotMessageCount === 0 || frame.snapshotVisibleMessageCount === 0,
      ).length,
      exposedPositionCount: exposedPositions.size,
      exposedPositions: [...exposedPositions],
      exposedPositionSpan: exposedPositions.size > 0
        ? Math.max(...exposedPositions) - Math.min(...exposedPositions)
        : 0,
      scrollBehavior: getComputedStyle(list).scrollBehavior,
      pseudoOverlayContent: getComputedStyle(
        document.querySelector<HTMLElement>(".message-list-shell")!,
        "::after",
      ).content,
    };
  });
  expect(result.targetOffset, JSON.stringify(result)).toBeGreaterThanOrEqual(-1);
  expect(result.targetOffset, JSON.stringify(result)).toBeLessThan(result.listHeight);
  expect(result.latestVisible).toBe(false);
  expect(
    result.placeholderFrameCount + result.transitionCoveredFrameCount,
  ).toBe(0);
  expect(result.snapshotCoveredFrameCount).toBeGreaterThan(0);
  expect(result.emptySnapshotFrameCount).toBe(0);
  expect(result.exposedPositionSpan, JSON.stringify(result.exposedPositions)).toBeLessThanOrEqual(4);
  expect(result.scrollBehavior).toBe("auto");
  expect(result.pseudoOverlayContent).toBe("none");
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      getPerformanceRecords: () => Array<{
        event: string;
        details: { navigationKind?: number; missingStageMask?: number };
      }>;
    };
    return module.getPerformanceRecords()
      .filter((record) => record.event === "ui_conversation_switch")
      .at(-1)?.details.missingStageMask;
  }, "/src/utils/performanceMonitor.ts")).toBe(0);
});

test("conversation switch snapshot preserves the source message geometry", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const geometry = await page.evaluate(async () => {
    const snapshotModule = await (0, eval)(
      'import("/src/utils/conversationSwitchSnapshot.ts")',
    ) as {
      captureConversationSwitchSnapshot: (targetIdentity: string) => {
        element: HTMLElement;
        content: HTMLElement;
      } | undefined;
      removeConversationSwitchSnapshot: (
        snapshot: { element: HTMLElement; content: HTMLElement } | undefined,
      ) => void;
    };
    const sourceList = document.querySelector<HTMLElement>(
      ".conversation .message-list",
    );
    const sourceContent = sourceList?.querySelector<HTMLElement>(".message-list-content");
    if (!sourceList || !sourceContent) throw new Error("Source message list is unavailable");

    const readRows = (list: HTMLElement) => {
      const listBounds = list.getBoundingClientRect();
      return new Map(
        [...list.querySelectorAll<HTMLElement>("[data-message-id]")].flatMap((row) => {
          const bubble = row.querySelector<HTMLElement>(".message-bubble-shell");
          if (!row.dataset.messageId || !bubble) return [];
          const bubbleBounds = bubble.getBoundingClientRect();
          const textBounds = row.querySelector<HTMLElement>(".message-rich-text")
            ?.getBoundingClientRect();
          return [[row.dataset.messageId, {
            left: bubbleBounds.left - listBounds.left,
            right: listBounds.right - bubbleBounds.right,
            top: bubbleBounds.top - listBounds.top,
            bottom: listBounds.bottom - bubbleBounds.bottom,
            width: bubbleBounds.width,
            textWidth: textBounds?.width ?? 0,
            textHeight: textBounds?.height ?? 0,
          }] as const];
        }),
      );
    };
    const readList = (list: HTMLElement, content: HTMLElement) => ({
      clientWidth: list.clientWidth,
      clientHeight: list.clientHeight,
      contentWidth: content.getBoundingClientRect().width,
      scrollTop: list.scrollTop,
      scrollbarWidth: getComputedStyle(list).scrollbarWidth,
      hasPinnedBanner: Boolean(list.parentElement?.querySelector(".pinned-message-banner")),
    });

    const sourceRows = readRows(sourceList);
    const source = readList(sourceList, sourceContent);
    const sourceCanvases = [...sourceList.querySelectorAll<HTMLCanvasElement>("canvas")]
      .map((canvas) => canvas.toDataURL());
    const snapshot = snapshotModule.captureConversationSwitchSnapshot("geometry-test");
    if (!snapshot) throw new Error("Conversation switch snapshot was not captured");
    try {
      const cloneList = snapshot.content.closest<HTMLElement>(".message-list");
      if (!cloneList) throw new Error("Snapshot message list is unavailable");
      const cloneRows = readRows(cloneList);
      const cloneCanvases = [...cloneList.querySelectorAll<HTMLCanvasElement>("canvas")]
        .map((canvas) => canvas.toDataURL());
      const differences = [...sourceRows].flatMap(([id, sourceRow]) => {
        const cloneRow = cloneRows.get(id);
        if (!cloneRow) return [];
        return Object.keys(sourceRow).map((key) =>
          Math.abs(
            sourceRow[key as keyof typeof sourceRow] - cloneRow[key as keyof typeof cloneRow],
          )
        );
      });
      return {
        source,
        clone: readList(cloneList, snapshot.content),
        sharedRows: [...sourceRows.keys()].filter((id) => cloneRows.has(id)).length,
        maxRowDifference: Math.max(0, ...differences),
        canvasCount: sourceCanvases.length,
        canvasPixelsMatch: cloneCanvases.length === sourceCanvases.length &&
          cloneCanvases.every((canvas, index) => canvas === sourceCanvases[index]),
      };
    } finally {
      snapshotModule.removeConversationSwitchSnapshot(snapshot);
    }
  });

  expect(geometry.source.hasPinnedBanner).toBe(true);
  expect(geometry.clone.hasPinnedBanner).toBe(true);
  expect(geometry.clone.scrollbarWidth).toBe(geometry.source.scrollbarWidth);
  expect(geometry.clone.clientWidth).toBe(geometry.source.clientWidth);
  expect(geometry.clone.clientHeight).toBe(geometry.source.clientHeight);
  expect(geometry.clone.contentWidth).toBeCloseTo(geometry.source.contentWidth, 1);
  expect(geometry.clone.scrollTop).toBeCloseTo(geometry.source.scrollTop, 1);
  expect(geometry.sharedRows).toBeGreaterThan(0);
  expect(geometry.maxRowDifference).toBeLessThanOrEqual(0.1);
  expect(geometry.canvasCount).toBeGreaterThan(0);
  expect(geometry.canvasPixelsMatch).toBe(true);
});

test("read conversations settle behind a non-empty switch snapshot", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const sampleChenSwitch = () => page.evaluate(async () => {
    const row = document.querySelector<HTMLElement>('[data-chat-id="chat-chen"]')!;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    const samples: Array<{
      busy: string | null;
      placeholder: boolean;
      transitionCovered: boolean;
      snapshotCovered: boolean;
      messageCount: number;
      distanceBottom: number;
    }> = [];
    let settledFrames = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const activeChatId = document.querySelector<HTMLElement>(
        '.chat-row[aria-current="true"]',
      )?.dataset.chatId;
      const list = document.querySelector<HTMLElement>(".message-list");
      const shell = document.querySelector<HTMLElement>(".message-list-shell");
      if (activeChatId !== "chat-chen" || !list || !shell) continue;
      const sample = {
        busy: list.getAttribute("aria-busy"),
        placeholder: Boolean(shell.querySelector(".message-positioning-placeholder")),
        transitionCovered: document.documentElement.classList.contains(
          "is-conversation-view-transition",
        ),
        snapshotCovered: Boolean(document.querySelector("[data-conversation-switch-snapshot]")),
        messageCount: list.querySelectorAll("[data-message-id]").length,
        distanceBottom: Math.round(list.scrollHeight - list.clientHeight - list.scrollTop),
      };
      samples.push(sample);
      settledFrames = sample.busy === "false" && sample.messageCount > 0 &&
          !sample.transitionCovered && !sample.snapshotCovered
        ? settledFrames + 1
        : 0;
      if (settledFrames >= 8) break;
    }
    return samples;
  });
  const expectOnlyBottomFrames = (frames: Awaited<ReturnType<typeof sampleChenSwitch>>) => {
    const positioned = frames.filter(
      (frame) => frame.busy === "false" && frame.messageCount > 0,
    );
    expect(positioned.length, JSON.stringify(frames)).toBeGreaterThan(0);
    expect(Math.max(...positioned.map((frame) => Math.abs(frame.distanceBottom))))
      .toBeLessThanOrEqual(1);
    expect(frames.some((frame) => frame.snapshotCovered), JSON.stringify(frames)).toBe(true);
  };

  expectOnlyBottomFrames(await sampleChenSwitch());
  await expect(page.locator('[data-message-id="c-2"]')).toBeVisible();
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  expectOnlyBottomFrames(await sampleChenSwitch());
});

test("conversation selection, header, and rows commit to one target", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const samples = await page.evaluate(async () => {
    document.querySelector<HTMLElement>('[data-chat-id="chat-chen"]')?.click();
    const frames: Array<{
      activeChatId?: string;
      title?: string;
      snapshot: boolean;
      sourceRowsInTarget: number;
    }> = [];
    let settledFrames = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const activeChatId = document.querySelector<HTMLElement>(
        '.chat-row[aria-current="true"]',
      )?.dataset.chatId;
      if (activeChatId !== "chat-chen") continue;
      const snapshot = document.querySelector<HTMLElement>(
        "[data-conversation-switch-snapshot]",
      );
      const list = document.querySelector<HTMLElement>(".message-list");
      frames.push({
        activeChatId,
        title: document.querySelector<HTMLElement>(".conversation-title strong")?.textContent ??
          undefined,
        snapshot: Boolean(snapshot),
        sourceRowsInTarget: list
          ? [...list.querySelectorAll<HTMLElement>("[data-message-id]")]
            .filter((row) => row.dataset.messageId?.startsWith("p-")).length
          : 0,
      });
      settledFrames = !snapshot && list?.getAttribute("aria-busy") === "false"
        ? settledFrames + 1
        : 0;
      if (settledFrames >= 6) break;
    }
    return frames;
  });

  expect(samples.length).toBeGreaterThan(0);
  expect(samples.every((sample) => sample.activeChatId === "chat-chen"), JSON.stringify(samples))
    .toBe(true);
  expect(samples.every((sample) => sample.title === "陈默"), JSON.stringify(samples)).toBe(true);
  expect(samples.some((sample) => sample.snapshot), JSON.stringify(samples)).toBe(true);
  expect(samples.some((sample) => sample.sourceRowsInTarget > 0), JSON.stringify(samples)).toBe(false);

  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-chat-id="chat-product"]')?.click();
    globalThis.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("[data-conversation-switch-snapshot]")).toHaveCount(0);
});

test("stalled background history never leaves source messages over the destination chat", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.locator('[data-chat-id="chat-chen"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-message-id="c-2"]')).toBeVisible();
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { histories: Map<string, unknown> };
        setState: (partial: { histories: Map<string, unknown> }) => void;
      };
    };
    const histories = new Map(storeModule.telegramStore.getState().histories);
    histories.set("chat-chen", { loading: true, hasMore: true, initialized: true });
    storeModule.telegramStore.setState({ histories });
  }, "/src/store/telegramStore.ts");

  await page.locator('[data-chat-id="chat-chen"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("陈默");
  await expect(page.locator("[data-conversation-switch-snapshot]")).toHaveCount(0, {
    timeout: 1_000,
  });
  await expect.poll(() => page.locator('.message-list [data-message-id^="c-"]').count())
    .toBeGreaterThan(0);

  const messageIds = await page.locator(".message-list [data-message-id]")
    .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.messageId ?? ""));
  expect(messageIds.length).toBeGreaterThan(0);
  expect(messageIds.some((id) => id.startsWith("p-")), JSON.stringify(messageIds)).toBe(false);
  expect(messageIds.some((id) => id.startsWith("c-")), JSON.stringify(messageIds)).toBe(true);
});

test("initial history completion remounts the list at the latest message", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        };
        setState: (partial: {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const fullHistory = state.messages.get("chat-product") ?? [];
    (window as typeof window & { __notgramFullHistory?: unknown[] }).__notgramFullHistory = fullHistory;
    const messages = new Map(state.messages);
    messages.set("chat-product", fullHistory.slice(-1));
    const histories = new Map(state.histories);
    histories.set("chat-product", { loading: true, hasMore: true, initialized: false });
    storeModule.telegramStore.setState({ messages, histories });
  }, "/src/store/telegramStore.ts");
  await expect(page.locator(".message-list [data-message-id]")).toHaveCount(1);

  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        };
        setState: (partial: {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set(
      "chat-product",
      (window as typeof window & { __notgramFullHistory?: unknown[] }).__notgramFullHistory ?? [],
    );
    const histories = new Map(state.histories);
    histories.set("chat-product", { loading: false, hasMore: true, initialized: true });
    storeModule.telegramStore.setState({ messages, histories });
  }, "/src/store/telegramStore.ts");

  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => page.locator(".message-list [data-message-id]").count())
    .toBeGreaterThan(3);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator('[data-message-id="p-video"]')).toBeVisible();
});

test("warm conversation switches reuse messages and reveal content promptly", async ({ page }) => {
  await page.goto("/");
  const product = page.locator('[data-chat-id="chat-product"]');
  const mia = page.locator('[data-chat-id="chat-mia"]');

  await mia.click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await product.click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const messageCounts = async () => page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, unknown[]> };
      };
    };
    const state = storeModule.telegramStore.getState();
    return {
      product: state.messages.get("chat-product")?.length ?? 0,
      mia: state.messages.get("chat-mia")?.length ?? 0,
    };
  }, "/src/store/telegramStore.ts");
  const beforeCounts = await messageCounts();

  const timing = await page.evaluate(async () => {
    const row = document.querySelector<HTMLElement>('[data-chat-id="chat-mia"]')!;
    const startedAt = performance.now();
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    let headerMs: number | undefined;
    let firstMessageMs: number | undefined;
    let contentMs: number | undefined;
    let placeholderFrames = 0;
    let snapshotFrames = 0;
    let emptySnapshotFrames = 0;
    let emptyFramesAfterHeader = 0;
    while (performance.now() - startedAt < 2_000) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (
        headerMs === undefined &&
        document.querySelector(".conversation-title strong")?.textContent === "Mia Chen"
      ) {
        headerMs = performance.now() - startedAt;
      }
      const list = document.querySelector(".message-list");
      const messageCount = list?.querySelectorAll("[data-message-id]").length ?? 0;
      const placeholderVisible = Boolean(document.querySelector(".message-positioning-placeholder"));
      const snapshot = document.querySelector<HTMLElement>(
        "[data-conversation-switch-snapshot]",
      );
      const snapshotVisible = Boolean(snapshot);
      if (placeholderVisible) placeholderFrames += 1;
      if (snapshotVisible) {
        snapshotFrames += 1;
        if (
          Number(snapshot?.dataset.snapshotMessageCount ?? 0) === 0 ||
          Number(snapshot?.dataset.snapshotVisibleMessageCount ?? 0) === 0
        ) {
          emptySnapshotFrames += 1;
        }
      }
      if (
        headerMs !== undefined && messageCount === 0 &&
        !placeholderVisible && !snapshotVisible
      ) {
        emptyFramesAfterHeader += 1;
      }
      if (headerMs !== undefined && firstMessageMs === undefined && messageCount > 0) {
        firstMessageMs = performance.now() - startedAt;
      }
      if (
        firstMessageMs !== undefined &&
        list?.getAttribute("aria-busy") === "false" &&
        !snapshotVisible
      ) {
        contentMs = performance.now() - startedAt;
        break;
      }
    }
    return {
      headerMs,
      firstMessageMs,
      contentMs,
      placeholderFrames,
      snapshotFrames,
      emptySnapshotFrames,
      emptyFramesAfterHeader,
    };
  });

  expect(timing.headerMs).toBeDefined();
  expect(timing.headerMs!).toBeLessThan(100);
  expect(timing.firstMessageMs).toBeDefined();
  expect(timing.firstMessageMs!).toBeLessThan(100);
  expect(timing.contentMs).toBeDefined();
  expect(timing.contentMs!).toBeLessThan(300);
  expect(timing.placeholderFrames).toBe(0);
  expect(timing.snapshotFrames).toBeGreaterThan(0);
  expect(timing.emptySnapshotFrames).toBe(0);
  expect(timing.emptyFramesAfterHeader).toBe(0);

  await product.click();
  await mia.click();
  await product.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  expect(await messageCounts()).toEqual(beforeCounts);
});

test("warm conversation switching coalesces message-list geometry checks", async ({ page }) => {
  await page.goto("/");
  const product = page.locator('[data-chat-id="chat-product"]');
  const mia = page.locator('[data-chat-id="chat-mia"]');

  await mia.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await product.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await mia.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const result = await page.evaluate(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
    if (!descriptor?.get) throw new Error("Element.scrollHeight getter is unavailable");
    let scrollHeightReads = 0;
    let readsThisFrame = 0;
    let maxReadsPerFrame = 0;
    Object.defineProperty(Element.prototype, "scrollHeight", {
      ...descriptor,
      get() {
        if (this instanceof HTMLElement && this.classList.contains("message-list")) {
          scrollHeightReads += 1;
          readsThisFrame += 1;
        }
        return descriptor.get!.call(this);
      },
    });

    try {
      document.querySelector<HTMLElement>('[data-chat-id="chat-product"]')?.click();
      let stableFrames = 0;
      for (let frame = 0; frame < 120; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        maxReadsPerFrame = Math.max(maxReadsPerFrame, readsThisFrame);
        readsThisFrame = 0;
        const settled = document.querySelector(".conversation-title strong")?.textContent === "产品讨论" &&
          document.querySelector(".message-list")?.getAttribute("aria-busy") === "false" &&
          !document.querySelector("[data-conversation-switch-snapshot]");
        stableFrames = settled ? stableFrames + 1 : 0;
        if (stableFrames >= 2) break;
      }
      return {
        scrollHeightReads,
        maxReadsPerFrame,
        mountedMessages: document.querySelectorAll(".message-list [data-message-id]").length,
        settled: stableFrames >= 2,
      };
    } finally {
      Object.defineProperty(Element.prototype, "scrollHeight", descriptor);
    }
  });

  expect(result.settled, JSON.stringify(result)).toBe(true);
  expect(result.mountedMessages).toBeGreaterThan(3);
  expect(result.scrollHeightReads).toBeGreaterThan(0);
  expect(result.maxReadsPerFrame, JSON.stringify(result)).toBeLessThanOrEqual(12);
});

test("idle bottom following remains motionless after geometry settles", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await page.waitForTimeout(250);

  const samples = await messageList.evaluate(async (element) => {
    const frames: Array<{
      scrollTop: number;
      distanceBottom: number;
      latestGap: number;
    }> = [];
    for (let frame = 0; frame < 90; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const messages = element.querySelectorAll<HTMLElement>("[data-message-id]");
      const latest = messages.item(messages.length - 1);
      frames.push({
        scrollTop: element.scrollTop,
        distanceBottom: element.scrollHeight - element.clientHeight - element.scrollTop,
        latestGap: latest
          ? element.getBoundingClientRect().bottom - latest.getBoundingClientRect().bottom
          : 0,
      });
    }
    return frames;
  });
  const span = (values: number[]) => Math.max(...values) - Math.min(...values);
  expect(
    Math.max(...samples.map(({ latestGap }) => Math.abs(latestGap))),
    JSON.stringify(samples),
  )
    .toBeLessThanOrEqual(13);
  expect(span(samples.map(({ distanceBottom }) => distanceBottom))).toBeLessThanOrEqual(0.5);
  expect(span(samples.map(({ scrollTop }) => scrollTop))).toBeLessThanOrEqual(0.5);
  expect(span(samples.map(({ latestGap }) => latestGap))).toBeLessThanOrEqual(1);
});

test("rapid alternating conversation clicks commit every latest intent without a cooldown", async ({ page }) => {
  await page.goto("/");
  const product = page.locator('[data-chat-id="chat-product"]');
  const mia = page.locator('[data-chat-id="chat-mia"]');
  await mia.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await product.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const observations = await page.evaluate(() => {
    const sequence = Array.from({ length: 24 }, (_, index) =>
      index % 2 === 0 ? "chat-mia" : "chat-product");
    return sequence.map((chatId) => {
      document.querySelector<HTMLElement>(`[data-chat-id="${chatId}"]`)?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }),
      );
      return {
        expected: chatId,
        active: document.querySelector<HTMLElement>('.chat-row[aria-current="true"]')?.dataset.chatId,
        transitionCovered: document.documentElement.classList.contains(
          "is-conversation-view-transition",
        ),
      };
    });
  });

  expect(observations.map(({ active }) => active))
    .toEqual(observations.map(({ expected }) => expected));
  expect(observations.some(({ transitionCovered }) => transitionCovered)).toBe(false);
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
});

test("outgoing messages stay inside the conversation at narrow widths and interface zoom", async ({ page }) => {
  for (const scenario of [
    { width: 464, zoom: "1" },
    { width: 580, zoom: "1.25" },
  ]) {
    await page.setViewportSize({ width: scenario.width, height: 620 });
    await page.goto("/");
    await page.locator('[data-chat-id="chat-product"]').click();
    await expect(page.locator(".message-row.is-outgoing").last()).toBeVisible();
    await page.locator("html").evaluate((element, zoom) => { element.style.zoom = zoom; }, scenario.zoom);

    const layout = await page.locator(".message-list").evaluate((list) => {
      const content = list.querySelector<HTMLElement>(".message-list-content");
      const outgoing = [...list.querySelectorAll<HTMLElement>(".message-row.is-outgoing")];
      const listBounds = list.getBoundingClientRect();
      const contentBounds = content?.getBoundingClientRect();
      const scale = listBounds.width / (list as HTMLElement).offsetWidth;
      const paddingRight = Number.parseFloat(getComputedStyle(list).paddingRight) * scale;
      const contentRightLimit = listBounds.left
        + ((list as HTMLElement).clientWidth * scale)
        - paddingRight;
      return {
        contentRight: contentBounds?.right ?? Number.POSITIVE_INFINITY,
        contentRightLimit,
        listRight: listBounds.right,
        overflowX: getComputedStyle(list).overflowX,
        outgoingRightEdges: outgoing.map((row) => {
          const shell = row.querySelector<HTMLElement>(".message-bubble-shell");
          const bubble = row.querySelector<HTMLElement>(".message-bubble");
          return {
            shell: shell?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
            bubble: bubble?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
          };
        }),
      };
    });

    expect(layout.overflowX).toBe("hidden");
    expect(layout.contentRight).toBeLessThanOrEqual(layout.contentRightLimit + 1);
    expect(layout.contentRight).toBeLessThan(layout.listRight);
    for (const edge of layout.outgoingRightEdges) {
      expect(edge.shell).toBeLessThanOrEqual(layout.contentRight + 1);
      expect(edge.bubble).toBeLessThanOrEqual(layout.contentRight + 1);
    }
  }
});

test("incoming virtual blocks preserve the sender avatar column", async ({ page }) => {
  await page.setViewportSize({ width: 525, height: 812 });
  await page.goto("/");
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".message-list")).toBeVisible();
  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        };
        setState: (partial: {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set("chat-product", Array.from({ length: 6 }, (_, index) => ({
      id: `virtual-incoming-${index + 1}`,
      chatId: "chat-product",
      senderId: "u-mia",
      outgoing: false,
      sentAt: new Date(Date.UTC(2026, 7, 4, 0, 0, index)).toISOString(),
      delivery: "read",
      content: { kind: "text", text: `连续来信 ${index + 1}` },
    })));
    const histories = new Map(state.histories);
    histories.set("chat-product", { loading: false, hasMore: false });
    storeModule.telegramStore.setState({ messages, histories });
  }, "/src/store/telegramStore.ts");

  await expect(page.locator('[data-message-id="virtual-incoming-6"]')).toBeVisible();
  const incomingGroups = page.locator(".message-group.is-incoming");
  await expect(incomingGroups).toHaveCount(2);
  const alignment = await incomingGroups.evaluateAll((groups) => {
    const content = groups[0]?.closest(".message-list-content");
    const contentLeft = content?.getBoundingClientRect().left ?? Number.NEGATIVE_INFINITY;
    return groups.map((group) => ({
      avatarSlots: group.querySelectorAll(".message-group-avatar").length,
      avatars: group.querySelectorAll(".message-group-avatar .avatar").length,
      avatarPosition: group.querySelector<HTMLElement>(".message-sender-avatar")
        ? getComputedStyle(group.querySelector<HTMLElement>(".message-sender-avatar")!).position
        : null,
      stackOffset: Math.round(
        (group.querySelector<HTMLElement>(".message-group-stack")?.getBoundingClientRect().left
          ?? Number.POSITIVE_INFINITY) - contentLeft,
      ),
    }));
  });
  expect(alignment).toEqual([
    { avatarSlots: 1, avatars: 0, avatarPosition: null, stackOffset: 42 },
    { avatarSlots: 1, avatars: 1, avatarPosition: "sticky", stackOffset: 42 },
  ]);
  const visibleAvatar = incomingGroups.nth(1).locator(".message-group-avatar .avatar");
  await expect(visibleAvatar).toHaveCSS("position", "relative");
  await expect(visibleAvatar).toHaveCSS("overflow", "hidden");
  await expect(visibleAvatar).toHaveCSS("border-radius", "50%");
});

test("media cache controls clean selected data and protect active files", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("notgram:cache-cleanup:default", String(Date.now()));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /高级设置/ }).click();

  const cacheSection = page.locator("section", {
    has: page.getByRole("heading", { name: "媒体缓存", exact: true }),
  });
  await expect(cacheSection.locator(".cache-usage-summary")).toContainText("46.5 MB");
  await expect(cacheSection.locator(".cache-category-row")).toHaveCount(5);
  for (const category of ["视频", "音频", "文件", "其他"]) {
    await cacheSection.locator(".cache-category-row", { hasText: category })
      .getByRole("checkbox").uncheck();
  }
  await cacheSection.getByLabel("自动清理周期").selectOption("30");
  await cacheSection.getByRole("button", { name: "清理所选" }).click();
  await expect(cacheSection.locator(".cache-cleanup-result"))
    .toContainText("已清理 6.0 MB，共 9 个文件；已保护 1 个正在使用的文件");
  await expect(cacheSection.locator(".cache-usage-summary")).toContainText("40.5 MB");

  const autoSection = page.locator("section", {
    has: page.getByRole("heading", { name: "自动下载", exact: true }),
  });
  await expect(autoSection.getByRole("switch", { name: "图片、贴纸与动画" })).toBeChecked();
  await expect(autoSection.getByRole("switch", { name: "视频与视频消息" })).not.toBeChecked();
  await expect(autoSection.getByLabel("单个文件上限")).toHaveValue("10");

  await cacheSection.getByRole("button", { name: "清理全部缓存" }).click();
  await expect(cacheSection.locator(".cache-usage-summary")).toContainText("0 B");
  await expect(cacheSection.locator(".cache-cleanup-result"))
    .toContainText("已清理 40.5 MB，共 9 个文件；已保护 1 个正在使用的文件");
  expect(await horizontalOverflow(page)).toBe(false);

  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 700 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /高级设置/ }).click();
  await cacheSection.scrollIntoViewIfNeeded();
  await expect(cacheSection.locator(".cache-category-row")).toHaveCount(5);
  expect(await horizontalOverflow(page)).toBe(false);
});

const chooseMessageMenuItem = async (page: Page, name: string) => {
  const menu = page.getByRole("menu", { name: "消息操作" });
  const items = menu.getByRole("menuitem");
  const item = menu.getByRole("menuitem", { name, exact: true });
  await expect(item).toBeVisible();
  await expect(items.first()).toBeFocused();
  const labels = (await items.allTextContents()).map((label) => label.trim());
  const targetIndex = labels.indexOf(name);
  expect(targetIndex).toBeGreaterThanOrEqual(0);
  if (targetIndex === labels.length - 1) {
    await page.keyboard.press("End");
  } else {
    await page.keyboard.press("Home");
    for (let step = 0; step < targetIndex; step += 1) {
      await page.keyboard.press("ArrowDown");
    }
  }
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");
};

test("background syncing does not show a composer status banner", async ({ page }) => {
  await page.goto("/?connection=syncing");
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
  await expect(page.locator(".composer-connection-status")).toHaveCount(0);

  await page.goto("/?connection=waitingForNetwork");
  await expect(page.locator(".composer-connection-status"))
    .toContainText("正在等待网络");
});

test("offline text messages survive a restart in the snapshot model", async ({ page }) => {
  await page.goto("/?connection=waitingForNetwork");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.fill("queued across restart");
  await page.getByRole("button", { name: "发送消息" }).click();

  await expect(page.locator(".composer-outbox-status"))
    .toContainText("1 条消息将在联网后发送");
  await expect(page.getByText("queued across restart", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.locator(".composer-outbox-status"))
    .toContainText("1 条消息将在联网后发送");
  await expect(page.getByText("queued across restart", { exact: true })).toBeVisible();
});

test("offline attachments survive restart and can be cancelled", async ({ page }) => {
  await page.goto("/?connection=waitingForNetwork");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(new File(["offline attachment"], "offline-note.txt", {
      type: "text/plain",
      lastModified: 1_775_000_000_000,
    }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  });
  await composer.fill("离线附件说明");
  await page.getByRole("button", { name: "发送附件" }).click();

  await expect(page.locator(".composer-outbox-status"))
    .toContainText("1 个附件将在联网后上传");
  await expect(page.getByText("offline-note.txt", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "取消上传 offline-note.txt" })).toBeVisible();

  await page.reload();
  await expect(page.locator(".composer-outbox-status"))
    .toContainText("1 个附件将在联网后上传");
  await expect(page.getByText("offline-note.txt", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "取消上传 offline-note.txt" }).click();
  await expect(page.getByText("offline-note.txt", { exact: true })).toBeHidden();
  await expect(page.locator(".composer-outbox-status")).toBeHidden();
});

test("creates a public supergroup with initial members and permissions", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新建群组或频道" }).click();
  const dialog = page.getByRole("dialog", { name: "新建聊天" });
  await expect(dialog).toBeVisible();

  await dialog.getByText("超级群组", { exact: true }).click();
  await dialog.getByLabel("名称", { exact: true }).fill("Notgram QA Team");
  await dialog.getByLabel("简介", { exact: true }).fill("桌面客户端验收协作");
  await dialog.getByRole("checkbox", { name: "公开聊天" }).check();
  await dialog.getByLabel("公开用户名", { exact: true }).fill("notgram_qa_team");
  await dialog.getByLabel("成员权限模板").selectOption("restricted");
  await dialog.locator(".new-chat-member-row", { hasText: "Mia Chen" }).getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "创建", exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(".conversation-title strong")).toHaveText("Notgram QA Team");
  await expect(page.locator('.chat-row[data-chat-id^="chat-created-"]')).toContainText("Notgram QA Team");
  await page.locator(".conversation-profile-trigger").click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile).toContainText("桌面客户端验收协作");
  await profile.locator(".profile-navigation > button").filter({ hasText: "成员" }).click();
  await expect(profile.locator(".profile-member-row")).toHaveCount(2);
});

test("manages member exceptions, default permissions, and audit events", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "查看 产品讨论 资料" }).click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await profile.getByRole("button", { name: "管理", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: /管理“产品讨论”/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".management-member-row")).toHaveCount(4);
  await dialog.getByLabel("设置 Mia Chen 的角色").selectOption("restricted");
  await expect(dialog.getByLabel("设置 Mia Chen 的角色")).toHaveValue("restricted");

  await dialog.getByRole("button", { name: "权限" }).click();
  const polls = dialog.getByRole("checkbox", { name: "发送投票" }).first();
  await polls.uncheck();
  await dialog.getByRole("button", { name: "保存默认权限" }).click();
  await expect(dialog.getByLabel("慢速模式间隔")).toHaveCount(0);
  await expect(dialog.getByText("成员例外权限", { exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "审计日志" }).click();
  await expect(dialog.getByText("更新群组默认发送权限", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "关闭管理面板" }).click();
  await expect(dialog).toBeHidden();
});

test("creates and governs invite links and join requests", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "查看 产品讨论 资料" }).click();
  await page.getByRole("dialog", { name: "资料" }).getByRole("button", { name: "管理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /管理“产品讨论”/ });
  await dialog.getByRole("button", { name: "邀请", exact: true }).click();
  await expect(dialog.getByText("主邀请链接", { exact: false })).toBeVisible();
  await dialog.getByLabel("邀请链接名称").fill("QA 临时入口");
  await dialog.getByLabel("邀请链接使用人数").fill("8");
  await dialog.getByLabel("新成员需要管理员批准").check();
  await dialog.getByRole("button", { name: "创建链接" }).click();
  const createdRow = dialog.locator(".invite-link-row", { hasText: "QA 临时入口" });
  await expect(createdRow).toBeVisible();
  await createdRow.getByRole("button", { name: "复制 QA 临时入口" }).click();
  await createdRow.getByRole("button", { name: "编辑" }).click();
  await dialog.getByLabel("邀请链接名称").fill("QA 临时入口（已编辑）");
  await dialog.getByRole("button", { name: "保存链接" }).click();
  await expect(dialog.getByText("QA 临时入口（已编辑）", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "全部批准" }).click();
  await expect(dialog.getByText("暂无待处理申请", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "关闭管理面板" }).click();
});

test("suggests bot commands and sends paginated inline results", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByLabel("消息内容");
  await composer.fill("/");
  const suggestions = page.getByRole("listbox", { name: "机器人命令建议" });
  await expect(suggestions.getByRole("option")).toHaveCount(3);
  const firstSuggestion = suggestions.getByRole("option").first();
  const suggestionLayout = await firstSuggestion.evaluate((element) => {
    const command = element.querySelector<HTMLElement>(".bot-suggestion-command");
    const description = element.querySelector<HTMLElement>(".bot-suggestion-description");
    return {
      width: element.getBoundingClientRect().width,
      commandBottom: command?.getBoundingClientRect().bottom ?? 0,
      descriptionTop: description?.getBoundingClientRect().top ?? 0,
    };
  });
  expect(suggestionLayout.width).toBeGreaterThan(320);
  expect(suggestionLayout.commandBottom).toBeLessThanOrEqual(suggestionLayout.descriptionTop + 1);
  await composer.fill("/he");
  await expect(suggestions.getByRole("option")).toHaveCount(1);
  await composer.press("Enter");
  await expect(composer).toHaveValue("/help@notgram_bot ");
  await composer.fill("/st");
  await expect(suggestions.getByRole("option")).toHaveCount(1);
  await suggestions.getByRole("option").click();
  await expect(composer).toHaveValue("/start@notgram_bot ");
  await composer.fill("/start@notgram_bot campaign");
  await composer.press("Enter");
  await expect(page.getByText("/start campaign", { exact: true })).toBeVisible();

  await composer.fill("@notgram_bot release");
  const inline = page.getByRole("region", { name: "Inline 查询结果" });
  await expect(inline.getByRole("button").filter({ hasText: "快速摘要" })).toBeVisible();
  await inline.getByRole("button").filter({ hasText: "快速摘要" }).click();
  await expect(page.getByText("@notgram_bot: release", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Release Notes/ }).first().click();
  await composer.fill("/he");
  await composer.fill("/");
  await expect(suggestions.getByRole("option")).toHaveCount(3);
});

test("renders and activates TDLib inline bot keyboards", async ({ page }) => {
  await page.goto("/");
  const row = await revealVirtualMessage(page, "p-bot-keyboard");
  const keyboard = row.locator(".message-inline-keyboard");
  await expect(keyboard).toBeVisible();
  await expect(keyboard.locator(".message-inline-keyboard-row")).toHaveCount(2);
  await expect(keyboard.locator(".message-inline-keyboard-row").nth(0).getByRole("button"))
    .toHaveCount(8);
  await expect(keyboard.locator(".message-inline-keyboard-row").nth(1).getByRole("button"))
    .toHaveCount(3);
  await keyboard.getByRole("button", { name: "下一页" }).click();
  await expect(keyboard.getByRole("status")).toHaveText("机器人已处理操作");
});

test("opens parameterized bot links and preserves the start payload", async ({ page }) => {
  await page.goto("/");
  const openBotLink = (url: string) => page.evaluate(async (targetUrl) => {
    const modulePath = "/src/utils/externalLinks.ts";
    const { openTelegramLinkInApp } = await import(/* @vite-ignore */ modulePath);
    return openTelegramLinkInApp(targetUrl);
  }, url);

  await expect(openBotLink("https://t.me/notgram_bot?start=verify_A1b2-token"))
    .resolves.toBe(true);
  await expect(page.getByRole("button", { name: "启动机器人" })).toBeVisible();
  await page.getByRole("button", { name: "启动机器人" }).click();
  const botMessages = page.locator(".message-list").getByText("/start verify_A1b2-token", { exact: true });
  await expect(botMessages).toHaveCount(1);
  await expect(page.getByRole("button", { name: "启动机器人" })).toHaveCount(0);

  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  await page.evaluate(() => {
    document.documentElement.dataset.botStartMounted = "false";
    const observer = new MutationObserver(() => {
      if (document.querySelector(".bot-start-bar")) {
        document.documentElement.dataset.botStartMounted = "true";
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    (globalThis as typeof globalThis & { botStartObserver?: MutationObserver }).botStartObserver = observer;
  });
  await expect(openBotLink("tg://resolve?domain=notgram_bot&start=verify_A1b2-token"))
    .resolves.toBe(true);
  await expect(botMessages).toHaveCount(2);
  await expect(page.locator("html")).toHaveAttribute("data-bot-start-mounted", "false");
  await expect(page.getByRole("button", { name: "启动机器人" })).toHaveCount(0);
  await page.evaluate(() => {
    const target = globalThis as typeof globalThis & { botStartObserver?: MutationObserver };
    target.botStartObserver?.disconnect();
    delete target.botStartObserver;
    delete document.documentElement.dataset.botStartMounted;
  });
});

test("long quotes fold to three and a half lines and animate back after collapsing", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /收藏夹/ }).click();
  const row = page.locator('[data-message-id="saved-long-quote"]');
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/is-outgoing/);
  await expect(row.locator(".message-rich-text")).toContainText("引用内容会保持消息正文可读");
  const quote = row.locator(".rich-blockquote");
  await expect(quote).toHaveAttribute("data-quote-state", "collapsed");
  await expect.poll(async () => Number(await quote.getAttribute("data-quote-line-count")))
    .toBeGreaterThan(5);
  await expect(quote.getByRole("button", { name: /展开引用/ })).toBeVisible();
  const collapsed = await quote.evaluate((element) => {
    const content = element.querySelector<HTMLElement>(".rich-blockquote-content")!;
    const fade = element.querySelector<HTMLElement>(".rich-blockquote-fade")!;
    return {
      height: element.getBoundingClientRect().height,
      contentHeight: content.scrollHeight,
      lineHeight: Number.parseFloat(getComputedStyle(content).lineHeight),
      backdropFilter: getComputedStyle(fade).backdropFilter,
    };
  });
  expect(Math.abs(collapsed.height - collapsed.lineHeight * 3.5)).toBeLessThanOrEqual(1);
  expect(collapsed.contentHeight).toBeGreaterThan(collapsed.height);
  expect(collapsed.backdropFilter).toContain("blur");

  await quote.click({ position: { x: 12, y: 8 } });
  await expect(quote).toHaveAttribute("data-quote-state", "expanded");
  await expect(quote.getByRole("button", { name: "收起引用" })).toBeVisible();
  const expandedHeight = await quote.evaluate((element) => element.getBoundingClientRect().height);
  expect(expandedHeight).toBeGreaterThan(collapsed.lineHeight * 5);

  await page.evaluate(() => {
    const originalAnimate = Element.prototype.animate;
    const records: Array<{
      duration: number;
      firstTransform?: string;
      lastTransform?: string;
    }> = [];
    (globalThis as typeof globalThis & { __notgramQuoteCollapseAnimations?: typeof records })
      .__notgramQuoteCollapseAnimations = records;
    Element.prototype.animate = function (keyframes, options) {
      if (this.classList.contains("message-list-content") && Array.isArray(keyframes)) {
        const timing = typeof options === "number" ? { duration: options } : options;
        records.push({
          duration: Number(timing?.duration ?? 0),
          firstTransform: String(keyframes[0]?.transform ?? ""),
          lastTransform: String(keyframes.at(-1)?.transform ?? ""),
        });
      }
      return originalAnimate.call(this, keyframes, options);
    };
  });
  const collapseButton = quote.getByRole("button", { name: "收起引用" });
  await collapseButton.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const recordCollapsePointer = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : undefined;
      if (!target?.closest(".rich-blockquote-collapse")) return;
      (globalThis as typeof globalThis & { __notgramQuoteCollapsePointerY?: number })
        .__notgramQuoteCollapsePointerY = event.clientY;
      document.removeEventListener("click", recordCollapsePointer, true);
    };
    document.addEventListener("click", recordCollapsePointer, true);
  });
  await expect(page.getByRole("button", { name: /^返回跳转前位置/ })).toHaveCount(0);
  await collapseButton.click();
  const collapsePointerY = await page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramQuoteCollapsePointerY?: number }
  ).__notgramQuoteCollapsePointerY ?? Number.NaN);
  expect(Number.isFinite(collapsePointerY)).toBe(true);
  await expect(quote).toHaveAttribute("data-quote-state", "collapsed");
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramQuoteCollapseAnimations?: unknown[] }
  ).__notgramQuoteCollapseAnimations?.length ?? 0)).toBe(2);
  const animations = await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __notgramQuoteCollapseAnimations?: Array<{
        duration: number;
        firstTransform?: string;
        lastTransform?: string;
      }>;
    }
  ).__notgramQuoteCollapseAnimations ?? []);
  expect(animations).toEqual([
    expect.objectContaining({ duration: 120, firstTransform: "translateY(0)", lastTransform: "translateY(8px)" }),
    expect.objectContaining({ duration: 180, firstTransform: "translateY(-8px)", lastTransform: "translateY(0)" }),
  ]);
  await expect(page.locator(".message-list")).not.toHaveClass(/is-jump-transitioning/);
  const expandIcon = quote.locator(".rich-blockquote-expand > svg");
  await expect(expandIcon).toBeVisible();
  await expect.poll(() => expandIcon.evaluate((element, pointerY) => {
    const bounds = element.getBoundingClientRect();
    return pointerY >= bounds.top - 1 && pointerY <= bounds.bottom + 1;
  }, collapsePointerY)).toBe(true);
  await expect(page.getByRole("button", { name: /^返回跳转前位置/ })).toHaveCount(0);
});

test("blocks users and reports chats or selected messages", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "查看 产品讨论 资料" }).click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await profile.getByRole("button", { name: "举报", exact: true }).click();
  const report = page.getByRole("dialog", { name: /举报“产品讨论”/ });
  await expect(report.getByRole("radiogroup", { name: "举报原因" })).toBeVisible();
  await expect(report.getByRole("radio")).toHaveText([
    "垃圾信息或诈骗",
    "暴力或危险内容",
    "色情或成人内容",
    "儿童伤害",
    "侵犯知识产权",
    "与标注地点无关",
    "虚假账号或冒充他人",
    "毒品或违禁药物",
    "泄露个人信息",
    "其他原因",
  ]);
  await report.getByRole("radio", { name: "垃圾信息" }).click();
  await report.getByRole("button", { name: "提交举报" }).click();
  await expect(report).toBeHidden();
  await profile.locator(".profile-navigation > button").filter({ hasText: "成员" }).click();
  await profile.locator(".profile-member-identity").filter({ hasText: "Mia Chen" }).click();
  await profile.getByRole("button", { name: "屏蔽", exact: true }).click();
  await expect(profile.getByRole("button", { name: "解除屏蔽", exact: true })).toBeVisible();
  await profile.getByRole("button", { name: "解除屏蔽", exact: true }).click();
  await profile.getByRole("button", { name: "加入黑名单", exact: true }).click();
  await expect(profile.getByRole("button", { name: "移出黑名单", exact: true })).toBeVisible();
  await profile.getByRole("button", { name: "移出黑名单", exact: true }).click();
  await profile.getByRole("button", { name: "关闭资料" }).click();
  await expect(page.locator(".conversation-profile-trigger")).toBeFocused();

  const message = page.locator('[data-message-id="p-5"] .message-bubble-shell');
  await message.scrollIntoViewIfNeeded();
  await message.focus();
  await page.keyboard.press("Shift+F10");
  await chooseMessageMenuItem(page, "举报");
  const messageReport = page.getByRole("dialog", { name: /举报“产品讨论”/ });
  const reportLayout = await messageReport.evaluate((dialog) => {
    const body = dialog.querySelector<HTMLElement>(".report-dialog-body")!;
    return {
      dialogFits: dialog.scrollHeight <= dialog.clientHeight + 1,
      bodyFits: body.scrollHeight <= body.clientHeight + 1,
      bodyOverflow: getComputedStyle(body).overflowY,
    };
  });
  expect(reportLayout).toEqual({ dialogFits: true, bodyFits: true, bodyOverflow: "visible" });
  await messageReport.getByRole("button", { name: "提交举报" }).click();
  await expect(messageReport).toBeHidden();
});

test("locally masks a group member and reveals messages at the requested scope", async ({ page }) => {
  await page.addInitScript((storageKey) => {
    localStorage.setItem(storageKey, JSON.stringify([{
      accountId: "default",
      userId: "u-mia",
      realName: "Mia Chen",
      realAvatar: { label: "MC", color: "#8d6cab" },
      alias: "小熊",
      aliasAvatar: { label: "🐻", color: "#8b6b55" },
      identityId: "bear",
      blockedAt: "2026-08-21T00:00:00.000Z",
    }]));
  }, "notgram:local-user-blocks:v1");

  await page.goto("/");
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator('.message-list[aria-busy="false"]')).toBeVisible();
  await expect(page.locator(".message-bubble-shell.is-local-block-concealed").first()).toBeVisible();

  const keyboardRow = await revealVirtualMessage(page, "p-bot-keyboard");
  const concealedBounds = await keyboardRow.evaluate((row) => {
    const bubble = row.querySelector<HTMLElement>(":scope > .message-bubble-shell > .message-bubble")!;
    const overlay = bubble.querySelector<HTMLElement>(":scope > .local-block-message-reveal")!;
    return {
      bubble: bubble.getBoundingClientRect().toJSON(),
      overlay: overlay.getBoundingClientRect().toJSON(),
    };
  });
  expect(Math.abs(concealedBounds.bubble.width - concealedBounds.overlay.width)).toBeLessThan(0.5);
  expect(Math.abs(concealedBounds.bubble.height - concealedBounds.overlay.height)).toBeLessThan(0.5);

  const richRow = await revealVirtualMessage(page, "p-rich-message");
  const maskLayering = await richRow.evaluate((row) => {
    const bubble = row.querySelector<HTMLElement>(":scope > .message-bubble-shell > .message-bubble")!;
    const sender = bubble.querySelector<HTMLElement>(":scope > .message-sender-row")!;
    const overlay = bubble.querySelector<HTMLElement>(":scope > .local-block-message-reveal")!;
    const unclippedBlurredChildren = [...bubble.children].filter((child) => {
      const style = getComputedStyle(child);
      return style.filter !== "none" && style.clipPath === "none";
    });
    return {
      senderZIndex: Number.parseInt(getComputedStyle(sender).zIndex, 10),
      overlayZIndex: Number.parseInt(getComputedStyle(overlay).zIndex, 10),
      unclippedBlurredChildren: unclippedBlurredChildren.length,
    };
  });
  expect(maskLayering.unclippedBlurredChildren).toBe(0);
  expect(maskLayering.senderZIndex).toBeGreaterThan(maskLayering.overlayZIndex);

  await openConversationMessageSearch(page);
  await page.getByRole("searchbox", { name: "搜索会话和消息" })
    .fill("desktop-layout-review.pdf");
  const searchResult = page.locator('[data-search-message-id="p-3"]');
  await expect(searchResult).toContainText("desktop-layout-review.pdf");
  await searchResult.click();
  const searchTarget = page.locator('[data-message-id="p-3"]');
  await expect(searchTarget.locator(":scope > .message-bubble-shell"))
    .not.toHaveClass(/is-local-block-concealed/);
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).not.toHaveClass(/is-jump-transitioning/);
  await messageList.hover();
  await page.mouse.wheel(0, 100_000);
  await expect.poll(() => messageList.evaluate((element, messageId) => {
    const row = element.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    if (!row) return true;
    const listBounds = element.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    return rowBounds.bottom <= listBounds.top + 1 || rowBounds.top >= listBounds.bottom - 1;
  }, "p-3")).toBe(true);

  const targetRow = await revealVirtualMessage(page, "p-3");
  await expect(targetRow.locator(":scope > .message-bubble-shell"))
    .toHaveClass(/is-local-block-concealed/);
  await targetRow.locator(".local-block-message-reveal").click();
  await expect(targetRow.locator(":scope > .message-bubble-shell"))
    .not.toHaveClass(/is-local-block-concealed/);
  await expect(page.locator(".message-bubble-shell.is-local-block-concealed").first()).toBeVisible();

  const animalAvatar = page.getByRole("button", {
    name: /显示 小熊 的连续消息和真实身份/,
  }).last();
  await animalAvatar.scrollIntoViewIfNeeded();
  const animalAvatarLayout = await animalAvatar.evaluate((button) => {
    const avatar = button.querySelector<HTMLElement>(".avatar")!;
    const label = button.querySelector<HTMLElement>(".avatar > span")!;
    const avatarBounds = avatar.getBoundingClientRect();
    const labelBounds = label.getBoundingClientRect();
    const labelStyle = getComputedStyle(label);
    return {
      fontSize: Number.parseFloat(labelStyle.fontSize),
      horizontalCenterDelta: (labelBounds.left + labelBounds.width / 2)
        - (avatarBounds.left + avatarBounds.width / 2),
      translateY: new DOMMatrix(labelStyle.transform).m42,
    };
  });
  expect(animalAvatarLayout.fontSize).toBeGreaterThanOrEqual(24);
  expect(Math.abs(animalAvatarLayout.horizontalCenterDelta)).toBeLessThan(0.1);
  expect(animalAvatarLayout.translateY).toBe(-1);
  const groupId = await animalAvatar
    .locator("xpath=ancestor::*[contains(@class, 'message-group')]")
    .locator("[data-local-block-group]")
    .first()
    .getAttribute("data-local-block-group");
  expect(groupId).toBeTruthy();
  await animalAvatar.click();
  await expect(page.locator(`[data-local-block-group="${groupId}"]`)
    .locator(".message-bubble-shell.is-local-block-concealed"))
    .toHaveCount(0);

  await page.getByRole("button", { name: "查看 Mia Chen 资料" }).last().click();
  await expect(page.getByRole("dialog", { name: "资料" })).toBeVisible();
  await page.getByRole("button", { name: "关闭资料" }).click();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("button", { name: /诊断与隐私/ }).click();
  const localBlockSection = settings.locator(".settings-section", { hasText: "屏蔽管理" });
  await expect(localBlockSection.getByText("Mia Chen", { exact: true })).toBeVisible();
  await expect(localBlockSection.getByText(/群聊中显示为 小熊/)).toBeVisible();
  await localBlockSection.getByRole("button", { name: "解除屏蔽" }).click();
  await expect(localBlockSection.getByText("暂无屏蔽用户", { exact: true })).toBeVisible();
});

test("manages device sessions and Telegram privacy rules", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("button", { name: /诊断与隐私/ }).click();
  await expect(settings.getByRole("heading", { name: "设备会话" })).toBeVisible();
  await expect(settings.getByText("当前设备", { exact: true })).toBeVisible();
  const phoneSession = settings.locator(".session-row", { hasText: "Telegram Android" });
  await phoneSession.getByRole("button", { name: "终止" }).click();
  await expect(phoneSession).toBeHidden();
  await settings.getByLabel("手机号码").selectOption("allowContacts");
  await expect(settings.getByLabel("手机号码")).toHaveValue("allowContacts");
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
});

test("keyboard navigation closes modals and completes message workflows", async ({ page }) => {
  await page.goto("/");

  const settingsButton = page.getByRole("button", { name: "设置", exact: true });
  await settingsButton.focus();
  await page.keyboard.press("Enter");
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await expect(settingsDialog).toBeVisible();
  const settingsClose = settingsDialog.getByRole("button", { name: "关闭", exact: true });
  await expect(settingsClose).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(settingsDialog.locator("button:not([disabled]), input:not([disabled])").last())
    .toBeFocused();
  await page.keyboard.press("Tab");
  await expect(settingsClose).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(settingsDialog).toBeHidden();
  await expect(settingsButton).toBeFocused();

  const focusEditableMessage = async () => {
    const editableMessage = await revealVirtualMessage(page, "p-2");
    const trigger = editableMessage.locator(".message-bubble-shell");
    await trigger.focus();
    await expect(trigger).toBeFocused();
    return trigger;
  };
  let actionTrigger = await focusEditableMessage();
  await page.keyboard.press("Shift+F10");
  const actionMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(actionMenu).toBeVisible();
  await expect(actionMenu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Escape");
  await expect(actionMenu).toBeHidden();
  await expect(actionTrigger).toBeFocused();

  await page.keyboard.press("Shift+F10");
  await chooseMessageMenuItem(page, "编辑");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await expect(composer).toBeFocused();
  await composer.fill("keyboard edited message");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message-list").getByText("keyboard edited message", { exact: true }))
    .toBeVisible();
  await expect(composer).toHaveValue("");

  actionTrigger = await focusEditableMessage();
  await page.keyboard.press("Shift+F10");
  await chooseMessageMenuItem(page, "回复");
  await expect(composer).toBeFocused();
  await composer.fill("keyboard reply");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message-list").getByText("keyboard reply", { exact: true }))
    .toBeVisible();
  await expect(composer).toHaveValue("");

  actionTrigger = await focusEditableMessage();
  await page.keyboard.press("Shift+F10");
  await chooseMessageMenuItem(page, "转发");
  const forwardButton = page.getByRole("button", { name: "转发", exact: true });
  await expect(forwardButton).toBeFocused();
  await page.keyboard.press("Enter");
  const forwardDialog = page.getByRole("dialog", { name: /转发 1 条消息/ });
  await expect(forwardDialog.getByRole("searchbox")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(forwardDialog.locator(".forward-target-row").first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(forwardDialog).toBeHidden();

  actionTrigger = await focusEditableMessage();
  await page.keyboard.press("Shift+F10");
  const reactionMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(reactionMenu.getByRole("button", { name: /^回应/ })).toHaveCount(0);
  await expect(reactionMenu.getByRole("menuitem").nth(0)).toHaveText("回复");
  await expect(reactionMenu.getByRole("menuitem").nth(1)).toHaveText("转发");
  await expect(reactionMenu.getByRole("menuitem").nth(2)).toHaveText("复制");
  await page.keyboard.press("Escape");
  await expect(reactionMenu).toBeHidden();
  await expect(actionTrigger).toBeFocused();
});

test("message reactions stay in the bubble and reveal the reacting users", async ({ page }) => {
  await page.goto("/?reactionPreview=1");

  const message = await revealVirtualMessage(page, "p-4");
  const bubble = message.locator(".message-bubble");
  const reactions = bubble.getByRole("group", { name: "消息回应" });
  await expect(reactions).toBeVisible();
  await expect(reactions.locator(":scope > button")).toHaveCount(2);
  await expect(reactions.locator(".message-reaction-avatars .avatar")).toHaveCount(5);
  const footer = bubble.locator(":scope > .message-reaction-footer");
  expect(await footer.evaluate((element) => element.parentElement?.classList.contains("message-bubble")))
    .toBe(true);
  await expect(bubble.locator(".message-text-flow .message-meta")).toHaveCount(0);
  await expect(footer.locator(":scope > .message-meta")).toHaveCount(1);
  const layout = await Promise.all([
    bubble.boundingBox(),
    reactions.boundingBox(),
    reactions.locator(":scope > button").first().boundingBox(),
    footer.locator(":scope > .message-meta").boundingBox(),
  ]);
  expect(layout[0]).not.toBeNull();
  expect(layout[1]).not.toBeNull();
  expect(layout[2]).not.toBeNull();
  expect(layout[3]).not.toBeNull();
  expect(layout[1]!.x).toBeGreaterThanOrEqual(layout[0]!.x);
  expect(layout[1]!.x + layout[1]!.width).toBeLessThanOrEqual(layout[0]!.x + layout[0]!.width + 1);
  expect(Math.abs(layout[2]!.y + layout[2]!.height / 2 - (layout[3]!.y + layout[3]!.height / 2)))
    .toBeLessThanOrEqual(3);
  const reactionStyle = await footer.evaluate((element) => ({
    borderTopStyle: getComputedStyle(element).borderTopStyle,
    emojiSize: getComputedStyle(element.querySelector(".message-reaction-emoji")!).fontSize,
  }));
  expect(reactionStyle.borderTopStyle).toBe("none");
  expect(Number.parseFloat(reactionStyle.emojiSize)).toBeLessThanOrEqual(14);

  const thumbsUp = reactions.getByRole("button", { name: /👍，3 个回应/ });
  await thumbsUp.click({ button: "right" });
  const details = page.getByRole("menu", { name: "👍 的回应者" });
  await expect(details).toBeVisible();
  await expect(details.getByRole("menuitem", { name: "林然", exact: true })).toBeVisible();
  await expect(details.getByRole("menuitem", { name: "Mia Chen", exact: true })).toBeVisible();
  await expect(details.getByRole("menuitem", { name: "陈默", exact: true })).toBeVisible();
  await expect(details.locator(".reaction-details-user .avatar")).toHaveCount(3);
  await expect(details.getByText("正在读取回应者", { exact: true })).toHaveCount(0);
  await expect(details.locator(".reaction-details-header")).toHaveCount(0);
  await expect(details.locator(".reaction-details-user-emoji")).toHaveCount(0);
  const detailsBox = await details.boundingBox();
  expect(detailsBox).not.toBeNull();
  expect(detailsBox!.width).toBeLessThan(214);

  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await expect(thumbsUp).toBeFocused();

  await thumbsUp.click();
  const updatedThumbsUp = reactions.getByRole("button", { name: /👍，2 个回应/ });
  await expect(updatedThumbsUp).toHaveAttribute("aria-pressed", "false");
  await expect(updatedThumbsUp.locator(".message-reaction-avatars .avatar")).toHaveCount(2);

  const outgoingMessage = await revealVirtualMessage(page, "p-2");
  await expect(outgoingMessage).toHaveClass(/is-outgoing/);
  const outgoingBubble = outgoingMessage.locator(".message-bubble");
  const outgoingReaction = outgoingBubble.locator(".message-reactions > button").first();
  const outgoingLayout = await Promise.all([outgoingBubble.boundingBox(), outgoingReaction.boundingBox()]);
  expect(outgoingLayout[0]).not.toBeNull();
  expect(outgoingLayout[1]).not.toBeNull();
  expect(outgoingLayout[1]!.x - outgoingLayout[0]!.x).toBeLessThanOrEqual(11);
});

test("repeat forwards an incoming message directly to the current group only", async ({ page }) => {
  await page.goto("/");

  const incoming = await revealVirtualMessage(page, "p-4");
  await incoming.locator(".message-bubble-shell").click({ button: "right" });
  let menu = page.getByRole("menu", { name: "消息操作" });
  await expect(menu.getByRole("menuitem").nth(1)).toHaveText("转发");
  await expect(menu.getByRole("menuitem").nth(2)).toHaveText("复读");
  await menu.getByRole("menuitem", { name: "复读", exact: true }).click();

  await expect(menu).toBeHidden();
  await expect(page.getByRole("dialog", { name: /转发 \d+ 条消息/ })).toHaveCount(0);
  await expect.poll(() => page.evaluate(async (storePath) => {
    const module = await import(storePath) as {
      telegramStore: { getState: () => { messages: Map<string, Message[]> } };
    };
    return module.telegramStore.getState().messages.get("chat-product")
      ?.filter((message) => message.outgoing && message.forwardInfo?.source?.messageId === "p-4")
      .map((message) => ({ chatId: message.chatId, text: message.content.kind === "text" ? message.content.text : "" }));
  }, "/src/store/telegramStore.ts")).toEqual([{
    chatId: "chat-product",
    text: "我把交互稿更新到最新版本了，下午可以直接走查。",
  }]);

  const outgoing = await revealVirtualMessage(page, "p-2");
  await outgoing.locator(".message-bubble-shell").click({ button: "right" });
  menu = page.getByRole("menu", { name: "消息操作" });
  await expect(menu.getByRole("menuitem", { name: "复读", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.locator('[data-chat-id="chat-mia"]').click();
  const directIncoming = await revealVirtualMessage(page, "m-3");
  await directIncoming.locator(".message-bubble-shell").click({ button: "right" });
  menu = page.getByRole("menu", { name: "消息操作" });
  await expect(menu.getByRole("menuitem", { name: "复读", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.locator('[data-chat-id="chat-forum"]').click();
  const forumIncoming = await revealVirtualMessage(page, "forum-general-1");
  await forumIncoming.locator(".message-bubble-shell").click({ button: "right" });
  menu = page.getByRole("menu", { name: "消息操作" });
  await menu.getByRole("menuitem", { name: "复读", exact: true }).click();
  await expect.poll(() => page.evaluate(async (storePath) => {
    const module = await import(storePath) as {
      telegramStore: { getState: () => { messages: Map<string, Message[]> } };
    };
    return module.telegramStore.getState().messages.get("chat-forum")
      ?.find((message) => message.outgoing && message.forwardInfo?.source?.messageId === "forum-general-1")
      ?.topicId;
  }, "/src/store/telegramStore.ts")).toBe("1");
});

test("search paginates, filters the current conversation by member, and opens exact messages", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("searchbox")).toHaveCount(1);
  await page.keyboard.press("Control+K");

  const search = page.getByRole("searchbox", { name: "搜索会话和消息" });
  await expect(search).toBeFocused();
  await search.fill("产品讨论历史消息");
  await expect(page.locator("[data-search-message-id]")).toHaveCount(30);
  await page.getByRole("button", { name: "加载更多" }).click();
  await expect(page.locator("[data-search-message-id]")).toHaveCount(36);

  await search.fill("产品讨论历史消息 36");
  await expect(page.locator("[data-search-message-id]")).toHaveCount(1);
  const globalMessageResult = page.locator('[data-search-message-id="p-old-36"]');
  await expect(globalMessageResult.locator(".avatar")).toContainText("产");
  await expect(globalMessageResult.locator("strong")).toHaveText("产品讨论");
  await expect(globalMessageResult.locator(".global-message-result-sender")).toHaveText("林然：");

  await page.getByRole("tab", { name: "媒体" }).click();
  await search.fill("预览");
  const target = page.locator('[data-search-message-id="p-5"]');
  await expect(target).toContainText("新的媒体预览样式");
  await target.click();
  await expect(page.locator(".global-search-results-panel")).toBeVisible();
  await expect(search).toHaveValue("预览");
  const locatedMessage = page.locator('[data-message-id="p-5"]');
  await expect(locatedMessage).toHaveClass(/is-notification-target/);
  await expect.poll(() => locatedMessage.evaluate((element) => {
    const list = element.closest(".message-list")?.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    if (!list) return Number.POSITIVE_INFINITY;
    return Math.abs((row.top + row.bottom) / 2 - (list.top + list.bottom) / 2);
  })).toBeLessThan(2);

  await page.evaluate(async (storePath) => {
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { searchChatMessages: (input: unknown) => Promise<void> };
        setState: (state: { searchChatMessages: (input: unknown) => Promise<void> }) => void;
      };
    };
    const originalSearch = storeModule.telegramStore.getState().searchChatMessages;
    const counters = globalThis as typeof globalThis & { __notgramChatSearchCalls?: number };
    counters.__notgramChatSearchCalls = 0;
    storeModule.telegramStore.setState({
      searchChatMessages: async (input) => {
        counters.__notgramChatSearchCalls = (counters.__notgramChatSearchCalls ?? 0) + 1;
        await originalSearch(input);
      },
    });
  }, "/src/store/telegramStore.ts");

  await page.keyboard.press("Control+F");
  await expect(search).toBeFocused();
  await expect(page.getByRole("group", { name: "搜索范围：产品讨论" })).toBeVisible();
  await expect(page.locator(".conversation-search-panel")).toHaveCount(0);
  await search.fill("产品讨论历史消息");
  const scopedResults = page.locator(".chat-search-results-panel [data-search-message-id]");
  await expect(scopedResults).toHaveCount(30);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramChatSearchCalls?: number }
  ).__notgramChatSearchCalls)).toBe(1);
  await expect(page.getByRole("log", { name: "消息列表" })).toBeVisible();
  await page.locator(".chat-search-results-panel").getByRole("button", { name: "加载更多" }).click();
  await expect(scopedResults).toHaveCount(36);

  const newestSearchResult = page.locator('.chat-search-results-panel [data-search-message-id="p-old-36"]');
  await expect(newestSearchResult).toContainText("产品讨论历史消息 36");
  await expect(newestSearchResult.locator(".avatar")).toContainText("林");
  await expect(newestSearchResult.locator("strong")).toHaveText("林然");
  await newestSearchResult.click();
  await expect(page.locator(".chat-search-results-panel")).toBeVisible();
  await expect(search).toHaveValue("产品讨论历史消息");
  const searchSourceMessage = page.locator('[data-message-id="p-old-36"]');
  await expect(searchSourceMessage).toHaveClass(/is-notification-target/);
  await expect(searchSourceMessage).toBeInViewport();

  await page.keyboard.press("Control+F");
  await expect(search).toBeFocused();
  await expect(page.getByLabel("消息类型")).toHaveCount(0);
  await expect(page.getByLabel("消息日期")).toHaveCount(0);
  await search.fill("产品讨论历史消息");
  const memberFilter = page.locator(".chat-search-member-trigger");
  await expect(memberFilter).toHaveAccessibleName("成员筛选：所有成员");
  await memberFilter.click();
  const memberDialog = page.getByRole("dialog", { name: "选择成员" });
  await expect(memberDialog).toBeVisible();
  const memberSearch = memberDialog.getByRole("searchbox", { name: "搜索成员" });
  await expect(memberSearch).toBeFocused();
  await memberSearch.fill("Jules");
  await expect(memberDialog.getByRole("button", { name: "Jules", exact: true })).toBeVisible();
  await expect(memberDialog.getByRole("button", { name: "我", exact: true })).toHaveCount(0);
  await memberDialog.getByRole("button", { name: "Jules", exact: true }).click();
  await expect(memberFilter).toHaveAccessibleName("成员筛选：Jules");
  await expect(memberDialog).toBeHidden();
  await expect.poll(() => scopedResults.count()).toBeGreaterThan(0);
  await search.press("Escape");
  await expect(page.getByRole("group", { name: "搜索范围：产品讨论" })).toBeHidden();
  await expect(search).toHaveValue("");

  const senderAvatar = page.locator(".message-sender-avatar").last();
  await expect(senderAvatar).toBeVisible();
  await senderAvatar.click({ button: "right" });
  const senderMenu = page.getByRole("menu", { name: "成员操作" });
  await expect(senderMenu.getByRole("menuitem", { name: /^搜索 .* 的消息$/ })).toBeVisible();
  await senderMenu.getByRole("menuitem", { name: /^搜索 .* 的消息$/ }).click();
  await expect(page.getByRole("group", { name: "搜索范围：产品讨论" })).toBeVisible();
  await expect(page.locator(".chat-search-member-trigger")).not.toHaveAccessibleName("成员筛选：所有成员");
  await page.getByRole("button", { name: "移除会话搜索范围" }).click();

  await page.keyboard.press("Control+K");
  await search.fill("Mia Chen");
  await page.locator(".global-chat-result", { hasText: "Mia Chen" }).click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await expect(page.locator(".global-search-results-panel")).toBeVisible();
  await expect(search).toHaveValue("Mia Chen");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Control+K");
  await search.fill("预览");
  await expect(page.locator('[data-search-message-id="p-5"]')).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
  await page.getByRole("button", { name: "清除搜索" }).click();
  await expect(page.locator(".global-search-results-panel")).toBeHidden();
});

test("conversation navigation records only links opened inside a conversation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "后退" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "前进" })).toHaveCount(0);

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");

  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");

  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointerdown", {
      button: 3,
      bubbles: true,
      cancelable: true,
    }));
  });
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");

  const forwardedMessage = page.locator('[data-message-id="p-channel-reply"]');
  await forwardedMessage.getByRole("button", { name: "打开频道原消息：Release editor" }).click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Release Notes");

  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointerdown", {
      button: 3,
      bubbles: true,
      cancelable: true,
    }));
  });
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");

  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointerdown", {
      button: 4,
      bubbles: true,
      cancelable: true,
    }));
  });
  await expect(page.locator(".conversation-title strong")).toHaveText("Release Notes");

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointerdown", {
      button: 3,
      bubbles: true,
      cancelable: true,
    }));
  });
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
});

test("chat profiles expose compact detail pages, rich bios, profile music, and shared media", async ({ page }) => {
  await page.goto("/");
  const profileTrigger = page.getByRole("button", { name: "查看 产品讨论 资料" });
  await profileTrigger.click();

  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile).toBeVisible();
  await expect(profile.getByRole("heading", { name: "产品讨论" })).toBeVisible();
  await expect(profile.getByText("产品、设计与开发协作群。", { exact: true })).toBeVisible();
  await expect(profile.locator(".profile-member-row")).toHaveCount(0);
  await profile.getByRole("button", { name: /成员\s*查看群组成员\s*4/ }).click();
  await expect(profile.locator(".profile-member-row")).toHaveCount(4);
  const popupBounds = await profile.boundingBox();
  expect(popupBounds).not.toBeNull();
  expect(popupBounds!.height).toBeLessThanOrEqual(680);
  expect(Math.abs((popupBounds!.x + popupBounds!.width / 2) - 640)).toBeLessThan(2);

  await profile.locator(".profile-member-identity").filter({ hasText: "Mia Chen" }).click();
  await expect(profile.getByText("@mia_design", { exact: true })).toBeVisible();
  await expect(profile.getByText("u-mia", { exact: true })).toBeVisible();
  await expect(profile.getByRole("link", { name: "https://example.com" })).toBeVisible();
  await expect(profile.getByRole("link", { name: "@Mia Chen" })).toBeVisible();
  expect(await profile.locator(".profile-drawer-scroll").evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  const avatarPopupPromise = page.waitForEvent("popup");
  await profile.getByRole("button", { name: "查看 Mia Chen 的头像和历史头像" }).click();
  const avatarPopup = await avatarPopupPromise;
  await avatarPopup.waitForLoadState("domcontentloaded");
  await expect(avatarPopup.getByRole("dialog", { name: /Mia Chen 的当前头像/ })).toBeVisible();
  await expect(avatarPopup.getByRole("navigation", { name: "会话图片预览" }).getByRole("button")).toHaveCount(3);
  await avatarPopup.close();
  await page.evaluate(() => {
    (window as unknown as { __notgramProfileAudioPlayCalls: string[] }).__notgramProfileAudioPlayCalls = [];
    HTMLMediaElement.prototype.play = function play() {
      const playbackId = this.dataset.playbackId;
      if (playbackId) {
        (window as unknown as { __notgramProfileAudioPlayCalls: string[] })
          .__notgramProfileAudioPlayCalls.push(playbackId);
      }
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
  });
  await profile.getByRole("button", { name: /音乐\s*资料歌单\s*2/ }).click();
  await expect(profile.locator(".profile-playlist-track")).toHaveCount(2);
  await profile.getByRole("button", { name: "播放 夜航界面" }).click();
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __notgramProfileAudioPlayCalls: string[] }
  ).__notgramProfileAudioPlayCalls)).toContain("profile:user:u-mia:audio:u-mia:audio:1");
  await profile.getByRole("button", { name: "返回资料" }).click();
  await profile.getByRole("button", { name: /共同群组\s*查看你们都加入的群组\s*2/ }).click();
  await expect(profile.locator(".profile-common-group-list > button")).toHaveCount(2);
  await profile.locator(".profile-common-group-list > button").first().click();
  await expect(profile).toBeHidden();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await profileTrigger.click();
  await expect(profile.locator(".profile-state")).toHaveCount(0);

  await profile.getByRole("button", { name: "共享媒体" }).click();
  await expect(profile.locator(".shared-media-item")).not.toHaveCount(0);
  await profile.locator(".shared-media-open").first().click();
  await expect(profile).toBeHidden();
  await expect(page.locator(".conversation")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await profileTrigger.click();
  await expect(profile).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
  await profile.getByRole("button", { name: "关闭资料" }).click();
  await expect(profileTrigger).toBeFocused();
});

test("unloaded profiles keep their top edge stable and grow only toward the bottom", async ({ page }) => {
  await page.goto("/");
  const loadedProfile: ChatProfile = {
    id: "user:u-delayed-profile",
    kind: "user",
    userId: "u-delayed-profile",
    title: "Delayed Profile",
    avatar: { label: "DP", color: "#4f7c70" },
    statusLabel: "在线",
    username: "delayed_profile",
    dataCenterId: 5,
    dataCenterLocation: "Singapore, SG",
    members: [],
    canViewMembers: false,
    groupInCommonCount: 2,
    groupsInCommon: [],
    profileAudioCount: 0,
    profileAudios: [],
  };
  const profile = page.getByRole("dialog", { name: "资料" });
  const openingMetrics = await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        setState: (partial: {
          profile: {
            target: { kind: "user"; userId: string };
            loading: boolean;
          };
        }) => void;
      };
    };
    module.telegramStore.setState({
      profile: {
        target: { kind: "user", userId: "u-delayed-profile" },
        loading: true,
      },
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const drawer = document.querySelector<HTMLElement>(".profile-drawer")!;
    const scroll = drawer.querySelector<HTMLElement>(".profile-drawer-scroll")!;
    return {
      height: drawer.offsetHeight,
      top: drawer.offsetTop,
      overflowY: getComputedStyle(scroll).overflowY,
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight,
    };
  }, "/src/store/telegramStore.ts");

  await expect(profile).toBeVisible();
  await expect(profile).toHaveAttribute("aria-busy", "true");
  const skeleton = profile.locator(".profile-loading-shell");
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveClass(/is-active/);
  const loadingMetrics = await profile.evaluate((element) => ({
    height: (element as HTMLElement).offsetHeight,
    top: (element as HTMLElement).offsetTop,
  }));

  await page.evaluate(async ({ modulePath, value }) => {
    const module = await import(modulePath) as {
      telegramStore: {
        setState: (partial: {
          profile: {
            target: { kind: "user"; userId: string };
            value: ChatProfile;
            loading: boolean;
          };
        }) => void;
      };
    };
    module.telegramStore.setState({
      profile: {
        target: { kind: "user", userId: value.userId! },
        value,
        loading: false,
      },
    });
  }, { modulePath: "/src/store/telegramStore.ts", value: loadedProfile });

  await expect(profile).toHaveAttribute("aria-busy", "false");
  await expect(profile.getByRole("heading", { name: loadedProfile.title })).toBeVisible();
  const loadedMetrics = await profile.evaluate((element) => {
    const scroll = element.querySelector<HTMLElement>(".profile-drawer-scroll")!;
    return {
      height: (element as HTMLElement).offsetHeight,
      top: (element as HTMLElement).offsetTop,
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight,
    };
  });
  expect(openingMetrics.height).toBeGreaterThan(0);
  expect(openingMetrics.height).toBe(loadingMetrics.height);
  expect(loadedMetrics.height).toBeGreaterThan(loadingMetrics.height);
  expect(new Set([openingMetrics.top, loadingMetrics.top, loadedMetrics.top]).size).toBe(1);
  expect(openingMetrics.overflowY).toBe("hidden");
  expect(openingMetrics.scrollHeight).toBeLessThanOrEqual(openingMetrics.clientHeight);
  expect(loadedMetrics.scrollHeight).toBeLessThanOrEqual(loadedMetrics.clientHeight + 1);
  expect(loadedMetrics.height).toBeLessThan(602);
});

test("shared media supports server categories, filters, forwarding, and batch deletion", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "查看 产品讨论 资料" }).click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await profile.getByRole("button", { name: "共享媒体" }).click();
  await profile.getByRole("tab", { name: "文件" }).click();
  await expect(profile.getByText("desktop-layout-review.pdf", { exact: true })).toBeVisible();
  await expect(profile.getByText("research-notes.zip", { exact: true })).toBeVisible();

  const search = profile.getByRole("searchbox", { name: "搜索共享媒体" });
  await search.fill("research");
  await profile.locator(".shared-media-search").getByRole("button", { name: "搜索" }).click();
  await expect(profile.getByText("research-notes.zip", { exact: true })).toBeVisible();
  await expect(profile.getByText("desktop-layout-review.pdf", { exact: true })).toHaveCount(0);
  await search.fill("");
  await profile.locator(".shared-media-search").getByRole("button", { name: "搜索" }).click();

  await profile.getByLabel("共享媒体开始日期").fill("2026-08-02");
  await expect(profile.getByText("没有匹配的内容", { exact: true })).toBeVisible();
  await profile.getByLabel("共享媒体开始日期").fill("");
  await profile.getByLabel("选择 p-3").check();
  const toolbar = profile.getByRole("toolbar", { name: "共享媒体批量操作" });
  await toolbar.getByLabel("共享媒体转发目标").selectOption("chat-mia");
  await toolbar.getByRole("button", { name: "转发" }).click();
  await expect(toolbar).toBeHidden();

  await profile.getByLabel("选择 p-3").check();
  const deleteSelected = toolbar.getByRole("button", { name: "删除", exact: true });
  await expect(deleteSelected).toBeEnabled();
  await deleteSelected.click();
  const deleteDialog = page.getByRole("dialog", { name: "删除 1 条消息" });
  await expect(deleteDialog.getByRole("button", { name: /为所有人删除/ })).toHaveCount(0);
  await deleteDialog.getByRole("button", { name: "仅对我删除" }).click();
  await expect(profile.getByText("desktop-layout-review.pdf", { exact: true })).toHaveCount(0);
  expect(await horizontalOverflow(page)).toBe(false);
});

test("message hashtags open and retain scoped search", async ({ page }) => {
  await page.goto("/");
  const message = await revealVirtualMessage(page, "p-rich-entities");
  const hashtag = message.getByRole("link", { name: "#release" });
  await expect(hashtag).toBeVisible();
  await expect(hashtag).toHaveCSS("text-decoration-line", "none");
  await expect(hashtag).toHaveCSS("color", "rgb(66, 120, 165)");
  await expect.poll(() => hashtag.evaluate((link) => getComputedStyle(link, "::after").transform))
    .toBe("matrix(0, 0, 0, 1, 0, 0)");

  await hashtag.hover();
  await expect.poll(() => hashtag.evaluate((link) => getComputedStyle(link, "::after").transform))
    .toBe("matrix(1, 0, 0, 1, 0, 0)");

  await hashtag.click();

  const search = page.getByRole("searchbox", { name: "搜索会话和消息" });
  await expect(page.getByRole("group", { name: "搜索范围：产品讨论" })).toBeVisible();
  await expect(search).toHaveValue("#release");
  const result = page.locator('.chat-search-results-panel [data-search-message-id="p-rich-entities"]');
  await expect(result).toBeVisible();
  await expect(result.locator("strong")).toHaveText("Jules");
  await expect(result.locator(".avatar")).toContainText("J");

  await result.click();
  await expect(page.locator(".chat-search-results-panel")).toBeVisible();
  await expect(search).toHaveValue("#release");
  await expect(page.locator('[data-message-id="p-rich-entities"]')).toHaveClass(/is-notification-target/);

  await page.getByRole("button", { name: "移除会话搜索范围" }).click();
  await expect(page.locator(".chat-search-results-panel")).toBeHidden();
});

test("message deletion keeps safety actions separate and exposes only allowed scopes", async ({ page }) => {
  await page.goto("/");

  const incoming = await revealVirtualMessage(page, "p-4");
  await incoming.locator(".message-bubble-shell").click({ button: "right" });
  let menu = page.getByRole("menu", { name: "消息操作" });
  await expect(menu.getByRole("menuitem", { name: "举报" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "删除" }).click();

  let dialog = page.getByRole("dialog", { name: "删除消息" });
  await expect(dialog).toContainText("我把交互稿更新到最新版本了");
  await expect(dialog.getByRole("button", { name: "仅对我删除" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /为所有人删除/ })).toHaveCount(0);
  await expect(dialog.getByText("Fuck Off", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "取消" }).click();

  const outgoing = await revealVirtualMessage(page, "p-2");
  await outgoing.locator(".message-bubble-shell").click({ button: "right" });
  menu = page.getByRole("menu", { name: "消息操作" });
  await menu.getByRole("menuitem", { name: "删除" }).click();

  dialog = page.getByRole("dialog", { name: "删除消息" });
  await expect(dialog.getByRole("button", { name: /仅对我删除/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "为所有人删除" })).toBeVisible();
  await dialog.getByRole("button", { name: "取消" }).click();

  await page.setViewportSize({ width: 390, height: 700 });
  await page.locator('[data-chat-id="chat-product"]').click();
  const mobileIncoming = await revealVirtualMessage(page, "p-4");
  await mobileIncoming.locator(".message-bubble-shell").click({ button: "right" });
  await page.getByRole("menu", { name: "消息操作" }).getByRole("menuitem", { name: "删除" }).click();
  dialog = page.getByRole("dialog", { name: "删除消息" });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(16);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(374);
  expect(bounds!.y).toBeGreaterThanOrEqual(16);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(684);
  expect(await horizontalOverflow(page)).toBe(false);
});

test("dark mode keeps interactive hover surfaces dark across the main UI", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("notgram:preferences:v1", JSON.stringify({ themeId: "notgram-dark" }));
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "notgram-dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");

  const missingTokens = await page.evaluate(() => {
    const contract = [
      "--color-bg-canvas",
      "--color-bg-surface",
      "--color-bg-elevated",
      "--color-bg-control",
      "--color-text-primary",
      "--color-text-secondary",
      "--color-border-default",
      "--color-border-strong",
      "--color-border-focus",
      "--color-accent",
      "--color-status-danger",
      "--color-message-incoming",
      "--color-message-outgoing",
      "--color-bg-media",
      "--color-overlay",
      "--color-shadow",
    ];
    const style = getComputedStyle(document.documentElement);
    return contract.filter((token) => style.getPropertyValue(token).trim() === "");
  });
  expect(missingTokens).toEqual([]);

  const assertDarkHover = async (locator: ReturnType<typeof page.locator>) => {
    await locator.hover();
    const background = await locator.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(background).not.toBe("rgb(255, 255, 255)");
    expect(background).not.toBe("rgb(244, 248, 250)");
  };

  await assertDarkHover(page.locator(".rail-button").first());
  await assertDarkHover(page.locator(".chat-row").first());
  await assertDarkHover(page.locator(".conversation-profile-trigger"));

  const profile = page.getByRole("dialog", { name: "资料" });
  await page.getByRole("button", { name: "查看 产品讨论 资料" }).click();
  await expect(profile).toBeVisible();
  await expect(profile).toHaveCSS("background-color", "rgb(38, 43, 49)");
  await expect(profile).toHaveCSS("border-color", "rgb(70, 80, 90)");
  await profile.locator(".profile-navigation > button").filter({ hasText: "成员" }).click();
  await assertDarkHover(profile.locator(".profile-member-identity").first());
  await profile.getByRole("button", { name: "返回资料" }).click();

  await profile.getByRole("button", { name: "管理", exact: true }).click();
  const management = page.getByRole("dialog", { name: /管理“产品讨论”/ });
  await management.getByRole("button", { name: "邀请", exact: true }).click();
  const inviteName = management.getByLabel("邀请链接名称");
  await expect(inviteName).toHaveCSS("background-color", "rgb(41, 46, 52)");
  await expect(inviteName).toHaveCSS("border-color", "rgb(70, 80, 90)");
  await expect(inviteName).toHaveCSS("color", "rgb(208, 212, 217)");
  await management.getByRole("button", { name: "关闭管理面板" }).click();
  if (await profile.isVisible()) {
    await profile.getByRole("button", { name: "关闭资料" }).click();
  }

  await page.locator(".message-bubble-shell").last().click({ button: "right" });
  const messageMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(messageMenu).toBeVisible();
  await assertDarkHover(messageMenu.getByRole("menuitem").first());
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "表情" }).click();
  const emojiPicker = page.locator(".emoji-picker");
  await expect(emojiPicker).toBeVisible();
  await expect(emojiPicker).toHaveCSS("background-color", "rgb(38, 43, 49)");
  await assertDarkHover(emojiPicker.locator(".emoji-picker-tabs > button").first());
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await expect(settings).toHaveCSS("background-color", "rgb(38, 43, 49)");
  await expect(settings.locator(".settings-categories")).toHaveCSS("background-color", "rgb(41, 47, 53)");
});

test("channel posts expose views, forwards, and author metadata without a sync forward label", async ({ page }) => {
  await page.goto("/");
  const linked = page.locator('[data-message-id="p-channel-reply"]');
  await expect(linked).toBeVisible();
  await expect(linked.locator(".message-forward-label")).toHaveCount(0);
  await expect(linked.locator('[aria-label="转发 23 次"]')).toHaveText("23");
  await expect(linked.locator('[aria-label="22200 次观看"]')).toHaveText("22.2K");
  await expect(linked.locator(".message-channel-author")).toHaveText("Release editor");

  await page.locator('[data-chat-id="chat-release"]').click();
  const post = page.locator('[data-message-id="release-post-1"]');
  await expect(post).toBeVisible();
  await expect(post.locator('[aria-label="转发 23 次"]')).toHaveText("23");
  await expect(post.locator('[aria-label="22200 次观看"]')).toHaveText("22.2K");
  await expect(post.locator(".message-channel-author")).toHaveText("Release editor");
});

test("reply previews jump to their source and channel senders keep their identity", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const channelMessage = page.locator('[data-message-id="p-channel-reply"]');
  await expect(channelMessage).toBeVisible();
  await expect(channelMessage.locator(".message-sender")).toHaveText("Release Notes");
  await expect(channelMessage.locator(".message-forward-label")).toHaveCount(0);
  await expect(channelMessage.locator('[aria-label="转发 23 次"]')).toHaveText("23");
  await expect(channelMessage.locator('[aria-label="22200 次观看"]')).toHaveText("22.2K");
  await expect(channelMessage.locator(".message-channel-author")).toHaveText("Release editor");
  await expect(page.locator('.message-group:has([data-message-id="p-channel-reply"]) .message-group-avatar .avatar')).toContainText("R");
  await expect(channelMessage.locator(".message-reply-preview")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  const [replyBounds, bubbleBounds] = await Promise.all([
    channelMessage.locator(".message-reply-preview").boundingBox(),
    channelMessage.locator(".message-bubble").boundingBox(),
  ]);
  expect(Math.abs(
    replyBounds!.x + replyBounds!.width - (bubbleBounds!.x + bubbleBounds!.width - 10),
  )).toBeLessThanOrEqual(1);
  await expect(channelMessage.getByRole("button", { name: "前往频道原消息" })).toHaveCount(0);

  await page.evaluate(() => {
    type JumpSample = {
      scrollTop: number;
      placeholder: boolean;
      snapshot: boolean;
    };
    const state = { samples: [] as JumpSample[], running: false };
    const globalState = globalThis as typeof globalThis & {
      __notgramJumpTrace?: typeof state;
    };
    globalState.__notgramJumpTrace = state;
    document.querySelector('[data-message-id="p-channel-reply"] .message-reply-preview')
      ?.addEventListener("pointerdown", () => {
        if (state.running) return;
        state.running = true;
        const startedAt = performance.now();
        const sample = () => {
          const list = document.querySelector<HTMLElement>(".message-list");
          state.samples.push({
            scrollTop: list?.scrollTop ?? -1,
            placeholder: Boolean(document.querySelector(".message-positioning-placeholder")),
            snapshot: Boolean(document.querySelector(
              "[data-conversation-switch-snapshot], [data-conversation-motion-snapshot]",
            )),
          });
          if (performance.now() - startedAt < 700) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, { once: true });
  });
  await channelMessage.locator(".message-reply-preview").click();
  const target = page.locator('[data-message-id="p-old-8"]');
  await expect(target).toHaveClass(/is-notification-target/);
  await expect.poll(() => target.evaluate((element) => {
    const list = element.closest(".message-list")?.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    if (!list) return Number.POSITIVE_INFINITY;
    return Math.abs((row.top + row.bottom) / 2 - (list.top + list.bottom) / 2);
  })).toBeLessThan(2);
  await page.waitForTimeout(720);
  const jumpReport = await page.evaluate(() => {
    type JumpSample = { scrollTop: number; placeholder: boolean; snapshot: boolean };
    const globalState = globalThis as typeof globalThis & {
      __notgramJumpTrace?: { samples: JumpSample[] };
    };
    const samples = globalState.__notgramJumpTrace?.samples ?? [];
    let direction = 0;
    let visibleReversals = 0;
    for (let index = 1; index < samples.length; index += 1) {
      if (samples[index].snapshot) continue;
      const delta = samples[index].scrollTop - samples[index - 1].scrollTop;
      if (Math.abs(delta) < 0.5) continue;
      const nextDirection = Math.sign(delta);
      if (direction && direction !== nextDirection) visibleReversals += 1;
      direction = nextDirection;
    }
    return {
      visibleReversals,
      placeholderFrames: samples.filter((sample) => sample.placeholder).length,
    };
  });
  expect(jumpReport.visibleReversals).toBe(0);
  expect(jumpReport.placeholderFrames).toBe(0);
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeFocused();
  await expect(target.locator(".message-bubble")).toHaveCSS("outline-style", "none");

  await openConversationMessageSearch(page);
  const search = page.getByRole("searchbox", { name: "搜索会话和消息" });
  await search.fill("Release Notes channel posted this reply");
  await page.locator('.chat-search-results-panel [data-search-message-id="p-channel-reply"]').click();
  await page.locator('[data-message-id="p-channel-reply"] .message-sender').click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile.getByRole("heading", { name: "Release Notes" })).toBeVisible();
  await profile.getByRole("button", { name: "关闭资料" }).click();

});

test("Telegram links navigate internally and incompatible routes stay in Notgram", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const initialPageCount = context.pages().length;

  await page.locator('[data-message-id="p-markdown"]').getByRole("link", { name: "链接" }).click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  expect(context.pages()).toHaveLength(initialPageCount);

  await page.locator('[data-chat-id="chat-product"]').click();
  const themeLink = page.locator('[data-message-id="p-rich-entities"]').getByRole("link", { name: "link" });
  await expect(themeLink).toBeVisible();
  await themeLink.click();

  await expect(page.getByRole("alert")).toContainText("Telegram 主题链接与 Notgram 不兼容");
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  expect(context.pages()).toHaveLength(initialPageCount);
});

test("TDLib mentions open user and bot profiles without leaving the conversation", async ({ page, context }) => {
  await page.goto("/");
  const initialPageCount = context.pages().length;
  const row = await revealVirtualMessage(page, "p-rich-entities");

  const userMention = row.getByRole("link", { name: "@Mia Chen" });
  await expect(userMention).toHaveAttribute("href", "https://t.me/mia_design");
  await userMention.click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile.getByRole("heading", { name: "Mia Chen" })).toBeVisible();
  await profile.getByRole("button", { name: "关闭资料" }).click();

  const botRow = await revealVirtualMessage(page, "p-rich-entities");
  await botRow.getByRole("link", { name: "@Notgram Bot" }).click();
  await expect(profile.getByRole("heading", { name: "Notgram Bot" })).toBeVisible();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  expect(context.pages()).toHaveLength(initialPageCount);
});

test("visible mentions follow nickname changes without changing their user target", async ({ page }) => {
  await page.goto("/");
  const row = await revealVirtualMessage(page, "p-rich-entities");
  await expect(row.getByRole("link", { name: "@Mia Chen" })).toBeVisible();

  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { users: Map<string, { id: string; displayName: string }> };
        setState: (patch: { users: Map<string, unknown> }) => void;
      };
    };
    const users = new Map(storeModule.telegramStore.getState().users);
    const mia = users.get("u-mia");
    if (!mia) throw new Error("Mock member is missing");
    users.set("u-mia", { ...mia, displayName: "Mia Zhou" });
    storeModule.telegramStore.setState({ users });
  }, "/src/store/telegramStore.ts");

  const renamedMention = row.getByRole("link", { name: "@Mia Zhou" });
  await expect(renamedMention).toHaveAttribute("href", "https://t.me/mia_design");
  await renamedMention.click();
  await expect(page.getByRole("dialog", { name: "资料" })).toBeVisible();
});

test("chat list hides its scrollbar and the conversation title has no hover highlight", async ({ page }) => {
  await page.goto("/");
  const chatList = page.locator(".chat-list");
  await expect(chatList).toHaveCSS("scrollbar-width", "none");

  const title = page.locator(".conversation-profile-trigger");
  const backgroundBeforeHover = await title.evaluate((element) => getComputedStyle(element).backgroundColor);
  await title.hover();
  await expect(title).toHaveCSS("background-color", backgroundBeforeHover);
});

test("chat pagination indicator does not change the bottom scroll geometry", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 420 });
  await page.goto("/");
  const chatList = page.locator(".chat-list");
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
    const lastRow = element.querySelector<HTMLElement>(".chat-row:last-of-type");
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
  const chatList = page.locator(".chat-list");
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
    const row = [...element.querySelectorAll<HTMLElement>(".chat-row[data-chat-id]")]
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
      if (this instanceof HTMLElement && this.matches(".chat-row[data-motion-key]")) {
        const frames = Array.isArray(keyframes) ? keyframes : [];
        diagnosticWindow.__notgramChatRowMotion?.push(String(frames[0]?.transform ?? ""));
      }
      return originalAnimate.call(this, keyframes, options);
    };
  });

  const anchorRow = page.locator(`.chat-row[data-chat-id="${anchor.id}"]`);
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

test("distant message jumps use a directional exit and entrance transition", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const source = page.locator('[data-message-id="p-channel-reply"]');
  await source.scrollIntoViewIfNeeded();
  await expect(page.locator('[data-message-id="p-old-8"]')).toHaveCount(0);
  await page.evaluate(() => {
    const originalAnimate = Element.prototype.animate;
    const records: Array<{ duration: number; firstOpacity?: number; lastOpacity?: number }> = [];
    (globalThis as typeof globalThis & { __notgramJumpAnimations?: typeof records })
      .__notgramJumpAnimations = records;
    Element.prototype.animate = function (keyframes, options) {
      if (this.classList.contains("message-list-content") && Array.isArray(keyframes)) {
        const timing = typeof options === "number" ? { duration: options } : options;
        records.push({
          duration: Number(timing?.duration ?? 0),
          firstOpacity: Number(keyframes[0]?.opacity),
          lastOpacity: Number(keyframes.at(-1)?.opacity),
        });
      }
      return originalAnimate.call(this, keyframes, options);
    };
  });

  await source.locator(".message-reply-preview").click();
  const target = page.locator('[data-message-id="p-old-8"]');
  await expect(target).toHaveClass(/is-notification-target/);
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramJumpAnimations?: unknown[] }
  ).__notgramJumpAnimations?.length ?? 0)).toBe(2);
  const animations = await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __notgramJumpAnimations?: Array<{ duration: number; firstOpacity?: number; lastOpacity?: number }>;
    }
  ).__notgramJumpAnimations ?? []);
  expect(animations).toEqual([
    expect.objectContaining({ duration: 120, firstOpacity: 1, lastOpacity: 0.72 }),
    expect.objectContaining({ duration: 180, firstOpacity: 0.72, lastOpacity: 1 }),
  ]);
  await expect.poll(() => target.evaluate((element) => {
    const list = element.closest(".message-list")?.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    return list
      ? Math.abs((row.top + row.bottom) / 2 - (list.top + list.bottom) / 2)
      : Number.POSITIVE_INFINITY;
  })).toBeLessThan(2);
  await expect(page.locator(".message-list")).not.toHaveClass(/is-jump-transitioning/);
});

test("forward source labels open the original message", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const forwardedMessage = page.locator('[data-message-id="p-channel-reply"]');
  const sourceButton = forwardedMessage.getByRole("button", { name: "打开频道原消息：Release editor" });
  await expect(sourceButton).toBeVisible();
  await sourceButton.click();

  await expect(page.locator(".conversation-title strong")).toHaveText("Release Notes");
  const originalMessage = page.locator('[data-message-id="release-post-1"]');
  await expect(originalMessage).toBeVisible();
  await expect(originalMessage).toHaveClass(/is-notification-target/);
});

test("text message time releases reserved inline space when it wraps", async ({ page }) => {
  await page.goto("/");
  const shortMessage = page.locator('[data-message-id="p-rich-entities"]');
  await expect(shortMessage.locator('.message-rich-text[data-rich-text="entities"]')).toBeVisible();
  const shortGeometry = await shortMessage.evaluate((element) => {
    const text = element.querySelector<HTMLElement>(".message-rich-text");
    const meta = element.querySelector<HTMLElement>(".message-meta");
    const shell = element.querySelector<HTMLElement>(".message-bubble-shell");
    const bubble = element.querySelector<HTMLElement>(".message-bubble");
    const stack = element.closest<HTMLElement>(".message-group-stack");
    if (!text || !meta || !shell || !bubble || !stack) return undefined;
    const range = document.createRange();
    range.selectNodeContents(text);
    const lastLine = [...range.getClientRects()].at(-1);
    const metaBounds = meta.getBoundingClientRect();
    return {
      lastLineTop: lastLine?.top,
      lastLineBottom: lastLine?.bottom,
      lastLineRight: lastLine?.right,
      metaTop: metaBounds.top,
      metaBottom: metaBounds.bottom,
      metaLeft: metaBounds.left,
      metaRight: metaBounds.right,
      bubbleRight: bubble.getBoundingClientRect().right,
      shellWidth: shell.getBoundingClientRect().width,
      stackWidth: stack.getBoundingClientRect().width,
    };
  });
  expect(shortGeometry).toBeTruthy();
  expect(shortGeometry!.metaBottom - shortGeometry!.lastLineBottom!).toBeGreaterThanOrEqual(2);
  expect(shortGeometry!.metaBottom - shortGeometry!.lastLineBottom!).toBeLessThanOrEqual(3);
  expect(shortGeometry!.metaLeft).toBeGreaterThan(shortGeometry!.lastLineRight!);
  expect(Math.abs(shortGeometry!.metaRight - (shortGeometry!.bubbleRight - 10))).toBeLessThanOrEqual(1);
  expect(shortGeometry!.shellWidth).toBeLessThanOrEqual(Math.min(shortGeometry!.stackWidth * 0.74, 720) + 1);

  await page.evaluate(async (storePath) => {
    const { telegramStore } = await import(storePath);
    const state = telegramStore.getState() as {
      messages: Map<string, Array<Record<string, unknown>>>;
    };
    const messages = new Map(state.messages);
    messages.set("chat-product", (messages.get("chat-product") ?? []).map((message) => (
      message.id === "p-rich-entities"
        ? {
            ...message,
            senderId: "self",
            outgoing: true,
            editedAt: "2026-08-01T09:49:00+08:00",
            delivery: "read",
            content: {
              kind: "text",
              text: "而且现在服务端已有自动重试的能力了，加一个异常匹配的事情",
            },
          }
        : message
    )));
    telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");

  const longMessage = shortMessage;
  await longMessage.evaluate((element) => {
    const group = element.closest<HTMLElement>(".message-group");
    if (group) group.style.width = "648px";
  });
  await expect(longMessage.locator(".message-bubble")).toHaveClass(/has-wrapped-meta/);
  await expect(longMessage.locator(".message-bubble")).toHaveCSS("padding-bottom", "2px");
  await expect(longMessage.locator(".message-meta")).toHaveCSS("float", "none");
  const releasedGeometry = await longMessage.locator(".message-bubble-shell").evaluate((shell) => {
    const text = shell.querySelector<HTMLElement>(".message-rich-text");
    const meta = shell.querySelector<HTMLElement>(".message-meta");
    const bubble = shell.querySelector<HTMLElement>(".message-bubble");
    const flow = shell.querySelector<HTMLElement>(".message-text-flow");
    if (!text || !meta || !bubble || !flow) return undefined;
    const range = document.createRange();
    range.selectNodeContents(text);
    const lastLine = [...range.getClientRects()].filter((rect) => rect.width > 0).at(-1);
    if (!lastLine) return undefined;
    const flowBounds = flow.getBoundingClientRect();
    const flowStyle = getComputedStyle(flow);
    const metaBounds = meta.getBoundingClientRect();
    return {
      availableInlineSpace: flowBounds.right - Number.parseFloat(flowStyle.paddingRight) - lastLine.right,
      textWidth: lastLine.width,
      metaWidth: metaBounds.width,
      metaRight: metaBounds.right,
      bubbleWidth: bubble.getBoundingClientRect().width,
      bubbleRight: bubble.getBoundingClientRect().right,
      metaTop: metaBounds.top,
      lastLineBottom: lastLine.bottom,
      lineHeight: Number.parseFloat(getComputedStyle(text).lineHeight),
    };
  });
  expect(releasedGeometry).toBeTruthy();
  expect(Math.abs(releasedGeometry!.bubbleWidth - releasedGeometry!.textWidth - 20)).toBeLessThanOrEqual(1);
  expect(releasedGeometry!.availableInlineSpace).toBeLessThan(releasedGeometry!.metaWidth + 8);
  expect(Math.abs(releasedGeometry!.metaRight - (releasedGeometry!.bubbleRight - 10))).toBeLessThanOrEqual(1);
  const wrappedGap = releasedGeometry!.metaTop - releasedGeometry!.lastLineBottom;
  expect(wrappedGap).toBeGreaterThanOrEqual(1);
  expect(wrappedGap).toBeLessThan(releasedGeometry!.lineHeight * 0.4);

  await longMessage.evaluate((element) => {
    const group = element.closest<HTMLElement>(".message-group");
    if (group) group.style.width = "900px";
  });
  await expect(longMessage.locator(".message-text-flow")).not.toHaveClass(/is-meta-wrapped/);
  await expect(longMessage.locator(".message-meta")).toHaveCSS("float", "right");
});

test("media cards preserve media width while giving captions a stable reading width", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Mia Chen/ }).first().click();

  const geometryFor = async (messageId: string) => {
    const row = page.locator(`[data-message-id="${messageId}"]`);
    await row.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "auto" }));
    await expect.poll(() => row.locator(".photo-preview img").evaluate((image) => {
      const media = image as HTMLImageElement;
      return media.complete && media.naturalWidth > 0 && media.naturalHeight > 0;
    })).toBe(true);
    return row.evaluate((element) => {
      const shell = element.querySelector<HTMLElement>(".message-bubble-shell");
      const preview = element.querySelector<HTMLElement>(".photo-preview");
      const image = element.querySelector<HTMLImageElement>(".photo-preview img");
      const caption = element.querySelector<HTMLElement>(".photo-caption");
      const meta = element.querySelector<HTMLElement>(".message-meta");
      if (!shell || !preview || !image || !caption || !meta) return undefined;
      const shellBounds = shell.getBoundingClientRect();
      const previewBounds = preview.getBoundingClientRect();
      const scale = Math.min(
        previewBounds.width / image.naturalWidth,
        previewBounds.height / image.naturalHeight,
      );
      const range = document.createRange();
      range.selectNodeContents(caption);
      const captionLastLine = [...range.getClientRects()].at(-1);
      const metaBounds = meta.getBoundingClientRect();
      return {
        shellWidth: shellBounds.width,
        previewWidth: previewBounds.width,
        previewHeight: previewBounds.height,
        captionHeight: caption.getBoundingClientRect().height,
        captionLastLineBottom: captionLastLine?.bottom,
        captionLastLineRight: captionLastLine?.right,
        metaTop: metaBounds.top,
        metaBottom: metaBounds.bottom,
        metaLeft: metaBounds.left,
        metaRight: metaBounds.right,
        captionFlowHeight: element.querySelector<HTMLElement>(".photo-caption-flow")?.getBoundingClientRect().height,
        horizontalLetterbox: (previewBounds.width - image.naturalWidth * scale) / 2,
        verticalLetterbox: (previewBounds.height - image.naturalHeight * scale) / 2,
        objectFit: getComputedStyle(image).objectFit,
      };
    });
  };

  const tall = await geometryFor("m-tall-caption");
  expect(tall).toBeDefined();
  expect(tall?.shellWidth).toBeCloseTo(320, 0);
  expect(Math.abs((tall?.shellWidth ?? 0) - (tall?.previewWidth ?? 1))).toBeLessThanOrEqual(1);
  expect(tall?.captionHeight).toBeLessThan(50);
  expect(tall?.horizontalLetterbox).toBeGreaterThan(50);
  expect(tall?.verticalLetterbox).toBeLessThanOrEqual(1);
  expect(tall?.objectFit).toBe("contain");

  const wide = await geometryFor("m-wide-caption");
  expect(wide).toBeDefined();
  expect(wide?.shellWidth).toBeCloseTo(390, 0);
  expect(Math.abs((wide?.shellWidth ?? 0) - (wide?.previewWidth ?? 1))).toBeLessThanOrEqual(1);
  expect(wide?.horizontalLetterbox).toBeLessThanOrEqual(1);
  expect(wide?.verticalLetterbox).toBeLessThanOrEqual(1);
  expect(wide?.objectFit).toBe("contain");
  expect(wide?.captionLastLineBottom).toBeDefined();
  expect(wide?.captionLastLineRight).toBeDefined();
  expect(Math.abs(wide!.metaBottom! - wide!.captionLastLineBottom!)).toBeLessThan(5);
  expect(wide!.metaLeft!).toBeGreaterThan(wide!.captionLastLineRight!);
  expect(wide!.captionFlowHeight!).toBeLessThan(32);

  await page.evaluate(async (storePath) => {
    const { telegramStore } = await import(storePath);
    const state = telegramStore.getState() as {
      messages: Map<string, Array<Record<string, unknown>>>;
    };
    const chatMessages = state.messages.get("chat-mia") ?? [];
    const source = chatMessages.find((message) => message.id === "m-tall-caption");
    if (!source) throw new Error("Missing portrait media fixture");
    const messages = new Map(state.messages);
    messages.set("chat-mia", [
      ...chatMessages,
      {
        ...source,
        id: "m-tall-caption-outgoing",
        senderId: "self",
        outgoing: true,
        sentAt: "2026-08-01T09:27:00+08:00",
        editedAt: "2026-08-01T09:28:00+08:00",
        content: {
          ...(source.content as Record<string, unknown>),
          caption: "媒体说明".repeat(15),
        },
      },
    ]);
    telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");

  const outgoingTall = await geometryFor("m-tall-caption-outgoing");
  expect(outgoingTall).toBeDefined();
  expect(Math.abs(outgoingTall!.shellWidth - tall!.shellWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(outgoingTall!.previewHeight - tall!.previewHeight)).toBeLessThanOrEqual(1);
  const outgoingCaption = page.locator('[data-message-id="m-tall-caption-outgoing"] .photo-caption-flow');
  await expect(outgoingCaption).toHaveClass(/is-meta-wrapped/);
  await expect(outgoingCaption.locator(".message-meta")).toHaveCSS("float", "none");

  await page.setViewportSize({ width: 360, height: 760 });
  const narrowTall = await geometryFor("m-tall-caption");
  expect(narrowTall).toBeDefined();
  expect(narrowTall!.previewWidth).toBeLessThan(320);
  expect(narrowTall!.previewWidth / narrowTall!.previewHeight).toBeCloseTo(320 / 420, 2);
});

test("pasted images preview, respect Telegram's album limit, and send as one album", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.evaluate((element) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
    for (let index = 1; index <= 11; index += 1) {
      data.items.add(new File([bytes], `paste-${index}.png`, { type: "image/png" }));
    }
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  });

  const preview = page.getByRole("region", { name: "待发送附件" });
  await expect(preview.locator(".composer-attachment-item")).toHaveCount(10);
  await expect(preview.getByRole("alert")).toHaveText("一次最多发送 10 个附件");
  await expect(preview.getByRole("radio", { name: "媒体" })).toBeChecked();
  await expect(preview.getByRole("radio", { name: "原文件" })).not.toBeChecked();
  await expect(preview.getByRole("checkbox", { name: "剧透" })).toBeEnabled();
  await expect(preview.getByRole("checkbox", { name: "说明置顶" })).toHaveCount(0);
  for (let index = 10; index >= 3; index -= 1) {
    await preview.getByRole("button", { name: `移除 paste-${index}.png` }).click();
  }
  await composer.fill("粘贴图片说明");
  await composer.press("Enter");
  await expect(preview).toBeHidden();
  await expect(composer).toHaveValue("");
  const sentAlbum = page.locator(".media-album.is-outgoing").last();
  await expect(sentAlbum.locator(".media-album-grid img")).toHaveCount(2);
  await expect(sentAlbum.locator(".media-album-captions")).toHaveCount(0);
  await expect(sentAlbum).not.toContainText("粘贴图片说明");
  await expect(composer).toBeFocused();

  await composer.fill("短说明不应收窄图片");
  await composer.evaluate((element) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
    data.items.add(new File([bytes], "outgoing-caption.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  });
  await composer.press("Enter");
  const sentPhoto = page.locator('.message-row.is-outgoing', { hasText: "短说明不应收窄图片" }).last();
  await expect.poll(() => sentPhoto.locator(".photo-preview").evaluate(
    (element) => element.getBoundingClientRect().width,
  )).toBeGreaterThan(380);
  await expect(composer).toBeFocused();

  await composer.evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(new File(["pasted document"], "pasted-notes.txt", { type: "text/plain" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  });
  await expect(preview.locator(".composer-file-preview")).toBeVisible();
  await expect(preview).toContainText("pasted-notes.txt");
  await composer.press("Enter");
  await expect(page.locator(".file-message", { hasText: "pasted-notes.txt" })).toBeVisible();
});

test("attachment entry points share classification, previews, spoilers, and local drafts", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  const preview = page.getByRole("region", { name: "待发送附件" });

  await composer.evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(new File(["export const value = 1;"], "clipboard-script.ts", {
      type: "video/mp2t",
    }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  });
  await expect(preview.getByText("clipboard-script.ts", { exact: true })).toBeVisible();
  await expect(preview.getByRole("radio", { name: "原文件" })).toBeChecked();
  await expect(preview.getByRole("radio", { name: "媒体" })).toBeDisabled();
  await expect(preview.locator("video")).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "预览 clipboard-script.ts" })).toHaveCount(0);
  await preview.getByRole("button", { name: "移除 clipboard-script.ts" }).click();

  await page.locator('input[type="file"]').setInputFiles({
    name: "selected-archive.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("archive"),
  });
  await expect(preview.getByText("selected-archive.zip", { exact: true })).toBeVisible();
  await expect(preview.getByRole("radio", { name: "原文件" })).toBeChecked();
  await preview.getByRole("button", { name: "移除 selected-archive.zip" }).click();

  const composerWrap = page.locator(".composer-wrap");
  await composerWrap.evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(new File(["drag probe"], "probe.txt", { type: "text/plain" }));
    element.dispatchEvent(new DragEvent("dragenter", {
      bubbles: true,
      cancelable: true,
      dataTransfer: data,
    }));
  });
  await expect(page.getByText("添加到待发送附件", { exact: true })).toBeVisible();
  await composerWrap.evaluate((element) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
    data.items.add(new File([bytes], "dropped-image.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: data,
    }));
  });
  await expect(preview.getByText("dropped-image.png", { exact: true })).toBeVisible();
  await expect(preview.getByRole("radio", { name: "媒体" })).toBeChecked();

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator('[data-chat-id="chat-product"] .chat-preview-message'))
    .toHaveText("草稿：1 个附件");
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(preview.getByText("dropped-image.png", { exact: true })).toBeVisible();

  await preview.getByRole("checkbox", { name: "剧透" }).check();
  const stagedSpoiler = preview.locator(".media-spoiler");
  await expect(stagedSpoiler).toHaveClass(/is-concealed/);
  await preview.getByRole("button", { name: "显示遮罩媒体" }).click();
  await expect(stagedSpoiler).toHaveClass(/is-revealed/);
  await preview.getByRole("button", { name: "预览 dropped-image.png" }).click();
  const mediaPreview = page.getByRole("dialog", { name: "附件预览：dropped-image.png" });
  await expect(mediaPreview).toBeVisible();
  await expect(mediaPreview.locator("img")).toBeVisible();
  await mediaPreview.getByRole("button", { name: "关闭附件预览" }).click();
  await expect(mediaPreview).toBeHidden();
});

test("poll messages support voting, results, and revoking an answer", async ({ page }) => {
  await page.goto("/");
  const poll = page.getByRole("region", { name: "投票" });
  await expect(poll).toBeVisible();
  await expect(poll.getByText("下一轮优先验证哪一项？")).toBeVisible();
  const firstOption = poll.getByRole("button", { name: /原生媒体发送/ });
  await firstOption.click();
  await expect(firstOption).toHaveAttribute("aria-pressed", "true");
  await expect(poll.getByText("11 票")).toBeVisible();
  await expect(firstOption).toContainText("64%");
  await poll.getByRole("button", { name: "撤回投票" }).click();
  await expect(poll.getByText("10 票")).toBeVisible();
  await expect(firstOption).toHaveAttribute("aria-pressed", "false");
});

test("audio messages continue to the next item in the same conversation", async ({ page }) => {
  await page.addInitScript(() => {
    const scope = window as unknown as {
      __notgramAudioContext?: { state: string };
      __notgramAudioLifecycle: string[];
    };
    scope.__notgramAudioLifecycle = [];
    class TestAudioContext {
      state = "suspended";
      destination = {};

      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          frequencyBinCount: 128,
          connect: () => undefined,
          getByteFrequencyData: (values: Uint8Array) => values.fill(0),
        };
      }

      createMediaElementSource() {
        return { connect: () => undefined };
      }

      resume() {
        scope.__notgramAudioLifecycle.push("resume");
        this.state = "running";
        return Promise.resolve();
      }

      close() {
        this.state = "closed";
        return Promise.resolve();
      }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: class extends TestAudioContext {
        constructor() {
          super();
          scope.__notgramAudioContext = this;
        }
      },
    });
  });
  await page.goto("/");
  await expect(page.locator('[data-message-id="p-audio"] audio')).toHaveCount(0);
  const audioEngine = page.locator(".persistent-audio-engine");
  await expect(audioEngine).toHaveCount(1);
  await expect(audioEngine).toHaveAttribute("crossorigin", "anonymous");
  await page.evaluate(() => {
    const scope = window as unknown as {
      __notgramAudioLifecycle: string[];
      __notgramAudioPlayCalls: string[];
    };
    scope.__notgramAudioPlayCalls = [];
    HTMLMediaElement.prototype.play = function play() {
      const playbackId = this.dataset.playbackId;
      if (playbackId) {
        scope.__notgramAudioLifecycle.push("play");
        scope.__notgramAudioPlayCalls.push(playbackId);
      }
      return Promise.resolve();
    };
  });
  await page.getByRole("button", { name: "播放 产品语音.m4a" }).click();
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __notgramAudioPlayCalls: string[] }
  ).__notgramAudioPlayCalls)).toContain("chat-product:p-audio");
  await expect(audioEngine).toHaveAttribute("src", /mock-video\.mp4/);
  await expect(audioEngine).toHaveJSProperty("muted", false);
  await expect(audioEngine).toHaveJSProperty("volume", 1);
  expect(await page.evaluate(() => (
    window as unknown as { __notgramAudioLifecycle: string[] }
  ).__notgramAudioLifecycle.slice(0, 2))).toEqual(["resume", "play"]);
  await page.evaluate(() => {
    const scope = window as unknown as {
      __notgramAudioContext?: { state: string };
    };
    if (scope.__notgramAudioContext) scope.__notgramAudioContext.state = "suspended";
    document.querySelector<HTMLAudioElement>(".persistent-audio-engine")
      ?.dispatchEvent(new Event("playing"));
  });
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __notgramAudioLifecycle: string[] }
  ).__notgramAudioLifecycle.filter((event) => event === "resume").length)).toBe(2);
  await audioEngine.evaluate((audio) => audio.dispatchEvent(new Event("ended")));
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __notgramAudioPlayCalls: string[] }
  ).__notgramAudioPlayCalls)).toContain("chat-product:p-audio-next");
});

test("audio controls remember volume and keep the collapsible player inside the conversation", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    HTMLMediaElement.prototype.play = function play() {
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
  });

  await page.getByRole("button", { name: "播放 产品语音.m4a" }).click();
  const audioEngine = page.locator(".persistent-audio-engine");
  const controller = page.getByRole("complementary", { name: "正在播放 产品语音.m4a" });
  await expect(controller).toBeVisible();
  const expandedBounds = await controller.boundingBox();

  const volume = controller.getByRole("slider", { name: "音量" });
  await expect(volume).toHaveAttribute("step", "0.01");
  const floatingVolumeBounds = await volume.boundingBox();
  expect(floatingVolumeBounds).not.toBeNull();
  expect(floatingVolumeBounds!.width).toBeGreaterThanOrEqual(84);
  await volume.fill("0.35");
  await expect(audioEngine).toHaveJSProperty("volume", 0.35);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("notgram.audio.volume")))
    .toBe("0.35");
  await controller.getByRole("button", { name: "静音" }).click();
  await expect(audioEngine).toHaveJSProperty("muted", true);
  await expect(controller.getByRole("button", { name: "取消静音" })).toBeVisible();
  await volume.fill("0.55");
  await expect(audioEngine).toHaveJSProperty("muted", false);
  await expect(audioEngine).toHaveJSProperty("volume", 0.55);

  const conversation = page.locator(".conversation");
  await expect(controller.getByRole("button", { name: /拖动播放器/ })).toHaveCount(0);
  const controllerBounds = await controller.boundingBox();
  expect(controllerBounds).not.toBeNull();
  await page.mouse.move(controllerBounds!.x + 12, controllerBounds!.y + controllerBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(0, 0, { steps: 3 });
  await page.mouse.up();

  const topLeft = await controller.boundingBox();
  const conversationBounds = await conversation.boundingBox();
  expect(topLeft).not.toBeNull();
  expect(conversationBounds).not.toBeNull();
  expect(topLeft!.x).toBeGreaterThanOrEqual(conversationBounds!.x + 11);
  expect(topLeft!.y).toBeGreaterThanOrEqual(conversationBounds!.y + 11);

  const movedControllerBounds = await controller.boundingBox();
  await page.mouse.move(
    movedControllerBounds!.x + 12,
    movedControllerBounds!.y + movedControllerBounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(2_000, 2_000, { steps: 3 });
  await page.mouse.up();
  const bottomRight = await controller.boundingBox();
  expect(bottomRight!.x + bottomRight!.width)
    .toBeLessThanOrEqual(conversationBounds!.x + conversationBounds!.width - 11);
  expect(bottomRight!.y + bottomRight!.height)
    .toBeLessThanOrEqual(conversationBounds!.y + conversationBounds!.height - 11);

  const movedPlay = controller.getByRole("button", { name: "暂停" });
  const movedPlayBounds = await movedPlay.boundingBox();
  await page.mouse.move(
    movedPlayBounds!.x + movedPlayBounds!.width / 2,
    movedPlayBounds!.y + movedPlayBounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    movedPlayBounds!.x - 80,
    movedPlayBounds!.y - 60,
    { steps: 3 },
  );
  await page.mouse.up();
  await expect(movedPlay).toBeVisible();

  await controller.getByRole("button", { name: "缩小播放器" }).click();
  await expect(controller).toHaveClass(/is-compact/);
  await expect(controller.locator(".audio-floating-progress")).toHaveCount(0);
  await expect(controller.locator(".audio-spectrum")).toHaveCount(0);
  await expect(controller.getByRole("button", { name: "暂停" })).toBeVisible();
  await expect(controller.getByRole("button", { name: "展开播放器" })).toBeVisible();
  const compactBounds = await controller.boundingBox();
  expect(compactBounds!.width).toBeLessThan(expandedBounds!.width);
});

test("audio message controls remain inside their bubble at narrow conversation widths", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 720 });
  await page.goto("/");
  const audio = page.getByRole("group", { name: "产品语音.m4a" });
  const bubble = audio.locator("xpath=ancestor::*[contains(@class, 'message-bubble')][1]");
  const volume = audio.getByRole("slider", { name: "音量" });
  await expect(audio).toBeVisible();
  await expect(volume).toHaveAttribute("step", "0.01");
  const volumeBounds = await volume.boundingBox();
  expect(volumeBounds).not.toBeNull();
  expect(volumeBounds!.width).toBeGreaterThanOrEqual(68);
  const geometry = await audio.evaluate((element) => {
    const bubbleElement = element.closest<HTMLElement>(".message-bubble");
    const player = element.getBoundingClientRect();
    const parent = bubbleElement?.getBoundingClientRect();
    return { player, parent };
  });
  expect(geometry.parent).toBeTruthy();
  expect(geometry.player.left).toBeGreaterThanOrEqual(geometry.parent!.left - 0.5);
  expect(geometry.player.right).toBeLessThanOrEqual(geometry.parent!.right + 0.5);
  expect(geometry.player.top).toBeGreaterThanOrEqual(geometry.parent!.top - 0.5);
  expect(geometry.player.bottom).toBeLessThanOrEqual(geometry.parent!.bottom + 0.5);
  expect(geometry.player.width).toBeLessThanOrEqual(geometry.parent!.width);
  await expect(bubble).toHaveCount(1);
});

test("download manager lists only explicit downloads and supports batch management", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+j");
  const dialog = page.getByRole("dialog", { name: "下载" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("暂无下载")).toBeVisible();
  await dialog.getByRole("button", { name: "关闭下载管理" }).click();

  await page.evaluate(async (storePath) => {
    type TestMessage = { id: string; content: { kind: string; [key: string]: unknown }; [key: string]: unknown };
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, TestMessage[]> };
        setState: (partial: {
          messages: Map<string, TestMessage[]>;
          downloadFile: (fileId: number, fileName: string) => Promise<void>;
        }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set("chat-product", (messages.get("chat-product") ?? []).map((message) =>
      message.id === "p-file-downloading" && message.content.kind === "file"
        ? {
            ...message,
            content: {
              ...message.content,
              isDownloading: false,
              isDownloaded: false,
              progress: undefined,
              downloadedSize: undefined,
            },
          }
        : message
    ));
    storeModule.telegramStore.setState({
      messages,
      downloadFile: async () => new Promise<void>(() => undefined),
    });
  }, "/src/store/telegramStore.ts");

  const fileMessage = await revealVirtualMessage(page, "p-file-downloading");
  await expect(fileMessage.getByRole("button", { name: "下载 research-notes.zip" })).toHaveCount(1);
  await fileMessage.getByRole("button", { name: "下载 research-notes.zip" }).click();
  await page.evaluate(async (storePath) => {
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set("chat-product", (messages.get("chat-product") ?? []).map((message) =>
      message.id === "p-file-downloading"
        ? {
            ...message,
            content: {
              ...(message.content as Record<string, unknown>),
              isDownloading: true,
              progress: 0,
            },
          }
        : message
    ));
    storeModule.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");
  await page.keyboard.press("Control+j");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("research-notes.zip", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("progressbar", { name: "research-notes.zip 下载进度" })).toHaveAttribute("aria-valuenow", "48");
  await page.setViewportSize({ width: 375, height: 667 });
  await expect.poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("checkbox", { name: "选择 research-notes.zip" }).check();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog.getByText("已取消", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "移除", exact: true }).click();
  await expect(dialog.getByText("暂无下载")).toBeVisible();
});

test("stale cached photos request recovery and render the refreshed local source", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async (storePath) => {
    type TestMessage = { id: string; content: { kind: string; [key: string]: unknown }; [key: string]: unknown };
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, TestMessage[]> };
        setState: (partial: {
          messages?: Map<string, TestMessage[]>;
          recoverFile?: (fileId: number) => Promise<boolean>;
        }) => void;
      };
    };
    const updatePhoto = (localPath: string) => {
      const state = storeModule.telegramStore.getState();
      const messages = new Map(state.messages);
      messages.set("chat-product", (messages.get("chat-product") ?? []).map((message) =>
        message.id === "p-5" && message.content.kind === "media"
          ? {
              ...message,
              content: {
                ...message.content,
                fileId: 510,
                localPath,
                isDownloaded: true,
                isDownloading: false,
              },
            }
          : message
      ));
      storeModule.telegramStore.setState({ messages });
    };
    (window as unknown as { __notgramRecoveredFiles: number[] }).__notgramRecoveredFiles = [];
    storeModule.telegramStore.setState({
      recoverFile: async (fileId: number) => {
        (window as unknown as { __notgramRecoveredFiles: number[] }).__notgramRecoveredFiles.push(fileId);
        updatePhoto("/mock-video-poster.jpg");
        return true;
      },
    });
    updatePhoto("/missing-cleared-cache-photo.jpg");
  }, "/src/store/telegramStore.ts");

  const photoMessage = await revealVirtualMessage(page, "p-5");
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __notgramRecoveredFiles: number[] }
  ).__notgramRecoveredFiles)).toContain(510);
  await expect(photoMessage.locator('img[src*="mock-video-poster.jpg"]')).toBeVisible();
});

test("unloaded media keeps its clear preview visible", async ({ page }) => {
  await page.goto("/");
  const preview = page.locator('[data-message-id="p-5"] .photo-preview');
  await expect(preview).toHaveClass(/is-preview-only/);
  await expect(preview.locator("img")).toHaveCSS("filter", "none");
  await expect(page.locator('[data-message-id="p-video"] .photo-preview')).not.toHaveClass(/is-preview-only/);
});

test("spoilers reveal on click and reset after leaving the viewport", async ({ page }) => {
  await page.goto("/");

  let richMessage = (await revealVirtualMessage(page, "p-rich-message"))
    .locator(".rich-message-content");
  let textSpoiler = richMessage.locator(".rich-spoiler").filter({ hasText: "Ready" });
  await expect(textSpoiler).toHaveAttribute("role", "button");
  await expect(textSpoiler).toHaveAttribute("data-spoiler-state", "concealed");
  await expect(textSpoiler).toHaveCSS("background-image", /data:image\/svg\+xml/);
  await expect(textSpoiler).toHaveCSS("filter", "blur(1px)");
  await textSpoiler.hover();
  await expect(textSpoiler).toHaveAttribute("data-spoiler-state", "concealed");
  await expect(textSpoiler).toHaveCSS("filter", "blur(0.6px)");
  await textSpoiler.click();
  await expect(textSpoiler).toHaveAttribute("data-spoiler-state", "revealed");
  await expect(textSpoiler).toHaveCSS("background-image", "none");
  await expect(textSpoiler).toHaveCSS("filter", "blur(0px)");

  const messageList = page.getByRole("log", { name: "消息列表" });
  await messageList.focus();
  await page.keyboard.press("End");
  await expect(page.locator('[data-message-id="p-video"]')).toBeVisible();
  richMessage = (await revealVirtualMessage(page, "p-rich-message"))
    .locator(".rich-message-content");
  textSpoiler = richMessage.locator(".rich-spoiler").filter({ hasText: "Ready" });
  await expect(textSpoiler).toHaveAttribute("role", "button");
  await expect(textSpoiler).toHaveAttribute("data-spoiler-state", "concealed");

  await page.evaluate(async (storePath) => {
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Message[]> };
        setState: (partial: { messages: Map<string, Message[]> }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set("chat-product", (messages.get("chat-product") ?? []).map((message) => (
      message.id === "p-5" && message.content.kind === "media"
        ? { ...message, content: { ...message.content, hasSpoiler: true } }
        : message
    )));
    storeModule.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");

  await messageList.focus();
  await page.keyboard.press("End");
  let photoMessage = page.locator('[data-message-id="p-5"]');
  await expect(photoMessage).toBeVisible();
  let mediaSpoiler = photoMessage.locator('.media-spoiler[data-spoiler-state="concealed"]');
  const concealedContent = mediaSpoiler.locator(".media-spoiler-content");
  const revealMedia = mediaSpoiler.getByRole("button", { name: "显示遮罩媒体" });
  await expect(revealMedia).toBeVisible();
  await expect(concealedContent).toHaveAttribute("inert", "");
  await expect(concealedContent).toHaveCSS("z-index", "0");
  await expect(concealedContent).toHaveCSS("filter", /blur\(12px\) saturate\(0.78\) brightness\(0.84\)/);
  const prism = mediaSpoiler.locator(".media-spoiler-prism");
  await expect(prism).toHaveCount(1);
  await expect(prism).toHaveCSS("z-index", "10");
  await expect(prism).toHaveCSS("background-size", "24px 100%");
  await expect(prism).toHaveCSS("backdrop-filter", /blur\(24px\) saturate\(0.92\)/);
  await expect(prism).toHaveCSS("filter", /url/);
  await expect(revealMedia).toHaveCSS("z-index", "20");
  await expect(mediaSpoiler.locator(":scope > .media-spoiler-layers")).toHaveCSS("z-index", "0");
  const spoilerStatus = photoMessage.locator(".photo-preview > .media-spoiler-status");
  await expect(spoilerStatus).toHaveCSS("z-index", "30");
  await expect(spoilerStatus).toHaveCSS("will-change", "transform");
  await expect(spoilerStatus.getByRole("progressbar", { name: "下载 界面预览.jpg" }))
    .toHaveAttribute("aria-valuenow", "62");

  await revealMedia.click({ position: { x: 12, y: 12 } });
  mediaSpoiler = photoMessage.locator('.media-spoiler[data-spoiler-state="revealed"]');
  await expect(mediaSpoiler).toBeVisible();
  await expect(mediaSpoiler.locator(".media-spoiler-content")).not.toHaveAttribute("inert", "");
  await expect(mediaSpoiler.getByRole("button", { name: "显示遮罩媒体" })).toHaveCount(0);
  await expect(photoMessage.locator(".photo-preview > .media-spoiler-status")).toHaveCount(0);
  await expect(mediaSpoiler.getByRole("progressbar", { name: "下载 界面预览.jpg" })).toBeVisible();
  await expect(mediaSpoiler.locator(".media-spoiler-prism")).toHaveCSS("opacity", "0");

  const popupPromise = page.waitForEvent("popup");
  await mediaSpoiler.locator(".photo-open").click();
  const popup = await popupPromise;
  await popup.close();

  await revealVirtualMessage(page, "p-rich-message");
  await messageList.focus();
  await page.keyboard.press("End");
  photoMessage = page.locator('[data-message-id="p-5"]');
  await expect(photoMessage).toBeVisible();
  await expect(photoMessage.locator('.media-spoiler[data-spoiler-state="concealed"]')).toBeVisible();
});

test("rich media transfer controls stay above spoiler reveal layers", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async (storePath) => {
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Message[]> };
        setState: (partial: {
          messages: Map<string, Message[]>;
          cancelFileDownload: (fileId: number) => Promise<void>;
        }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set("chat-product", (messages.get("chat-product") ?? []).map((message) => {
      if (message.id !== "p-rich-message" || message.content.kind !== "rich") return message;
      return {
        ...message,
        content: {
          ...message.content,
          blocks: message.content.blocks.map((block) => block.kind === "media" ? {
            ...block,
            media: {
              ...block.media,
              fileId: 611,
              isDownloaded: false,
              isDownloading: true,
              progress: 0.44,
              hasSpoiler: true,
            },
          } : block),
        },
      };
    }));
    (window as unknown as { __notgramCancelledDownloads: number[] }).__notgramCancelledDownloads = [];
    storeModule.telegramStore.setState({
      messages,
      cancelFileDownload: async (fileId) => {
        (window as unknown as { __notgramCancelledDownloads: number[] })
          .__notgramCancelledDownloads.push(fileId);
      },
    });
  }, "/src/store/telegramStore.ts");

  const richMessage = await revealVirtualMessage(page, "p-rich-message");
  const mediaSpoiler = richMessage.locator('.rich-media-block .media-spoiler[data-spoiler-state="concealed"]');
  await mediaSpoiler.scrollIntoViewIfNeeded();
  await expect(mediaSpoiler.locator(".media-spoiler-content")).toHaveAttribute("inert", "");
  const status = richMessage.locator(".rich-media-visual > .media-spoiler-status");
  await expect(status).toHaveCSS("z-index", "30");
  const progress = status.getByRole("progressbar", { name: "下载 Bot chart" });
  await expect(progress).toHaveAttribute("aria-valuenow", "44");
  await progress.getByRole("button", { name: "取消下载 Bot chart" }).click();
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __notgramCancelledDownloads: number[] }
  ).__notgramCancelledDownloads)).toEqual([611]);
  await expect(mediaSpoiler).toHaveAttribute("data-spoiler-state", "concealed");
});

test("single-clicking a photo opens a dedicated fullscreen viewer with wheel zoom and dragging", async ({ page }) => {
  await page.goto("/");
  await revealVirtualMessage(page, "p-5");
  await page.evaluate(async (storePath) => {
    type ViewerMessage = {
      id: string;
      sentAt: string;
      content: { kind: string; fileName?: string; caption?: string; [key: string]: unknown };
      [key: string]: unknown;
    };
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, ViewerMessage[]> };
        setState: (partial: {
          messages: Map<string, ViewerMessage[]>;
          saveFileToDownloads: (sourcePath: string, fileName: string) => Promise<void>;
          saveFileAs: (sourcePath: string, fileName: string) => Promise<void>;
        }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    const sourceEntry = [...messages.entries()].find(([, items]) =>
      items.some((message) => message.id === "p-5"));
    if (!sourceEntry) throw new Error("Missing source photo for media viewer test");
    const [sourceChatId, sourceMessages] = sourceEntry;
    const source = sourceMessages.find((message) => message.id === "p-5")!;
    const downloadedSource: ViewerMessage = {
      ...source,
      content: {
        ...source.content,
        localPath: "/mock-video-poster.jpg",
        isDownloaded: true,
        isDownloading: false,
        canDownload: false,
        progress: undefined,
      },
    };
    const additions = Array.from({ length: 8 }, (_, index): ViewerMessage => ({
      ...downloadedSource,
      id: `p-viewer-extra-${index + 1}`,
      sentAt: new Date(Date.parse(source.sentAt) + (index + 1) * 1_000).toISOString(),
      content: {
        ...downloadedSource.content,
        fileName: `查看器补充图片-${index + 1}.jpg`,
        caption: "",
      },
    }));
    messages.set(sourceChatId, [
      ...sourceMessages.map((message) => message.id === source.id ? downloadedSource : message),
      ...additions,
    ]);
    const testWindow = window as unknown as {
      __notgramViewerSavedFiles: Array<[string, string]>;
      __notgramViewerSaveAsFiles: Array<[string, string]>;
    };
    testWindow.__notgramViewerSavedFiles = [];
    testWindow.__notgramViewerSaveAsFiles = [];
    storeModule.telegramStore.setState({
      messages,
      saveFileToDownloads: async (sourcePath, fileName) => {
        testWindow.__notgramViewerSavedFiles.push([sourcePath, fileName]);
      },
      saveFileAs: async (sourcePath, fileName) => {
        testWindow.__notgramViewerSaveAsFiles.push([sourcePath, fileName]);
      },
    });
  }, "/src/store/telegramStore.ts");
  const sourcePhoto = await revealVirtualMessage(page, "p-5");
  const popupPromise = page.waitForEvent("popup");
  await sourcePhoto.locator(".photo-open").click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  await popup.setViewportSize({ width: 1080, height: 720 });

  await expect(page.getByRole("dialog", { name: "图片查看器：界面预览.jpg" })).toHaveCount(0);
  await expect(popup.getByRole("dialog", { name: "图片查看器：界面预览.jpg" })).toBeVisible();
  const viewer = popup.locator(".media-viewer");
  await expect.poll(() => viewer.evaluate((element) => {
    const animations = element.getAnimations({ subtree: false });
    return animations.length > 0 && animations.every((animation) => animation.playState === "finished");
  })).toBe(true);
  const downloadButton = viewer.getByRole("button", { name: "下载图片" });
  await expect(viewer.locator(".media-viewer-toolbar")).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "关闭图片查看器" })).toHaveCount(0);
  await expect(downloadButton).toBeVisible();
  await expect(downloadButton).not.toBeFocused();
  await expect.poll(() => popup.evaluate(() =>
    document.activeElement?.classList.contains("media-viewer-stage"))).toBe(true);
  await expect(viewer.getByRole("button", { name: "缩小" })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "放大" })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "重置缩放" })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "复制图片" })).toHaveCount(0);
  const details = viewer.getByLabel("图片详细信息");
  await expect(details.locator("span")).toHaveText([
    "数据中心：DC2",
    "尺寸：512 × 512",
    "大小：186 KB",
  ]);
  await expect(details).toHaveCSS("text-align", "left");
  await expect(details).toHaveCSS("position", "absolute");
  const detailRows = await details.locator("span").evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect().y));
  expect(detailRows.every((row, index) => index === 0 || row > detailRows[index - 1]!)).toBe(true);
  await expect.poll(() => details.evaluate((element) =>
    getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  const caption = popup.locator(".media-viewer-caption");
  await expect(caption).toHaveText("新的媒体预览样式");
  await expect(caption).toHaveCSS("position", "absolute");
  await expect(caption).toHaveCSS("text-align", "center");
  await expect(caption).toHaveCSS("border-radius", "8px");
  const viewerBounds = await popup.locator(".media-viewer-backdrop").boundingBox();
  const viewport = popup.viewportSize();
  expect(viewerBounds).toEqual({ x: 0, y: 0, width: viewport?.width, height: viewport?.height });
  const stage = popup.locator(".media-viewer-stage");
  const stageBounds = await stage.boundingBox();
  const detailsBounds = await details.boundingBox();
  const downloadBounds = await downloadButton.boundingBox();
  expect(Math.abs(stageBounds!.x - viewerBounds!.x)).toBeLessThan(2);
  expect(Math.abs(stageBounds!.y - viewerBounds!.y)).toBeLessThan(2);
  expect(Math.abs(stageBounds!.width - viewerBounds!.width)).toBeLessThan(2);
  expect(Math.abs(stageBounds!.height - viewerBounds!.height)).toBeLessThan(2);
  expect(detailsBounds!.x - stageBounds!.x).toBeCloseTo(18, 0);
  expect(detailsBounds!.width).toBeLessThan(260);
  expect(stageBounds!.y + stageBounds!.height - detailsBounds!.y - detailsBounds!.height)
    .toBeCloseTo(14, 0);
  expect(stageBounds!.x + stageBounds!.width - downloadBounds!.x - downloadBounds!.width)
    .toBeCloseTo(18, 0);
  expect(stageBounds!.y + stageBounds!.height - downloadBounds!.y - downloadBounds!.height)
    .toBeCloseTo(14, 0);
  const overlayColor = await popup.locator("html").evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--color-overlay").trim());
  await expect(popup.locator(".media-viewer-backdrop")).toHaveCSS(
    "background-color",
    overlayColor,
  );
  await expect.poll(() => popup.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgba(0, 0, 0, 0)");
  const thumbnails = viewer.getByRole("navigation", { name: "会话图片预览" });
  await expect(thumbnails.getByRole("button")).toHaveCount(9);
  await expect(thumbnails.locator("img")).toHaveCount(9);
  await expect(thumbnails).toHaveCSS("overflow-x", "hidden");
  await expect(thumbnails).toHaveCSS("scrollbar-width", "none");
  await expect(thumbnails.locator("img").first()).toHaveAttribute("loading", "eager");
  await expect.poll(() => thumbnails.locator("img").evaluateAll((images) =>
    images.every((image) => {
      const imageElement = image as HTMLImageElement;
      return imageElement.complete && imageElement.naturalWidth > 0;
    }),
  )).toBe(true);
  await expect(thumbnails.getByRole("button", { name: "查看 界面预览.jpg" }))
    .toHaveAttribute("aria-current", "true");
  const captionBounds = await caption.boundingBox();
  const thumbnailBounds = await thumbnails.boundingBox();
  expect(captionBounds!.x + captionBounds!.width / 2)
    .toBeCloseTo(thumbnailBounds!.x + thumbnailBounds!.width / 2, 0);
  expect(detailsBounds!.y).toBeCloseTo(thumbnailBounds!.y, 0);
  expect(detailsBounds!.y + detailsBounds!.height)
    .toBeCloseTo(thumbnailBounds!.y + thumbnailBounds!.height, 0);
  expect(captionBounds!.y + captionBounds!.height)
    .toBeLessThan(Math.min(detailsBounds!.y, thumbnailBounds!.y));

  await stage.hover();
  await popup.keyboard.down("Control");
  await popup.mouse.wheel(0, -240);
  await popup.keyboard.up("Control");
  await expect(popup.locator(".media-viewer-image")).toHaveAttribute("style", /scale\(1\.5\)/);
  await popup.mouse.move(stageBounds!.x + stageBounds!.width / 2, stageBounds!.y + stageBounds!.height / 2);
  await popup.mouse.down();
  await popup.mouse.move(stageBounds!.x + stageBounds!.width / 2 + 48, stageBounds!.y + stageBounds!.height / 2 + 32);
  await popup.mouse.up();
  await expect(popup.locator(".media-viewer-image")).toHaveAttribute("style", /translate\(48px, 32px\) scale\(1\.5\)/);
  const previousNavigationBounds = await viewer.getByRole("button", { name: "上一张" }).boundingBox();
  await popup.keyboard.press("ArrowLeft");
  await expect(viewer).toHaveAttribute("aria-label", "图片查看器：纵向图片.jpg");
  await expect(details.locator("span")).toHaveText([
    "数据中心：DC4",
    "尺寸：512 × 512",
    "大小：220 KB",
  ]);
  await expect(popup.locator(".media-viewer-caption"))
    .toHaveText("纵向图片应该按实际比例收窄，外壳不能留下额外空白。");
  const nextNavigationBounds = await viewer.getByRole("button", { name: "下一张" }).boundingBox();
  expect(nextNavigationBounds!.y).toBeCloseTo(previousNavigationBounds!.y, 0);
  await thumbnails.getByRole("button", { name: "查看 界面预览.jpg" }).click();
  await expect(viewer).toHaveAttribute("aria-label", "图片查看器：界面预览.jpg");
  await expect(popup.locator(".media-viewer-caption")).toHaveText("新的媒体预览样式");
  await downloadButton.click();
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __notgramViewerSavedFiles: Array<[string, string]> }
  ).__notgramViewerSavedFiles)).toEqual([["/mock-video-poster.jpg", "界面预览.jpg"]]);
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __notgramViewerSaveAsFiles: Array<[string, string]> }
  ).__notgramViewerSaveAsFiles)).toEqual([]);

  const closed = popup.waitForEvent("close");
  const finalStageBounds = await stage.boundingBox();
  await popup.mouse.click(finalStageBounds!.x + 8, finalStageBounds!.y + 8);
  await closed;
  await expect(page.locator(".conversation")).toBeVisible();
});

test("captioned albums keep descriptions in the fullscreen viewer", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const album = page.locator('[data-media-album-id="mock-album-product"]');
  await expect(album).toBeVisible();
  await expect(album.locator(".media-album-captions")).toHaveCount(0);
  await expect(album).not.toContainText("新的媒体预览样式");
  for (const viewport of [
    { width: 1220, height: 780 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await album.scrollIntoViewIfNeeded();
    const geometry = await album.evaluate((element) => ({
      albumHeight: element.getBoundingClientRect().height,
      gridHeight: element.querySelector<HTMLElement>(".media-album-grid")?.getBoundingClientRect().height,
    }));
    expect(geometry.gridHeight).toBeDefined();
    expect(geometry.albumHeight).toBeCloseTo(geometry.gridHeight!, 0);
    expect(await horizontalOverflow(page)).toBe(false);
  }

  const popupPromise = page.waitForEvent("popup");
  await page.locator('[data-message-id="p-5"] .photo-open').click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  await expect(popup.locator(".media-viewer-caption")).toHaveText("新的媒体预览样式");
  await popup.keyboard.press("ArrowLeft");
  await expect(popup.locator(".media-viewer-caption"))
    .toHaveText("纵向图片应该按实际比例收窄，外壳不能留下额外空白。");

  const closed = popup.waitForEvent("close");
  await popup.keyboard.down("Escape");
  await closed;
});

test("chat switching and ordinary message interactions keep typing focus in the composer", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await expect(composer).toBeFocused();

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(composer).toBeFocused();
  await page.locator('[data-message-id="m-3"] .message-rich-text').click();
  await expect(composer).toBeFocused();

  await openConversationMessageSearch(page);
  await expect(page.getByRole("searchbox", { name: "搜索会话和消息" })).toBeFocused();
  await expect(page.getByRole("group", { name: "搜索范围：Mia Chen" })).toBeVisible();
});

test("selecting message text is not interrupted by composer autofocus", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-chat-id="chat-mia"]').click();

  const composer = page.getByRole("textbox", { name: "消息内容" });
  const messageText = page.locator('[data-message-id="m-3"] .message-rich-text');
  await expect(composer).toBeFocused();
  await expect(messageText).toBeVisible();
  await messageText.scrollIntoViewIfNeeded();
  const drag = await messageText.evaluate((surface) => {
    const text = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT).nextNode();
    if (!text) return undefined;
    const pointAt = (offset: number) => {
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      const bounds = range.getBoundingClientRect();
      return { x: bounds.left + 1, y: bounds.top + bounds.height / 2 };
    };
    return {
      start: pointAt(0),
      end: pointAt(Math.min(8, (text.textContent?.length ?? 1) - 1)),
    };
  });
  expect(drag).toBeTruthy();
  await page.mouse.move(drag!.start.x, drag!.start.y);
  await page.mouse.down();
  await page.mouse.move(drag!.end.x, drag!.end.y, { steps: 12 });
  await page.mouse.up();

  const selectedText = await page.evaluate(() => globalThis.getSelection()?.toString() ?? "");
  expect(selectedText.length).toBeGreaterThan(0);
  await expect(composer).not.toBeFocused();

  // Conversation state changes must not replace the selected native text nodes.
  await page.evaluate(async (storePath) => {
    const { preferencesStore } = await import(storePath);
    const notificationSound = preferencesStore.getState().notificationSound;
    preferencesStore.setState({ notificationSound: !notificationSound });
  }, "/src/store/preferencesStore.ts");
  await page.waitForTimeout(2_000);
  await expect.poll(() => page.evaluate(() => globalThis.getSelection()?.toString() ?? ""))
    .toBe(selectedText);

  const dragPoints = await messageText.evaluate((surface) => {
    const otherSurface = [...document.querySelectorAll<HTMLElement>(".message-rich-text")]
      .find((candidate) => candidate !== surface && candidate.textContent?.trim());
    const sourceNode = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT).nextNode();
    const otherNode = otherSurface
      ? document.createTreeWalker(otherSurface, NodeFilter.SHOW_TEXT).nextNode()
      : null;
    if (!sourceNode || !otherNode) return undefined;
    const selection = globalThis.getSelection();
    selection?.setBaseAndExtent(sourceNode, Math.min(4, sourceNode.textContent?.length ?? 0), otherNode, 0);
    document.dispatchEvent(new Event("selectionchange"));
    return true;
  });
  expect(dragPoints).toBe(true);
  const boundaryResult = await page.evaluate(() => {
    const selection = globalThis.getSelection();
    const owner = (node: Node | null) => node instanceof Element
      ? node.closest<HTMLElement>("[data-message-id]")?.dataset.messageId
      : node?.parentElement?.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
    return {
      text: selection?.toString() ?? "",
      anchorMessageId: owner(selection?.anchorNode ?? null),
      focusMessageId: owner(selection?.focusNode ?? null),
    };
  });
  expect(boundaryResult?.text.length).toBeGreaterThan(0);
  expect(boundaryResult?.anchorMessageId).toBe("m-3");
  expect(boundaryResult?.focusMessageId).toBe("m-3");

  await page.locator(".message-list").click({ position: { x: 8, y: 8 } });
  await expect.poll(() => page.evaluate(() => globalThis.getSelection()?.toString() ?? ""))
    .toBe("");
  await expect(page.locator(".conversation")).not.toHaveClass(/is-message-text-selecting/);
});

test("primary clicks outside selected message text clear the native selection", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-chat-id="chat-mia"]').click();

  const messageText = page.locator('[data-message-id="m-3"] .message-rich-text');
  await expect(messageText).toBeVisible();
  const selectText = async () => {
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    await expect(messageText).toHaveAttribute("data-rich-text", "markdown");
    await messageText.scrollIntoViewIfNeeded();
    const drag = await messageText.evaluate((surface) => {
      const text = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT).nextNode();
      if (!text) return undefined;
      const pointAt = (offset: number) => {
        const range = document.createRange();
        range.setStart(text, offset);
        range.setEnd(text, offset + 1);
        const bounds = range.getBoundingClientRect();
        return { x: bounds.left + 1, y: bounds.top + bounds.height / 2 };
      };
      return {
        start: pointAt(0),
        end: pointAt(Math.min(8, (text.textContent?.length ?? 1) - 1)),
      };
    });
    expect(drag).toBeTruthy();
    await page.mouse.move(drag!.start.x, drag!.start.y);
    await page.mouse.down();
    await page.mouse.move(drag!.end.x, drag!.end.y, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => globalThis.getSelection()?.toString() ?? ""))
      .not.toBe("");
  };
  const expectSelectionCleared = async () => {
    await expect.poll(() => page.evaluate(() => globalThis.getSelection()?.toString() ?? ""))
      .toBe("");
    await expect(page.locator(".conversation")).not.toHaveClass(/is-message-text-selecting/);
  };

  await selectText();
  await page.locator(".message-list").click({ position: { x: 8, y: 8 } });
  await expectSelectionCleared();

  await selectText();
  await page.locator('[data-chat-id="chat-product"]').click();
  await expectSelectionCleared();

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(messageText).toBeVisible();
  await selectText();
  await page.getByRole("textbox", { name: "消息内容" }).click();
  await expectSelectionCleared();
});

test("replying from selected message text sends only the partial quote", async ({ page }) => {
  await page.goto("/");
  await revealVirtualMessage(page, "p-2");

  const source = page.locator('[data-message-id="p-2"]');
  const messageText = source.locator(".message-rich-text");
  const selectedText = "消息区再留一点呼吸感";
  await messageText.evaluate((surface, quote) => {
    const fullText = surface.textContent ?? "";
    const start = fullText.indexOf(quote);
    if (start < 0) throw new Error("quote fixture was not found");
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
    const pointAt = (offset: number) => {
      let consumed = 0;
      let node = walker.nextNode();
      while (node) {
        const length = node.textContent?.length ?? 0;
        if (offset <= consumed + length) return { node, offset: offset - consumed };
        consumed += length;
        node = walker.nextNode();
      }
      throw new Error("selection point was not found");
    };
    const begin = pointAt(start);
    walker.currentNode = surface;
    const end = pointAt(start + quote.length);
    const range = document.createRange();
    range.setStart(begin.node, begin.offset);
    range.setEnd(end.node, end.offset);
    const selection = globalThis.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, selectedText);
  const quoteBounds = await messageText.boundingBox();
  expect(quoteBounds).toBeTruthy();
  await page.mouse.click(
    quoteBounds!.x + quoteBounds!.width / 2,
    quoteBounds!.y + quoteBounds!.height / 2,
    { button: "right" },
  );
  const menu = page.getByRole("menu", { name: "消息操作" });
  await expect(menu.getByRole("menuitem").first()).toHaveText("回复");
  await chooseMessageMenuItem(page, "回复");
  await expect(page.locator(".composer-context.is-replying small")).toHaveText(selectedText);
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: { getState: () => { drafts: Map<string, { replyQuote?: unknown }> } };
    };
    return module.telegramStore.getState().drafts.get("chat-product")?.replyQuote;
  }, "/src/store/telegramStore.ts")).toEqual({ text: selectedText, position: 4 });

  // A native TDLib draft echo can temporarily omit the quote while it is
  // being normalized. The locally selected quote must remain authoritative.
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: { getState: () => { updateChatDraft: (chatId: string, text: string, replyToMessageId?: string) => void } };
    };
    module.telegramStore.getState().updateChatDraft("chat-product", "", "p-2");
  }, "/src/store/telegramStore.ts");
  await expect(page.locator(".composer-context.is-replying small")).toHaveText(selectedText);

  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.fill("只回复选中的这部分");
  await page.getByRole("button", { name: "发送消息" }).click();
  const sent = page.locator(".message-row.is-outgoing", { hasText: "只回复选中的这部分" }).last();
  await expect(sent.locator(".message-reply-preview small")).toHaveText(selectedText);
});

test("partial replies map rendered Markdown back to an exact source quote", async ({ page }) => {
  await page.goto("/");
  await revealVirtualMessage(page, "p-markdown");

  const source = page.locator('[data-message-id="p-markdown"]');
  const messageText = source.locator(".message-rich-text");
  const renderedQuote = "Markdown 粗体、斜体";
  await expect(messageText).toContainText(renderedQuote);
  await messageText.evaluate((surface, quote) => {
    const fullText = surface.textContent ?? "";
    const start = fullText.indexOf(quote);
    if (start < 0) throw new Error("Markdown quote fixture was not found");
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
    const pointAt = (offset: number) => {
      let consumed = 0;
      let node = walker.nextNode();
      while (node) {
        const length = node.textContent?.length ?? 0;
        if (offset <= consumed + length) return { node, offset: offset - consumed };
        consumed += length;
        node = walker.nextNode();
      }
      throw new Error("Markdown selection point was not found");
    };
    const begin = pointAt(start);
    walker.currentNode = surface;
    const end = pointAt(start + quote.length);
    const range = document.createRange();
    range.setStart(begin.node, begin.offset);
    range.setEnd(end.node, end.offset);
    const selection = globalThis.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, renderedQuote);
  await messageText.locator("strong").click({ button: "right" });
  await chooseMessageMenuItem(page, "回复");

  const sourceQuote = "Markdown 粗体**、*斜体";
  await expect(page.locator(".composer-context.is-replying small")).toHaveText(sourceQuote);
  await expect.poll(() => page.evaluate(async (storePath) => {
    const module = await import(storePath) as {
      telegramStore: { getState: () => { drafts: Map<string, { replyQuote?: unknown }> } };
    };
    return module.telegramStore.getState().drafts.get("chat-product")?.replyQuote;
  }, "/src/store/telegramStore.ts")).toEqual({ text: sourceQuote, position: 2 });

  await page.getByRole("textbox", { name: "消息内容" }).fill("回复 Markdown 选区");
  await page.getByRole("button", { name: "发送消息" }).click();
  const sent = page.locator(".message-row.is-outgoing", { hasText: "回复 Markdown 选区" }).last();
  await expect(sent.locator(".message-reply-preview small")).toHaveText(sourceQuote);
});

test("reply context resizes the latest viewport without moving a detached anchor", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(13);

  const latest = page.locator('[data-message-id="p-video"]');
  await latest.locator(".message-bubble-shell").click({ button: "right" });
  await chooseMessageMenuItem(page, "回复");
  await expect(page.locator(".composer-context.is-replying")).toBeVisible();
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(13);
  const readLatestGap = () => latest.evaluate((element) => {
    const replyContext = document.querySelector<HTMLElement>(".composer-context.is-replying");
    return replyContext
      ? replyContext.getBoundingClientRect().top - element.getBoundingClientRect().bottom
      : Number.NEGATIVE_INFINITY;
  });
  await expect.poll(readLatestGap).toBeGreaterThanOrEqual(11);
  const latestGap = await readLatestGap();
  expect(latestGap).toBeLessThanOrEqual(13);

  await page.getByRole("button", { name: "取消回复", exact: true }).click();
  await scrollAwayFromBottom(page);
  const anchorBeforeReply = await visibleMessageAnchor(page);
  const detachedReplyTargetId = await messageList.evaluate((list) => {
    const bounds = list.getBoundingClientRect();
    return [...list.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((row) => {
        const rowBounds = row.getBoundingClientRect();
        return row.querySelector(".message-bubble-shell") &&
          rowBounds.top >= bounds.top + 40 && rowBounds.bottom <= bounds.bottom - 40;
      })?.dataset.messageId;
  });
  expect(detachedReplyTargetId).toBeTruthy();
  await page.evaluate(async ({ modulePath, messageId }) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { drafts: Map<string, unknown> };
        setState: (partial: { drafts: Map<string, unknown> }) => void;
      };
    };
    const drafts = new Map(storeModule.telegramStore.getState().drafts);
    drafts.set("chat-product", {
      chatId: "chat-product",
      text: "",
      replyToMessageId: messageId,
      updatedAt: new Date().toISOString(),
      pending: false,
    });
    storeModule.telegramStore.setState({ drafts });
  }, {
    modulePath: "/src/store/telegramStore.ts",
    messageId: detachedReplyTargetId!,
  });
  await expect(page.locator(".composer-context.is-replying")).toBeVisible();
  const anchorAfterReply = await visibleMessageAnchor(page);
  expect(anchorAfterReply.id).toBe(anchorBeforeReply.id);
  expect(Math.abs(anchorAfterReply.offset - anchorBeforeReply.offset)).toBeLessThanOrEqual(1);
});

test("long message editing keeps the bottom stable through cancel and save", async ({ page }) => {
  await page.goto("/");
  const messageList = page.getByRole("log", { name: "消息列表" });
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");

  const longText = Array.from(
    { length: 18 },
    (_, index) => `编辑稳定性第 ${index + 1} 行：保持末条消息贴底`,
  ).join("\n");
  await composer.fill(longText);
  await page.getByRole("button", { name: "发送消息" }).click();
  const sent = page.locator(".message-row.is-outgoing", {
    hasText: "编辑稳定性第 18 行",
  }).last();
  await expect(sent).toBeVisible();
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);

  const openEditor = async () => {
    await sent.locator(".message-bubble-shell").click({ button: "right" });
    const edit = page.getByRole("menuitem", { name: "编辑", exact: true });
    await expect(edit).toBeVisible();
    const samples = await traceBottomGeometryWhileClicking(edit);
    await expect(page.locator(".composer-context.is-editing")).toBeVisible();
    expectStableFollowingGeometry(samples, "is-editing");
  };

  await openEditor();
  const cancelSamples = await traceBottomGeometryWhileClicking(
    page.getByRole("button", { name: "取消编辑", exact: true }),
  );
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  expectStableFollowingGeometry(cancelSamples, "");

  await openEditor();
  const savedText = `${longText}\n保存后仍保持稳定`;
  await composer.fill(savedText);
  const saveSamples = await traceBottomGeometryWhileClicking(
    page.getByRole("button", { name: "保存编辑", exact: true }),
    40,
  );
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  await expect(sent).toContainText("保存后仍保持稳定");
  expectStableFollowingGeometry(saveSamples, "");
});

test("editing while detached preserves the visible message anchor", async ({ page }) => {
  await page.goto("/");
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await scrollAwayFromBottom(page);
  const anchorBefore = await visibleMessageAnchor(page);
  const editableMessageId = await messageList.evaluate((list) => {
    const bounds = list.getBoundingClientRect();
    return [...list.querySelectorAll<HTMLElement>(".message-row.is-outgoing[data-message-id]")]
      .find((row) => {
        const rowBounds = row.getBoundingClientRect();
        return row.querySelector(".message-rich-text") &&
          rowBounds.top >= bounds.top + 40 && rowBounds.bottom <= bounds.bottom - 40;
      })?.dataset.messageId;
  });
  expect(editableMessageId).toBeTruthy();

  const editable = page.locator(`[data-message-id="${editableMessageId}"]`);
  await editable.locator(".message-bubble-shell").click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  await expect(page.locator(".composer-context.is-editing")).toBeVisible();
  const anchorDuring = await visibleMessageAnchor(page);
  expect(anchorDuring.id).toBe(anchorBefore.id);
  expect(Math.abs(anchorDuring.offset - anchorBefore.offset)).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "取消编辑", exact: true }).click();
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  const anchorAfter = await visibleMessageAnchor(page);
  expect(anchorAfter.id).toBe(anchorBefore.id);
  expect(Math.abs(anchorAfter.offset - anchorBefore.offset)).toBeLessThanOrEqual(1);
});

test("reply context survives concurrent message updates and is sent", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await revealVirtualMessage(page, "p-2");
  const source = page.locator('[data-message-id="p-2"]');
  await source.locator(".message-bubble-shell").click({ button: "right" });
  await chooseMessageMenuItem(page, "回复");
  await expect(page.locator(".composer-context.is-replying")).toBeVisible();

  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, unknown[]> };
        setState: (state: { messages: Map<string, unknown[]> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    module.telegramStore.setState({ messages: new Map(state.messages) });
  }, "/src/store/telegramStore.ts");

  await expect(page.locator(".composer-context.is-replying")).toBeVisible();
  await composer.fill("消息刷新后仍保留引用");
  await page.getByRole("button", { name: "发送消息" }).click();
  const sent = page.locator(
    ".message-row.is-outgoing",
    { hasText: "消息刷新后仍保留引用" },
  ).last();
  await expect(sent).toBeVisible();
  await expect(sent.locator(".message-reply-preview")).toBeVisible();
});

test("canceling a draft reply removes the persisted reply target", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await revealVirtualMessage(page, "p-2");
  const source = page.locator('[data-message-id="p-2"]');
  await source.locator(".message-bubble-shell").click({ button: "right" });
  await chooseMessageMenuItem(page, "回复");
  await expect(page.locator(".composer-context.is-replying")).toBeVisible();
  await composer.fill("取消回复后仍是普通草稿");
  await page.waitForTimeout(850);
  await page.getByRole("button", { name: "取消回复", exact: true }).click();
  await expect(page.locator(".composer-context.is-replying")).toHaveCount(0);
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          drafts: Map<string, { text: string; replyToMessageId?: string }>;
        };
      };
    };
    return module.telegramStore.getState().drafts.get("chat-product");
  }, "/src/store/telegramStore.ts")).toMatchObject({
    text: "取消回复后仍是普通草稿",
    replyToMessageId: undefined,
  });

  await page.locator('[data-chat-id="chat-mia"]').click();
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".composer-context.is-replying")).toHaveCount(0);
  await expect(composer).toHaveValue("取消回复后仍是普通草稿");
  await page.getByRole("button", { name: "发送消息" }).click();
  const sent = page.locator(
    '.message-row.is-outgoing',
    { hasText: "取消回复后仍是普通草稿" },
  ).last();
  await expect(sent).toBeVisible();
  await expect(sent.locator(".message-reply-preview")).toHaveCount(0);
});

test("user profiles expose account identifiers and data-center information", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Mia Chen/ }).first().click();
  await page.getByRole("button", { name: "查看 Mia Chen 资料" }).click();

  const profile = page.getByRole("dialog", { name: "资料" });
  const identity = profile.locator(".profile-identity-card");
  await expect(identity).toBeVisible();
  await expect(identity.getByText("@mia_design", { exact: true })).toBeVisible();
  await expect(identity.getByText("u-mia", { exact: true })).toBeVisible();
  await expect(identity.getByText("DC5, Singapore, SG", { exact: true })).toBeVisible();
});

test("contacts are hidden from the navigation rail", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "联系人", exact: true })).toHaveCount(0);
  await expect(page.locator(".contacts-view")).toHaveCount(0);
});

test("mobile chat switching has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator(".chat-row").first().click();

  await expect(page.locator(".conversation")).toBeVisible();
  await expect(page.locator(".mobile-back")).toBeVisible();
  await expect(page.locator(".message-row")).not.toHaveCount(0);
  expect(await horizontalOverflow(page)).toBe(false);
});

test("minimum window remains operable at Windows 125, 150, and 200 percent scaling", async ({ browser }) => {
  for (const deviceScaleFactor of [1.25, 1.5, 2]) {
    const context = await browser.newContext({
      viewport: { width: 680, height: 560 },
      deviceScaleFactor,
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.locator(".chat-row").first().click();

    await expect(page.locator(".conversation")).toBeVisible();
    await expect(page.locator(".mobile-back")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
    expect(await page.evaluate(() => devicePixelRatio)).toBe(deviceScaleFactor);
    expect(await horizontalOverflow(page)).toBe(false);
    await context.close();
  }
});

test("muted chats use a neutral unread badge", async ({ page }) => {
  await page.goto("/");
  const mutedRow = page.getByRole("button", { name: /Release Notes/ });
  const regularRow = page.getByRole("button", { name: /Mia Chen/ });
  const mutedBadge = mutedRow.locator(".unread-count");
  const regularBadge = regularRow.locator(".unread-count");

  await expect(mutedBadge).toHaveClass(/is-muted/);
  await expect(mutedBadge).toHaveCSS("background-color", "rgb(167, 178, 183)");
  await expect(regularBadge).not.toHaveCSS("background-color", "rgb(167, 178, 183)");
  await expect(page.locator(".chat-row .lucide-volume-x")).toHaveCount(0);
});

test("mention and reply unread counts use theme-specific attention colors", async ({ page }) => {
  await page.goto("/");
  const badge = page.locator('[data-chat-id="chat-forum"] .unread-count');

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

test("chat settings move unread counters onto avatars and persist the choice", async ({ page }) => {
  await page.goto("/");
  const releaseRow = page.locator('.chat-row[data-chat-id="chat-release"]');
  const rightBadge = releaseRow.locator(".chat-row-meta .unread-count");
  const rightBadgeGeometry = await rightBadge.boundingBox();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /聊天设置/ }).click();
  await page.getByRole("button", { name: "头像右下角", exact: true }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  await expect(releaseRow.locator(".chat-avatar-wrap .unread-count-avatar")).toHaveText("8");
  await expect(releaseRow.locator(".chat-row-meta .unread-count")).toHaveCount(0);
  const avatarBadgeGeometry = await releaseRow.locator(".chat-avatar-wrap .unread-count-avatar").boundingBox();
  expect(Math.abs(avatarBadgeGeometry!.width - rightBadgeGeometry!.width)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(avatarBadgeGeometry!.height - rightBadgeGeometry!.height)).toBeLessThanOrEqual(0.5);

  await page.reload();
  await expect(page.locator(
    '.chat-row[data-chat-id="chat-release"] .chat-avatar-wrap .unread-count-avatar',
  )).toHaveText("8");
});

test("media transfers expose their exact circular progress", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    const chatMessages = [...(messages.get("chat-product") ?? [])];
    const index = chatMessages.findIndex((message) => message.id === "p-video");
    if (index < 0) return;
    const message = chatMessages[index];
    chatMessages[index] = {
      ...message,
      content: {
        ...(message.content as Record<string, unknown>),
        isDownloaded: false,
        isDownloading: true,
        progress: 0.37,
      },
    };
    messages.set("chat-product", chatMessages);
    storeModule.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");

  const progress = page.locator('[data-message-id="p-video"] [role="progressbar"]');
  await expect(progress).toHaveAttribute("aria-valuenow", "37");
  const ring = progress.locator(".media-progress-ring-value");
  const dashOffset = Number(await ring.getAttribute("stroke-dashoffset"));
  expect(dashOffset).toBeGreaterThan(47);
  expect(dashOffset).toBeLessThan(48);
});

test("video downloads share real progress and a usable file name across both views", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("notgram:managed-downloads:v1", JSON.stringify([{
      accountId: "default",
      fileId: 93,
      fileName: "视频",
      requestedAt: "2026-08-13T12:00:00.000Z",
    }]));
  });
  await page.goto("/");
  await page.keyboard.press("Control+j");
  const dialog = page.getByRole("dialog", { name: "下载" });
  await expect(dialog.getByText("交互预览.mp4", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("progressbar", { name: "交互预览.mp4 下载进度" }))
    .toHaveAttribute("aria-valuenow", "0");
});

test("pinned chats can be dragged into a fixed order", async ({ page }) => {
  await page.goto("/");
  const product = page.locator('[data-chat-id="chat-product"]');
  const mia = page.locator('[data-chat-id="chat-mia"]');

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

  await expect(page.locator(".chat-row").first()).toContainText("Mia Chen");
  await expect(page.locator(".chat-row").nth(1)).toContainText("产品讨论");
});

test("Markdown and TDLib rich text render as structured message content", async ({ page }) => {
  const mathAssetRequests: string[] = [];
  page.on("request", (request) => {
    if (/RichMathExpression|katex/i.test(request.url())) {
      mathAssetRequests.push(request.url());
    }
  });
  await page.goto("/");
  const productChat = page.getByRole("button", { name: /产品讨论/ }).first();
  await expect(productChat).toBeVisible();
  expect(mathAssetRequests).toEqual([]);
  await productChat.click();

  const markdownRow = await revealVirtualMessage(page, "p-markdown");
  const markdown = markdownRow.locator(".message-rich-text");
  await expect(markdown).toHaveAttribute("data-rich-text", "markdown");
  await expect(markdown.locator("strong")).toHaveText("Markdown 粗体");
  await expect(markdown.locator("em")).toHaveText("斜体");
  await expect(markdown.locator("del")).toHaveText("删除线");
  await expect(markdown.locator("li")).toHaveCount(2);
  await expect(markdown.locator("code")).toHaveText("code");
  const markdownLink = markdown.locator('a[href="https://t.me/mia_design"]');
  await expect(markdownLink).toHaveText("链接");

  const entities = (await revealVirtualMessage(page, "p-rich-entities"))
    .locator(".message-rich-text");
  await expect(entities).toHaveAttribute("data-rich-text", "entities");
  await expect(entities.locator("strong")).toHaveText("bold");
  await expect(entities.locator('a[href="https://t.me/addtheme/NotgramTheme"]')).toHaveText("link");
  const messageList = page.getByRole("log", { name: "消息列表" });
  await messageList.focus();
  await page.keyboard.press("End");
  await expect(page.locator('[data-message-id="p-video"] .photo-caption strong'))
    .toHaveText("昨晚");

  const richMessage = (await revealVirtualMessage(page, "p-rich-message"))
    .locator(".rich-message-content");
  await expect(richMessage).toHaveAttribute("data-rich-text", "rich-message");
  await expect(richMessage.locator("h1")).toHaveText("今日小贴士");
  await expect(richMessage.locator("li")).toHaveCount(3);
  await expect(richMessage.locator("li").first().locator("strong"))
    .toHaveText("优先处理最重要的一件事");
  await expect(richMessage.locator("blockquote")).toHaveCount(2);
  await expect(richMessage.locator("code").first()).toHaveText("5,709 tokens");
  await expect(richMessage.locator(".katex")).toContainText("E");
  expect(mathAssetRequests.some((url) => url.includes("/src/components/RichMathExpression.tsx"))).toBe(true);
  expect(mathAssetRequests.some((url) => /katex(?:\.min)?\.css/i.test(url))).toBe(true);
  await expect(richMessage.locator("table caption")).toHaveText("Status");
  await expect(richMessage.locator("table th")).toHaveText("Metric");
  await expect(richMessage.locator("table td")).toHaveText("Ready");
  const anchorLink = richMessage.locator('a[href^="#rich-message-p-rich-message-anchor-"]');
  await expect(anchorLink).toHaveText("jump");
  const anchorHref = await anchorLink.getAttribute("href");
  expect(anchorHref).toBeTruthy();
  await expect(richMessage.locator(anchorHref!)).toHaveCount(1);
  await richMessage.locator("details summary").click();
  await expect(richMessage.locator("details")).toContainText("Advanced details");
  await expect(richMessage.locator('.rich-media-photo img[alt="Bot chart"]')).toBeVisible();

  const globalSearch = page.getByPlaceholder("搜索会话和消息");
  await globalSearch.fill("热搜");
  await page.locator(".global-message-result").filter({ hasText: "热搜" }).first().click();
  const botQuoteRow = page.locator('[data-message-id="archive-bot-quote"]');
  const botQuote = botQuoteRow.locator(".rich-blockquote");
  await botQuoteRow.scrollIntoViewIfNeeded();
  await expect(botQuote).toHaveCount(1);
  await expect(botQuote.locator("a")).toHaveCount(10);
  const quoteGeometry = await botQuote.evaluate((element) => {
    const style = getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const range = document.createRange();
    range.selectNodeContents(element);
    const lineTops = [...range.getClientRects()].reduce<number[]>((tops, rect) => {
      if (!tops.some((top) => Math.abs(top - rect.top) < 1)) tops.push(rect.top);
      return tops;
    }, []);
    return { lineCount: lineTops.length, height: element.getBoundingClientRect().height, lineHeight };
  });
  expect(quoteGeometry.lineCount).toBeLessThanOrEqual(3);
  expect(quoteGeometry.height).toBeLessThanOrEqual(quoteGeometry.lineHeight * 3.2);
  const senderRow = botQuoteRow.locator(".message-sender-row");
  await expect(senderRow.locator(".message-sender-label")).toHaveText("热点机器人");
  await expect(senderRow).not.toContainText("管理员");
  const senderGeometry = await senderRow.evaluate((element) => {
    const label = element.querySelector<HTMLElement>(".message-sender-label")!;
    const bubble = element.closest<HTMLElement>(".message-bubble")!;
    return {
      rightGap: bubble.getBoundingClientRect().right - label.getBoundingClientRect().right,
      topGap: label.getBoundingClientRect().top - bubble.getBoundingClientRect().top,
      fontSize: Number.parseFloat(getComputedStyle(label).fontSize),
    };
  });
  expect(senderGeometry.rightGap).toBeCloseTo(10, 0);
  expect(senderGeometry.topGap).toBeGreaterThanOrEqual(6);
  expect(senderGeometry.topGap).toBeLessThanOrEqual(10);
  expect(senderGeometry.fontSize).toBeGreaterThanOrEqual(11);
});

test("opening an oversized image document previews and downloads it with synchronized progress", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  await page.evaluate(async ({ mapperPath, storePath }) => {
    const [{ mapTdMessage }, { telegramStore }] = await Promise.all([
      import(mapperPath),
      import(storePath),
    ]);
    const mapped = mapTdMessage({
      "@type": "message",
      id: "p-image-document",
      chat_id: "chat-product",
      sender_id: { "@type": "messageSenderUser", user_id: "u-mia" },
      is_outgoing: false,
      date: Math.floor(Date.now() / 1_000) + 30,
      content: {
        "@type": "messageDocument",
        document: {
          file_name: "design-export.png",
          mime_type: "image/png",
          minithumbnail: {
            width: 1,
            height: 1,
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          },
          document: {
            "@type": "file",
            id: 181,
            size: 11 * 1024 * 1024,
            local: {
              can_be_downloaded: true,
              is_downloading_active: false,
              is_downloading_completed: false,
            },
            remote: {},
          },
        },
        caption: {
          "@type": "formattedText",
          text: "Image sent as a file",
          entities: [],
        },
      },
    });
    if (!mapped) throw new Error("Image document did not map to a message");
    const state = telegramStore.getState() as {
      messages: Map<string, Array<Record<string, unknown>>>;
    };
    const messages = new Map<string, Array<Record<string, unknown>>>(state.messages);
    messages.set("chat-product", [
      ...(messages.get("chat-product") ?? []),
      mapped as Record<string, unknown>,
    ]);
    (window as unknown as { __notgramOpenedImageDownloads: Array<[number, string]> })
      .__notgramOpenedImageDownloads = [];
    telegramStore.setState({
      messages,
      downloadFile: async (fileId: number, fileName: string) => {
        (window as unknown as { __notgramOpenedImageDownloads: Array<[number, string]> })
          .__notgramOpenedImageDownloads.push([fileId, fileName]);
        const current = telegramStore.getState() as {
          messages: Map<string, Array<Record<string, unknown>>>;
        };
        const updatedMessages = new Map(current.messages);
        updatedMessages.set("chat-product", (updatedMessages.get("chat-product") ?? []).map((message) => {
          if (message.id !== "p-image-document") return message;
          const content = message.content as Record<string, unknown>;
          return {
            ...message,
            content: {
              ...content,
              isDownloading: true,
              progress: 0.37,
            },
          };
        }));
        telegramStore.setState({ messages: updatedMessages });
        await new Promise<void>(() => undefined);
      },
    });
  }, {
    mapperPath: "/src/telegram/tdlibMapper.ts",
    storePath: "/src/store/telegramStore.ts",
  });

  const row = page.locator('[data-message-id="p-image-document"]');
  await row.scrollIntoViewIfNeeded();
  await expect(row.locator('[data-media-type="photo"]')).toBeVisible();
  await expect(row.locator(".file-message")).toHaveCount(0);
  await expect(row.locator(".photo-caption")).toContainText("Image sent as a file");
  const preview = row.locator(".photo-preview");
  const image = row.locator('img[alt="Image sent as a file"]');
  await expect(preview).toHaveClass(/is-preview-only/);
  await expect(image).toBeVisible();
  await expect(image).toHaveCSS("filter", "none");
  const download = row.getByRole("button", { name: "下载 design-export.png" });
  await expect(download).toBeVisible();
  await expect(download.locator(".lucide-download")).toBeVisible();
  await expect(download.locator(".lucide-play")).toHaveCount(0);

  const popupPromise = page.waitForEvent("popup");
  await preview.locator(".photo-open").click({ position: { x: 12, y: 12 } });
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __notgramOpenedImageDownloads: Array<[number, string]> }
  ).__notgramOpenedImageDownloads)).toEqual([[181, "design-export.png"]]);
  await expect(popup.locator('.media-viewer-image[alt="Image sent as a file"]')).toBeVisible();

  const mainProgress = row.getByRole("progressbar", { name: "下载 design-export.png" });
  const thumbnail = popup.getByRole("button", { name: "查看 design-export.png" });
  const thumbnailProgress = thumbnail.getByRole("progressbar", { name: "下载 design-export.png" });
  await expect(mainProgress).toHaveAttribute("aria-valuenow", "37");
  await expect(thumbnailProgress).toHaveAttribute("aria-valuenow", "37");
  await expect(thumbnailProgress.locator(".media-progress-ring-value")).toBeVisible();
  const mainProgressStyle = await mainProgress.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.width, style.height, style.backgroundColor, style.borderRadius];
  });
  await expect.poll(() => thumbnailProgress.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.width, style.height, style.backgroundColor, style.borderRadius];
  })).toEqual(mainProgressStyle);

  const closed = popup.waitForEvent("close");
  await popup.keyboard.down("Escape");
  await closed;
});

test("video uses synchronized transparent playback windows and owns the playback spacebar", async ({ page }) => {
  await page.context().addInitScript(() => {
    const pausedState = new WeakMap<HTMLMediaElement, boolean>();
    Object.defineProperty(HTMLMediaElement.prototype, "buffered", {
      configurable: true,
      get() {
        return {
          length: 1,
          start: () => 0,
          end: () => Number.isFinite(this.duration) ? Math.min(this.duration, 6) : 6,
        } as TimeRanges;
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
      configurable: true,
      get() {
        return pausedState.get(this) ?? true;
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value(this: HTMLMediaElement) {
        if (pausedState.get(this) === false) return Promise.resolve();
        pausedState.set(this, false);
        this.dispatchEvent(new Event("play"));
        this.dispatchEvent(new Event("playing"));
        return Promise.resolve();
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", {
      configurable: true,
      value(this: HTMLMediaElement) {
        if (pausedState.get(this) ?? true) return;
        pausedState.set(this, true);
        this.dispatchEvent(new Event("pause"));
      },
    });
  });
  await page.setViewportSize({ width: 1_100, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const row = page.locator('[data-message-id="p-video"]');
  const player = row.locator(".video-player");
  const video = player.locator("video");

  await expect(player).toBeVisible();
  await row.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "auto" }));
  await expect(video).toHaveAttribute("poster", /mock-video-poster\.jpg/);
  await expect(video).not.toHaveAttribute("controls", "");
  await expect(player.getByRole("slider", { name: "播放进度" })).toBeVisible();
  await expect(player.getByRole("button", { name: "打开声音" })).toBeVisible();
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(true);
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).volume))
    .toBe(0.2);

  await player.getByRole("button", { name: /播放 交互预览/ }).click();
  await expect(video).toHaveAttribute("src", /mock-video\.mp4/);
  await video.dispatchEvent("canplay");
  await expect.poll(() => video.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);

  const settingsButton = page.getByRole("button", { name: "设置", exact: true });
  await settingsButton.focus();
  await page.keyboard.press("Space");
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).paused))
    .toBe(true);
  await expect(page.getByRole("dialog", { name: "设置" })).toHaveCount(0);
  await expect.poll(() => settingsButton.evaluate((element) => document.activeElement !== element))
    .toBe(true);

  await page.keyboard.press("Space");
  await expect.poll(() => video.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.focus();
  await page.keyboard.press("Space");
  await expect(composer).toHaveValue(" ");
  await expect.poll(() => video.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);
  await composer.fill("");

  const messageList = page.locator(".message-list");
  await messageList.hover();
  await page.mouse.wheel(0, -240);
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).paused))
    .toBe(true);
  await row.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "auto" }));
  await player.getByRole("button", { name: /播放 交互预览/ }).click();
  await expect.poll(() => video.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);

  await row.click({ button: "right" });
  const actionMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(actionMenu.getByRole("menuitem").nth(0)).toHaveText("回复");
  await expect(actionMenu.getByRole("menuitem").nth(1)).toHaveText("转发");
  await expect(actionMenu.getByRole("menuitem").nth(2)).toHaveText("复制");
  await expect(actionMenu.getByRole("menuitem", { name: "以小窗播放" })).toBeVisible();
  await expect(actionMenu.getByRole("menuitem", { name: "下载", exact: true })).toBeVisible();
  const popupPromise = page.waitForEvent("popup");
  await actionMenu.getByRole("menuitem", { name: "以小窗播放" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  const popupPlayer = popup.locator(".video-window");
  const popupVideo = popupPlayer.locator("video");
  await expect(popupPlayer).toHaveClass(/is-windowed/);
  await expect(popupVideo).toHaveAttribute("src", /mock-video\.mp4/);
  await popupVideo.dispatchEvent("loadedmetadata");
  await expect(player).toBeVisible();
  await expect(player).not.toHaveClass(/is-floating/);
  await expect.poll(() => popupVideo.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);

  const windowedControls = popup.locator(".video-windowed-controls");
  await popup.mouse.move(120, 80);
  await expect.poll(() => windowedControls.evaluate(
    (element) => getComputedStyle(element).opacity,
  )).toBe("1");
  await popup.getByRole("slider", { name: "音量" }).fill("0.35");
  await popup.waitForTimeout(1_100);
  await expect.poll(() => windowedControls.evaluate(
    (element) => getComputedStyle(element).opacity,
  )).toBe("0");
  const popupBounds = await popupPlayer.boundingBox();
  await popup.mouse.click(40, popupBounds!.height / 2);
  await expect.poll(() => popupVideo.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);

  await popup.keyboard.press("f");
  await expect(popupPlayer).toHaveClass(/is-fullscreen/);
  await popupVideo.evaluate((element) => {
    element.style.width = "70%";
    element.style.margin = "0 auto";
  });
  await expect.poll(() => popupVideo.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(false);
  await expect.poll(() => popupVideo.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);
  await popup.mouse.move(550, 360);
  const controls = popup.locator(".video-fullscreen-controls");
  await expect.poll(() => controls.evaluate((element) => getComputedStyle(element).opacity))
    .toBe("1");
  await expect(popup.getByRole("button", { name: "下载视频" })).toBeVisible();
  const controlsBounds = await controls.boundingBox();
  expect(Math.round(controlsBounds!.width)).toBe(550);
  expect(Math.round(controlsBounds!.height)).toBe(80);
  await expect.poll(() => popup.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgba(0, 0, 0, 0)");
  const popupOverlayColor = await popup.locator("html").evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--color-overlay").trim());
  await expect(popupPlayer).toHaveCSS("background-color", popupOverlayColor);

  await popup.waitForTimeout(1_100);
  await expect.poll(() => controls.evaluate((element) => getComputedStyle(element).opacity))
    .toBe("0");
  const popupClosed = popup.waitForEvent("close");
  await popup.keyboard.down("Escape");
  await popupClosed;
  await expect(player).toBeVisible();
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(true);
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).volume))
    .toBe(0.35);
  await page.reload();
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const restoredVideo = page.locator('[data-message-id="p-video"] video');
  await expect.poll(() => restoredVideo.evaluate((element) => (element as HTMLVideoElement).volume))
    .toBe(0.35);
  await expect.poll(() => restoredVideo.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(true);
});

test("photo albums stay compact while keeping captions in the media viewer", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const squareRow = page.locator('[data-message-id="p-5"]');
  const tallRow = page.locator('[data-message-id="p-tall"]');
  const album = page.locator('[data-media-album-id="mock-album-product"]');
  await expect(album).toBeVisible();
  await expect(squareRow).toBeVisible();
  await expect(tallRow).toBeVisible();
  await expect(album.locator(".message-row")).toHaveCount(2);
  expect(await album.locator(".message-row").evaluateAll((rows) =>
    rows.map((row) => (row as HTMLElement).dataset.messageId),
  )).toEqual(["p-tall", "p-5"]);
  await expect(album.locator(".media-album-captions")).toHaveCount(0);
  await expect(album).not.toContainText("纵向图片应该按实际比例收窄，外壳不能留下额外空白。");
  await expect(album).not.toContainText("新的媒体预览样式");
  const compactAlbumGeometry = await album.evaluate((element) => ({
    albumHeight: element.getBoundingClientRect().height,
    gridHeight: element.querySelector<HTMLElement>(".media-album-grid")?.getBoundingClientRect().height,
  }));
  expect(compactAlbumGeometry.gridHeight).toBeDefined();
  expect(compactAlbumGeometry.albumHeight).toBeCloseTo(compactAlbumGeometry.gridHeight!, 0);
  await expect(tallRow).toHaveClass(/group-first/);
  await expect(squareRow).toHaveClass(/group-last/);
  await expect(album.locator(".media-album-grid")).toHaveCSS("gap", "2px");
  await expect(album.locator(".media-album-grid")).toHaveCSS("background-color", "rgb(211, 221, 223)");
  const albumTime = squareRow.locator(".message-meta");
  await expect(albumTime).toHaveCSS("opacity", "0");
  await page.locator(".message-list").evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
  });
  await squareRow.scrollIntoViewIfNeeded();
  const photoBounds = await squareRow.locator(".photo-open").boundingBox();
  expect(photoBounds).not.toBeNull();
  await page.mouse.move(photoBounds!.x + photoBounds!.width / 2, photoBounds!.y + photoBounds!.height / 2);
  await expect(albumTime).toHaveCSS("opacity", "1");
  await expect.poll(() => tallRow.locator("img").evaluate((image) => {
    const media = image as HTMLImageElement;
    return `${media.naturalWidth}x${media.naturalHeight}`;
  })).toBe("900x1800");

  for (const viewport of [
    { width: 1220, height: 780 },
    { width: 680, height: 620 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    for (const row of [tallRow, squareRow]) {
      await row.evaluate((element) => {
        element.scrollIntoView({ block: "center", behavior: "auto" });
      });
      await expect.poll(() => row.locator("img").evaluate((image) => {
        const media = image as HTMLImageElement;
        return media.complete && media.naturalWidth > 0 && media.naturalHeight > 0;
      })).toBe(true);
      const geometry = await row.evaluate((element) => {
        const shell = element.querySelector<HTMLElement>(".message-bubble-shell");
        const bubble = element.querySelector<HTMLElement>(".message-bubble");
        const preview = element.querySelector<HTMLElement>(".photo-preview");
        const image = element.querySelector<HTMLImageElement>(".photo-preview img");
        const stack = element.closest<HTMLElement>(".message-group-stack");
        if (!shell || !bubble || !preview || !image || !stack) return undefined;
        const shellBounds = shell.getBoundingClientRect();
        const bubbleBounds = bubble.getBoundingClientRect();
        const previewBounds = preview.getBoundingClientRect();
        const imageBounds = image.getBoundingClientRect();
        const stackBounds = stack.getBoundingClientRect();
        return {
          shellWidth: shellBounds.width,
          previewWidth: previewBounds.width,
          previewHeight: previewBounds.height,
          shellInsideStack: shellBounds.left >= stackBounds.left - 1 &&
            shellBounds.right <= stackBounds.right + 1,
          bubbleGap: Math.abs(shellBounds.width - bubbleBounds.width),
          imageHorizontalGap: Math.max(
            Math.abs(imageBounds.left - previewBounds.left),
            Math.abs(imageBounds.right - previewBounds.right),
          ),
          imageVerticalGap: Math.max(
            Math.abs(imageBounds.top - previewBounds.top),
            Math.abs(imageBounds.bottom - previewBounds.bottom),
          ),
          objectFit: getComputedStyle(image).objectFit,
          borderRadius: getComputedStyle(bubble).borderRadius,
          overflow: getComputedStyle(bubble).overflow,
        };
      });
      expect(geometry).toBeDefined();
      expect(geometry?.shellInsideStack).toBe(true);
      expect(geometry?.bubbleGap).toBeLessThanOrEqual(1);
      expect(geometry?.imageHorizontalGap).toBeLessThanOrEqual(1);
      expect(geometry?.imageVerticalGap).toBeLessThanOrEqual(1);
      expect(geometry?.objectFit).toBe("cover");
      expect(geometry?.borderRadius).toBe("0px");
      expect(geometry?.overflow).toBe("hidden");
    }
    const albumGeometry = await album.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const stack = element.closest<HTMLElement>(".message-group-stack")?.getBoundingClientRect();
      return {
        insideStack: stack !== undefined &&
          bounds.left >= stack.left - 1 && bounds.right <= stack.right + 1,
        borderRadius: getComputedStyle(element).borderRadius,
        overflow: getComputedStyle(element).overflow,
      };
    });
    expect(albumGeometry).toEqual({ insideStack: true, borderRadius: "8px", overflow: "hidden" });
    expect(await horizontalOverflow(page)).toBe(false);
  }

  const tallTile = await tallRow.locator(".message-bubble-shell").evaluate((shell) => ({
    width: shell.getBoundingClientRect().width,
    height: shell.getBoundingClientRect().height,
  }));
  await tallRow.locator("img").evaluate((image) => {
    image.dispatchEvent(new Event("error", { bubbles: false }));
  });
  await expect(tallRow.locator(".photo-placeholder")).toBeVisible();
  const failedState = await tallRow.evaluate((element) => {
    const shell = element.querySelector<HTMLElement>(".message-bubble-shell");
    const bubble = element.querySelector<HTMLElement>(".message-bubble");
    const preview = element.querySelector<HTMLElement>(".photo-preview");
    return {
      shellWidth: shell?.getBoundingClientRect().width,
      shellHeight: shell?.getBoundingClientRect().height,
      previewWidth: preview?.getBoundingClientRect().width,
      borderRadius: bubble ? getComputedStyle(bubble).borderRadius : "",
      overflow: bubble ? getComputedStyle(bubble).overflow : "",
    };
  });
  expect(Math.abs((failedState.shellWidth ?? 0) - (failedState.previewWidth ?? 1)))
    .toBeLessThanOrEqual(1);
  expect(failedState.shellWidth).toBeCloseTo(tallTile.width, 0);
  expect(failedState.shellHeight).toBeCloseTo(tallTile.height, 0);
  expect(failedState.borderRadius).toBe("0px");
  expect(failedState.overflow).toBe("hidden");
});

test("mixed media albums justify every row across the bubble", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async (storePath) => {
    type TestMessage = {
      id: string;
      renderKey?: string;
      mediaAlbumId?: string;
      sentAt: string;
      content: { kind: string; [key: string]: unknown };
      [key: string]: unknown;
    };
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, TestMessage[]> };
        setState: (partial: { messages: Map<string, TestMessage[]> }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    const source = (messages.get("chat-product") ?? []).find((message) => message.id === "p-5");
    if (!source || source.content.kind !== "media") throw new Error("Album source is unavailable");
    const dimensions = [
      [900, 1_600],
      [1_600, 900],
      [1_000, 1_000],
      [1_400, 1_000],
      [800, 1_200],
      [1_000, 1_000],
      [1_600, 900],
    ];
    const album = dimensions.map(([width, height], index) => ({
      ...source,
      id: `album-fill-${index}`,
      renderKey: `album-fill-${index}`,
      mediaAlbumId: "album-fill-regression",
      sentAt: `2026-08-13T17:00:${String(index).padStart(2, "0")}+08:00`,
      content: {
        ...source.content,
        width,
        height,
        caption: undefined,
        captionEntities: undefined,
        isDownloading: false,
        progress: undefined,
      },
    }));
    messages.set("chat-product", [...(messages.get("chat-product") ?? []), ...album]);
    storeModule.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");

  const album = page.locator('[data-media-album-id="album-fill-regression"]');
  await page.keyboard.press("End");
  await expect(album).toBeVisible();
  await album.scrollIntoViewIfNeeded();
  await expect(album.locator(".media-album-tile")).toHaveCount(7);
  const geometry = await album.evaluate((element) => {
    const albumBounds = element.getBoundingClientRect();
    const gridBounds = element.querySelector<HTMLElement>(".media-album-grid")?.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>(".media-album-row")].map((row) => {
      const rowBounds = row.getBoundingClientRect();
      const tiles = [...row.querySelectorAll<HTMLElement>(".media-album-tile")];
      return {
        count: tiles.length,
        leftGap: Math.abs((tiles[0]?.getBoundingClientRect().left ?? 0) - rowBounds.left),
        rightGap: Math.abs((tiles.at(-1)?.getBoundingClientRect().right ?? 0) - rowBounds.right),
        tilesHaveArea: tiles.every((tile) => {
          const bounds = tile.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0;
        }),
      };
    });
    return {
      albumWidth: albumBounds.width,
      gridWidth: gridBounds?.width ?? 0,
      rows,
    };
  });
  expect(Math.abs(geometry.albumWidth - geometry.gridWidth)).toBeLessThanOrEqual(1);
  expect(geometry.rows.reduce((total, row) => total + row.count, 0)).toBe(7);
  expect(geometry.rows.every((row) =>
    row.count >= 2 && row.count <= 3 &&
    row.leftGap <= 1 && row.rightGap <= 1 && row.tilesHaveArea,
  )).toBe(true);
  expect(await horizontalOverflow(page)).toBe(false);
});

test("saved and direct messages align to the conversation edges", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /收藏夹/ }).click();
  const savedMessage = page.locator('[data-message-id="s-2"]');
  await expect(savedMessage).toBeVisible();
  await expect(savedMessage).toHaveClass(/is-outgoing/);

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-message-id="m-1"]')).toBeVisible();
  await expect(page.locator('[data-message-id="m-2"]')).toBeVisible();
  await expect(page.locator(".message-group-avatar")).toHaveCount(0);
  const alignment = await page.locator(".message-list").evaluate((list) => {
    const content = list.querySelector<HTMLElement>(".message-list-content");
    const incoming = list.querySelector<HTMLElement>('[data-message-id="m-1"] .message-bubble-shell');
    const outgoing = list.querySelector<HTMLElement>('[data-message-id="m-2"] .message-bubble-shell');
    if (!content || !incoming || !outgoing) return undefined;
    const contentBounds = content.getBoundingClientRect();
    const incomingBounds = incoming.getBoundingClientRect();
    const outgoingBounds = outgoing.getBoundingClientRect();
    const style = getComputedStyle(list);
    return {
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      incomingOffset: incomingBounds.left - contentBounds.left,
      outgoingOffset: contentBounds.right - outgoingBounds.right,
    };
  });
  expect(alignment).toEqual({
    paddingLeft: "10px",
    paddingRight: "10px",
    incomingOffset: 0,
    outgoingOffset: 0,
  });
});

test("group service messages render as centered notices", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const notice = await revealVirtualMessage(page, "p-service");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveClass(/is-service/);
  await expect(notice.locator(".message-bubble")).toHaveText("Mia Chen 加入了群聊");
  const member = notice.getByRole("button", { name: "查看 Mia Chen 资料" });
  await expect(member).toBeVisible();
  await expect(notice.locator(".message-meta")).toHaveCount(0);
  const centerDelta = await notice.evaluate((row) => {
    const shell = row.querySelector<HTMLElement>(".message-bubble-shell");
    if (!shell) return Number.POSITIVE_INFINITY;
    const rowBounds = row.getBoundingClientRect();
    const shellBounds = shell.getBoundingClientRect();
    return Math.abs(
      (rowBounds.left + rowBounds.right) / 2 - (shellBounds.left + shellBounds.right) / 2,
    );
  });
  expect(centerDelta).toBeLessThanOrEqual(1);
  await member.click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile.getByRole("heading", { name: "Mia Chen" })).toBeVisible();
});

test("date separators are centered and only upward user scrolling exposes the visible day", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const separatorMessage = await revealVirtualMessage(page, "p-service");
  const separator = page.locator(".message-day").filter({ hasText: "8月1日" }).first();
  await expect(separator).toBeVisible();
  const spacing = await separator.evaluate((label) => {
    const next = document.querySelector<HTMLElement>('[data-message-id="p-service"]');
    const labelBounds = label.getBoundingClientRect();
    const previous = [...document.querySelectorAll<HTMLElement>("[data-message-id]")]
      .filter((row) => row.dataset.messageId !== "p-service")
      .filter((row) => row.getBoundingClientRect().bottom <= labelBounds.top + 1)
      .sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom)[0];
    if (!previous || !next) return undefined;
    return {
      before: labelBounds.top - previous.getBoundingClientRect().bottom,
      after: next.getBoundingClientRect().top - labelBounds.bottom,
    };
  });
  expect(spacing).toBeTruthy();
  expect(Math.abs(spacing!.before - spacing!.after)).toBeLessThanOrEqual(1);

  const indicator = page.locator(".conversation-date-indicator");
  const messageList = page.locator(".message-list");
  await messageList.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.getByRole("textbox", { name: "消息内容" }).fill("日期标签不应被输入触发");
  await page.getByRole("button", { name: "表情", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "表情、贴纸与 GIF" })).toBeVisible();
  await expect(indicator).toHaveCount(0);
  await page.getByRole("button", { name: "关闭表情面板" }).click();

  const remountedSeparatorMessage = await revealVirtualMessage(page, "p-service");
  await remountedSeparatorMessage.evaluate((element) => {
    element.scrollIntoView({ block: "start", behavior: "auto" });
  });
  await messageList.hover();
  await page.mouse.wheel(0, -120);
  await expect(indicator).toHaveText("7月30日");
  await expect(indicator).toHaveClass(/is-visible/);

  await expect(indicator).not.toHaveClass(/is-visible/, { timeout: 2_000 });
  await messageList.focus();
  await page.keyboard.press("End");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await messageList.hover();
  await page.mouse.wheel(0, -160);
  await expect(indicator).toHaveText("8月1日");
  await expect(indicator).toHaveClass(/is-visible/);
  await expect(indicator).toHaveCSS("pointer-events", "none");

  await messageList.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(indicator).not.toHaveClass(/is-visible/);
});

test("developer tooling is absent from settings and message actions", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();

  const notice = await revealVirtualMessage(page, "p-unknown");
  await expect(notice).toContainText("收到新类型消息（messageFutureType）");
  await expect(notice.getByRole("button")).toHaveCount(0);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /高级设置/ }).click();
  await expect(page.getByText("开发者选项", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "开发者模式" })).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "关闭" }).click();

  const regularMessage = await revealVirtualMessage(page, "p-2");
  await regularMessage.locator(".message-bubble-shell").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "复制原始消息" })).toHaveCount(0);
});

const messageViewportOffset = (page: Page, messageId: string) =>
  page.locator(`[data-message-id="${messageId}"]`).evaluate((element) => {
    const list = element.closest<HTMLElement>(".message-list");
    if (!list) return Number.POSITIVE_INFINITY;
    return element.getBoundingClientRect().top - list.getBoundingClientRect().top;
  });

test("message jumps return through prior reading positions before returning to latest", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const source = await revealVirtualMessage(page, "p-channel-reply");
  const originalSourceOffset = await messageViewportOffset(page, "p-channel-reply");

  await source.locator(".message-reply-preview").click();
  const firstTarget = page.locator('[data-message-id="p-old-8"]');
  await expect(firstTarget).toHaveClass(/is-notification-target/);
  await expect.poll(() => firstTarget.evaluate((element) => {
    const list = element.closest(".message-list")?.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    return list
      ? Math.abs((row.top + row.bottom) / 2 - (list.top + list.bottom) / 2)
      : Number.POSITIVE_INFINITY;
  })).toBeLessThan(2);
  await expect(page.getByRole("button", { name: "返回跳转前位置，可回退 1 次" })).toBeVisible();
  const firstTargetOffset = await messageViewportOffset(page, "p-old-8");

  await page.locator(".pinned-message-preview").click();
  await expect(page.locator('[data-message-id="p-4"]')).toBeVisible();
  const returnButton = page.getByRole("button", { name: "返回跳转前位置，可回退 2 次" });
  await expect(returnButton).toBeVisible();

  await returnButton.click();
  await expect(firstTarget).toBeAttached();
  await expect.poll(async () => Math.abs(
    await messageViewportOffset(page, "p-old-8") - firstTargetOffset,
  )).toBeLessThanOrEqual(2);

  await page.getByRole("button", { name: "返回跳转前位置，可回退 1 次" }).click();
  await expect(source).toBeAttached();
  await expect.poll(async () => Math.abs(
    await messageViewportOffset(page, "p-channel-reply") - originalSourceOffset,
  )).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: /^返回跳转前位置/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^跳到最新消息/ })).toBeVisible();
});

test("returning from a reply jump to the latest message clears navigation state", async ({ page }) => {
  await page.goto("/");
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect(messageList.locator("[data-message-id]")).not.toHaveCount(0);

  const targetMessageId = await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    const target = current.at(-Math.min(12, Math.max(2, current.length)));
    if (!latest || !target || target === latest || typeof target.id !== "string") return undefined;
    current.push({
      ...latest,
      id: "p-latest-reply-jump",
      renderKey: undefined,
      senderId: "u-mia",
      outgoing: false,
      sentAt: new Date(Date.now() + 10_000).toISOString(),
      replyTo: {
        kind: "message",
        chatId: "chat-product",
        messageId: target.id,
        content: target.content,
      },
      content: { kind: "text", text: "最新消息引用了前文" },
    });
    messages.set("chat-product", current);
    module.telegramStore.setState({ messages });
    return target.id;
  }, "/src/store/telegramStore.ts");
  expect(targetMessageId).toBeTruthy();

  const latestReply = page.locator('[data-message-id="p-latest-reply-jump"]');
  await expect(latestReply).toBeVisible();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await latestReply.locator(".message-reply-preview").click();

  const target = messageList.locator(`[data-message-id="${targetMessageId}"]`);
  await expect(target).toHaveClass(/is-notification-target/);
  const returnButton = page.getByRole("button", { name: "返回跳转前位置，可回退 1 次" });
  await expect(returnButton).toBeVisible();
  const returnTrace = await returnButton.evaluate((button) => {
    const list = document.querySelector<HTMLElement>(".message-list");
    const samples: number[] = [];
    const started = performance.now();
    const record = () => {
      if (list) samples.push(list.scrollTop);
      if (performance.now() - started < 900) requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
    (button as HTMLElement).click();
    return new Promise<number[]>((resolve) => globalThis.setTimeout(() => resolve(samples), 950));
  });

  const upwardRebounds = returnTrace.slice(1).filter((scrollTop, index) =>
    scrollTop < returnTrace[index] - 1
  );
  expect(upwardRebounds, JSON.stringify(returnTrace)).toHaveLength(0);

  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);
  await page.waitForTimeout(700);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);
});

test("manual bottom navigation and conversation switches clear reply jump history", async ({ page }) => {
  await page.goto("/");
  const source = await revealVirtualMessage(page, "p-channel-reply");
  await source.locator(".message-reply-preview").click();
  await expect(page.getByRole("button", { name: "返回跳转前位置，可回退 1 次" })).toBeVisible();

  const messageList = page.getByRole("log", { name: "消息列表" });
  await messageList.focus();
  await page.keyboard.press("End");
  await expect(page.getByRole("button", { name: /^返回跳转前位置/ })).toHaveCount(0);

  await page.locator(".pinned-message-preview").click();
  await expect(page.getByRole("button", { name: "返回跳转前位置，可回退 1 次" })).toBeVisible();
  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect(page.getByRole("button", { name: /^返回跳转前位置/ })).toHaveCount(0);
});

test("conversation scroll state follows, restores, counts, and resets to latest", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-row")).not.toHaveCount(0);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  await scrollAwayFromBottom(page);
  const savedAnchor = await visibleMessageAnchor(page);
  expect(savedAnchor.id).toBeTruthy();

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await page.getByRole("button", { name: /产品讨论/ }).click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect.poll(async () => (await visibleMessageAnchor(page)).id).toBe(savedAnchor.id);
  await expect.poll(async () => Math.abs(
    (await visibleMessageAnchor(page)).offset - savedAnchor.offset,
  )).toBeLessThanOrEqual(2);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  for (const text of ["滚动定位测试一", "滚动定位测试二"]) {
    await page.getByRole("textbox", { name: "消息内容" }).fill(text);
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveValue("");
  }
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.getByText("滚动定位测试二", { exact: true })).toBeVisible();
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);

  await page.getByRole("textbox", { name: "消息内容" }).fill("底部自动跟随测试");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);

  await page.locator(".message-list").hover();
  for (let attempt = 0; attempt < 5; attempt += 1) await page.mouse.wheel(0, 600);
  await page.waitForTimeout(180);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  await scrollAwayFromBottom(page);
  await page.locator('[data-chat-id="chat-mia"]').click();
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
});

test("local reading anchor wins over an older unread cursor after switching conversations", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await scrollAwayFromBottom(page);
  const savedAnchor = await visibleMessageAnchor(page);
  expect(savedAnchor.id).toBeTruthy();

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          chats: Map<string, Record<string, unknown>>;
          messages: Map<string, Array<Record<string, unknown>>>;
        };
        setState: (partial: {
          chats: Map<string, Record<string, unknown>>;
          messages: Map<string, Array<Record<string, unknown>>>;
        }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const chats = new Map(state.chats);
    const messages = new Map(state.messages);
    const product = chats.get("chat-product");
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    if (!product || !latest) return;
    chats.set("chat-product", {
      ...product,
      unreadCount: 3,
      lastReadInboxMessageId: current[1]?.id ?? current[0]?.id,
    });
    current.push({
      ...latest,
      id: "p-anchor-regression-live",
      renderKey: undefined,
      senderId: "u-mia",
      outgoing: false,
      delivery: "read",
      sentAt: new Date(Date.now() + 3_000).toISOString(),
      content: { kind: "text", text: "切换期间到达、但不应改变阅读锚点的新消息" },
    });
    messages.set("chat-product", current);
    module.telegramStore.setState({ chats, messages });
  }, "/src/store/telegramStore.ts");

  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await visibleMessageAnchor(page)).id).toBe(savedAnchor.id);
  await expect.poll(async () => Math.abs(
    (await visibleMessageAnchor(page)).offset - savedAnchor.offset,
  )).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: /跳到最新消息/ })).toBeVisible();
});

test("repeated virtual range changes do not restart detached anchor settlement", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await scrollAwayFromBottom(page);
  const savedAnchor = await visibleMessageAnchor(page);
  expect(savedAnchor.id).toBeTruthy();

  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await expect(messageList).toHaveAttribute("aria-busy", "false");

  const result = await page.evaluate(async () => {
    const style = document.createElement("style");
    style.textContent = [
      ".message-list [data-message-id] {",
      "  padding-bottom: var(--notgram-range-churn, 0px) !important;",
      "}",
    ].join("\n");
    document.head.append(style);

    document.querySelector<HTMLElement>('[data-chat-id="chat-product"]')?.click();
    let destinationFrame: number | undefined;
    let settledFrame: number | undefined;
    try {
      for (let frame = 0; frame < 54; frame += 1) {
        document.documentElement.style.setProperty(
          "--notgram-range-churn",
          frame % 2 === 0 ? "0px" : "48px",
        );
        await new Promise<void>((resolve) => requestAnimationFrame(() => {
          globalThis.setTimeout(resolve, 0);
        }));
        const isDestination = document.querySelector(".conversation-title strong")?.textContent ===
          "产品讨论";
        if (!isDestination) continue;
        destinationFrame ??= frame;
        const list = document.querySelector<HTMLElement>(".message-list");
        const settled = list?.getAttribute("aria-busy") === "false" &&
          !document.querySelector("[data-conversation-switch-snapshot]");
        if (settled && settledFrame === undefined) {
          settledFrame = frame - destinationFrame;
        }
      }
    } finally {
      document.documentElement.style.removeProperty("--notgram-range-churn");
      style.remove();
    }

    for (let frame = 0; frame < 30; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const performanceModule = await import("/src/utils/performanceMonitor.ts" as string) as {
      getPerformanceRecords: () => Array<{
        event: string;
        durationMs?: number;
        details: { missingStageMask?: number; timedOut?: boolean };
      }>;
    };
    const trace = performanceModule.getPerformanceRecords()
      .filter((record) => record.event === "ui_conversation_switch")
      .at(-1);
    return {
      settledFrame,
      finalBusy: document.querySelector(".message-list")?.getAttribute("aria-busy"),
      snapshotPresent: Boolean(document.querySelector("[data-conversation-switch-snapshot]")),
      traceDurationMs: trace?.durationMs,
      missingStageMask: trace?.details.missingStageMask,
      timedOut: trace?.details.timedOut,
    };
  });

  expect(result.settledFrame, JSON.stringify(result)).toBeDefined();
  // Allow the 18-frame anchor reconciliation and the bounded snapshot release.
  expect(result.settledFrame!, JSON.stringify(result)).toBeLessThanOrEqual(40);
  expect(result.finalBusy).toBe("false");
  expect(result.snapshotPresent).toBe(false);
  expect(result.missingStageMask).toBe(0);
  expect(result.timedOut).not.toBe(true);
  expect(result.traceDurationMs, JSON.stringify(result)).toBeLessThan(750);
  await expect.poll(async () => (await visibleMessageAnchor(page)).id).toBe(savedAnchor.id);
});

test("window resizing and new messages preserve the user's follow intent", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  await scrollAwayFromBottom(page);
  await expect(page.getByRole("button", { name: "跳到最新消息", exact: true })).toBeVisible();
  const savedAnchor = await visibleMessageAnchor(page);
  expect(savedAnchor.id).toBeTruthy();

  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    if (!latest) return;
    current.push({
      ...latest,
      id: "p-live-resize",
      senderId: "u-mia",
      outgoing: false,
      delivery: "read",
      sentAt: new Date(Date.now() + 1_000).toISOString(),
      content: { kind: "text", text: "缩放期间的锚点消息" },
    });
    messages.set("chat-product", current);
    module.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");
  for (const width of [1180, 1320, 1210, 1280]) {
    await page.setViewportSize({ width, height: 760 });
  }
  await page.waitForTimeout(160);

  const afterResize = await visibleMessageAnchor(page);
  expect(afterResize.id).toBe(savedAnchor.id);
  expect(Math.abs(afterResize.offset - savedAnchor.offset)).toBeLessThanOrEqual(2);
  const jumpButton = page.getByRole("button", { name: "跳到最新消息，1 条新消息" });
  await expect(jumpButton).toBeVisible();

  await jumpButton.click();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await page.getByRole("textbox", { name: "消息内容" }).fill("缩放期间自动跟随");
  await page.getByRole("button", { name: "发送消息" }).click();
  for (const width of [1240, 1340, 1260, 1280]) {
    await page.setViewportSize({ width, height: 760 });
  }
  await page.waitForTimeout(160);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);
});

test("mention and reply notifications jump newest-first and are consumed once", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await scrollAwayFromBottom(page);

  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          messages: Map<string, Array<Record<string, unknown>>>;
          unreadAttentionMessageIds: Map<string, string[]>;
        };
        setState: (partial: {
          messages: Map<string, Array<Record<string, unknown>>>;
          unreadAttentionMessageIds: Map<string, string[]>;
        }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    if (!latest) return;
    const timestamp = Date.now() + 5_000;
    current.push(
      {
        ...latest,
        id: "p-attention-1",
        renderKey: undefined,
        senderId: "u-mia",
        outgoing: false,
        sentAt: new Date(timestamp).toISOString(),
        containsUnreadMention: true,
        content: { kind: "text", text: "第一条提及" },
      },
      {
        ...latest,
        id: "p-attention-2",
        renderKey: undefined,
        senderId: "u-chen",
        outgoing: false,
        sentAt: new Date(timestamp + 1_000).toISOString(),
        containsUnreadMention: false,
        replyTo: {
          kind: "message",
          messageId: "p-attention-own-target",
          outgoing: true,
          senderName: "我",
          text: "被引用的消息",
          content: { kind: "text", text: "被引用的消息" },
        },
        content: { kind: "text", text: "第二条引用回复" },
      },
    );
    messages.set("chat-product", current);
    const unreadAttentionMessageIds = new Map(state.unreadAttentionMessageIds);
    unreadAttentionMessageIds.set("chat-product", ["p-attention-1", "p-attention-2"]);
    module.telegramStore.setState({ messages, unreadAttentionMessageIds });
  }, "/src/store/telegramStore.ts");

  const attentionButton = page.locator(".jump-to-attention");
  const latestButton = page.locator(".jump-to-latest");
  await expect(attentionButton).toHaveAccessibleName("跳到提及或引用，2 条待查看");
  await expect(attentionButton.locator("span")).toHaveText("2");
  await expect(latestButton).toBeVisible();
  const buttonLayout = await page.locator(".conversation").evaluate((element) => {
    const attention = element.querySelector<HTMLElement>(".jump-to-attention")?.getBoundingClientRect();
    const latest = element.querySelector<HTMLElement>(".jump-to-latest")?.getBoundingClientRect();
    return { attentionBottom: attention?.bottom ?? 0, latestTop: latest?.top ?? 0 };
  });
  expect(buttonLayout.attentionBottom).toBeLessThan(buttonLayout.latestTop);

  await attentionButton.click();
  await expect(page.locator('[data-message-id="p-attention-2"]')).toHaveClass(/is-notification-target/);
  await expect(attentionButton).toHaveCount(0);
});

test("visible attention is consumed only while focus is inside the conversation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const latestId = await page.locator(".message-list [data-message-id]").last()
    .getAttribute("data-message-id");
  expect(latestId).toBeTruthy();
  await page.locator('[data-chat-id="chat-product"]').focus();
  await page.evaluate(async ({ modulePath, messageId }) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { unreadAttentionMessageIds: Map<string, string[]> };
        setState: (partial: { unreadAttentionMessageIds: Map<string, string[]> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const unreadAttentionMessageIds = new Map(state.unreadAttentionMessageIds);
    unreadAttentionMessageIds.set("chat-product", [messageId]);
    module.telegramStore.setState({ unreadAttentionMessageIds });
  }, { modulePath: "/src/store/telegramStore.ts", messageId: latestId! });

  await expect(page.locator(".jump-to-attention")).toBeVisible();
  await page.getByRole("textbox", { name: "消息内容" }).focus();
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { unreadAttentionMessageIds: Map<string, string[]> };
      };
    };
    return module.telegramStore.getState().unreadAttentionMessageIds
      .get("chat-product")?.length ?? 0;
  }, "/src/store/telegramStore.ts")).toBe(0);
  await expect(page.locator(".jump-to-attention")).toHaveCount(0);
});

test("attention button occupies the lower slot and animates when latest appears", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.locator('[data-chat-id="chat-product"]').focus();
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          messages: Map<string, Array<{ id: string }>>;
          unreadAttentionMessageIds: Map<string, string[]>;
        };
        setState: (partial: { unreadAttentionMessageIds: Map<string, string[]> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const firstId = state.messages.get("chat-product")?.[0]?.id;
    if (!firstId) return;
    const unreadAttentionMessageIds = new Map(state.unreadAttentionMessageIds);
    unreadAttentionMessageIds.set("chat-product", [firstId]);
    module.telegramStore.setState({ unreadAttentionMessageIds });
  }, "/src/store/telegramStore.ts");

  const attentionButton = page.locator(".jump-to-attention");
  await expect(attentionButton).toBeVisible();
  await expect(attentionButton).not.toHaveClass(/is-stacked/);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);
  await expect.poll(() => page.locator(".message-list-shell").evaluate((shell) => {
    const attention = shell.querySelector<HTMLElement>(".jump-to-attention")!;
    return shell.getBoundingClientRect().bottom - attention.getBoundingClientRect().bottom;
  })).toBeLessThanOrEqual(20);

  await scrollAwayFromBottom(page);
  await expect(page.locator(".jump-to-latest")).toBeVisible();
  await expect(attentionButton).toHaveClass(/is-stacked/);
  await expect.poll(() => page.locator(".conversation").evaluate((conversation) => {
    const attention = conversation.querySelector<HTMLElement>(".jump-to-attention")!;
    const latest = conversation.querySelector<HTMLElement>(".jump-to-latest")!;
    return latest.getBoundingClientRect().top - attention.getBoundingClientRect().bottom;
  })).toBeGreaterThan(0);
  await expect(attentionButton).not.toHaveCSS("transition-duration", "0s");
});

test("large emoji and sticker replies keep compact transparent geometry", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "表情", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "表情、贴纸与 GIF" });
  await picker.getByRole("button", { name: /发送贴纸/ }).first().click();
  await expect(page.locator('[data-media-type="sticker"]').last()).toBeVisible();

  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    const stickerTemplate = [...current].reverse().find((message) => {
      const content = message.content as { kind?: string; mediaType?: string } | undefined;
      return content?.kind === "media" && content.mediaType === "sticker";
    });
    if (!latest || !stickerTemplate) return;
    const timestamp = Date.now() + 10_000;
    const replyTarget = {
      ...latest,
      id: "p-sticker-reply-target",
      renderKey: undefined,
      senderId: "me",
      outgoing: true,
      sentAt: new Date(timestamp).toISOString(),
      replyTo: undefined,
      content: { kind: "text", text: "被引用的文本消息" },
    };
    current.push(
      replyTarget,
      {
        ...latest,
        id: "p-large-emoji",
        renderKey: undefined,
        senderId: "u-emoji",
        outgoing: false,
        sentAt: new Date(timestamp + 1_000).toISOString(),
        replyTo: undefined,
        content: { kind: "text", text: "😀" },
      },
      {
        ...stickerTemplate,
        id: "p-sticker-group-first",
        renderKey: undefined,
        senderId: "u-sticker",
        senderTag: "Administrator",
        outgoing: false,
        sentAt: new Date(timestamp + 2_000).toISOString(),
        replyTo: undefined,
      },
      {
        ...latest,
        id: "p-sticker-group-last",
        renderKey: undefined,
        senderId: "u-sticker",
        outgoing: false,
        sentAt: new Date(timestamp + 3_000).toISOString(),
        replyTo: undefined,
        content: { kind: "text", text: "同组的下一条消息" },
      },
      {
        ...stickerTemplate,
        id: "p-sticker-with-reply",
        renderKey: undefined,
        senderId: "u-reply-sticker",
        outgoing: false,
        sentAt: new Date(timestamp + 4_000).toISOString(),
        replyTo: {
          kind: "message",
          messageId: replyTarget.id,
          outgoing: true,
          senderName: "我",
          text: "被引用的文本消息",
          content: replyTarget.content,
        },
      },
    );
    messages.set("chat-product", current);
    module.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");

  const emoji = page.locator('[data-message-id="p-large-emoji"]');
  await emoji.scrollIntoViewIfNeeded();
  const emojiGeometry = await emoji.evaluate((element) => {
    const bubble = element.querySelector<HTMLElement>(".message-bubble");
    const flow = element.querySelector<HTMLElement>(".message-text-flow.is-large-emoji");
    const richText = element.querySelector<HTMLElement>(".message-rich-text");
    return {
      bubbleHeight: bubble?.getBoundingClientRect().height ?? 0,
      flowHeight: flow?.getBoundingClientRect().height ?? 0,
      richTextHeight: richText?.getBoundingClientRect().height ?? 0,
    };
  });
  expect(emojiGeometry.richTextHeight).toBeGreaterThan(30);
  expect(emojiGeometry.flowHeight).toBeLessThanOrEqual(52);
  expect(emojiGeometry.bubbleHeight).toBeLessThanOrEqual(68);

  const firstSticker = page.locator('[data-message-id="p-sticker-group-first"]');
  await firstSticker.scrollIntoViewIfNeeded();
  await expect(firstSticker).toHaveClass(/group-first/);
  await expect(firstSticker.locator(".message-sender-row")).toHaveCount(0);
  const firstStickerStyle = await firstSticker.locator(".message-bubble").evaluate((element) => ({
    backgroundColor: getComputedStyle(element).backgroundColor,
    boxShadow: getComputedStyle(element).boxShadow,
  }));
  expect(firstStickerStyle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(firstStickerStyle.boxShadow).toBe("none");

  const repliedSticker = page.locator('[data-message-id="p-sticker-with-reply"]');
  await repliedSticker.scrollIntoViewIfNeeded();
  const repliedStickerStyle = await repliedSticker.evaluate((element) => {
    const bubble = element.querySelector<HTMLElement>(".message-bubble");
    const preview = element.querySelector<HTMLElement>(".message-reply-preview");
    const media = element.querySelector<HTMLElement>('[data-media-type="sticker"]');
    const previewBounds = preview?.getBoundingClientRect();
    const mediaBounds = media?.getBoundingClientRect();
    return {
      bubbleBackground: bubble ? getComputedStyle(bubble).backgroundColor : "",
      previewBackground: preview ? getComputedStyle(preview).backgroundColor : "",
      verticalGap: previewBounds && mediaBounds ? mediaBounds.top - previewBounds.bottom : -1,
    };
  });
  expect(repliedStickerStyle.bubbleBackground).toBe("rgba(0, 0, 0, 0)");
  expect(repliedStickerStyle.previewBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(repliedStickerStyle.verticalGap).toBeGreaterThanOrEqual(0);
  expect(repliedStickerStyle.verticalGap).toBeLessThanOrEqual(4);
});

test("a chat left at the latest position returns to the latest message", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await page.locator('[data-chat-id="chat-mia"]').click();
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    if (!latest) return;
    current.push({
      ...latest,
      id: "p-return-latest",
      senderId: "u-mia",
      outgoing: false,
      delivery: "read",
      sentAt: new Date(Date.now() + 2_000).toISOString(),
      content: { kind: "text", text: "返回时仍在最新位置" },
    });
    messages.set("chat-product", current);
    module.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");
  await page.locator('[data-chat-id="chat-product"]').click();
  await expect(page.getByText("返回时仍在最新位置", { exact: true })).toBeVisible();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
});

test("clicking the selected conversation repeatedly converges to its latest message", async ({ page }) => {
  await page.goto("/");
  const product = page.locator('[data-chat-id="chat-product"]');
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  await page.locator('[data-chat-id="chat-mia"]').click();
  await product.click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await product.click();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  const messageList = page.locator(".message-list");
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await scrollAwayFromBottom(page);
    const listNode = await messageList.elementHandle();
    if (!listNode) throw new Error("Message list is not mounted");
    await product.click();
    expect(await page.evaluate(
      (node) => node === document.querySelector(".message-list"),
      listNode,
    )).toBe(true);
    await listNode.dispose();
    await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
    await expect(page.locator('[data-message-id="p-video"]')).toBeVisible();
  }
});

test("near and distant latest jumps finish smoothly without a bottom rebound", async ({ page }) => {
  await page.goto("/");
  const list = page.locator(".message-list");
  await expect(list).toHaveAttribute("aria-busy", "false");

  const sampleJump = async (mode: "near" | "far") => page.evaluate(async (jumpMode) => {
    const element = document.querySelector<HTMLElement>(".message-list")!;
    const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = jumpMode === "near"
      ? Math.max(0, maximum - 180)
      : Math.max(0, maximum - element.clientHeight * 2);
    element.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -120,
    }));
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const button = document.querySelector<HTMLButtonElement>(".jump-to-latest");
    if (!button) throw new Error(`Latest button missing for ${jumpMode} jump`);

    const startedAt = performance.now();
    const readSample = () => ({
      elapsed: performance.now() - startedAt,
      scrollTop: element.scrollTop,
      distanceBottom: Math.max(
        0,
        element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    });
    const samples: Array<ReturnType<typeof readSample>> = [readSample()];
    button.click();
    for (let frame = 0; frame < 55; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(readSample());
    }
    return { viewportHeight: element.clientHeight, samples };
  }, mode);

  const near = await sampleJump("near");
  const far = await sampleJump("far");
  for (const [mode, result] of [["near", near], ["far", far]] as const) {
    const distanceDeltas = result.samples.slice(1).map((sample, index) =>
      sample.distanceBottom - result.samples[index].distanceBottom);
    expect(
      distanceDeltas.filter((delta) => delta > 2),
      `${mode}: ${JSON.stringify(result.samples)}`,
    ).toHaveLength(0);
    expect(result.samples.at(-1)?.distanceBottom, mode).toBeLessThanOrEqual(1);
  }

  const nearDistanceDrops = near.samples.slice(1).map((sample, index) =>
    near.samples[index].distanceBottom - sample.distanceBottom);
  expect(Math.max(...nearDistanceDrops)).toBeLessThan(near.viewportHeight * 0.5);

  const farDistanceDrops = far.samples.slice(1).map((sample, index) =>
    far.samples[index].distanceBottom - sample.distanceBottom);
  const snapIndex = farDistanceDrops.findIndex((delta) => delta > far.viewportHeight);
  expect(snapIndex, JSON.stringify(far.samples)).toBeGreaterThanOrEqual(0);
  expect(
    farDistanceDrops.slice(snapIndex + 1).filter((delta) => delta > 0.5).length,
  ).toBeGreaterThan(1);

  const settleTime = (samples: typeof near.samples) => samples.find(
    (sample, index) => sample.distanceBottom <= 1 &&
      samples.slice(index, index + 3).every((next) => next.distanceBottom <= 1),
  )?.elapsed ?? Number.POSITIVE_INFINITY;
  expect(Math.abs(settleTime(near.samples) - settleTime(far.samples))).toBeLessThan(160);
});

test("one upward input loads exactly one history page", async ({ page }) => {
  await page.goto("/");
  const list = page.locator(".message-list");
  await expect(list).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { loadMoreHistory: (chatId: string) => Promise<void> };
        setState: (state: { loadMoreHistory: (chatId: string) => Promise<void> }) => void;
      };
    };
    const original = module.telegramStore.getState().loadMoreHistory;
    let calls = 0;
    module.telegramStore.setState({ loadMoreHistory: async (chatId: string) => {
      calls += 1;
      return original(chatId);
    } });
    Object.assign(globalThis, { __notgramHistoryPageCalls: () => calls });
  }, "/src/store/telegramStore.ts");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  await list.hover();
  await page.mouse.wheel(0, -10_000);
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramHistoryPageCalls: () => number }
  ).__notgramHistoryPageCalls())).toBe(1);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramHistoryPageCalls: () => number }
  ).__notgramHistoryPageCalls())).toBe(1);
});

test("loading older messages preserves the visible message anchor", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-row").first()).toBeAttached();

  const list = page.locator(".message-list");
  await expect(list).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { loadMoreHistory: (chatId: string) => Promise<void> };
        setState: (state: { loadMoreHistory: (chatId: string) => Promise<void> }) => void;
      };
    };
    const original = module.telegramStore.getState().loadMoreHistory;
    let release: (() => void) | undefined;
    module.telegramStore.setState({ loadMoreHistory: async (chatId: string) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return original(chatId);
    } });
    Object.assign(globalThis, {
      __notgramHistoryLoadPending: () => Boolean(release),
      __notgramReleaseHistoryLoad: () => release?.(),
    });
  }, "/src/store/telegramStore.ts");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await list.hover();
  await page.mouse.wheel(0, -10_000);
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramHistoryLoadPending: () => boolean }
  ).__notgramHistoryLoadPending())).toBe(true);
  const before = await list.evaluate((element) => {
    const listBounds = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((candidate) => {
        const bounds = candidate.getBoundingClientRect();
        return bounds.bottom > listBounds.top + 1 && bounds.top < listBounds.bottom - 1;
      });
    return {
      id: row?.dataset.messageId,
      offset: row ? row.getBoundingClientRect().top - listBounds.top : 0,
    };
  });

  expect(before.id).toBeTruthy();
  const frameTrace = await page.evaluate(async ({ messageId }) => {
    const targetGlobal = globalThis as typeof globalThis & {
      __notgramReleaseHistoryLoad: () => void;
    };
    const element = document.querySelector<HTMLElement>(".message-list")!;
    const samples: Array<{
      frame: number;
      offset?: number;
      scrollTop: number;
      scrollHeight: number;
      firstVisibleMessageId?: string;
      snapshotCovered: boolean;
    }> = [];
    targetGlobal.__notgramReleaseHistoryLoad();
    for (let frame = 0; frame < 45; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => {
        globalThis.setTimeout(resolve, 0);
      }));
      const listBounds = element.getBoundingClientRect();
      const target = element.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      const firstVisible = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find((candidate) => {
          const bounds = candidate.getBoundingClientRect();
          return bounds.bottom > listBounds.top + 1 && bounds.top < listBounds.bottom - 1;
        });
      samples.push({
        frame,
        offset: target
          ? target.getBoundingClientRect().top - listBounds.top
          : undefined,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        firstVisibleMessageId: firstVisible?.dataset.messageId,
        snapshotCovered: Boolean(document.querySelector("[data-conversation-history-snapshot]")),
      });
    }
    return samples;
  }, { messageId: before.id! });
  const exposedUnstableFrames = frameTrace.filter((sample) => (
    !sample.snapshotCovered &&
    (sample.offset === undefined || Math.abs(sample.offset - before.offset) > 2)
  ));
  expect(exposedUnstableFrames, JSON.stringify(frameTrace)).toEqual([]);
  expect(frameTrace.some((sample) => sample.snapshotCovered)).toBe(true);
  expect(frameTrace.at(-1)?.snapshotCovered).toBe(false);
  await expect(page.locator("[data-conversation-history-snapshot]")).toHaveCount(0);
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<{ id: string }>> };
      };
    };
    return storeModule.telegramStore.getState().messages.get("chat-product")
      ?.some((message) => message.id === "p-old-1") ?? false;
  }, "/src/store/telegramStore.ts")).toBe(true);
  const loadedIds = await page.locator(".message-row").evaluateAll((rows) =>
    rows.map((row) => (row as HTMLElement).dataset.messageId),
  );
  expect(new Set(loadedIds).size).toBe(loadedIds.length);
  await expect.poll(() => page.locator(
    `.message-row[data-message-id="${before.id}"]`,
  ).evaluate((row, expectedOffset) => Math.abs(
    row.getBoundingClientRect().top -
    (row.closest(".message-list")?.getBoundingClientRect().top ?? 0) -
    expectedOffset,
  ), before.offset)).toBeLessThanOrEqual(2);
});

test("chat organization menu confirms pin, mute, and archive changes", async ({ page }) => {
  await page.goto("/");
  const moreButton = page.getByRole("button", { name: "更多操作" });
  const productRow = page.locator('.chat-row[data-chat-id="chat-product"]');

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

test("messages support pin lists, notification scope, and auto-delete settings", async ({ page }) => {
  await page.goto("/");
  const target = await revealVirtualMessage(page, "p-1");
  await target.locator(".message-bubble-shell").click({ button: "right" });
  const messageMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(messageMenu.getByRole("menuitem", { name: "置顶消息" })).toBeVisible();
  await messageMenu.getByRole("menuitem", { name: "置顶消息" }).click();
  const pinDialog = page.getByRole("dialog", { name: "置顶消息" });
  await expect(pinDialog).toBeVisible();
  await pinDialog.getByLabel("静音置顶通知").check();
  await pinDialog.getByRole("button", { name: /^置顶/ }).click();
  await expect(pinDialog).toBeHidden();
  await expect(target.locator('[aria-label="已置顶"]')).toBeVisible();

  const pinnedBanner = page.locator(".pinned-message-banner");
  await expect(pinnedBanner).toBeVisible();
  await expect(pinnedBanner).toContainText("早上好，左侧会话列表的密度已经调整好了。");
  const pinnedBannerLayout = await pinnedBanner.evaluate((element) => {
    const shell = element.parentElement!;
    const list = shell.querySelector<HTMLElement>(".message-list")!;
    const bannerBounds = element.getBoundingClientRect();
    const shellBounds = shell.getBoundingClientRect();
    const listBounds = list.getBoundingClientRect();
    return {
      bannerTop: bannerBounds.top,
      bannerBottom: bannerBounds.bottom,
      shellTop: shellBounds.top,
      shellScrollTop: shell.scrollTop,
      listTop: listBounds.top,
    };
  });
  expect(pinnedBannerLayout.bannerTop).toBeCloseTo(pinnedBannerLayout.shellTop, 0);
  expect(pinnedBannerLayout.listTop).toBeCloseTo(pinnedBannerLayout.bannerBottom, 0);
  expect(pinnedBannerLayout.shellScrollTop).toBe(0);
  const normalTargetOffset = await target.evaluate((element) => {
    const list = element.closest(".message-list")!;
    return element.getBoundingClientRect().top - list.getBoundingClientRect().top;
  });

  await pinnedBanner.getByRole("button", { name: "查看全部置顶消息" }).click();
  const pinnedList = page.getByRole("log", { name: "置顶消息列表" });
  await expect(page.getByRole("button", { name: "返回会话" })).toBeVisible();
  await expect(pinnedList.locator(".message-row")).toHaveCount(2);
  await expect(pinnedList).toContainText("早上好，左侧会话列表的密度已经调整好了。");
  await expect(pinnedList).toContainText("我把交互稿更新到最新版本了");
  await expect(pinnedList).not.toContainText("看到了。消息区再留一点呼吸感");
  const locateButton = pinnedList.getByRole("button", { name: /跳转到消息原位置：早上好/ });
  const locateGeometry = await locateButton.evaluate((button) => {
    const shell = button.closest<HTMLElement>(".message-bubble-shell")!;
    const buttonBounds = button.getBoundingClientRect();
    const shellBounds = shell.getBoundingClientRect();
    return {
      width: buttonBounds.width,
      height: buttonBounds.height,
      rightOffset: buttonBounds.right - shellBounds.right,
      topOffset: buttonBounds.top - shellBounds.top,
    };
  });
  expect(locateGeometry).toEqual({ width: 28, height: 28, rightOffset: -5, topOffset: 5 });
  expect(await horizontalOverflow(page)).toBe(false);

  await page.getByRole("button", { name: "返回会话" }).click();
  const normalList = page.getByRole("log", { name: "消息列表" });
  await expect(normalList).toBeVisible();
  await expect.poll(async () => target.evaluate((element) => {
    const list = element.closest(".message-list")!;
    return element.getBoundingClientRect().top - list.getBoundingClientRect().top;
  })).toBeCloseTo(normalTargetOffset, 0);

  await pinnedBanner.getByRole("button", { name: "查看全部置顶消息" }).click();
  await locateButton.click();
  await expect(normalList).toBeVisible();
  await expect(target).toHaveClass(/is-notification-target/);

  const pinnedP4 = await revealVirtualMessage(page, "p-4");
  await pinnedP4.locator(".message-bubble-shell").click({ button: "right" });
  await page.getByRole("menu", { name: "消息操作" })
    .getByRole("menuitem", { name: "取消置顶" }).click();
  await expect(pinnedBanner).toContainText("早上好，左侧会话列表的密度已经调整好了。");

  await page.getByRole("button", { name: "更多操作" }).click();
  const chatMenu = page.getByRole("menu", { name: "会话操作" });

  await chatMenu.getByRole("menuitem", { name: "自动删除消息" }).click();
  const autoDeleteDialog = page.getByRole("dialog", { name: "自动删除消息" });
  await autoDeleteDialog.getByLabel("自动删除时长").selectOption("604800");
  await autoDeleteDialog.getByRole("button", { name: "保存" }).click();
  await expect(autoDeleteDialog).toBeHidden();
  await expect.poll(async () => page.evaluate(async () => {
    const module = await import("/src/store/telegramStore.ts" as string) as {
      telegramStore: {
        getState: () => { chats: Map<string, { messageAutoDeleteTime?: number }> };
      };
    };
    return module.telegramStore.getState().chats.get("chat-product")?.messageAutoDeleteTime;
  })).toBe(604800);

  await page.getByRole("button", { name: "更多操作" }).click();
  await chatMenu.getByRole("menuitem", { name: "自动删除消息" }).click();
  await autoDeleteDialog.getByLabel("自动删除时长").selectOption("custom");
  await autoDeleteDialog.getByLabel("自定义天数").fill("12");
  await autoDeleteDialog.getByRole("button", { name: "保存" }).click();
  await expect.poll(async () => page.evaluate(async () => {
    const module = await import("/src/store/telegramStore.ts" as string) as {
      telegramStore: {
        getState: () => { chats: Map<string, { messageAutoDeleteTime?: number }> };
      };
    };
    return module.telegramStore.getState().chats.get("chat-product")?.messageAutoDeleteTime;
  })).toBe(1_036_800);
});

test("pinned banner advances through earlier pins as source messages enter the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 420 });
  await page.goto("/");
  await page.addStyleTag({ content: ".message-row { min-height: 96px; }" });
  await page.evaluate(async () => {
    const module = await import("/src/store/telegramStore.ts" as string) as {
      telegramStore: {
        getState: () => {
          pinMessage: (
            messageId: string,
            disableNotification: boolean,
            onlyForSelf: boolean,
          ) => Promise<boolean>;
        };
      };
    };
    const state = module.telegramStore.getState();
    await state.pinMessage("p-old-1", true, false);
    await state.pinMessage("p-1", true, false);
  });

  const pinnedBanner = page.locator(".pinned-message-banner");
  const pinnedPreview = pinnedBanner.locator(".pinned-message-preview");
  await expect(pinnedBanner).toContainText("我把交互稿更新到最新版本了");

  await pinnedPreview.click();
  const latestPinnedSource = page.locator('[data-message-id="p-4"]');
  await expect(latestPinnedSource).toBeVisible();
  await expect(latestPinnedSource).not.toHaveClass(/is-notification-target/);
  await expect(pinnedBanner).toContainText("早上好，左侧会话列表的密度已经调整好了。");

  await pinnedPreview.click();
  const middlePinnedSource = page.locator('[data-message-id="p-1"]');
  await expect(middlePinnedSource).toBeVisible();
  await expect(middlePinnedSource).not.toHaveClass(/is-notification-target/);
  await expect(pinnedBanner).toContainText("产品讨论历史消息 1");

  await pinnedPreview.click();
  const earliestPinnedSource = page.locator('[data-message-id="p-old-1"]');
  await expect(earliestPinnedSource).toBeVisible();
  await expect(earliestPinnedSource).not.toHaveClass(/is-notification-target/);
  await expect(pinnedBanner).toContainText("产品讨论历史消息 1");

  const messageList = page.getByRole("log", { name: "消息列表", exact: true });
  await expect.poll(() => earliestPinnedSource.evaluate((element) => {
    const list = element.closest<HTMLElement>(".message-list")!;
    const listBounds = list.getBoundingClientRect();
    const targetBounds = element.getBoundingClientRect();
    return targetBounds.bottom > listBounds.top + 1 && targetBounds.top < listBounds.bottom - 1;
  })).toBe(true);
  const scrollTopBeforeNoop = await messageList.evaluate((element) => element.scrollTop);
  await pinnedPreview.click();
  await page.waitForTimeout(350);
  await expect.poll(() => messageList.evaluate((element) => element.scrollTop))
    .toBeCloseTo(scrollTopBeforeNoop, 0);
  await expect(earliestPinnedSource).not.toHaveClass(/is-notification-target/);
});

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
  await page.goto("/context-menu-window.html");
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

test("native context menu entry renders account avatars and the trailing add action", async ({ page }) => {
  await page.goto("/context-menu-window.html");
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

test("chat context menu manages folders, pinning, and group exit", async ({ page }) => {
  await page.goto("/");
  const miaRow = page.locator('.chat-row[data-chat-id="chat-mia"]');

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

  const productRow = page.locator('.chat-row[data-chat-id="chat-product"]');
  await productRow.click({ button: "right" });
  await page.getByRole("menu", { name: "会话操作：产品讨论" })
    .getByRole("menuitem", { name: "退出群组" }).click();
  const confirm = page.getByRole("dialog", { name: "退出“产品讨论”？" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "退出群组" }).click();
  await expect(productRow).toHaveCount(0);
  await expect(page.locator(".conversation-title strong")).not.toHaveText("产品讨论");
});

test("nested context menus keep the primary anchor stable and leave transparent areas clickable", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 420 });
  await page.goto("/");
  await page.addStyleTag({
    content: ".chat-folder-submenu { height: min(360px, calc(100vh - 16px)); }",
  });

  const releaseRow = page.locator('.chat-row[data-chat-id="chat-release"]');
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
  const productRow = page.locator('.chat-row[data-chat-id="chat-product"]');
  await productRow.click({ button: "right", position: { x: 50, y: 24 } });
  menu = page.getByRole("menu", { name: "会话操作：产品讨论" });
  await menu.getByRole("menuitem", { name: "分组" }).click();
  await expect(page.getByRole("menu", { name: "选择分组" })).toBeVisible();
  await expect(menu).toHaveAttribute("data-context-submenu-side", "right");

  const chenName = page.locator('.chat-row[data-chat-id="chat-chen"] strong');
  await chenName.click({ timeout: 1_000 });
  await expect(page.locator(".conversation-title strong")).toHaveText("陈默", { timeout: 1_000 });
  await expect(menu).toBeHidden();
});

test("sidebar context menus close when content outside them scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 420 });
  await page.goto("/");
  await page.addStyleTag({
    content: ".chat-row { min-height: 92px; }",
  });

  const chatList = page.locator(".chat-list");
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

  const productRow = page.locator('.chat-row[data-chat-id="chat-product"]');
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

test("message context menu closes when the conversation scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 420 });
  await page.goto("/");

  const messageList = page.locator(".message-list");
  const visibleBubble = (await revealVirtualMessage(page, "p-2")).locator(".message-bubble-shell");
  await visibleBubble.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "消息操作" });
  await expect(menu).toBeVisible();

  const movement = await messageList.evaluate((element) => ({
    before: element.scrollTop,
    maximum: element.scrollHeight - element.clientHeight,
    height: element.clientHeight,
  }));
  expect(movement.maximum).toBeGreaterThan(0);
  await messageList.hover({ position: { x: 18, y: movement.height - 12 } });
  await page.mouse.wheel(0, movement.before > 0 ? -80 : 80);
  await expect.poll(() => messageList.evaluate((element) => element.scrollTop))
    .not.toBe(movement.before);
  await expect(menu).toBeHidden();
});

test("folder context menu edits, marks read, and deletes a custom folder", async ({ page }) => {
  await page.goto("/");
  const workButton = page.getByRole("button", { name: "工作", exact: true });
  await workButton.click();
  await expect(page.locator('.chat-row[data-chat-id="chat-release"] .unread-count')).toHaveText("8");

  await workButton.click({ button: "right" });
  let menu = page.getByRole("menu", { name: "分组操作：工作" });
  await expect(menu.getByRole("menuitem", { name: "编辑文件夹" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "标记为已读" }).click();
  await expect(page.locator(".chat-list .unread-count")).toHaveCount(0);

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
  const miaRow = page.locator('.chat-row[data-chat-id="chat-mia"]');
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

test("folder manager creates, edits, and deletes confirmed server folders", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "管理文件夹" }).click();
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
