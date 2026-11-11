import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Message } from "../../src/telegram/types";

const captionText = "首字起可以复制相册说明\n第二行保留完整文本";

async function settle(scope: Locator) {
  await scope.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).filter(animation =>
      animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)));
  });
}

async function prepare(page: Page, width: number, channel = false, above = false, photosOnly = false) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  const chatId = channel ? "chat-release" : "chat-product";
  await page.locator(`.chat-list[data-active=true] [data-chat-id="${chatId}"]`).click();
  const scope = page.locator(".conversation");
  await expect(scope.getByRole("log")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async ({ chatId, channel, above, photosOnly, captionText, storePath, mockPath }) => {
    const { telegramStore } = await import(storePath) as typeof import("../../src/store/telegramStore");
    const { MockTelegramTransport } = await import(mockPath) as typeof import("../../src/telegram/mockTransport");
    const state = telegramStore.getState();
    const source = state.messages.get(chatId)![0];
    const permissions = { canReply: true, canEdit: false, canForward: true, canSave: true,
      canDeleteOnlyForSelf: true, canDeleteForAllUsers: true };
    const preview = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#647d90"/></svg>');
    const messages: Message[] = Array.from({ length: 5 }, (_, index) => ({
      ...source, id: `album-selection-${index}`, renderKey: `album-selection-${index}`,
      chatId, outgoing: false, senderId: "u-mia", isChannelPost: channel,
      mediaAlbumId: index > 0 && index < 4 ? "selection-album" : undefined,
      replyToMessageId: undefined, replyQuote: undefined, replyMarkup: undefined,
      forwardInfo: undefined, interaction: undefined, canSave: true, permissions,
      sentAt: new Date(Date.now() - (5 - index) * 1000).toISOString(),
      content: index === 0 || index === 4 ? { kind: "text", text: `相册外的消息 ${index}` } : {
        kind: "media", mediaType: index === 2 && !photosOnly ? "video" : "photo", fileName: `selection-${index}.jpg`,
        sizeLabel: "1 KB", width: 240, height: 120, previewDataUrl: preview,
        caption: index === (photosOnly ? 1 : 3) ? captionText : undefined, showCaptionAboveMedia: above,
        hasSpoiler: index === 1 && !photosOnly,
      },
    }));
    MockTelegramTransport.prototype.getMessageProperties = async () => permissions;
    telegramStore.setState({ messages: new Map(state.messages).set(chatId, messages) });
  }, { chatId, channel, above, photosOnly, captionText, storePath: "/src/store/telegramStore.ts", mockPath: "/src/telegram/mockTransport.ts" });
  const album = scope.locator('[data-media-album-id="selection-album"]');
  await expect(album.locator(".message-row")).toHaveCount(3);
  await expect(album.locator(".message-rich-text")).toHaveText(captionText);
  await settle(scope);
  return { scope, album };
}

