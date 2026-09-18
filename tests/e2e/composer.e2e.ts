import { expect, test } from "@playwright/test";
import { horizontalOverflow, messageListMetrics, revealVirtualMessage, openConversationMessageSearch, chooseMessageMenuItem } from "./helpers";

test("composer keeps focus, typing status is visible, and previews name the sender", async ({ page }) => {
  await page.goto("/?typing=group");

  const composer = page.getByRole("textbox", { name: "消息内容" });
  const previewSender = page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"] .chat-preview-sender');
  await expect(page.locator(".conversation-header-status")).toHaveText("Jules 正在输入...");
  await expect(page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"] .chat-preview'))
    .toContainText("Jules: 我把交互稿更新到最新版本了");
  await expect(previewSender).toHaveText("Jules:");
  await expect(previewSender).toHaveCSS("color", "rgb(55, 109, 153)");
  await expect(page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"] .chat-preview-sender')).toHaveCount(0);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "notgram-dark";
  });
  await expect(previewSender).toHaveCSS("color", "rgb(120, 167, 200)");

  await composer.fill("发送后继续输入");
  await page.keyboard.press("Enter");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveJSProperty("value", "");
  await composer.fill("第二条消息无需重新点击");
  await page.keyboard.press("Enter");
  await expect(composer).toBeFocused();
  await expect(page.getByText("第二条消息无需重新点击", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /Notgram/ }).click();
  await expect(page.getByRole("switch", { name: "屏蔽 Zalgo 文本" })).toBeChecked();
  const typingSwitch = page.getByRole("switch", { name: "屏蔽输入状态" });
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
      const input = textarea as HTMLElement;
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

test("composer provides recent Emoji, installed stickers, and saved GIFs", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  const composerControls = await page.locator(".composer").evaluate((element) =>
    [...element.children].map((child) => child.getAttribute("aria-label") ?? child.querySelector('[role="textbox"]')?.getAttribute("aria-label") ?? child.tagName));
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
  await expect(composer).toHaveJSProperty("value", "😀");
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
  await stickerSetPreview.getByRole("button", { name: "移除贴纸" }).click();
  await expect(stickerSetPreview).toBeHidden();
  await expect(composer).toBeFocused();

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
  const headerBox = await page.locator(".conversation-header").boundingBox();
  const composerBox = await page.locator(".composer").boundingBox();
  expect(pickerBox!.height).toBeGreaterThan(400);
  expect(pickerBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
  expect(pickerBox!.y + pickerBox!.height).toBeLessThanOrEqual(composerBox!.y);
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

test("stacked reply, attachments and choosers fit a narrow offline composer", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  const composer = page.getByRole("textbox", { name: "消息内容" });
  const source = await revealVirtualMessage(page, "p-2");
  await source.locator(".message-bubble-shell").click({ button: "right" });
  await chooseMessageMenuItem(page, "回复");
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    telegramStore.setState({ connectionStatus: "waitingForNetwork", outbox: [{
      id: "panel-layout-queued", chatId: "chat-product", text: "queued before replying",
      status: "queued", createdAt: new Date().toISOString(),
    }] });
  });
  await expect(page.locator(".composer-outbox-status")).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(Array.from({ length: 10 }, (_, index) => ({
    name: `staged-${index}.txt`, mimeType: "text/plain", buffer: Buffer.from(`attachment ${index}`),
  })));
  await composer.fill(Array.from({ length: 12 }, () => "long attachment caption").join("\n"));
  await page.setViewportSize({ width: 390, height: 660 });
  await expect.poll(() => page.locator(".composer-wrap").evaluate(wrap => {
    const selectors = [".composer-connection-status", ".composer-outbox-status", ".composer-context", ".composer-attachment-preview", ".composer"];
    const boxes = selectors.map(selector => wrap.querySelector(selector)!.getBoundingClientRect());
    const grid = wrap.querySelector<HTMLElement>(".composer-attachment-grid")!;
    const card = grid.querySelector(".composer-attachment-item")!.getBoundingClientRect();
    return boxes[0].top >= 0 && boxes.at(-1)!.bottom <= innerHeight + 1 &&
      boxes.slice(1).every((box, index) => box.top >= boxes[index].bottom - 1) &&
      grid.scrollHeight > grid.clientHeight && card.height > 80 && wrap.scrollWidth <= wrap.clientWidth;
  })).toBe(true);
  await expect(page.getByRole("button", { name: "发送附件", exact: true })).toBeInViewport();

  const panelFits = async (selector: string) => {
    const panel = page.locator(selector);
    await expect(panel).toBeVisible();
    await expect.poll(() => panel.evaluate(element => {
      const scope = element.closest("[data-composer-scope]")!;
      const bounds = element.getBoundingClientRect();
      const header = scope.querySelector(":scope > header")!.getBoundingClientRect();
      const input = scope.querySelector(".composer")!.getBoundingClientRect();
      const root = scope.getBoundingClientRect();
      return bounds.top >= header.bottom && bounds.bottom <= input.top &&
        bounds.left >= root.left && bounds.right <= root.right;
    })).toBe(true);
  };
  await composer.fill("@mia");
  await panelFits(".mention-suggestion-panel");
  await page.getByRole("button", { name: "表情", exact: true }).click();
  await panelFits(".emoji-picker");
  await expect(page.locator(".mention-suggestion-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "关闭表情面板" }).click();
  await panelFits(".mention-suggestion-panel");
  await composer.press("Enter");
  await expect(composer).toHaveJSProperty("value", "@Mia Chen ");
  await expect(page.locator(".composer-attachment-item")).toHaveCount(10);
  await composer.fill("/");
  await panelFits(".bot-suggestion-panel");
  await composer.fill("@notgram_bot release");
  await panelFits(".inline-query-panel");
  await composer.fill(Array.from({ length: 10 }, () => "caption line").join("\n"));
  await page.getByRole("button", { name: "表情", exact: true }).click();
  await panelFits(".emoji-picker");
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

test("chat list shows draft previews only for inactive conversations", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  const productPreview = page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"] .chat-preview');
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

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(productPreview).toHaveClass(/is-draft/);
  await expect(productPreview).toContainText(`草稿：${firstDraft}`);

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(composer).toHaveJSProperty("value", firstDraft);
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

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(productPreview).toContainText(`草稿：${secondDraft}`);

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
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
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
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

  await expect(composer).toHaveJSProperty("value", `${mentionLabel} `);
  const mentionDraft = await composer.evaluate(element => element.textContent ?? "");
  await page.waitForTimeout(250);
  await expect(page.locator(".inline-query-panel")).toHaveCount(0);
  await expect(page.locator(".operation-error")).toHaveCount(0);

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(composer).toHaveJSProperty("value", "");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(composer).toHaveJSProperty("value", mentionDraft);
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { drafts: Map<string, { entities?: Array<{ kind: string; userId?: string }> }> };
      };
    };
    return storeModule.telegramStore.getState().drafts.get("chat-product")?.entities?.[0];
  }, "/src/store/telegramStore.ts")).toMatchObject({ kind: "mentionName", userId: expect.any(String) });

  await composer.fill("");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(composer).toHaveJSProperty("value", "");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(composer).toHaveJSProperty("value", "");
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
  await expect(composer).toHaveJSProperty("value", `${mentionLabel} `);
  await page.getByRole("button", { name: "发送消息" }).click();

  const sentMention = page.locator(".message-row.is-outgoing .message-rich-text a")
    .filter({ hasText: mentionLabel.slice(1) })
    .last();
  await expect(sentMention).toHaveText(mentionLabel.slice(1));
  await sentMention.click();
  await expect(page.getByRole("dialog", { name: "资料" })).toBeVisible();
});

