import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const input = (page: Page) => page.getByRole("textbox", { name: "消息内容" });
const tray = (page: Page) => page.getByRole("region", { name: "待发送附件" });
const placeholders = (page: Page) => page.locator(".composer-attachment-placeholder");
const dispatchFiles = (target: Locator, type: string, count = 1, protectedData = false) =>
  target.evaluate((element, { type, count, protectedData }) => {
    const data = new DataTransfer();
    for (let index = 0; index < count; index += 1) {
      data.items.add(new File(["dragged document"], `dropped-${index}.txt`, { type: "text/plain" }));
    }
    if (protectedData) {
      Object.defineProperty(data, "files", { get: () => [] });
      for (const item of data.items) Object.defineProperty(item, "getAsFile", { value: () => null });
    }
    const bounds = element.getBoundingClientRect();
    const event = new DragEvent(type, {
      bubbles: true, cancelable: true, dataTransfer: data,
      clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2,
    });
    element.dispatchEvent(event);
    return { prevented: event.defaultPrevented, effect: data.dropEffect };
  }, { type, count, protectedData });
const draftKeys = (page: Page) => page.evaluate(async () => {
  const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
  return [...telegramStore.getState().localAttachmentDrafts.keys()];
});

test("browser-delivered file drags keep protected data unread until drop", async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), "notgram-conversation-drop-"));
  const paths = [join(directory, "browser-first.txt"), join(directory, "browser-second.txt")];
  try {
    await Promise.all(paths.map(path => writeFile(path, "browser drag attachment")));
    await page.goto("/");
    await expect(page.locator(".message-list-shell")).not.toHaveAttribute("inert");
    await page.evaluate(() => {
      const samples: { type: string; files: number; items: number }[] = [];
      (window as unknown as { dragSamples: typeof samples }).dragSamples = samples;
      for (const type of ["dragenter", "dragover", "drop"]) document.addEventListener(type, event => {
        const data = (event as DragEvent).dataTransfer;
        if (data) samples.push({ type, files: data.files.length, items: data.items.length });
      }, true);
    });
    const bounds = await page.locator(".message-list-shell").boundingBox();
    const session = await page.context().newCDPSession(page);
    const position = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
    const data = { items: [], files: paths, dragOperationsMask: 1 };
    await session.send("Input.dispatchDragEvent", { type: "dragEnter", ...position, data });
    await session.send("Input.dispatchDragEvent", { type: "dragOver", ...position, data });
    await expect(tray(page)).toHaveCount(0);
    expect(await draftKeys(page)).toEqual([]);
    await session.send("Input.dispatchDragEvent", { type: "drop", ...position, data });
    await expect(tray(page).locator("article")).toHaveCount(2);
    await expect(tray(page).getByText("browser-first.txt", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { dragSamples: { type: string; files: number; items: number }[] }).dragSamples))
      .toEqual(expect.arrayContaining([
        { type: "dragenter", files: 0, items: 2 },
        { type: "drop", files: 2, items: 2 },
      ]));
    await session.detach();
  } finally {
    await Promise.allSettled(paths.map(path => unlink(path)));
    await rmdir(directory);
  }
});

