import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revealVirtualMessage } from "./helpers";

const input = (page: Page) => page.getByRole("textbox", { name: "消息内容" });
const tray = (page: Page) => page.getByRole("region", { name: "待发送附件" });
const row = (page: Page, chatId = "chat-mia") => page.locator(`.chat-list[data-active=true] [data-chat-id="${chatId}"]`);
const drafts = (page: Page) => page.evaluate(async () => {
  const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
  return [...telegramStore.getState().localAttachmentDrafts.keys()];
});

async function prepareMessage(page: Page, kind: "photo" | "file", width = 1366) {
  await page.setViewportSize({ width, height: 768 });
  await page.route("**/drag-document.txt", route => route.fulfill({ body: "original document bytes", contentType: "text/plain" }));
  await page.goto("/");
  if (width === 390) await row(page, "chat-product").click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async kind => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const messages = new Map(telegramStore.getState().messages);
    messages.set("chat-product", messages.get("chat-product")!.map(message => message.id !== "p-4" ? message : {
      ...message,
      content: kind === "photo" ? {
        kind: "media", mediaType: "photo", fileName: "original-photo.png", mimeType: "image/png", sizeLabel: "1 KB",
        localPath: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        isDownloaded: true, width: 120, height: 120,
      } : {
        kind: "file", fileName: "original-document.txt", mimeType: "text/plain", sizeLabel: "1 KB",
        localPath: "/drag-document.txt", isDownloaded: true,
      },
    }));
    telegramStore.setState({ messages });
  }, kind);
  await revealVirtualMessage(page, "p-4");
  const source = page.locator(`[data-message-id="p-4"] ${kind === "photo" ? ".photo-preview" : ".file-primary-action"}`);
  await expect(source).toBeVisible();
  if (kind === "photo") {
    await expect(source.locator("img").last()).toBeVisible();
    await expect.poll(() => source.locator("img").last().evaluate(element =>
      (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
  }
  await source.evaluate(element => element.addEventListener("dragstart", () => {
    document.body.dataset.messageDragStarted = "true";
  }, { once: true }));
  return source;
}

for (const kind of ["photo", "file"] as const) {
  for (const width of [1366, 390]) {
    test(`a ${kind} dragged back to its own editor never stages or inserts a fallback at ${width}px`, async ({ page }) => {
      const source = await prepareMessage(page, kind, width);
      await input(page).fill("retain original caption");
      await source.dragTo(input(page));
      await expect(page.locator("body")).toHaveAttribute("data-message-drag-started", "true");
      await expect(input(page)).toHaveJSProperty("value", "retain original caption");
      await expect(tray(page)).toHaveCount(0);
      expect(await drafts(page)).toEqual([]);
    });
  }

  test(`a native ${kind} drag survives hover switching and stages only in the destination`, async ({ page }) => {
    const source = await prepareMessage(page, kind);
    await row(page).click();
    await input(page).fill("destination caption");
    await row(page, "chat-product").click();
    await input(page).fill("original caption");
    await revealVirtualMessage(page, "p-4");
    const start = await source.boundingBox();
    const destination = await row(page).boundingBox();
    await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
    await page.mouse.down();
    await page.mouse.move(start!.x + start!.width / 2 + 15, start!.y + start!.height / 2, { steps: 5 });
    await page.mouse.move(destination!.x + destination!.width / 2, destination!.y + destination!.height / 2, { steps: 12 });
    await expect(row(page)).toHaveAttribute("data-attachment-hover", "true");
    await expect(row(page)).toHaveAttribute("aria-current", "true");
    await expect(input(page)).toHaveJSProperty("value", "destination caption");
    await expect(tray(page)).toHaveCount(0);
    const target = await input(page).boundingBox();
    await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(tray(page).getByText(kind === "photo" ? "original-photo.png" : "original-document.txt", { exact: true })).toBeVisible();
    await expect.poll(() => drafts(page)).toEqual(["chat-mia"]);
    const restored = await page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      return (await telegramStore.getState().loadLocalAttachmentDraft("chat-mia"))[0].file.text();
    });
    if (kind === "file") expect(restored).toBe("original document bytes");
    await row(page, "chat-product").click();
    await expect(input(page)).toHaveJSProperty("value", "original caption");
    await expect(tray(page)).toHaveCount(0);
  });
}

