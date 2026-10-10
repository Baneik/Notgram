import { expect, test, type Page } from "@playwright/test";

const storePath = "/src/store/telegramStore.ts";
const openForum = async (page: Page) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"]').click();
  await expect(page.locator('[data-message-id="forum-general-1"]')).toBeVisible();
  await expect.poll(() => page.evaluate(async path => {
    const { telegramStore } = await import(path);
    return telegramStore.getState().forumTopicsLoading.has("chat-forum");
  }, storePath)).toBe(false);
};
const tab = (page: Page, id: string) => page.locator(`.forum-topic-strip [data-topic-id="${id}"]`);
const input = (page: Page) => page.getByRole("textbox", { name: "消息" });

test("forum tabs keep their DOM, positions and scroll offset across activity and topic switches", async ({ page }) => {
  await openForum(page);
  await page.evaluate(() => {
    const runtime = window as unknown as { forumHeader: Element | null; forumStrip: Element | null };
    runtime.forumHeader = document.querySelector(".conversation-header");
    runtime.forumStrip = document.querySelector(".forum-topic-strip");
  });
  const before = await page.locator(".forum-topic-tabs").evaluate(element => ({
    order: [...element.children].map(node => (node as HTMLElement).dataset.topicId),
    positions: [...element.children].map(node => node.getBoundingClientRect().left),
    scroll: element.scrollLeft,
  }));
  await page.evaluate(async path => {
    const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
    const topics = new Map(telegramStore.getState().forumTopics);
    topics.set("chat-forum", [...topics.get("chat-forum")!].reverse().map((topic, i) => ({ ...topic,
      order: String(i * 1_000), isPinned: !topic.isPinned, unreadCount: 0, unreadReactionCount: 0 })));
    telegramStore.setState({ forumTopics: topics });
  }, storePath);
  await tab(page, "12").click();
  await expect(page.locator('[data-message-id="forum-release-1"]')).toBeVisible();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const after = await page.locator(".forum-topic-tabs").evaluate(element => ({
    order: [...element.children].map(node => (node as HTMLElement).dataset.topicId),
    positions: [...element.children].map(node => node.getBoundingClientRect().left),
    scroll: element.scrollLeft,
  }));
  expect(after).toEqual(before);
  expect(await page.evaluate(() => {
    const runtime = window as unknown as { forumHeader: Element; forumStrip: Element };
    return runtime.forumHeader === document.querySelector(".conversation-header") &&
      runtime.forumStrip === document.querySelector(".forum-topic-strip");
  })).toBe(true);
});

test("forum drag order survives switching and reload; All stays fixed and keyboard sorting works", async ({ page }) => {
  await openForum(page);
  const first = await tab(page, "1").boundingBox();
  const last = await tab(page, "18").boundingBox();
  await page.mouse.move(last!.x + last!.width / 2, last!.y + last!.height / 2);
  await page.mouse.down();
  await page.mouse.move(first!.x + first!.width / 2 - 3, first!.y + first!.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => page.locator(".forum-topic-tabs [data-topic-id]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-topic-id"))))
    .toEqual(["18", "1", "12"]);
  await tab(page, "12").click();
  await expect(page.locator('[data-message-id="forum-release-1"]')).toBeVisible();
  await page.reload();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"]').click();
  await expect.poll(() => page.locator(".forum-topic-tabs [data-topic-id]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-topic-id"))))
    .toEqual(["18", "1", "12"]);
  await tab(page, "18").focus();
  await page.keyboard.press("Control+Shift+ArrowRight");
  await expect.poll(() => page.locator(".forum-topic-tabs [data-topic-id]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-topic-id"))))
    .toEqual(["1", "18", "12"]);
  await expect(page.locator(".forum-topic-tablist > .forum-topic-all")).toHaveText("所有");
});

test("All loads the whole group history, survives reentry and does not send into an unspecified topic", async ({ page }) => {
  await openForum(page);
  await tab(page, "__all__").click();
  await expect(tab(page, "__all__")).toHaveAttribute("aria-selected", "true");
  for (const id of ["forum-general-1", "forum-release-1", "forum-design-1"]) {
    await expect(page.locator(`[data-message-id="${id}"]`)).toBeVisible();
  }
  await expect(input(page)).toHaveCount(0);
  await expect(page.getByText("选择话题后发送消息", { exact: true })).toBeVisible();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"]').click();
  await expect(tab(page, "__all__")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-message-id="forum-release-1"]')).toBeVisible();
});