async function gutter(scope: Locator, item: Locator, fraction = 0.5) {
  const list = (await scope.getByRole("log").boundingBox())!;
  const bounds = (await item.boundingBox())!;
  return { x: list.x + list.width - 22, y: bounds.y + bounds.height * fraction };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

async function enterSelection(scope: Locator) {
  await scope.locator(".conversation-header").getByRole("button", { name: "更多操作", exact: true }).click();
  await scope.getByRole("menuitem", { name: "多选", exact: true }).click();
  await expect(scope.getByRole("toolbar")).toBeVisible();
  await settle(scope);
}

test("discussion photos separate image copying from the album caption", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await page.evaluate(async ({ storePath, captionText }) => {
    const { telegramStore } = await import(storePath) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const channelMessages = state.messages.get("chat-release")!;
    const post = channelMessages.find(message => message.id === "release-post-1")!;
    const chatId = "chat-release-discussion";
    const root: Message = { ...post, id: "copy-root", chatId, isChannelPost: false, discussionThread: undefined };
    const permissions = { canReply: true, canEdit: false, canForward: true, canSave: true,
      canDeleteOnlyForSelf: true, canDeleteForAllUsers: false };
    const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 16;
    canvas.getContext("2d")!.fillRect(0, 0, 32, 16);
    const comments: Message[] = [0, 1].map(index => ({
      ...root, id: `discussion-copy-${index}`, renderKey: `discussion-copy-${index}`, senderId: "u-mia", outgoing: false,
      mediaAlbumId: "discussion-copy-album", canSave: true, permissions,
      replyTo: { kind: "message", chatId, messageId: root.id },
      content: { kind: "media", mediaType: "photo", fileName: `${index}.png`, sizeLabel: "1 KB", width: 32, height: 16,
        previewDataUrl: canvas.toDataURL(), caption: index === 0 ? captionText : undefined },
    }));
    const messages = new Map(state.messages).set(chatId, [root, ...comments]);
    messages.set("chat-release", channelMessages.map(message => message.id === post.id
      ? { ...message, discussionThread: { chatId, messageId: root.id } } : message));
    telegramStore.setState({ messages,
      loadMessageThreadHistory: async () => ({ chatId, messageId: root.id, messages: [root, ...comments], hasMore: false }),
      loadMessageProperties: async () => permissions,
    });
  }, { storePath: "/src/store/telegramStore.ts", captionText });
  await page.locator('[data-message-id="release-post-1"] .channel-post-discussion').click();
  const panel = page.locator(".channel-discussion-panel");
  const menu = page.getByRole("menu", { name: "消息操作", exact: true });
  for (let index = 0; index <= 1; index++) {
    const photo = panel.locator(`[data-message-id="discussion-copy-${index}"] .message-bubble-shell`);
    await photo.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "复制图片", exact: true }).click();
    await expect(menu).toBeHidden();
    expect(await page.evaluate(async () => (await navigator.clipboard.read())[0].types)).toEqual(["image/png"]);
    await photo.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "复制文本", exact: true }).click();
    await expect(menu).toBeHidden();
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(captionText);
  }
});