test("mentions use the same bold presentation in the composer and sent message", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.fill("@mia_design");
  await expect(page.getByRole("listbox", { name: "提及成员" }).locator('[data-mention-user-id="u-mia"]')).toBeVisible();
  await composer.press("Control+1");
  await expect(composer).toHaveJSProperty("value", "@Mia Chen ");
  const composerMention = composer.locator('[data-composer-entity="mentionName"]');
  await expect(composerMention).toHaveCSS("font-weight", "700");
  await expect(composerMention.locator(".composer-mention-prefix")).toHaveCount(1);
  await expect(composerMention.locator(".composer-mention-prefix")).toHaveCSS("display", "none");

  await page.getByRole("button", { name: "发送消息" }).click();
  const sentMention = page.locator(".message-row.is-outgoing .message-rich-text a.message-mention").last();
  await expect(sentMention).toHaveText("Mia Chen");
  await expect(sentMention).toHaveCSS("font-weight", "700");
});

test("IME composition defers draft persistence and layout work until commit", async ({ page }) => {
  await page.goto("/");
  const composer = page.locator(".composer .composer-input");
  await expect(composer).toBeVisible();

  const result = await composer.evaluate(async (textarea) => {
    const input = textarea as HTMLElement & { value: string };
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
      input.querySelector("p")!.textContent = value;
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: value,
        inputType: "insertCompositionText",
        isComposing: true,
      }));
      await new Promise(resolve => setTimeout(resolve, 0));
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
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
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

test("mention search excludes cached outsiders and stale recent mentions", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("消息内容")).toBeVisible();
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const mia = state.users.get("u-mia")!;
    const outsider = { ...mia, id: "outside", displayName: "Mia Outsider", username: "mia_outside" };
    const users = new Map(state.users).set(outsider.id, outsider);
    const messages = new Map(state.messages);
    const history = messages.get("chat-product")!;
    messages.set("chat-product", [...history, {
      ...history.at(-1)!, id: "recent-outsider", outgoing: true,
      content: { kind: "text", text: "outside mia", entities: [
        { kind: "mentionName", offset: 0, length: 7, userId: "outside" },
        { kind: "mentionName", offset: 8, length: 3, userId: "u-mia" },
      ] },
    }]);
    telegramStore.setState({ users, messages });
  });
  const composer = page.getByLabel("消息内容");
  const mentions = page.getByRole("listbox", { name: "提及成员" });
  await composer.fill("@mia");
  await expect(mentions.getByRole("option")).toHaveCount(1);
  await expect(mentions.locator('[data-mention-user-id="u-mia"]')).toBeVisible();
  await composer.fill("@");
  await expect(mentions.getByRole("option")).toHaveCount(1);
  await expect(mentions.locator('[data-mention-user-id="u-mia"]')).toBeVisible();
  await composer.press("Control+1");
  await composer.press("Enter");
  await expect(composer).toHaveJSProperty("value", "");
});