test("forum manager creates, renames, closes and deletes a topic with confirmation", async ({ page }) => {
  await openForum(page);
  await page.getByRole("button", { name: "管理话题", exact: true }).click();
  let manager = page.getByRole("dialog", { name: "管理话题", exact: true });
  await manager.getByRole("button", { name: "创建话题" }).click();
  await manager.getByPlaceholder("话题名称").fill("QA topic");
  await manager.getByRole("button", { name: "确认创建" }).click();
  await expect(manager).toHaveCount(0);
  await expect(page.getByRole("region", { name: "QA topic 话题 对话" })).toBeVisible();
  await input(page).fill("Unsent text in a deleted topic");
  await page.getByRole("button", { name: "管理话题", exact: true }).click();
  manager = page.getByRole("dialog", { name: "管理话题", exact: true });
  await manager.getByRole("button", { name: "QA topic 更多操作" }).click();
  await manager.getByRole("menuitem", { name: "重命名" }).click();
  await manager.locator(".forum-topic-edit input").fill("QA renamed");
  await manager.getByRole("button", { name: "保存话题" }).click();
  await manager.getByRole("button", { name: "QA renamed 更多操作" }).click();
  await manager.getByRole("menuitem", { name: "关闭话题" }).click();
  await expect(manager.locator(".forum-topic-row.is-closed", { hasText: "QA renamed" })).toBeVisible();
  await manager.getByRole("button", { name: "QA renamed 更多操作" }).click();
  await manager.getByRole("menuitem", { name: "删除话题" }).click();
  const confirmation = page.getByRole("dialog", { name: "删除话题", exact: true });
  await expect(confirmation.getByText(/此操作无法撤销/)).toBeVisible();
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(manager.getByText("QA renamed", { exact: true })).toBeVisible();
  await manager.getByRole("button", { name: "QA renamed 更多操作" }).click();
  await manager.getByRole("menuitem", { name: "删除话题" }).click();
  await confirmation.getByRole("button", { name: "删除话题", exact: true }).click();
  await expect(manager.getByText("QA renamed", { exact: true })).toHaveCount(0);
  await manager.getByRole("button", { name: "返回会话列表" }).click();
  await expect(tab(page, "__all__")).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(async path => {
    const { telegramStore } = await import(path);
    return [...telegramStore.getState().drafts.values()].some(draft => draft.text === "Unsent text in a deleted topic");
  }, storePath)).toBe(false);
});

test("unsent forum drafts stay in their original topic during immediate switches", async ({ page }) => {
  await openForum(page);
  await input(page).fill("General draft stays here");
  await tab(page, "12").click();
  await expect(input(page)).toHaveText("");
  await input(page).fill("Release draft stays here");
  await tab(page, "1").click();
  await expect(input(page)).toHaveText("General draft stays here");
  await tab(page, "12").click();
  await expect(input(page)).toHaveText("Release draft stays here");
  await input(page).press("Enter");
  await expect(input(page)).toHaveText("");
  await tab(page, "1").click();
  await expect(input(page)).toHaveText("General draft stays here");
  await tab(page, "12").click();
  await expect(input(page)).toHaveText("");
});

test("sent forum text cannot return through a stale topic-list response after the clear ack", async ({ page }) => {
  await openForum(page);
  await tab(page, "12").click();
  await input(page).fill("Sent text must stay sent");
  await expect.poll(() => page.evaluate(async path => {
    const { telegramStore } = await import(path);
    return telegramStore.getState().drafts.get("chat-forum:topic:12")?.text;
  }, storePath)).toBe("Sent text must stay sent");
  await page.evaluate(async paths => {
    const { telegramStore } = await import(paths.store);
    const { MockTelegramTransport } = await import(paths.transport);
    const original = MockTelegramTransport.prototype.getForumTopics;
    const state = telegramStore.getState();
    const stale = { topics: state.forumTopics.get("chat-forum").map((topic: { id: string }) => ({ ...topic,
      draft: state.drafts.get(`chat-forum:topic:${topic.id}`) })), hasMore: false };
    const runtime = window as unknown as { releaseStaleForum: () => void };
    MockTelegramTransport.prototype.getForumTopics = () => new Promise(resolve => {
      runtime.releaseStaleForum = () => { MockTelegramTransport.prototype.getForumTopics = original; resolve(stale); };
    });
    void telegramStore.getState().loadForumTopics("chat-forum");
  }, { store: storePath, transport: "/src/telegram/mockTransport.ts" });
  await input(page).press("Enter");
  await expect(input(page)).toHaveText("");
  await expect.poll(() => page.evaluate(async path => {
    const { telegramStore } = await import(path);
    return telegramStore.getState().drafts.has("chat-forum:topic:12");
  }, storePath)).toBe(false);
  await page.evaluate(() => (window as unknown as { releaseStaleForum: () => void }).releaseStaleForum());
  await expect.poll(() => page.evaluate(async path => {
    const { telegramStore } = await import(path);
    return telegramStore.getState().forumTopicsLoading.has("chat-forum");
  }, storePath)).toBe(false);
  await expect(input(page)).toHaveText("");
  expect(await page.evaluate(async path => {
    const { telegramStore } = await import(path);
    return telegramStore.getState().drafts.has("chat-forum:topic:12");
  }, storePath)).toBe(false);
  await tab(page, "1").click();
  await tab(page, "12").click();
  await expect(input(page)).toHaveText("");
  expect(await page.evaluate(async path => {
    const { telegramStore } = await import(path);
    return telegramStore.getState().drafts.has("chat-forum:topic:12");
  }, storePath)).toBe(false);
});

