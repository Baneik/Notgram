import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Message, MessagePermissions } from "../../src/telegram/types";

const storePath = "/src/store/telegramStore.ts";
const mockPath = "/src/telegram/mockTransport.ts";
const permissions = (self: boolean, all: boolean): MessagePermissions => ({
  canReply: true, canEdit: false, canForward: true, canSave: true,
  canDeleteOnlyForSelf: self, canDeleteForAllUsers: all,
});

async function prepare(page: Page, width = 1366, count = 4) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  const scope = page.locator(".conversation");
  await expect(scope.getByRole("log")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async ({ storePath, mockPath, count, permissions }) => {
    const { telegramStore } = await import(storePath) as typeof import("../../src/store/telegramStore");
    const { MockTelegramTransport } = await import(mockPath) as typeof import("../../src/telegram/mockTransport");
    const state = telegramStore.getState();
    const source = state.messages.get("chat-product")!.find(message => message.content.kind === "text")!;
    const messages: Message[] = Array.from({ length: count }, (_, i) => ({
      ...source, id: `selection-${i}`, chatId: "chat-product", outgoing: i % 2 === 0,
      senderId: i % 2 === 0 ? state.currentUserId! : "u-mia", mediaAlbumId: undefined,
      sentAt: new Date(Date.now() - (count - i) * 1000).toISOString(),
      content: { kind: "text", text: `可选择的消息 ${i + 1}` },
      permissions: permissions[i % permissions.length],
    }));
    const byId = new Map(messages.map(message => [message.id, message]));
    MockTelegramTransport.prototype.getMessageProperties = async (_chatId, id) => byId.get(id)!.permissions!;
    MockTelegramTransport.prototype.deleteMessage = async input => {
      const latest = telegramStore.getState();
      telegramStore.setState({ messages: new Map(latest.messages).set(input.chatId,
        latest.messages.get(input.chatId)!.filter(message => message.id !== input.messageId)) });
    };
    telegramStore.setState({ messages: new Map(state.messages).set("chat-product", messages) });
  }, { storePath, mockPath, count, permissions: [permissions(false, true), permissions(true, false), permissions(false, false), permissions(true, true)] });
  if (count <= 4) await expect(scope.locator(".message-row")).toHaveCount(count);
  else await expect(scope.locator(`[data-message-id="selection-${count - 1}"]`)).toBeVisible();
  await settle(scope);
  return scope;
}

async function settle(scope: Locator) {
  await scope.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).filter(animation =>
      animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)));
  });
}

async function blankPoint(scope: Locator, id: string) {
  return scope.locator(`[data-message-id="${id}"]`).evaluate(row => {
    const list = row.closest('[role="log"]')!.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    const y = bounds.top + bounds.height / 2;
    for (const x of [list.left + 3, list.right - 22, list.left + list.width / 2]) {
      const target = document.elementFromPoint(x, y);
      if (target && !target.closest(".message-bubble-shell, button")) return { x, y };
    }
    throw new Error("No blank selection gutter");
  });
}