test("an internal drag remains rejected after switching back to its source conversation", async ({ page }) => {
  const source = await prepareMessage(page, "photo");
  const data = await source.evaluateHandle(element => {
    const data = new DataTransfer();
    data.setData("text/html", `<img src="${element.querySelector("img")?.src}">`);
    element.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: data }));
    return data;
  });
  await row(page).dispatchEvent("dragover", { dataTransfer: data });
  await expect(row(page)).toHaveAttribute("aria-current", "true");
  await row(page, "chat-product").dispatchEvent("dragover", { dataTransfer: data });
  await expect(row(page, "chat-product")).toHaveAttribute("aria-current", "true");
  await input(page).dispatchEvent("drop", { dataTransfer: data });
  await expect(tray(page)).toHaveCount(0);
  expect(await drafts(page)).toEqual([]);
  await data.dispose();
});

test("protected message images do not publish attachment drag data", async ({ page }) => {
  const source = await prepareMessage(page, "photo");
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const messages = new Map(telegramStore.getState().messages);
    messages.set("chat-product", messages.get("chat-product")!.map(message => message.id === "p-4" ? { ...message, canSave: false } : message));
    telegramStore.setState({ messages });
  });
  expect(await source.locator("img").last().evaluate(element => {
    const data = new DataTransfer();
    const event = new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: data });
    element.dispatchEvent(event);
    return { prevented: event.defaultPrevented, types: [...data.types] };
  })).toEqual({ prevented: true, types: [] });
});

test("external protected file drags switch on hover and read files only on release", async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), "notgram-drag-switch-"));
  const path = join(directory, "external-note.txt");
  try {
    await writeFile(path, "external file bytes");
    await page.goto("/");
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    const session = await page.context().newCDPSession(page);
    const data = { items: [], files: [path], dragOperationsMask: 1 };
    const surface = await page.locator(".message-list-shell").boundingBox();
    await session.send("Input.dispatchDragEvent", { type: "dragEnter", x: surface!.x + 30, y: surface!.y + 30, data });
    await expect(tray(page)).toHaveCount(0);
    const destination = await row(page).boundingBox();
    const position = { x: destination!.x + destination!.width / 2, y: destination!.y + destination!.height / 2 };
    await session.send("Input.dispatchDragEvent", { type: "dragOver", ...position, data });
    await expect(row(page)).toHaveAttribute("aria-current", "true");
    await expect(tray(page)).toHaveCount(0);
    expect(await drafts(page)).toEqual([]);
    const target = await input(page).boundingBox();
    const release = { x: target!.x + target!.width / 2, y: target!.y + target!.height / 2 };
    await session.send("Input.dispatchDragEvent", { type: "dragOver", ...release, data });
    await session.send("Input.dispatchDragEvent", { type: "drop", ...release, data });
    await expect(tray(page).getByText("external-note.txt", { exact: true })).toBeVisible();
    await expect.poll(() => drafts(page)).toEqual(["chat-mia"]);
    await session.detach();
  } finally {
    await unlink(path);
    await rmdir(directory);
  }
});

for (const changeDestination of [false, true]) {
  test(`a deferred attachment download ${changeDestination ? "cannot populate a replacement conversation" : "starts only on release and stages the original file"}`, async ({ page }) => {
    const source = await prepareMessage(page, "file");
    await page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      const messages = new Map(telegramStore.getState().messages);
      messages.set("chat-product", messages.get("chat-product")!.map(message => message.id === "p-4" && message.content.kind === "file"
        ? { ...message, content: { ...message.content, localPath: undefined, isDownloaded: false, fileId: 98765, canDownload: true } } : message));
      telegramStore.setState({ messages, cacheFile: async () => {
        document.body.dataset.dragDownload = "pending";
        await new Promise<void>(resolve => Reflect.set(window, "releaseDragDownload", resolve));
        const current = new Map(telegramStore.getState().messages);
        current.set("chat-product", current.get("chat-product")!.map(message => message.id === "p-4" && message.content.kind === "file"
          ? { ...message, content: { ...message.content, localPath: "/drag-document.txt", isDownloaded: true } } : message));
        telegramStore.setState({ messages: current });
        document.body.dataset.dragDownload = "complete";
      } });
    });
    const data = await source.evaluateHandle(element => {
      const data = new DataTransfer();
      element.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: data }));
      return data;
    });
    await row(page).dispatchEvent("dragover", { dataTransfer: data });
    await expect(row(page)).toHaveAttribute("aria-current", "true");
    await expect(page.locator("body")).not.toHaveAttribute("data-drag-download");
    await input(page).dispatchEvent("drop", { dataTransfer: data });
    await expect(page.locator("body")).toHaveAttribute("data-drag-download", "pending");
    await expect(tray(page)).toHaveCount(0);
    if (changeDestination) await row(page, "chat-product").click();
    await page.evaluate(() => (Reflect.get(window, "releaseDragDownload") as () => void)());
    await expect(page.locator("body")).toHaveAttribute("data-drag-download", "complete");
    if (changeDestination) {
      await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
      expect(await drafts(page)).toEqual([]);
      await expect(tray(page)).toHaveCount(0);
    } else {
      await expect(tray(page).getByText("original-document.txt", { exact: true })).toBeVisible();
      await expect.poll(() => drafts(page)).toEqual(["chat-mia"]);
    }
    await data.dispose();
  });
}