test("narrow forum keeps All and management reachable without page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openForum(page);
  await tab(page, "__all__").click();
  await expect(tab(page, "__all__")).toBeVisible();
  await expect(page.getByRole("button", { name: "管理话题", exact: true })).toBeVisible();
  await expect(page.locator('[data-message-id="forum-release-1"]')).toBeVisible();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/forum-narrow.png" });
});

test("forum deletion failure keeps the topic and offers a retry; General cannot be deleted", async ({ page }) => {
  await openForum(page);
  await page.getByRole("button", { name: "管理话题", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "管理话题", exact: true });
  await manager.getByRole("button", { name: "常规 更多操作" }).click();
  await expect(manager.getByRole("menuitem", { name: "删除话题" })).toHaveCount(0);
  await manager.getByRole("button", { name: "创建话题" }).click();
  await manager.getByPlaceholder("话题名称").fill("Retry deletion");
  await manager.getByRole("button", { name: "确认创建" }).click();
  await expect(manager).toHaveCount(0);
  await page.evaluate(async path => {
    const { MockTelegramTransport } = await import(path);
    const original = MockTelegramTransport.prototype.deleteForumTopic;
    let first = true;
    MockTelegramTransport.prototype.deleteForumTopic = async function (...args: unknown[]) {
      if (first) { first = false; throw new Error("Deletion temporarily failed"); }
      return original.apply(this, args);
    };
  }, "/src/telegram/mockTransport.ts");
  await page.getByRole("button", { name: "管理话题", exact: true }).click();
  await manager.getByRole("button", { name: "Retry deletion 更多操作" }).click();
  await manager.getByRole("menuitem", { name: "删除话题" }).click();
  const confirmation = page.getByRole("dialog", { name: "删除话题", exact: true });
  await confirmation.getByRole("button", { name: "删除话题", exact: true }).click();
  await expect(confirmation.getByRole("alert")).toHaveText("无法删除话题");
  await expect(manager.getByText("Retry deletion", { exact: true })).toHaveCount(1);
  await confirmation.getByRole("button", { name: "删除话题", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(manager.getByText("Retry deletion", { exact: true })).toHaveCount(0);
});

test("forum tabs keep header and All visible during a slow topic history load", async ({ page }) => {
  await openForum(page);
  await page.evaluate(async paths => {
    const { telegramStore } = await import(paths.store) as typeof import("../../src/store/telegramStore");
    const { MockTelegramTransport } = await import(paths.transport);
    const original = MockTelegramTransport.prototype.loadForumTopicHistory;
    MockTelegramTransport.prototype.loadForumTopicHistory = async function (...args: unknown[]) {
      await new Promise(resolve => setTimeout(resolve, 500));
      return original.apply(this, args);
    };
    const state = telegramStore.getState();
    const topics = new Map(state.forumTopics);
    topics.set("chat-forum", [...topics.get("chat-forum")!, { ...topics.get("chat-forum")![0],
      id: "99", name: "Slow topic", isGeneral: false, lastMessage: undefined }]);
    telegramStore.setState({ forumTopics: topics });
  }, { store: storePath, transport: "/src/telegram/mockTransport.ts" });
  await tab(page, "99").click();
  const frames = await page.evaluate(async () => {
    const header = document.querySelector(".conversation-header")!;
    const strip = document.querySelector(".forum-topic-strip")!;
    let invalid = 0;
    let frameCount = 0;
    const start = performance.now();
    while (performance.now() - start < 700) {
      await new Promise(requestAnimationFrame);
      frameCount++;
      const snapshot = document.querySelector("[data-conversation-switch-snapshot]");
      const stripBounds = strip.getBoundingClientRect();
      if (!header.isConnected || !strip.isConnected || stripBounds.height < 1 ||
        (snapshot && snapshot.getBoundingClientRect().top < stripBounds.bottom - 1)) invalid++;
    }
    return { invalid, frameCount };
  });
  expect(frames.frameCount).toBeGreaterThan(10);
  expect(frames.invalid).toBe(0);
  await expect(tab(page, "99")).toHaveAttribute("aria-selected", "true");
});