async function dragRows(page: Page, scope: Locator, from: string, to: string) {
  const start = await blankPoint(scope, from);
  const end = await blankPoint(scope, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
}

for (const width of [1366, 390]) {
  test(`blank drag requires two messages, supports reverse/additional ranges and Escape (${width})`, async ({ page }) => {
    const scope = await prepare(page, width);
    const point = await blankPoint(scope, "selection-0");
    await page.mouse.click(point.x, point.y);
    await expect(scope.getByRole("toolbar")).toHaveCount(0);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 15, point.y, { steps: 4 });
    await page.mouse.up();
    await expect(scope.getByRole("toolbar")).toHaveCount(0);
    await dragRows(page, scope, "selection-1", "selection-0");
    await expect(scope.locator(".message-row.is-selected")).toHaveCount(2);
    await expect(scope.getByText("已选择 2 条", { exact: true })).toBeVisible();
    await expect(scope.locator(".message-selection-toggle")).toHaveCount(0);
    await dragRows(page, scope, "selection-2", "selection-3");
    await expect(scope.locator(".message-row.is-selected")).toHaveCount(4);
    await expect(scope.getByRole("button", { name: "删除已选消息" })).toBeEnabled();
    await page.screenshot({ path: `test-results/multiselect-${width}-light.png` });
    await page.evaluate(async path => {
      const { preferencesStore } = await import(path) as typeof import("../../src/store/preferencesStore");
      preferencesStore.setState({ themeId: "notgram-dark" });
    }, "/src/store/preferencesStore.ts");
    await settle(scope);
    await page.screenshot({ path: `test-results/multiselect-${width}-dark.png` });
    await page.keyboard.press("Escape");
    await expect(scope.getByRole("toolbar")).toHaveCount(0);
    await expect(scope.getByRole("textbox", { name: "消息内容" })).toBeVisible();
  });

  test(`mixed permission deletion shows scope counts and preserves other messages (${width})`, async ({ page }) => {
    const scope = await prepare(page, width);
    await dragRows(page, scope, "selection-0", "selection-3");
    await scope.getByRole("button", { name: "删除已选消息" }).click();
    const dialog = page.getByRole("dialog", { name: "删除 4 条消息" });
    await expect(dialog.getByRole("button", { name: "仅对我删除", exact: true }).locator(".message-delete-count")).toHaveText("2");
    await expect(dialog.getByRole("button", { name: "为所有人删除", exact: true }).locator(".message-delete-count")).toHaveText("2");
    await settle(scope);
    await page.screenshot({ path: `test-results/multiselect-delete-${width}.png` });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(scope.locator(".message-row.is-selected")).toHaveCount(4);
    await scope.getByRole("button", { name: "删除已选消息" }).click();
    await dialog.getByRole("button", { name: "为所有人删除", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(scope.locator('[data-message-id="selection-0"]')).toHaveCount(0);
    await expect(scope.locator('[data-message-id="selection-3"]')).toHaveCount(0);
    await expect(scope.locator(".message-row.is-selected")).toHaveCount(2);
    await scope.getByRole("button", { name: "删除已选消息" }).click();
    const remaining = page.getByRole("dialog", { name: "删除 2 条消息" });
    await expect(remaining.getByRole("button", { name: "为所有人删除", exact: true })).toHaveCount(0);
    await remaining.getByRole("button", { name: "仅对我删除", exact: true }).click();
    await expect(scope.locator(".message-row.is-selected")).toHaveCount(1);
    await expect(scope.getByRole("button", { name: "删除已选消息" })).toBeDisabled();
  });

  test(`drag beginning inside content never enters multi-select (${width})`, async ({ page }) => {
    const scope = await prepare(page, width);
    const content = scope.locator('[data-message-id="selection-0"] .message-rich-text');
    const bounds = (await content.boundingBox())!;
    const end = await blankPoint(scope, "selection-3");
    await page.mouse.move(bounds.x + 12, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 15 });
    await page.mouse.up();
    await expect(scope.getByRole("toolbar")).toHaveCount(0);
  });
}

test("protected messages can be selected for authorized deletion without copy or forward", async ({ page }) => {
  const scope = await prepare(page);
  await page.evaluate(async path => {
    const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    telegramStore.setState({ messages: new Map(state.messages).set("chat-product", state.messages.get("chat-product")!.map(message => ({
      ...message, canSave: false, permissions: { ...message.permissions!, canForward: false, canSave: false, canDeleteForAllUsers: true },
    }))) });
  }, storePath);
  await dragRows(page, scope, "selection-0", "selection-1");
  await expect(scope.locator(".message-row.is-selected")).toHaveCount(2);
  await expect(scope.getByRole("button", { name: "复制已选消息" })).toBeDisabled();
  await expect(scope.getByRole("button", { name: "转发已选消息" })).toBeDisabled();
  await expect(scope.getByRole("button", { name: "删除已选消息" })).toBeEnabled();
});

test("discussion drag selects comments and deletes in the discussion chat", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await page.locator('[data-message-id="release-post-1"] .channel-post-discussion').click();
  const scope = page.locator(".channel-discussion-panel");
  await expect(scope.locator('[data-message-id="release-comment-1"]')).toBeVisible();
  await settle(scope);
  await dragRows(page, scope, "release-comment-1", "release-comment-2");
  await expect(scope.locator(".message-row.is-selected")).toHaveCount(2);
  await expect(scope.getByRole("button", { name: "删除已选消息" })).toBeEnabled();
  await expect(page.locator('.conversation > .message-list .message-row.is-selected')).toHaveCount(0);
  await scope.getByRole("button", { name: "删除已选消息" }).click();
  const dialog = page.getByRole("dialog", { name: "删除 2 条消息" });
  await dialog.getByRole("button", { name: "为所有人删除", exact: true }).click();
  await expect(scope.locator('[data-message-id="release-comment-2"]')).toHaveCount(0);
  await expect(scope.locator('[data-message-id="release-comment-1"]')).toBeVisible();
  await expect(scope.locator('.channel-discussion-post [data-message-id="release-post-1"]')).toBeVisible();
});

