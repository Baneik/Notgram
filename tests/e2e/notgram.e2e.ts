import { expect, test, type Page } from "@playwright/test";

const horizontalOverflow = async (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll("body *")].some((element) => {
    if (element.closest(".rail-actions")) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
  }));

const messageListMetrics = (page: Page) => page.locator(".message-list").evaluate((element) => ({
  scrollTop: element.scrollTop,
  scrollHeight: element.scrollHeight,
  clientHeight: element.clientHeight,
  distanceBottom: element.scrollHeight - element.clientHeight - element.scrollTop,
}));

const visibleMessageAnchor = (page: Page) => page.locator(".message-list").evaluate((element) => {
  const listBounds = element.getBoundingClientRect();
  const row = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find((candidate) => candidate.getBoundingClientRect().bottom > listBounds.top + 1);
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
  await page.locator(".message-list").evaluate((element) => {
    const maximum = element.scrollHeight - element.clientHeight;
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -500 }));
    element.scrollTop = Math.max(100, Math.floor(maximum * 0.45));
    element.dispatchEvent(new Event("scroll"));
  });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }));
};

test("webview chrome is suppressed and settings are opened from the Notgram brand", async ({ page }) => {
  await page.goto("/");

  const settingsButton = page.locator(".rail-brand");
  await expect(settingsButton).toHaveRole("button");
  await expect(settingsButton).toHaveAccessibleName("设置");
  await expect(settingsButton).toContainText("Notgram");
  await expect(page.locator(".rail-settings, .rail-connection")).toHaveCount(0);
  await expect(page.locator(".sidebar-heading .connection-status")).toHaveCount(0);
  await expect(page.locator(".conversation-title > span")).toHaveCount(0);

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
  await expect(stall.locator(".performance-entry-details")).toContainText("总耗时");

  const pause = page.getByRole("button", { name: "暂停刷新" });
  await pause.click();
  await expect(page.getByRole("button", { name: "继续刷新" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "清空性能记录" }).click();
  await expect(page.getByText("暂无性能采样")).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
});

test("desktop messaging, reactions, and preferences remain usable", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".chat-row")).not.toHaveCount(0);
  await expect(page.locator(".message-day")).not.toHaveCount(0);

  const visibleBubble = page.locator(".message-bubble-shell").last();
  await visibleBubble.click({ button: "right" });
  await page.getByRole("button", { name: "回应 👍" }).click();
  await expect(visibleBubble.locator(".message-reactions > button")).toHaveCount(1);
  await expect(page.locator(".reaction-add, .message-action-trigger")).toHaveCount(0);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /聊天设置/ }).click();
  await page.getByRole("switch", { name: "紧凑会话密度" }).check();
  await expect(page.locator("html")).toHaveClass(/compact-chat/);
  await page.getByRole("slider", { name: "消息字体大小" }).fill("18");
  await expect(page.locator(".range-preference").filter({ hasText: "消息字体大小" }))
    .toContainText("18 px");
  await expect(page.locator(".message-rich-text").first()).toHaveCSS("font-size", "18px");
  await page.getByRole("slider", { name: "界面缩放比例" }).fill("110");
  await expect(page.locator(".range-preference").filter({ hasText: "界面缩放比例" }))
    .toContainText("110%");
  await expect(page.locator("html")).toHaveCSS("zoom", "1.1");
  const lightTheme = page.getByRole("button", { name: "浅色", exact: true });
  const darkTheme = page.getByRole("button", { name: "深色", exact: true });
  await expect(lightTheme).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".conversation")).toHaveCSS("background-color", "rgb(223, 231, 228)");
  await darkTheme.click();
  await expect(page.locator("html")).toHaveClass(/theme-dark/);
  await expect(darkTheme).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".settings-dialog")).toHaveCSS("background-color", "rgb(23, 33, 43)");
  await expect(page.locator(".conversation")).toHaveCSS("background-color", "rgb(14, 22, 33)");
  await expect(page.locator(".message-row.is-incoming:has(.message-rich-text) .message-bubble").first())
    .toHaveCSS("background-color", "rgb(24, 37, 51)");
  await expect(page.locator(".message-row.is-outgoing:has(.message-rich-text) .message-bubble").first())
    .toHaveCSS("background-color", "rgb(43, 82, 120)");
  await page.getByRole("button", { name: /高级设置/ }).click();
  await page.getByRole("button", { name: "重建界面缓存" }).click();
  await expect(page.locator(".settings-dialog .cache-health"))
    .toContainText("缓存状态：刚刚重建");
  await page.getByRole("button", { name: /软件更新/ }).click();
  await expect(page.getByRole("heading", { name: /Notgram 0\.5\.0-rc\.2/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "检查更新" })).toBeDisabled();
  await page.getByRole("button", { name: /诊断与隐私/ }).click();
  await expect(page.getByRole("button", { name: "导出诊断包" })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "保留脱敏崩溃报告" })).toBeDisabled();
  await expect(page.getByText("浏览器预览不生成诊断包")).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/theme-dark/);
  await expect(page.locator(".conversation")).toHaveCSS("background-color", "rgb(14, 22, 33)");
});