for (const scenario of [
  { source: "history", fail: false },
  { source: "search", fail: false },
  { source: "search", fail: true },
] as const) {
  test(`mention search includes this chat's ${scenario.source} authors when the member endpoint is ${scenario.fail ? "unavailable" : "empty"}`, async ({ page }) => {
    await page.goto("/");
    const composer = page.getByLabel("消息内容");
    await expect(composer).toBeVisible();
    await page.evaluate(async ({ source, fail }) => {
      const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
      const state = telegramStore.getState();
      const base = state.users.get("u-mia")!;
      const users = new Map(state.users);
      for (const id of ["hidden-author", "outside", "mention-only"]) {
        users.set(id, { ...base, id, displayName: "Olivia", firstName: "Olivia", username: undefined });
      }
      const messages = new Map(state.messages);
      const history = messages.get("chat-product")!;
      const authorMessage = {
        ...history.at(-1)!, id: "hidden-author-message", chatId: "chat-product", senderId: "hidden-author", outgoing: false,
        content: { kind: "text" as const, text: "Message by this group's author" },
      };
      messages.set("chat-mia", [{ ...authorMessage, chatId: "chat-mia", senderId: "outside" }]);
      messages.set("chat-product", [...history, {
        ...authorMessage, id: "mention-only-message", senderId: "u-mia",
        content: { kind: "text", text: "Olivia", entities: [{ kind: "mentionName", userId: "mention-only", offset: 0, length: 6 }] },
      }, ...(source === "history" ? [authorMessage] : [])]);
      telegramStore.setState({
        users, messages,
        chatMessageSearch: { input: { chatId: "chat-product", query: "" }, messages: source === "search" ? [authorMessage] : [], loading: false, loadingMore: false },
        getChatMentionSuggestions: async () => {
          document.body.dataset.mentionRequested = "1";
          await new Promise<void>((resolve) => Reflect.set(window, "releaseHiddenMemberSearch", resolve));
          document.body.dataset.mentionCompleted = "1";
          if (fail) throw new Error("Member search unavailable");
          return [];
        },
      });
    }, scenario);
    await composer.fill("@olivia");
    await expect(page.locator("body")).toHaveAttribute("data-mention-requested", "1");
    const mentions = page.getByRole("listbox", { name: "提及成员" });
    // Known authors must be available while the member-list request is still pending.
    await expect(mentions.locator('[data-mention-user-id="hidden-author"]')).toBeVisible();
    await expect(mentions.getByRole("option")).toHaveCount(1);
    await page.evaluate(() => Reflect.get(window, "releaseHiddenMemberSearch")());
    await expect(page.locator("body")).toHaveAttribute("data-mention-completed", "1");
    await expect(mentions.locator('[data-mention-user-id="hidden-author"]')).toBeVisible();
    await composer.press("Control+1");
    await composer.press("Enter");
    expect(await page.evaluate(async () => {
      const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
      const last = telegramStore.getState().messages.get("chat-product")!.at(-1)!;
      return last.content.kind === "text" ? last.content.entities : [];
    })).toContainEqual(expect.objectContaining({ kind: "mentionName", userId: "hidden-author" }));
  });
}