test("drag preview contracts when reversing and preserves previously selected messages", async ({ page }) => {
  const scope = await prepare(page);
  const start = await blankPoint(scope, "selection-0");
  const far = await blankPoint(scope, "selection-3");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(far.x, far.y, { steps: 12 });
  await expect(scope.locator(".message-row.is-selected")).toHaveCount(4);
  const near = await blankPoint(scope, "selection-1");
  await page.mouse.move(near.x, near.y, { steps: 12 });
  await expect(scope.locator(".message-row.is-selected")).toHaveCount(2);
  await page.mouse.up();
  await expect(scope.locator(".message-row.is-selected")).toHaveCount(2);
  await dragRows(page, scope, "selection-3", "selection-2");
  await expect(scope.locator(".message-row.is-selected")).toHaveCount(4);
});

test("edge dragging scrolls the history and respects the 100 message limit", async ({ page }) => {
  const scope = await prepare(page, 1366, 130);
  const list = scope.getByRole("log");
  const start = await blankPoint(scope, "selection-129");
  const bounds = (await list.boundingBox())!;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, bounds.y + 2, { steps: 20 });
  // Entering selection removes the pinned banner; use the resulting list edge.
  await expect(scope).toHaveClass(/is-selecting-messages/);
  const selectionBounds = (await list.boundingBox())!;
  await page.mouse.move(start.x, selectionBounds.y + 2, { steps: 4 });
  await expect(scope.getByText("已选择 100 条", { exact: true })).toBeVisible({ timeout: 15000 });
  await page.mouse.up();
  await expect(scope.getByText("已选择 100 条", { exact: true })).toBeVisible();
  const top = await list.evaluate(element => element.scrollTop);
  await page.keyboard.press("Escape");
  await expect(scope.getByRole("toolbar")).toHaveCount(0);
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(top);
});