test("composer keeps focus, typing status is visible, and previews name the sender", async ({ page }) => {
  await page.goto("/?typing=group");

  const composer = page.getByRole("textbox", { name: "消息内容" });
  await expect(page.locator(".conversation-typing-status")).toHaveText("Jules 正在输入...");
  await expect(page.locator('[data-chat-id="chat-product"] .chat-preview'))
    .toContainText("Jules: 我把交互稿更新到最新版本了");

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
    for (const character of text) {
      valueSetter.call(input, input.value + character);
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: character,
        inputType: "insertText",
      }));
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

test("private chats show incoming typing state", async ({ page }) => {
  await page.goto("/?typing=direct");
  await page.locator('[data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-typing-status")).toHaveText("正在输入...");
});

test("sidebar dragging and window resizing keep the responsive layout live", async ({ page }) => {
  await page.goto("/");
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
  await expect(messageList).not.toHaveClass(/is-scrolling/);

  const idle = await messageList.evaluate((element) => {
    const content = element.querySelector<HTMLElement>(".message-list-content");
    return {
      clientWidth: element.clientWidth,
      contentWidth: content?.getBoundingClientRect().width,
      horizontalOverflow: element.scrollWidth > (element as HTMLElement).offsetWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrollbarColor: getComputedStyle(element).scrollbarColor,
    };
  });
  expect(idle.overflowX).toBe("hidden");
  expect(idle.horizontalOverflow).toBe(false);
  expect(idle.scrollbarColor).toContain("rgba(0, 0, 0, 0)");

  await messageList.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -160 }));
    element.scrollTop = Math.max(0, element.scrollTop - 160);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(messageList).toHaveClass(/is-scrolling/);

  const scrolling = await messageList.evaluate((element) => ({
    clientWidth: element.clientWidth,
    contentWidth: element.querySelector<HTMLElement>(".message-list-content")
      ?.getBoundingClientRect().width,
    scrollbarColor: getComputedStyle(element).scrollbarColor,
  }));
  expect(scrolling.clientWidth).toBe(idle.clientWidth);
  expect(scrolling.contentWidth).toBe(idle.contentWidth);
  expect(scrolling.scrollbarColor).not.toBe(idle.scrollbarColor);

  await expect(messageList).not.toHaveClass(/is-scrolling/, { timeout: 2_000 });
  await expect.poll(() => messageList.evaluate((element) => element.clientWidth))
    .toBe(idle.clientWidth);
});

test("latest message keeps a fixed gap above the composer", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);

  const gap = await page.evaluate(() => {
    const latest = document.querySelector<HTMLElement>('[data-message-id="p-video"]');
    const composer = document.querySelector<HTMLElement>(".composer-wrap");
    if (!latest || !composer) return -1;
    return composer.getBoundingClientRect().top - latest.getBoundingClientRect().bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(11);
  expect(gap).toBeLessThanOrEqual(13);
});