for (const width of [1366, 390]) {
  test(`browser-delivered drops inside the expanded staging tray retain attachments at ${width}px`, async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), "notgram-staging-drop-"));
    const path = join(directory, "tray-image.png");
    try {
      await writeFile(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
      await page.setViewportSize({ width, height: 768 });
      await page.goto("/");
      if (width === 390) await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
      await page.locator('input[type="file"]').setInputFiles({ name: "existing.txt", mimeType: "text/plain", buffer: Buffer.from("existing") });
      await expect(tray(page).locator("article")).toHaveCount(1);
      await input(page).fill("retain this caption");
      await expect(input(page)).toBeFocused();
      const session = await page.context().newCDPSession(page);
      const data = { items: [], files: [path], dragOperationsMask: 1 };
      const surface = await page.locator(".message-list-shell").boundingBox();
      await session.send("Input.dispatchDragEvent", {
        type: "dragEnter", x: surface!.x + surface!.width / 2, y: surface!.y + surface!.height / 2, data,
      });
      await expect(placeholders(page)).toHaveCount(1);
      const slot = await placeholders(page).locator(".composer-attachment-open").boundingBox();
      const position = { x: slot!.x + slot!.width / 2, y: slot!.y + slot!.height / 2 };
      await session.send("Input.dispatchDragEvent", { type: "dragOver", ...position, data });
      await expect(placeholders(page)).toHaveCount(1);
      expect(await draftKeys(page)).toEqual(["chat-product"]);
      await session.send("Input.dispatchDragEvent", { type: "drop", ...position, data });
      await expect(tray(page)).toBeVisible();
      await expect(placeholders(page)).toHaveCount(0);
      await expect(tray(page).getByText("tray-image.png", { exact: true })).toBeVisible();
      await expect.poll(() => draftKeys(page)).toEqual(["chat-product"]);
      await expect(input(page)).toHaveJSProperty("value", "retain this caption");
      await expect(input(page)).toBeFocused();
      await expect.poll(() => page.evaluate(() => {
        const snapshot = JSON.parse(localStorage.getItem("notgram:ui-cache:v1") ?? "null");
        return snapshot?.drafts.find((draft: { chatId: string }) => draft.chatId === "chat-product")?.text;
      }), { timeout: 15_000 }).toBe("retain this caption");
      await page.reload();
      if (width === 390) await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
      await expect(tray(page).getByText("tray-image.png", { exact: true })).toBeVisible();
      await expect(input(page)).toHaveJSProperty("value", "retain this caption");
      await session.detach();
    } finally {
      await unlink(path);
      await rmdir(directory);
    }
  });
}

for (const layout of [
  { width: 1366, height: 768, scale: 100, theme: "notgram-light" },
  { width: 390, height: 660, scale: 100, theme: "notgram-dark" },
  { width: 1024, height: 768, scale: 125, theme: "notgram-light" },
] as const) {
  test(`first file drags preserve the composer layout until release at ${layout.width}px/${layout.scale}%`, async ({ page }) => {
    await page.setViewportSize(layout);
    await page.goto("/");
    if (layout.width === 390) await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
    await page.evaluate(async ({ scale, theme }) => {
      const { preferencesStore } = await (0, eval)('import("/src/store/preferencesStore.ts")') as typeof import("../../src/store/preferencesStore");
      preferencesStore.getState().setPreference("interfaceScale", scale);
      preferencesStore.getState().setPreference("themeId", theme);
    }, layout);
    await input(page).evaluate(async element => {
      const animations: Animation[] = [];
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        animations.push(...ancestor.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity));
      }
      await Promise.allSettled(animations.map(animation => animation.finished));
    });
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    await input(page).fill("keep this caption");
    await input(page).evaluate(element => {
      (element as import("../../src/components/ComposerInput").ComposerInputElement).setSelectionRange(5, 5);
    });
    const original = await input(page).boundingBox();
    const surface = page.locator(".message-list-shell");
    await expect(surface).not.toHaveAttribute("inert");
    expect((await dispatchFiles(surface, "dragenter", 1, true)).prevented).toBe(true);
    await expect(tray(page)).toHaveCount(0);
    await expect(page.locator(".composer-wrap")).toHaveClass(/is-file-drop-target/);
    expect(await draftKeys(page)).toEqual([]);
    await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveJSProperty("value", "keep this caption");
    expect(await input(page).evaluate(element => (element as import("../../src/components/ComposerInput").ComposerInputElement).selectionStart)).toBe(5);
    const hoveredInput = await input(page).boundingBox();
    expect(hoveredInput!.y).toBeCloseTo(original!.y, 0);
    expect(hoveredInput!.height).toBeCloseTo(original!.height, 0);
    const hoveredSurface = await surface.boundingBox();
    await page.screenshot({ path: test.info().outputPath("first-file-hover.png") });
    await dispatchFiles(surface, "drop");
    await expect(placeholders(page)).toHaveCount(0);
    await expect(tray(page).getByText("dropped-0.txt", { exact: true })).toBeVisible();
    expect((await surface.boundingBox())!.height).toBeLessThan(hoveredSurface!.height);
    await expect.poll(() => draftKeys(page)).toEqual(["chat-product"]);
    await expect(input(page)).toHaveJSProperty("value", "keep this caption");
    await expect(input(page)).toBeFocused();
  });
}