test("mention search keeps matching candidates mounted while refining the query", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByLabel("消息内容");
  await expect(composer).toBeVisible();
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const mia = telegramStore.getState().users.get("u-mia")!;
    telegramStore.setState({ getChatMentionSuggestions: async (_chatId, query) => {
      document.body.dataset.mentionRequested = query;
      if (query === "mia") await new Promise<void>((resolve) => Reflect.set(window, "finishMentionQuery", resolve));
      return [mia];
    } });
  });
  await composer.fill("@mi");
  const option = page.locator('[data-mention-user-id="u-mia"]');
  await expect(option).toBeVisible();
  const original = await option.elementHandle();
  await composer.fill("@mia");
  await expect(page.locator("body")).toHaveAttribute("data-mention-requested", "mia");
  const uninterrupted = await original!.evaluate(async (element) => {
    for (let frame = 0; frame < 18; frame += 1) {
      await new Promise(requestAnimationFrame);
      const presence = element.closest(".motion-presence");
      if (!element.isConnected || presence?.hasAttribute("inert") || presence?.getAttribute("data-motion-state") === "exiting") return false;
    }
    return true;
  });
  await page.evaluate(() => Reflect.get(window, "finishMentionQuery")());
  expect(uninterrupted).toBe(true);
  await expect(option).toBeVisible();
  expect(await original!.evaluate((element) => element === document.querySelector('[data-mention-user-id="u-mia"]'))).toBe(true);
  await composer.press("Control+1");
  await expect(composer.locator('[data-composer-entity="mentionName"]')).toHaveCount(1);
});