test("single-click entry restores the server read marker without exposing intermediate jumps", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(() => {
    const diagnosticWindow = window as typeof window & {
      __notgramEntryFrames?: Array<{
        busy: string | null;
        placeholder: boolean;
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
        messageCount: number;
        scrollTop: number;
      }>;
    }).__notgramEntryFrames ?? [];
    const placeholderFrames = frames.filter((frame) => frame.placeholder);
    const uncoveredEmptyFrames = frames.filter(
      (frame) => frame.messageCount === 0 && !frame.placeholder,
    );
    const exposedPositions = new Set(
      frames.filter((frame) => !frame.placeholder && frame.messageCount > 0)
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
      uncoveredEmptyFrameCount: uncoveredEmptyFrames.length,
      exposedPositionCount: exposedPositions.size,
      scrollBehavior: getComputedStyle(list).scrollBehavior,
      pseudoOverlayContent: getComputedStyle(
        document.querySelector<HTMLElement>(".message-list-shell")!,
        "::after",
      ).content,
    };
  });
  expect(result.targetOffset).toBeGreaterThanOrEqual(-1);
  expect(result.targetOffset).toBeLessThan(result.listHeight);
  expect(result.latestVisible).toBe(false);
  expect(result.placeholderFrameCount).toBeGreaterThan(0);
  expect(result.uncoveredEmptyFrameCount).toBeLessThanOrEqual(1);
  expect(result.exposedPositionCount).toBeLessThanOrEqual(1);
  expect(result.scrollBehavior).toBe("auto");
  expect(result.pseudoOverlayContent).toBe("none");
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
      if (document.querySelector(".message-positioning-placeholder")) placeholderFrames += 1;
      if (headerMs !== undefined && messageCount === 0) emptyFramesAfterHeader += 1;
      if (headerMs !== undefined && firstMessageMs === undefined && messageCount > 0) {
        firstMessageMs = performance.now() - startedAt;
      }
      if (
        firstMessageMs !== undefined &&
        list?.getAttribute("aria-busy") === "false"
      ) {
        contentMs = performance.now() - startedAt;
        break;
      }
    }
    return { headerMs, firstMessageMs, contentMs, placeholderFrames, emptyFramesAfterHeader };
  });

  expect(timing.headerMs).toBeDefined();
  expect(timing.headerMs!).toBeLessThan(100);
  expect(timing.firstMessageMs).toBeDefined();
  expect(timing.firstMessageMs!).toBeLessThan(100);
  expect(timing.contentMs).toBeDefined();
  expect(timing.contentMs!).toBeLessThan(300);
  expect(timing.placeholderFrames).toBe(0);
  expect(timing.emptyFramesAfterHeader).toBeLessThanOrEqual(1);

  await product.click();
  await mia.click();
  await product.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  expect(await messageCounts()).toEqual(beforeCounts);
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
      stackOffset: Math.round(
        (group.querySelector<HTMLElement>(".message-group-stack")?.getBoundingClientRect().left
          ?? Number.POSITIVE_INFINITY) - contentLeft,
      ),
    }));
  });
  expect(alignment).toEqual([
    { avatarSlots: 1, avatars: 0, stackOffset: 42 },
    { avatarSlots: 1, avatars: 1, stackOffset: 42 },
  ]);
});