test("existing attachments append multiple reserved slots and cancellation keeps the draft", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({ name: "existing.txt", mimeType: "text/plain", buffer: Buffer.from("existing") });
  await expect(tray(page).locator("article")).toHaveCount(1);
  const existing = await tray(page).locator("article").boundingBox();
  const surface = page.locator(".message-list-shell");
  await dispatchFiles(surface, "dragover", 2, true);
  await expect(placeholders(page)).toHaveCount(2);
  const reserved = await Promise.all([placeholders(page).nth(0).boundingBox(), placeholders(page).nth(1).boundingBox()]);
  await dispatchFiles(input(page), "dragenter", 2, true);
  await surface.evaluate(element => element.dispatchEvent(new DragEvent("dragleave", {
    bubbles: true, relatedTarget: document.querySelector(".composer-input"),
  })));
  await expect(placeholders(page)).toHaveCount(2);
  await dispatchFiles(placeholders(page).last().locator("small"), "drop", 2);
  await expect(tray(page).locator("article")).toHaveCount(3);
  await dispatchFiles(surface, "dragenter", 1, true);
  await page.keyboard.press("Escape");
  await expect(placeholders(page)).toHaveCount(0);
  await expect(tray(page).locator("article")).toHaveCount(3);
  for (let index = 0; index < 2; index += 1) {
    const bounds = await tray(page).locator("article").nth(index + 1).boundingBox();
    for (const dimension of ["x", "y", "width", "height"] as const) expect(bounds![dimension]).toBeCloseTo(reserved[index]![dimension], 0);
  }
  const originalCard = await tray(page).locator("article").first().boundingBox();
  expect(originalCard!.x).toBe(existing!.x);
  await dispatchFiles(surface, "dragenter", 1, true);
  await page.locator(".chat-list").filter({ visible: true }).first().dispatchEvent("dragenter");
  await expect(placeholders(page)).toHaveCount(0);
  await expect(tray(page).locator("article")).toHaveCount(3);
  await dispatchFiles(surface, "dragenter", 1, true);
  await page.evaluate(() => window.dispatchEvent(new Event("dragend")));
  await expect(placeholders(page)).toHaveCount(0);
  await expect(tray(page).locator("article")).toHaveCount(3);
  await dispatchFiles(surface, "dragenter", 1, true);
  await dispatchFiles(page.locator(".chat-list").filter({ visible: true }).first(), "drop");
  await expect(placeholders(page)).toHaveCount(0);
  await expect(tray(page).locator("article")).toHaveCount(3);
});

test("a multiline caption retains its layout until the first file is dropped", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list-shell")).not.toHaveAttribute("inert");
  const caption = Array.from({ length: 20 }, (_, index) => `caption line ${index}`).join("\n");
  await input(page).fill(caption);
  await dispatchFiles(page.locator(".message-list-shell"), "dragenter", 1, true);
  await expect(tray(page)).toHaveCount(0);
  const editor = await input(page).boundingBox();
  await dispatchFiles(page.locator(".message-list-shell"), "drop");
  await expect(tray(page).locator("article")).toHaveCount(1);
  expect((await input(page).boundingBox())!.height).toBeLessThanOrEqual(editor!.height);
  await expect(input(page)).toHaveJSProperty("value", caption);
});

test("drag exit, Escape and chat switches leave no phantom attachment drafts", async ({ page }) => {
  await page.goto("/");
  const surface = page.locator(".message-list-shell");
  await dispatchFiles(surface, "dragenter", 1, true);
  await surface.evaluate(element => element.dispatchEvent(new DragEvent("dragleave", {
    bubbles: true, clientX: -10, clientY: -10,
  })));
  await expect(tray(page)).toHaveCount(0);
  await dispatchFiles(surface, "dragenter", 1, true);
  await page.keyboard.press("Escape");
  await expect(tray(page)).toHaveCount(0);
  await dispatchFiles(surface, "dragenter", 1, true);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(tray(page)).toHaveCount(0);
  await expect(surface).not.toHaveAttribute("inert");
  await dispatchFiles(surface, "drop");
  await expect(tray(page).getByText("dropped-0.txt")).toBeVisible();
  await expect.poll(() => draftKeys(page)).toEqual(["chat-mia"]);
});