test("touch scrolling and image dragging do not enter message selection", async ({ page }) => {
  const scope = await prepare(page);
  const start = await blankPoint(scope, "selection-0");
  const end = await blankPoint(scope, "selection-3");
  await scope.getByRole("log").dispatchEvent("pointerdown", { pointerId: 30, pointerType: "touch", button: 0, buttons: 1, clientX: start.x, clientY: start.y });
  await scope.getByRole("log").dispatchEvent("pointermove", { pointerId: 30, pointerType: "touch", button: 0, buttons: 1, clientX: end.x, clientY: end.y });
  await scope.getByRole("log").dispatchEvent("pointerup", { pointerId: 30, pointerType: "touch", button: 0, buttons: 0, clientX: end.x, clientY: end.y });
  await expect(scope.getByRole("toolbar")).toHaveCount(0);
  await page.evaluate(async path => {
    const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    telegramStore.setState({ messages: new Map(state.messages).set("chat-product", state.messages.get("chat-product")!.map((message, index) => index ? message : {
      ...message, content: { kind: "media", mediaType: "photo", fileId: 99001, fileName: "image.jpg", sizeLabel: "1 KB",
        width: 120, height: 60, localPath: "/mock-video-poster.jpg", previewDataUrl: "/mock-video-poster.jpg", isDownloaded: true },
    })) });
  }, storePath);
  const shell = scope.locator('[data-message-id="selection-0"] .message-bubble-shell');
  await expect(shell).toBeVisible();
  await settle(scope);
  const bounds = (await shell.boundingBox())!;
  const target = await blankPoint(scope, "selection-3");
  await page.mouse.move(bounds.x + 20, bounds.y + 20);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await page.mouse.up();
  await expect(scope.getByRole("toolbar")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("failed permission reads can retry without losing selection", async ({ page }) => {
  const scope = await prepare(page);
  await page.evaluate(async path => {
    const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const load = state.loadMessageProperties;
    const failed = new Set<string>();
    telegramStore.setState({
      messages: new Map(state.messages).set("chat-product", state.messages.get("chat-product")!.map(message => ({ ...message, permissions: undefined }))),
      loadMessageProperties: async (chat, id, ...rest) => {
        if (!failed.has(id)) { failed.add(id); return undefined; }
        return load(chat, id, ...rest);
      },
    });
  }, storePath);
  await dragRows(page, scope, "selection-0", "selection-1");
  await expect(scope.locator(".message-row.is-selected")).toHaveCount(2);
  await expect(scope.getByRole("button", { name: "删除已选消息" })).toBeDisabled();
  await scope.getByRole("toolbar").getByRole("button", { name: "重试", exact: true }).click();
  await expect(scope.getByRole("button", { name: "删除已选消息" })).toBeEnabled();
  await expect(scope.locator(".message-row.is-selected")).toHaveCount(2);
});

test("late permission responses cannot restore cancelled or replacement selections", async ({ page }) => {
  const scope = await prepare(page);
  await page.evaluate(async path => {
    const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const load = state.loadMessageProperties;
    const finishes: Array<() => void> = [];
    Object.assign(globalThis, { finishSelectionPermissions: () => finishes.forEach(finish => finish()) });
    telegramStore.setState({
      messages: new Map(state.messages).set("chat-product", state.messages.get("chat-product")!.map(message => ({ ...message, permissions: undefined }))),
      loadMessageProperties: (chat, id, ...rest) => new Promise(resolve => {
        finishes.push(() => { void load(chat, id, ...rest).then(resolve); });
      }),
    });
  }, storePath);
  await dragRows(page, scope, "selection-0", "selection-1");
  await expect(scope.locator(".message-row.is-selected")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await page.evaluate(() => (globalThis as typeof globalThis & { finishSelectionPermissions: () => void }).finishSelectionPermissions());
  await expect(scope.getByRole("toolbar")).toHaveCount(0);
  await expect(scope.getByRole("textbox", { name: "消息内容" })).toBeVisible();
});

test("zoomed whitespace dragging preserves the two-message threshold", async ({ page }) => {
  const scope = await prepare(page);
  await page.locator("html").evaluate(element => { element.style.zoom = "1.25"; });
  await settle(scope);
  await dragRows(page, scope, "selection-0", "selection-1");
  await expect(scope.locator(".message-row.is-selected")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(scope.getByRole("toolbar")).toHaveCount(0);
});

test("service notices do not count toward the two-message threshold", async ({ page }) => {
  const scope = await prepare(page, 1366, 2);
  await page.evaluate(async path => {
    const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const [first, last] = state.messages.get("chat-product")!;
    const service: Message = { ...last, id: "selection-service", sentAt: first.sentAt,
      content: { kind: "service", text: "群组通知" } };
    telegramStore.setState({ messages: new Map(state.messages).set("chat-product", [first, service, last]) });
  }, storePath);
  await settle(scope);
  await dragRows(page, scope, "selection-0", "selection-service");
  await expect(scope.getByRole("toolbar")).toHaveCount(0);
  await dragRows(page, scope, "selection-0", "selection-1");
  await expect(scope.locator(".message-row.is-selected")).toHaveCount(2);
  await expect(scope.locator('[data-message-id="selection-service"]')).not.toHaveClass(/is-selected/);
});