test("media cache controls clean selected data and protect active files", async ({ page }) => {
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
  await cacheSection.getByLabel("清理范围").selectOption("30");
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
  const item = menu.getByRole("menuitem", { name, exact: true });
  await expect(item).toBeVisible();
  for (let step = 0; step < 12; step += 1) {
    if (await item.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");
};

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

  const editableMessage = page.locator('[data-message-id="p-2"]');
  const focusEditableMessage = async () => {
    await editableMessage.scrollIntoViewIfNeeded();
    const trigger = editableMessage.locator(".message-bubble-shell");
    await trigger.focus();
    await expect(trigger).toBeFocused();
    return trigger;
  };
  let actionTrigger = await focusEditableMessage();
  await page.keyboard.press("Shift+F10");
  const actionMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(actionMenu).toBeVisible();
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
  await expect(reactionMenu.getByRole("button", { name: "回应 👍" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(reactionMenu).toBeHidden();
  await expect(actionTrigger).toBeFocused();
});

test("the unified sidebar search paginates, filters, supports regex, and opens exact messages", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("searchbox")).toHaveCount(1);
  await page.keyboard.press("Control+K");

  const search = page.getByRole("searchbox", { name: "搜索会话和消息" });
  await expect(search).toBeFocused();
  await search.fill("产品讨论历史消息");
  await expect(page.locator("[data-search-message-id]")).toHaveCount(30);
  await page.getByRole("button", { name: "加载更多" }).click();
  await expect(page.locator("[data-search-message-id]")).toHaveCount(36);

  await search.fill("reg:^产品讨论历史消息 3[0-6]$");
  await expect(page.locator("[data-search-message-id]")).toHaveCount(7);
  await search.fill("reg:[");
  await expect(page.getByRole("alert").getByText("无效的正则表达式")).toBeVisible();

  await page.getByRole("tab", { name: "媒体" }).click();
  await search.fill("预览");
  const target = page.locator('[data-search-message-id="p-5"]');
  await expect(target).toContainText("新的媒体预览样式");
  await target.click();
  await expect(page.locator(".global-search-results-panel")).toBeHidden();
  const locatedMessage = page.locator('[data-message-id="p-5"]');
  await expect(locatedMessage).toHaveClass(/is-notification-target/);
  await expect.poll(() => locatedMessage.evaluate((element) => {
    const list = element.closest(".message-list")?.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    if (!list) return Number.POSITIVE_INFINITY;
    return Math.abs((row.top + row.bottom) / 2 - (list.top + list.bottom) / 2);
  })).toBeLessThan(2);

  await page.getByRole("button", { name: "搜索消息" }).click();
  const conversationSearch = page.getByRole("searchbox", { name: "搜索当前对话" });
  await conversationSearch.fill("reg:^新的媒体预览样式$");
  await expect(page.locator('[data-message-id="p-5"]')).toBeVisible();
  await conversationSearch.fill("reg:[");
  await expect(page.locator(".messages-empty")).toHaveText("没有匹配的消息");
  await expect(page.getByRole("alert").getByText("无效的正则表达式")).toBeVisible();
  await page.getByRole("button", { name: "关闭消息搜索" }).click();
  await page.getByRole("button", { name: "关闭操作提示" }).click();

  await page.keyboard.press("Control+K");
  await search.fill("Mia Chen");
  await page.locator(".global-chat-result", { hasText: "Mia Chen" }).click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Control+K");
  await search.fill("预览");
  await expect(page.locator('[data-search-message-id="p-5"]')).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
  await page.getByRole("button", { name: "清除搜索" }).click();
  await expect(page.locator(".global-search-results-panel")).toBeHidden();
});

test("chat profiles expose members and shared media with focus restoration", async ({ page }) => {
  await page.goto("/");
  const profileTrigger = page.getByRole("button", { name: "查看 产品讨论 资料" });
  await profileTrigger.click();

  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile).toBeVisible();
  await expect(profile.getByRole("heading", { name: "产品讨论" })).toBeVisible();
  await expect(profile.getByText("产品、设计与开发协作群。", { exact: true })).toBeVisible();
  await expect(profile.locator(".profile-member-row")).toHaveCount(4);

  await profile.getByRole("button", { name: "共享媒体" }).click();
  await expect(profile.locator(".profile-media-list button")).not.toHaveCount(0);
  await profile.locator(".profile-media-list button").first().click();
  await expect(profile).toBeHidden();
  await expect(page.locator(".conversation")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await profileTrigger.click();
  await expect(profile).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
  await profile.getByRole("button", { name: "关闭资料" }).click();
  await expect(profileTrigger).toBeFocused();
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
  await expect(mutedBadge).toHaveCSS("background-color", "rgb(146, 154, 158)");
  await expect(regularBadge).not.toHaveCSS("background-color", "rgb(146, 154, 158)");
  await expect(page.locator(".chat-row .lucide-volume-x")).toHaveCount(0);
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
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();

  const markdown = page.locator('[data-message-id="p-markdown"] .message-rich-text');
  await expect(markdown).toHaveAttribute("data-rich-text", "markdown");
  await expect(markdown.locator("strong")).toHaveText("Markdown 粗体");
  await expect(markdown.locator("em")).toHaveText("斜体");
  await expect(markdown.locator("del")).toHaveText("删除线");
  await expect(markdown.locator("li")).toHaveCount(2);
  await expect(markdown.locator("code")).toHaveText("code");
  await expect(markdown.locator('a[href="https://example.com"]')).toHaveText("链接");

  const entities = page.locator('[data-message-id="p-rich-entities"] .message-rich-text');
  await expect(entities).toHaveAttribute("data-rich-text", "entities");
  await expect(entities.locator("strong")).toHaveText("bold");
  await expect(entities.locator('a[href="https://example.com/rich"]')).toHaveText("link");
  await expect(page.locator('[data-message-id="p-video"] .photo-caption strong'))
    .toHaveText("昨晚");

  const richMessage = page.locator('[data-message-id="p-rich-message"] .rich-message-content');
  await expect(richMessage).toHaveAttribute("data-rich-text", "rich-message");
  await expect(richMessage.locator("h1")).toHaveText("今日小贴士");
  await expect(richMessage.locator("li")).toHaveCount(3);
  await expect(richMessage.locator("li").first().locator("strong"))
    .toHaveText("优先处理最重要的一件事");
  await expect(richMessage.locator("blockquote")).toHaveCount(2);
  await expect(richMessage.locator("code").first()).toHaveText("5,709 tokens");
  await expect(richMessage.locator(".katex")).toContainText("E");
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
});

test("video uses synchronized transparent playback windows and owns the playback spacebar", async ({ page }) => {
  await page.setViewportSize({ width: 1_100, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const row = page.locator('[data-message-id="p-video"]');
  const player = row.locator(".video-player");
  const video = player.locator("video");

  await expect(player).toBeVisible();
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
  await messageList.evaluate((list, messageId) => {
    const playerElement = list.querySelector<HTMLElement>(`[data-message-id="${messageId}"] .video-player`);
    if (!playerElement) return;
    const listBounds = list.getBoundingClientRect();
    const playerBounds = playerElement.getBoundingClientRect();
    list.scrollTop += playerBounds.top - listBounds.top + playerBounds.height * 0.6;
  }, "p-video");
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).paused))
    .toBe(true);
  await row.scrollIntoViewIfNeeded();
  await player.getByRole("button", { name: /播放 交互预览/ }).click();
  await expect.poll(() => video.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);

  await row.click({ button: "right" });
  const actionMenu = page.getByRole("menu", { name: "消息操作" });
  await expect(actionMenu.getByRole("menuitem").first()).toHaveText("以小窗播放");
  await expect(actionMenu.getByRole("menuitem").nth(1)).toHaveText("下载视频");
  const popupPromise = page.waitForEvent("popup");
  await actionMenu.getByRole("menuitem", { name: "以小窗播放" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  const popupPlayer = popup.locator(".video-window");
  const popupVideo = popupPlayer.locator("video");
  await expect(popupPlayer).toHaveClass(/is-windowed/);
  await expect(popupVideo).toHaveAttribute("src", /mock-video\.mp4/);
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
  await expect.poll(() => popupPlayer.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe("rgba(12, 18, 20, 0.62)");

  await popup.waitForTimeout(1_100);
  await expect.poll(() => controls.evaluate((element) => getComputedStyle(element).opacity))
    .toBe("0");
  const popupClosed = popup.waitForEvent("close");
  await popup.mouse.click(20, 20);
  await popupClosed;
  await expect(player).toBeVisible();
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(true);
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).volume))
    .toBe(0.35);

  const fullscreenPopupPromise = page.waitForEvent("popup");
  const inlineBounds = await player.boundingBox();
  await player.dblclick({ position: { x: inlineBounds!.width / 2, y: inlineBounds!.height / 2 } });
  const fullscreenPopup = await fullscreenPopupPromise;
  await fullscreenPopup.waitForLoadState("domcontentloaded");
  const fullscreenVideo = fullscreenPopup.locator("video");
  await expect(fullscreenPopup.locator(".video-window")).toHaveClass(/is-fullscreen/);
  await expect.poll(() => fullscreenVideo.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(false);
  await expect.poll(() => fullscreenVideo.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);
  const secondFullscreenControls = fullscreenPopup.locator(".video-fullscreen-controls");
  await fullscreenPopup.locator(".video-window").hover({ position: { x: 100, y: 100 } });
  await expect.poll(() => secondFullscreenControls.evaluate(
    (element) => getComputedStyle(element).opacity,
  )).toBe("1");
  const fullscreenClosed = fullscreenPopup.waitForEvent("close");
  await fullscreenPopup.getByRole("button", { name: "关闭播放窗口" }).click();
  await fullscreenClosed;
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(true);
  await page.reload();
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const restoredVideo = page.locator('[data-message-id="p-video"] video');
  await expect.poll(() => restoredVideo.evaluate((element) => (element as HTMLVideoElement).volume))
    .toBe(0.35);
  await expect.poll(() => restoredVideo.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(true);
});

test("photo albums preserve order, captions, clipping, and tile geometry", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
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
  await expect(album.locator(".media-album-caption")).toHaveText([
    "纵向图片应该按实际比例收窄，外壳不能留下额外空白。",
    "新的媒体预览样式",
  ]);
  await expect(tallRow).toHaveClass(/group-first/);
  await expect(squareRow).toHaveClass(/group-last/);
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

test("saved and direct messages align to the conversation edges", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /收藏夹/ }).click();
  const savedMessage = page.locator('[data-message-id="s-2"]');
  await expect(savedMessage).toBeVisible();
  await expect(savedMessage).toHaveClass(/is-outgoing/);

  await page.getByRole("button", { name: /Mia Chen/ }).click();
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
  const notice = page.locator('[data-message-id="p-service"]');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveClass(/is-service/);
  await expect(notice.locator(".message-bubble")).toHaveText("Mia Chen 加入了群聊");
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
});

test("developer mode copies the complete raw unknown message", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://127.0.0.1:1422",
  });
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();

  const notice = page.locator('[data-message-id="p-unknown"]');
  await expect(notice).toContainText("收到新类型消息（messageFutureType）");
  await expect(notice.locator(".unknown-message-copy")).toHaveCount(0);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /高级设置/ }).click();
  await page.getByRole("switch", { name: "开发者模式" }).check();
  await page.getByRole("dialog").getByRole("button", { name: "关闭" }).click();

  const copyButton = notice.getByRole("button", { name: "复制 messageFutureType 原始消息" });
  await copyButton.click();
  await expect(copyButton).toContainText("已复制原始消息");
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied).toMatchObject({
    "@type": "message",
    id: "p-unknown",
    content: { "@type": "messageFutureType" },
  });

  const regularMessage = page.locator('[data-message-id="p-2"]');
  await regularMessage.locator(".message-bubble-shell").click({ button: "right" });
  const rawMenuItem = page.getByRole("menuitem", { name: "复制原始消息" });
  await expect(rawMenuItem).toBeVisible();
  await rawMenuItem.click();
  const regularRaw = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(regularRaw).toMatchObject({
    "@type": "message",
    id: "p-2",
    chat_id: "chat-product",
  });
});

