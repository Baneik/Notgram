import { expect, test } from "@playwright/test";
import type { Message } from "../../src/telegram/types";
import { revealVirtualMessage, chooseMessageMenuItem } from "./helpers";

test("offline text messages survive a restart in the snapshot model", { tag: "@smoke" }, async ({ page }) => {
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

test("offline attachments survive restart and can be cancelled", { tag: "@smoke" }, async ({ page }) => {
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

test("pasted images preview, respect Telegram's album limit, and send as one album", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.evaluate(async (element) => {
    const data = new DataTransfer();
    for (let index = 1; index <= 11; index += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = 2;
      canvas.height = 2;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Missing canvas context");
      context.fillStyle = `hsl(${index * 31} 90% 50%)`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Unable to encode PNG")), "image/png");
      });
      data.items.add(new File([blob], index <= 2 ? "paste.png" : `paste-${index}.png`, {
        type: "image/png",
      }));
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
  await expect(composer).toHaveJSProperty("value", "");
  const sentAlbum = page.locator(".media-album.is-outgoing").last();
  await expect(sentAlbum.locator(".media-album-grid img")).toHaveCount(2);
  await expect.poll(() => sentAlbum.locator(".media-album-grid img").evaluateAll((images) =>
    new Set(images.map((image) => (image as HTMLImageElement).currentSrc)).size,
  )).toBe(2);
  await expect(sentAlbum.locator(".media-album-caption > .message-rich-text")).toHaveText("粘贴图片说明");
  await expect(sentAlbum.locator(".photo-caption")).toHaveCount(0);
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

test("replying can send media, files, and stickers with the reply target", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await revealVirtualMessage(page, "p-2");
  const source = page.locator('[data-message-id="p-2"]');
  await revealVirtualMessage(page, "p-2");
  await source.locator(".message-bubble-shell").click({ button: "right" });
  await chooseMessageMenuItem(page, "回复");
  await expect(page.locator(".composer-context.is-replying")).toBeVisible();
  await expect(page.getByRole("button", { name: "添加附件" })).toBeEnabled();

  await page.locator('input[type="file"]').setInputFiles({
    name: "reply-photo.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  const attachmentPreview = page.getByRole("region", { name: "待发送附件" });
  await expect(attachmentPreview.getByText("reply-photo.png", { exact: true })).toBeVisible();
  const replyBounds = await page.locator(".composer-context.is-replying").boundingBox();
  const attachmentBounds = await attachmentPreview.boundingBox();
  expect(replyBounds!.y + replyBounds!.height).toBeLessThanOrEqual(attachmentBounds!.y + 1);
  await composer.press("Enter");
  const sentPhoto = page.locator(".message-row.is-outgoing", {
    has: page.locator('[data-media-type="photo"]'),
  }).last();
  await expect(sentPhoto).toBeVisible();
  await expect(sentPhoto.locator(".message-reply-preview")).toBeVisible();
  await expect(page.locator(".composer-context.is-replying")).toHaveCount(0);

  await revealVirtualMessage(page, "p-2");
  await source.locator(".message-bubble-shell").click({ button: "right" });
  await chooseMessageMenuItem(page, "回复");
  await page.locator('input[type="file"]').setInputFiles({
    name: "reply-file.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("reply file"),
  });
  await composer.press("Enter");
  const sentFile = page.locator(".message-row.is-outgoing", { has: page.locator(".file-message") }).last();
  await expect(sentFile).toBeVisible();
  await expect(sentFile.locator(".message-reply-preview")).toBeVisible();
  await expect(page.locator(".composer-context.is-replying")).toHaveCount(0);

  await revealVirtualMessage(page, "p-2");
  await source.locator(".message-bubble-shell").click({ button: "right" });
  await chooseMessageMenuItem(page, "回复");
  await page.getByRole("button", { name: "表情" }).click();
  const picker = page.getByRole("dialog", { name: "表情、贴纸与 GIF" });
  await picker.getByRole("button", { name: /发送贴纸/ }).first().click();
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: { getState: () => { messages: Map<string, Array<{
        outgoing: boolean;
        content: { kind: string; mediaType?: string };
        replyTo?: { messageId?: string };
      }>> } } };
    return module.telegramStore.getState().messages.get("chat-product")?.some((message) =>
      message.outgoing && message.content.kind === "media" && message.content.mediaType === "sticker" &&
      message.replyTo?.messageId === "p-2",
    ) ?? false;
  }, "/src/store/telegramStore.ts")).toBe(true);
  await expect(page.locator(".composer-context.is-replying")).toHaveCount(0);
});

test("editing suspends staged attachments and restores their original caption", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.fill("message before staging");
  await composer.press("Enter");
  const sent = page.locator(".message-row.is-outgoing").filter({ hasText: "message before staging" });
  await expect(sent).toBeVisible();
  const messageId = await sent.getAttribute("data-message-id");
  await page.locator('input[type="file"]').setInputFiles({
    name: "preserved.txt", mimeType: "text/plain", buffer: Buffer.from("staged document"),
  });
  await composer.fill("original attachment caption");
  for (const save of [false, true]) {
    await page.locator(`[data-message-id="${messageId}"] .message-bubble-shell`).click({ button: "right" });
    await chooseMessageMenuItem(page, "编辑");
    await expect(page.locator(".composer-context.is-editing")).toBeVisible();
    await expect(page.locator(".composer-attachment-preview")).toHaveCount(0);
    await composer.fill("edited message");
    await page.getByRole("button", { name: save ? "保存编辑" : "取消编辑", exact: true }).click();
    await expect(page.locator(".composer-attachment-preview")).toBeVisible();
    await expect(composer).toHaveJSProperty("value", "original attachment caption");
  }
  await expect(page.locator(`[data-message-id="${messageId}"] .message-rich-text`)).toHaveText("edited message");
  await composer.press("Enter");
  await expect(page.locator(".composer-attachment-preview")).toHaveCount(0);
  const file = page.locator(".message-row.is-outgoing").filter({ has: page.locator(".file-message", { hasText: "preserved.txt" }) });
  await expect(file).toContainText("original attachment caption");
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

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"] .chat-preview-message'))
    .toHaveText("草稿：1 个附件");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(preview.getByText("dropped-image.png", { exact: true })).toBeVisible();

  await preview.getByRole("checkbox", { name: "剧透" }).check();
  const stagedSpoiler = preview.locator(".media-spoiler");
  await expect(stagedSpoiler).toHaveClass(/is-concealed/);
  await preview.getByRole("button", { name: "显示遮罩媒体" }).click();
  await expect(stagedSpoiler).toHaveClass(/is-revealed/);
  await composer.focus();
  const popupPromise = page.waitForEvent("popup");
  await preview.getByRole("button", { name: "预览 dropped-image.png" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("dialog", { name: "图片查看器：dropped-image.png" })).toHaveCount(0);
  await expect(popup.getByRole("dialog", { name: "图片查看器：dropped-image.png" })).toBeVisible();
  await expect(popup.locator('.media-viewer-image[alt="dropped-image.png"]')).toBeVisible();
  const popupClosed = popup.waitForEvent("close");
  await popup.keyboard.down("Escape");
  await popupClosed;
  await expect(preview.getByText("dropped-image.png", { exact: true })).toBeVisible();
  await expect(composer).toBeFocused();

  await preview.getByRole("checkbox", { name: "剧透" }).uncheck();
  await preview.getByRole("button", { name: "移除 dropped-image.png" }).click();
  await page.locator('input[type="file"]').setInputFiles("tests/fixtures/public/mock-video.mp4");
  await expect(preview.getByText("mock-video.mp4", { exact: true })).toBeVisible();
  const videoPopupPromise = page.waitForEvent("popup");
  await preview.getByRole("button", { name: "预览 mock-video.mp4" }).click();
  const videoPopup = await videoPopupPromise;
  await videoPopup.waitForLoadState("domcontentloaded");
  await expect(videoPopup.locator(".video-window")).toHaveClass(/is-fullscreen/);
  await expect(videoPopup.locator("video")).toHaveAttribute("src", /^blob:/);
  const videoPopupClosed = videoPopup.waitForEvent("close");
  await videoPopup.keyboard.down("Escape");
  await videoPopupClosed;
  await expect(composer).toBeFocused();
});

test("download manager lists only explicit downloads and supports batch management", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
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
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
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
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
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

test("media transfers expose their exact circular progress", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
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
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("Control+j");
  const dialog = page.getByRole("dialog", { name: "下载" });
  await expect(dialog.getByText("交互预览.mp4", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("progressbar", { name: "交互预览.mp4 下载进度" }))
    .toHaveAttribute("aria-valuenow", "0");
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

  await page.evaluate(async storePath => {
    const { telegramStore } = await import(storePath);
    const messages = new Map(telegramStore.getState().messages);
    messages.set("chat-product", (messages.get("chat-product") as Array<{ id: string; content: Record<string, unknown> }>).map(message => message.id === "p-image-document"
      ? { ...message, content: { ...message.content, localPath: "/mock-video-poster.jpg", isDownloaded: true, isDownloading: false } }
      : message));
    telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");
  const original = popup.locator('.media-viewer-image[src="/mock-video-poster.jpg"][data-image-state="ready"]');
  await expect(original).toHaveCount(1);
  await expect.poll(() => original.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(640);
  await expect.poll(async () => (await original.boundingBox())!.width).toBe(640);
  await expect(popup.locator(".media-viewer-details")).toContainText("640 × 360");
  await expect(thumbnailProgress).toHaveCount(0);

  const closed = popup.waitForEvent("close");
  await popup.keyboard.down("Escape");
  await closed;
});
