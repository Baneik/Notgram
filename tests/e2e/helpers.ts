import { expect, type Locator, type Page } from "@playwright/test";

export interface ConversationSwitchRecord {
  durationMs?: number;
  navigationKind?: number;
  cancelled?: boolean;
  [key: string]: number | boolean | undefined;
}

export const horizontalOverflow = async (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll("body *")].some((element) => {
    if (element.closest(".rail-actions")) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
  }));

export const conversationSwitchRecords = (page: Page): Promise<ConversationSwitchRecord[]> =>
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

export const messageListMetrics = (page: Page) => page.locator(".message-list").evaluate((element) => ({
  scrollTop: element.scrollTop,
  scrollHeight: element.scrollHeight,
  clientHeight: element.clientHeight,
  distanceBottom: element.scrollHeight - element.clientHeight - element.scrollTop,
}));

export const latestMessageBottomGap = (page: Page) => page.locator(".message-list").evaluate((element) => {
  const messages = element.querySelectorAll<HTMLElement>("[data-message-id]");
  const latest = messages.item(messages.length - 1);
  if (!latest) return Number.POSITIVE_INFINITY;
  return Math.abs(
    element.getBoundingClientRect().bottom - latest.getBoundingClientRect().bottom,
  );
});

export const visibleMessageAnchor = (page: Page) => page.locator(".message-list").evaluate((element) => {
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

export const scrollAwayFromBottom = async (page: Page) => {
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

export const revealVirtualMessage = async (page: Page, messageId: string) => {
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

export const openConversationMessageSearch = async (page: Page) => {
  const menu = page.getByRole("menu", { name: "会话操作" });
  if (!await menu.isVisible()) {
    await page.getByRole("button", { name: "更多操作" }).click();
  }
  await menu.getByRole("menuitem", { name: "搜索消息" }).click();
};

export const chooseMessageMenuItem = async (page: Page, name: string) => {
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