test("conversation scroll state follows, restores, counts, and resets to latest", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-row")).not.toHaveCount(0);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);

  await scrollAwayFromBottom(page);
  const savedAnchor = await visibleMessageAnchor(page);
  expect(savedAnchor.id).toBeTruthy();

  await page.getByRole("button", { name: /Mia Chen/ }).click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await page.getByRole("button", { name: /产品讨论/ }).click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect.poll(async () => (await visibleMessageAnchor(page)).id).toBe(savedAnchor.id);
  await expect.poll(async () => Math.abs(
    (await visibleMessageAnchor(page)).offset - savedAnchor.offset,
  )).toBeLessThanOrEqual(2);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const restored = await visibleMessageAnchor(page);
  for (const text of ["滚动定位测试一", "滚动定位测试二"]) {
    await page.getByRole("textbox", { name: "消息内容" }).fill(text);
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveValue("");
  }

  const jumpButton = page.getByRole("button", { name: "跳到最新消息，2 条新消息" });
  await expect(jumpButton).toBeVisible();
  const afterMessages = await visibleMessageAnchor(page);
  expect(afterMessages.id).toBe(restored.id);
  expect(Math.abs(afterMessages.offset - restored.offset)).toBeLessThanOrEqual(2);

  await jumpButton.click();
  await expect(jumpButton).toBeHidden();
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);

  await page.getByRole("textbox", { name: "消息内容" }).fill("底部自动跟随测试");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);

  await scrollAwayFromBottom(page);
  await page.getByRole("button", { name: /Mia Chen/ }).click();
  await page.locator('[data-chat-id="chat-product"]').dblclick();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);
});