test("mention search does not restart when the conversation receives messages", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByLabel("消息内容");
  await expect(composer).toBeVisible();
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const mia = telegramStore.getState().users.get("u-mia")!;
    let calls = 0;
    telegramStore.setState({ getChatMentionSuggestions: async () => {
      document.body.dataset.mentionCalls = String(++calls);
      return [mia];
    } });
  });
  await composer.fill("@mia");
  await expect(page.locator('[data-mention-user-id="u-mia"]')).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-mention-calls", "1");
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    for (let index = 0; index < 4; index += 1) {
      const state = telegramStore.getState();
      const messages = new Map(state.messages);
      const history = messages.get("chat-product")!;
      messages.set("chat-product", [...history, {
        ...history.at(-1)!, id: `mention-refresh-${index}`, outgoing: false,
        content: { kind: "text", text: "Incoming message during member search" },
      }]);
      telegramStore.setState({ messages });
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
  });
  await expect(page.locator("body")).toHaveAttribute("data-mention-calls", "1");
  await expect(page.locator('[data-mention-user-id="u-mia"]')).toBeVisible();
});

test("mention search reuses completed queries only within the current completion session", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByLabel("消息内容");
  await expect(composer).toBeVisible();
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const mia = telegramStore.getState().users.get("u-mia")!;
    let calls = 0;
    telegramStore.setState({ getChatMentionSuggestions: async () => {
      document.body.dataset.mentionCalls = String(++calls);
      return [mia];
    } });
  });
  for (const query of ["@mi", "@mia", "@mi"]) {
    await composer.fill(query);
    await expect(page.locator('[data-mention-user-id="u-mia"]')).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 180)));
  }
  await expect(page.locator("body")).toHaveAttribute("data-mention-calls", "2");
  await composer.fill("");
  await expect(page.getByRole("listbox", { name: "提及成员" })).toHaveCount(0);
  await composer.fill("@mi");
  await expect(page.locator("body")).toHaveAttribute("data-mention-calls", "3");
});

test("mention search ignores late queries and clears suggestions on failure", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("消息内容")).toBeVisible();
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const users = telegramStore.getState().users;
    telegramStore.setState({ getChatMentionSuggestions: async (_chatId, query) => {
      document.body.dataset.mentionRequested = query;
      if (query === "mia") {
        delete document.body.dataset.mentionCompleted;
        await new Promise((resolve) => setTimeout(resolve, 700));
        document.body.dataset.mentionCompleted = query;
        return [users.get("u-mia")!];
      }
      if (query === "fail") throw new Error("Unavailable");
      return [users.get("u-chen")!];
    } });
  });
  const composer = page.getByLabel("消息内容");
  const mentions = page.getByRole("listbox", { name: "提及成员" });
  await composer.fill("@mia");
  await expect(page.locator("body")).toHaveAttribute("data-mention-requested", "mia");
  await composer.fill("@陈");
  await expect(mentions.locator('[data-mention-user-id="u-chen"]')).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-mention-completed", "mia");
  await expect(mentions.locator('[data-mention-user-id="u-mia"]')).toHaveCount(0);
  await composer.fill("@fail");
  await expect(page.locator("body")).toHaveAttribute("data-mention-requested", "fail");
  await expect(mentions).toHaveCount(0);
  await composer.fill("@mia");
  await expect(page.locator("body")).toHaveAttribute("data-mention-requested", "mia");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(composer).toHaveJSProperty("value", "");
  await expect(page.locator("body")).toHaveAttribute("data-mention-completed", "mia");
  await expect(mentions).toHaveCount(0);
});

