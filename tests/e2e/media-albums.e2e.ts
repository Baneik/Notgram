import { expect, test } from "@playwright/test";
import type { Message } from "../../src/telegram/types";
import { horizontalOverflow, revealVirtualMessage, chooseMessageMenuItem } from "./helpers";

test("album captions follow the sole owner, placement, and live content updates", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const album = page.locator('[data-media-album-id="mock-album-product"]');
  const caption = album.locator(".media-album-caption");
  for (const ownerId of ["p-tall", "p-5"]) {
    for (const above of [false, true]) {
      await page.evaluate(async ({ ownerId, above }) => {
        const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as {
          telegramStore: { getState: () => { messages: Map<string, Message[]> }; setState: (state: { messages: Map<string, Message[]> }) => void };
        };
        const messages = new Map(telegramStore.getState().messages);
        messages.set("chat-product", messages.get("chat-product")!.map((message) =>
          message.mediaAlbumId === "mock-album-product" && message.content.kind === "media"
            ? { ...message, content: { ...message.content,
                caption: message.id === ownerId ? "相册描述\n第二行完整显示" : undefined,
                captionEntities: message.id === ownerId ? [{ kind: "bold", offset: 0, length: 4 }] : undefined,
                showCaptionAboveMedia: above,
              } }
            : message));
        telegramStore.setState({ messages });
      }, { ownerId, above });
      await expect(caption).toHaveAttribute("data-caption-message-id", ownerId);
      await expect(caption.locator(".message-rich-text")).toHaveText("相册描述\n第二行完整显示");
      await expect(caption.locator("time")).toBeVisible();
      await expect(album.locator(".media-album-grid time")).toHaveCount(0);
      await expect(caption.locator("strong")).toHaveText("相册描述");
      await expect(album.locator(".photo-caption")).toHaveCount(0);
      const placement = await album.evaluate((element) => {
        const caption = element.querySelector(".media-album-caption")!.getBoundingClientRect();
        const grid = element.querySelector(".media-album-grid")!.getBoundingClientRect();
        return { above: caption.bottom <= grid.top + 1, below: caption.top >= grid.bottom - 1,
          contained: caption.right <= element.getBoundingClientRect().right + 1 };
      });
      expect(above ? placement.above : placement.below).toBe(true);
      expect(placement.contained).toBe(true);
    }
  }
  await revealVirtualMessage(page, "p-tall");
  await album.scrollIntoViewIfNeeded();
  await expect(caption).toBeInViewport({ ratio: 1 });
  // Identical text on two items still means two independent captions.
  for (const text of ["相册描述\n第二行完整显示", ""]) {
    await page.evaluate(async (text) => {
      const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as {
        telegramStore: { getState: () => { messages: Map<string, Message[]> }; setState: (state: { messages: Map<string, Message[]> }) => void };
      };
      const messages = new Map(telegramStore.getState().messages);
      messages.set("chat-product", messages.get("chat-product")!.map((message) =>
        message.mediaAlbumId === "mock-album-product" && message.content.kind === "media"
          ? { ...message, content: { ...message.content, caption: text, captionEntities: undefined } } : message));
      telegramStore.setState({ messages });
    }, text);
    await expect(caption).toHaveCount(0);
  }
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as {
      telegramStore: { getState: () => { messages: Map<string, Message[]> }; setState: (state: { messages: Map<string, Message[]> }) => void };
    };
    const messages = new Map(telegramStore.getState().messages);
    messages.set("chat-product", messages.get("chat-product")!.map((message) =>
      message.mediaAlbumId === "mock-album-product" && message.content.kind === "media"
        ? { ...message, mediaAlbumId: undefined, content: { ...message.content,
            caption: "单张媒体上方说明", showCaptionAboveMedia: true } } : message));
    telegramStore.setState({ messages });
  });
  const photo = page.locator('[data-message-id="p-5"]');
  await expect(photo.locator(".photo-caption")).toHaveText("单张媒体上方说明");
  expect(await photo.evaluate((element) =>
    element.querySelector(".photo-caption-flow")!.getBoundingClientRect().bottom <=
      element.querySelector(".photo-preview")!.getBoundingClientRect().top + 1,
  )).toBe(true);
});

test("sent album captions can be edited, removed, and owned by a later item", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.fill("整组说明");
  const buffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "caption-first.png", mimeType: "image/png", buffer },
    { name: "caption-second.png", mimeType: "image/png", buffer },
  ]);
  await expect(page.locator(".composer-attachment-item")).toHaveCount(2);
  await composer.press("Enter");
  const album = page.locator(".media-album.is-outgoing").last();
  const caption = album.locator(".media-album-caption");
  await expect(caption.locator(".message-rich-text")).toHaveText("整组说明");
  await expect(caption.locator("time")).toBeVisible();
  await expect(caption.locator(".message-delivery-status")).toBeVisible();
  await caption.click({ button: "right" });
  await chooseMessageMenuItem(page, "编辑");
  await expect(composer).toHaveValue("整组说明");
  await composer.fill("");
  await page.getByRole("button", { name: "保存编辑", exact: true }).click();
  await expect(caption).toHaveCount(0);
  const second = album.locator(".message-row").nth(1);
  const secondId = await second.getAttribute("data-message-id");
  await second.locator(".message-bubble-shell").click({ button: "right" });
  await chooseMessageMenuItem(page, "编辑");
  await expect(composer).toHaveValue("");
  await composer.fill("第二项承载的说明");
  await composer.press("Enter");
  await expect(caption).toHaveAttribute("data-caption-message-id", secondId!);
  await expect(caption.locator(".message-rich-text")).toHaveText("第二项承载的说明");
  await expect(caption.locator("time")).toBeVisible();
  await expect(album.locator(".media-album-grid time")).toHaveCount(0);
  await caption.focus();
  await caption.press("Shift+F10");
  await chooseMessageMenuItem(page, "编辑");
  await expect(composer).toHaveValue("第二项承载的说明");
  await composer.fill("修改后的整组说明");
  await composer.press("Enter");
  await expect(caption.locator(".message-rich-text")).toHaveText("修改后的整组说明");
  await expect(caption).toHaveAttribute("data-caption-message-id", secondId!);
  await expect(album.locator(".photo-caption")).toHaveCount(0);
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
  await expect(album.locator(".media-album-grid")).toHaveCSS("background-color", "rgb(200, 212, 215)");
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