test("staged files cannot duplicate themselves and can be dragged to another conversation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.locator('input[type="file"]').setInputFiles({ name: "staged-note.txt", mimeType: "text/plain", buffer: Buffer.from("staged bytes") });
  const source = tray(page).locator(".composer-attachment-copy");
  await expect(source).toBeVisible();
  await source.dragTo(input(page));
  await expect(tray(page).locator("article")).toHaveCount(1);
  const data = await source.evaluateHandle(element => {
    const data = new DataTransfer();
    element.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: data }));
    return data;
  });
  await row(page).dispatchEvent("dragover", { dataTransfer: data });
  await expect(row(page)).toHaveAttribute("aria-current", "true");
  await input(page).dispatchEvent("drop", { dataTransfer: data });
  await expect(tray(page).getByText("staged-note.txt", { exact: true })).toBeVisible();
  await expect.poll(() => drafts(page)).toEqual(["chat-product", "chat-mia"]);
  await row(page, "chat-product").click();
  await expect(tray(page).locator("article")).toHaveCount(1);
  await data.dispose();
});

test("text drags never switch sidebar conversations", async ({ page }) => {
  await page.goto("/");
  await expect(input(page)).toBeVisible();
  await row(page).evaluate(element => {
    const data = new DataTransfer();
    data.setData("text/plain", "selected message text");
    element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await page.waitForTimeout(650);
  await expect(row(page, "chat-product")).toHaveAttribute("aria-current", "true");
  await expect(row(page)).not.toHaveAttribute("data-attachment-hover");
});

for (const internal of [false, true]) {
  test(`Escape over the sidebar preserves staged files during an ${internal ? "internal" : "external"} attachment drag`, async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    await page.locator('input[type="file"]').setInputFiles({ name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("keep") });
    await expect(tray(page).locator("article")).toHaveCount(1);
    const data = await tray(page).locator(".composer-attachment-copy").evaluateHandle((element, internal) => {
      const data = new DataTransfer();
      if (internal) element.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: data }));
      else data.items.add(new File(["external"], "external.txt", { type: "text/plain" }));
      return data;
    }, internal);
    await row(page).dispatchEvent("dragover", { dataTransfer: data });
    await expect(row(page)).toHaveAttribute("data-attachment-hover", "true");
    await page.keyboard.press("Escape");
    await expect(tray(page).locator("article")).toHaveCount(1);
    await expect(tray(page).getByText("keep.txt", { exact: true })).toBeVisible();
    await data.dispose();
  });
}

for (const cancel of ["leave", "escape", "drop", "dragend", "blur", "modal"] as const) {
  test(`${cancel} cancels a pending attachment hover switch`, async ({ page }) => {
    await page.goto("/");
    await expect(input(page)).toBeVisible();
    const data = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(["note"], "note.txt", { type: "text/plain" }));
      return data;
    });
    await row(page).dispatchEvent("dragover", { dataTransfer: data });
    await expect(row(page)).toHaveAttribute("data-attachment-hover", "true");
    await expect(row(page, "chat-product")).toHaveAttribute("aria-current", "true");
    if (cancel === "leave") await row(page).dispatchEvent("dragleave");
    if (cancel === "escape") await page.keyboard.press("Escape");
    if (cancel === "drop") await row(page).dispatchEvent("drop", { dataTransfer: data });
    if (cancel === "dragend" || cancel === "blur") await page.evaluate(type => window.dispatchEvent(new Event(type)), cancel);
    if (cancel === "modal") await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.waitForTimeout(650);
    await expect(row(page, "chat-product")).toHaveAttribute("aria-current", "true");
    await expect(row(page)).not.toHaveAttribute("data-attachment-hover");
    expect(await drafts(page)).toEqual([]);
    await data.dispose();
  });
}