test("discussion mention search uses the linked conversation", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set("chat-release", messages.get("chat-release")!.map((message) => message.id === "release-post-1"
      ? { ...message, discussionThread: { chatId: "chat-product", messageId: "discussion-root" } }
      : message));
    telegramStore.setState({ messages, loadMessageThreadHistory: async () => undefined });
  });
  await page.locator('[data-message-id="release-post-1"]').getByRole("button", { name: "2 条评论" }).click();
  const panel = page.locator(".channel-discussion-panel");
  const composer = panel.getByLabel("消息内容");
  await expect(composer).toBeVisible();
  const discussionChatId = await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const original = state.getChatMentionSuggestions;
    telegramStore.setState({ getChatMentionSuggestions: async (chatId, query, recent) => {
      document.body.dataset.mentionChatId = chatId;
      return original(chatId, query, recent);
    } });
    return state.messages.get("chat-release")!.find((message) => message.id === "release-post-1")!.discussionThread!.chatId;
  });
  await composer.fill("@mia");
  await expect(page.locator("body")).toHaveAttribute("data-mention-chat-id", discussionChatId);
  expect(discussionChatId).not.toBe("chat-release");
  await expect(panel.locator('[data-mention-user-id="u-mia"]')).toBeVisible();
});

test("suggests group members for @ mentions without invoking inline bots", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByLabel("消息内容");
  const mentions = page.getByRole("listbox", { name: "提及成员" });

  await composer.fill("@");
  await expect(mentions).toHaveCount(0);
  await composer.fill("@mia_design");
  await expect(mentions.locator('[data-mention-user-id="u-mia"]')).toBeVisible();
  await composer.press("Control+1");
  await expect(composer).toHaveJSProperty("value", "@Mia Chen ");
  await expect.poll(async () => page.evaluate(async () => {
    const module = await (0, eval)('import("/src/store/telegramStore.ts")') as {
      telegramStore: {
        getState: () => { drafts: Map<string, { entities?: Array<{ kind: string; userId?: string }> }> };
      };
    };
    return module.telegramStore.getState().drafts.get("chat-product")?.entities?.[0];
  })).toMatchObject({ kind: "mentionName", userId: "u-mia" });
  await composer.press("Enter");
  await expect(composer).toHaveJSProperty("value", "");

  await composer.fill("@陈");
  await expect(mentions.locator('[data-mention-user-id="u-chen"]')).toBeVisible();
  await composer.press("Control+1");
  await composer.press("Enter");
  await composer.fill("@mia");
  await expect(mentions.locator('[data-mention-user-id="u-mia"]')).toBeVisible();
  await composer.press("Control+1");
  await composer.press("Enter");

  await composer.fill("@");
  await expect(mentions.getByRole("option")).toHaveCount(2);
  await expect(mentions.locator(".avatar")).toHaveCount(2);
  await expect(mentions.getByRole("option").nth(0)).toContainText("Mia Chen");
  await expect(mentions.getByRole("option").nth(0)).toContainText("@mia_design");
  await expect(mentions.getByRole("option").nth(1)).toContainText("陈默");
  await composer.press("ArrowDown");
  await expect(mentions.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");

  await composer.fill("@MIA_DESIGN ");
  await expect(mentions).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Inline 查询结果" })).toHaveCount(0);

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await composer.fill("@mia");
  await expect(mentions).toHaveCount(0);
});

test("chat switching and ordinary message interactions keep typing focus in the composer", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await expect(composer).toBeFocused();

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(composer).toBeFocused();
  await page.locator('[data-message-id="m-3"] .message-rich-text').click();
  await expect(composer).toBeFocused();

  await openConversationMessageSearch(page);
  await expect(page.getByRole("searchbox", { name: "搜索会话和消息" })).toBeFocused();
  await expect(page.getByRole("group", { name: "搜索范围：Mia Chen" })).toBeVisible();
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

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator(".composer-context.is-replying")).toHaveCount(0);
  await expect(composer).toHaveJSProperty("value", "取消回复后仍是普通草稿");
  await page.getByRole("button", { name: "发送消息" }).click();
  const sent = page.locator(
    '.message-row.is-outgoing',
    { hasText: "取消回复后仍是普通草稿" },
  ).last();
  await expect(sent).toBeVisible();
  await expect(sent.locator(".message-reply-preview")).toHaveCount(0);
});