for (const width of [1366, 390]) {
  for (const channel of [false, true]) {
    test(`album copy separates every image from its shared caption (${width}, channel=${channel})`, async ({ page, context }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const { album } = await prepare(page, width, channel, false, true);
      const menu = page.getByRole("menu", { name: "消息操作", exact: true });
      for (let index = 1; index <= 3; index++) {
        const tile = album.locator(`[data-message-id="album-selection-${index}"] .message-bubble-shell`);
        await tile.click({ button: "right" });
        await menu.getByRole("menuitem", { name: "复制图片", exact: true }).click();
        await expect(menu).toBeHidden();
        expect(await page.evaluate(async () => {
          const [item] = await navigator.clipboard.read();
          const image = await createImageBitmap(await item.getType("image/png"));
          const result = { types: item.types, width: image.width, height: image.height };
          image.close(); return result;
        })).toEqual({ types: ["image/png"], width: 240, height: 120 });
        await tile.focus();
        await page.keyboard.press("Shift+F10");
        await menu.getByRole("menuitem", { name: "复制文本", exact: true }).click();
        await expect(menu).toBeHidden();
        expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(captionText);
      }
      await album.locator(".media-album-caption").click({ button: "right" });
      await menu.getByRole("menuitem", { name: "复制文本", exact: true }).click();
      expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(captionText);
    });
  }

  for (const channel of [false, true]) {
    test(`album caption retains native selection, padding and clipboard (${width}, channel=${channel})`, async ({ page, context }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const { scope, album } = await prepare(page, width, channel, channel);
      if (width === 390) {
        await page.locator("html").evaluate(element => { element.style.zoom = "1.25"; });
      }
      const surface = album.locator(".message-rich-text");
      await surface.scrollIntoViewIfNeeded();
      await settle(scope);
      for (const padding of [false, true]) {
        const points = await surface.evaluate((element, padding) => {
          const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
          const first = document.createRange(); first.setStart(node, 0); first.setEnd(node, 1);
          const last = document.createRange(); last.setStart(node, 6); last.setEnd(node, 7);
          const start = first.getBoundingClientRect(); const end = last.getBoundingClientRect();
          return { from: { x: start.left + (padding ? -2 : 1), y: start.top + start.height / 2 },
            to: { x: end.right, y: end.top + end.height / 2 } };
        }, padding);
        await drag(page, points.from, points.to);
        await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(captionText.slice(0, 7));
        await expect(scope.getByRole("toolbar")).toHaveCount(0);
        await page.keyboard.press("Control+c");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(captionText.slice(0, 7));
        await page.evaluate(() => getSelection()?.removeAllRanges());
      }
      await expect(album.locator(".message-row")).toHaveCount(3);
    });
  }

  test(`blank ranges keep album nodes, geometry and complete endpoints (${width})`, async ({ page }) => {
    const { scope, album } = await prepare(page, width);
    const original = await album.elementHandle();
    const sizes = await album.locator(".media-album-tile").evaluateAll(elements => elements.map(element => {
      const bounds = element.getBoundingClientRect(); return [bounds.width, bounds.height];
    }));
    // Three media items form one visible group, so dragging within its gutter is not a range.
    await drag(page, await gutter(scope, album, 0.2), await gutter(scope, album, 0.8));
    await expect(scope.getByRole("toolbar")).toHaveCount(0);
    const first = scope.locator('[data-message-id="album-selection-0"]');
    await drag(page, await gutter(scope, first), await gutter(scope, album, 0.8));
    await expect(scope.locator(".message-row.is-selected")).toHaveCount(4);
    await expect(album).toHaveClass(/is-selected/);
    expect(await album.evaluate((element, original) => element === original, original)).toBe(true);
    const selectedSizes = await album.locator(".media-album-tile").evaluateAll(elements => elements.map(element => {
      const bounds = element.getBoundingClientRect(); return [bounds.width, bounds.height];
    }));
    expect(selectedSizes).toEqual(sizes);
    const last = scope.locator('[data-message-id="album-selection-4"]');
    await page.keyboard.press("Escape");
    await settle(scope);
    await drag(page, await gutter(scope, last), await gutter(scope, album, 0.2));
    await expect(scope.locator(".message-row.is-selected")).toHaveCount(4);
    await expect(album).toHaveClass(/is-selected/);
    await expect(first).not.toHaveClass(/is-selected/);
    await page.screenshot({ path: `test-results/album-selection-range-${width}.png` });
  });

  test(`tiles toggle independently while shared areas toggle the album (${width})`, async ({ page }) => {
    const { scope, album } = await prepare(page, width);
    await enterSelection(scope);
    await expect(album).toBeVisible();
    const photo = album.locator('[data-message-id="album-selection-3"]');
    const video = album.locator('[data-message-id="album-selection-2"]');
    const spoiler = album.locator('[data-message-id="album-selection-1"]');
    await photo.locator(".photo-preview").click();
    await expect(photo).toHaveClass(/is-selected/);
    await expect(album).toHaveClass(/is-partially-selected/);
    await video.locator(".video-preview").click();
    await expect(video).toHaveClass(/is-selected/);
    await spoiler.locator(".photo-preview").click();
    await expect(spoiler).toHaveClass(/is-selected/);
    await expect(album).toHaveClass(/is-selected/);
    await expect(page.locator(".media-viewer")).toHaveCount(0);
    expect(page.context().pages()).toHaveLength(1);
    await expect(spoiler.locator(".media-spoiler")).not.toHaveClass(/is-revealed/);
    await video.locator(".video-preview").click();
    await expect(video).not.toHaveClass(/is-selected/);
    const caption = album.locator(".media-album-caption");
    await caption.click();
    await expect(album.locator(".message-row.is-selected")).toHaveCount(3);
    await caption.click();
    await expect(album.locator(".message-row.is-selected")).toHaveCount(0);
    await album.focus(); await page.keyboard.press("Space");
    await expect(album.locator(".message-row.is-selected")).toHaveCount(3);
    await photo.locator(".message-bubble-shell").focus(); await page.keyboard.press("Enter");
    await expect(album.locator(".message-row.is-selected")).toHaveCount(2);
    await page.screenshot({ path: `test-results/album-selection-partial-${width}.png` });
    await page.evaluate(async path => {
      const { preferencesStore } = await import(path) as typeof import("../../src/store/preferencesStore");
      preferencesStore.setState({ themeId: "notgram-dark" });
    }, "/src/store/preferencesStore.ts");
    await settle(scope);
    await expect(album.locator(".message-row.is-selected")).toHaveCount(2);
    await page.screenshot({ path: `test-results/album-selection-dark-${width}.png` });
    await page.emulateMedia({ forcedColors: "active" });
    await page.screenshot({ path: `test-results/album-selection-forced-colors-${width}.png` });
    await page.keyboard.press("Escape");
    await expect(album.locator(".message-row")).toHaveCount(3);
    await expect(scope.getByRole("toolbar")).toHaveCount(0);
  });
}