test("double-clicking a conversation repeatedly converges to its latest message", async ({ page }) => {
  await page.goto("/");
  const product = page.locator('[data-chat-id="chat-product"]');
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: /Mia Chen/ }).click();
  await product.dblclick();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);

  const messageList = page.locator(".message-list");
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await expect.poll(async () => {
      const metrics = await messageListMetrics(page);
      return metrics.scrollHeight - metrics.clientHeight;
    }).toBeGreaterThan(200);
    await messageList.hover();
    await page.mouse.wheel(0, -900);
    await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
      .toBeGreaterThan(100);
    await product.dblclick();
    await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
      .toBeLessThanOrEqual(1);
    await expect(page.locator('[data-message-id="p-video"]')).toBeVisible();
  }
});

test("loading older messages preserves the visible message anchor", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-row").first()).toBeAttached();

  const list = page.locator(".message-list");
  await expect(list).toHaveAttribute("aria-busy", "false");
  const before = await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    element.scrollTop = 40;
    const listBounds = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((candidate) => candidate.getBoundingClientRect().bottom > listBounds.top + 1);
    const result = {
      id: row?.dataset.messageId,
      offset: row ? row.getBoundingClientRect().top - listBounds.top : 0,
    };
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    return result;
  });

  expect(before.id).toBeTruthy();
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
  await page.getByRole("button", { name: "搜索消息" }).click();
  await expect(menu).toBeHidden();
  await page.getByRole("button", { name: "关闭消息搜索" }).click();

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
  const miaRow = page.locator('.chat-row[data-chat-id="chat-mia"]');

  await miaRow.click({ button: "right" });
  let menu = page.getByRole("menu", { name: "会话操作：Mia Chen" });
  await expect(menu).toBeVisible();
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

  const chenName = page.locator('.chat-row[data-chat-id="chat-chen"] strong');
  await chenName.click({ timeout: 1_000 });
  await expect(page.locator(".conversation-title strong")).toHaveText("陈默", { timeout: 1_000 });
  await expect(menu).toBeHidden();
});

test("sidebar context menus close when content outside them scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 420 });
  await page.goto("/");
  await page.addStyleTag({
    content: ".chat-row { min-height: 92px; } .chat-folder-submenu { height: 32px; max-height: 32px; }",
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
  await menu.locator('[data-context-menu-primary] [role="menuitem"]').first().click();
  const submenu = menu.locator(".chat-folder-submenu");
  await expect(submenu).toBeVisible();
  const submenuMovement = await submenu.evaluate((element) => ({
    before: element.scrollTop,
    maximum: element.scrollHeight - element.clientHeight,
  }));
  expect(submenuMovement.maximum).toBeGreaterThan(0);
  await submenu.hover();
  await page.mouse.wheel(0, 60);
  await expect.poll(() => submenu.evaluate((element) => element.scrollTop))
    .not.toBe(submenuMovement.before);
  await expect(menu).toBeVisible();

  await scrollChatList();
  await expect(menu).toBeHidden();
});

test("message context menu closes when the conversation scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 420 });
  await page.goto("/");

  const messageList = page.locator(".message-list");
  const visibleBubble = page.locator('[data-message-id="p-2"] .message-bubble-shell');
  await visibleBubble.scrollIntoViewIfNeeded();
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