test("text drags and file drops while editing or behind a modal never add attachments", async ({ page }) => {
  await page.goto("/");
  const surface = page.locator(".message-list-shell");
  expect(await surface.evaluate(element => {
    const data = new DataTransfer(); data.setData("text/plain", "dragged text");
    return element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: data }));
  })).toBe(true);
  await expect(tray(page)).toHaveCount(0);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await input(page).fill("editable attachment regression");
  await input(page).press("Enter");
  await expect(page.locator(".message-row.is-outgoing").filter({ hasText: "editable attachment regression" })).toBeVisible();
  await input(page).press("Control+r");
  await expect(page.getByRole("button", { name: "取消编辑" })).toBeVisible();
  expect(await dispatchFiles(surface, "dragenter")).toEqual({ prevented: true, effect: "none" });
  await dispatchFiles(input(page), "drop");
  await expect(tray(page)).toHaveCount(0);
  await page.getByRole("button", { name: "取消编辑" }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await dispatchFiles(surface, "dragenter");
  await dispatchFiles(surface, "drop");
  expect(await draftKeys(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(tray(page)).toHaveCount(0);
});

test("reserved slots respect the attachment cap and remain visible in a scrollable tray", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 450 });
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(Array.from({ length: 9 }, (_, index) => ({
    name: `existing-${index}.txt`, mimeType: "text/plain", buffer: Buffer.from("note"),
  })));
  const surface = page.locator(".message-list-shell");
  await dispatchFiles(surface, "dragenter", 3, true);
  await expect(placeholders(page)).toHaveCount(1);
  await expect(tray(page).getByRole("status").filter({ hasText: "一次最多发送 10 个附件" })).toBeVisible();
  await expect(placeholders(page)).toBeInViewport();
  await expect.poll(() => placeholders(page).evaluate(element => {
    const card = element.getBoundingClientRect();
    const grid = element.parentElement!.getBoundingClientRect();
    return card.bottom <= grid.bottom + 1;
  })).toBe(true);
  await expect(placeholders(page).getByText("松开鼠标以添加附件")).toBeInViewport();
  await dispatchFiles(surface, "drop", 3);
  await expect(tray(page).locator("article")).toHaveCount(10);
  await expect(tray(page).getByRole("alert")).toHaveText("一次最多发送 10 个附件");
  await dispatchFiles(surface, "dragenter", 1, true);
  await expect(placeholders(page)).toHaveCount(0);
  await expect(tray(page).getByRole("status")).toHaveText("一次最多发送 10 个附件");
});

test("forum topics and nested channel discussions receive drops in their own draft scope", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-forum"]').click();
  await expect(input(page)).toBeVisible();
  await dispatchFiles(page.locator(".message-list-shell"), "dragenter", 1, true);
  await expect(tray(page)).toHaveCount(0);
  await page.locator('.forum-topic-strip [data-topic-id="12"]').click();
  await expect(placeholders(page)).toHaveCount(0);
  await expect(page.locator(".message-list-shell")).not.toHaveAttribute("inert");
  await dispatchFiles(page.locator(".message-list-shell"), "dragenter", 1, true);
  await expect(tray(page)).toHaveCount(0);
  await dispatchFiles(page.locator(".message-list-shell"), "drop");
  await expect.poll(() => draftKeys(page)).toEqual(["chat-forum:topic:12"]);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-release"]').click();
  await page.locator('[data-message-id="release-post-1"] .channel-post-discussion').click();
  const panel = page.locator(".channel-discussion-panel");
  await expect(panel).toBeVisible();
  const scope = await panel.getAttribute("data-composer-scope");
  await dispatchFiles(panel.locator(".channel-discussion-messages"), "dragenter", 1, true);
  await expect(panel.getByRole("region", { name: "待发送附件" })).toHaveCount(0);
  await expect(page.locator(".conversation > .composer-wrap .composer-attachment-placeholder")).toHaveCount(0);
  await dispatchFiles(panel.locator(".channel-discussion-messages"), "drop");
  await expect(panel.getByText("dropped-0.txt", { exact: true })).toBeVisible();
  await expect.poll(() => draftKeys(page)).toEqual(["chat-forum:topic:12", scope]);
});
