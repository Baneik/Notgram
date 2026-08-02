import { expect, test, type Page } from "@playwright/test";

const horizontalOverflow = async (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll("body *")].some((element) => {
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

const scrollAwayFromBottom = (page: Page) => page.locator(".message-list").evaluate((element) => {
  const maximum = element.scrollHeight - element.clientHeight;
  element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -500 }));
  element.scrollTop = Math.max(100, Math.floor(maximum * 0.45));
  element.dispatchEvent(new Event("scroll"));
});

test("desktop messaging, reactions, and preferences remain usable", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".chat-row")).not.toHaveCount(0);
  await expect(page.locator(".message-day")).not.toHaveCount(0);

  const visibleBubble = page.locator(".message-bubble-shell").last();
  await visibleBubble.hover();
  await visibleBubble.locator(".reaction-add").click();
  await visibleBubble.locator(".reaction-picker button").first().click();
  await expect(visibleBubble.locator(".message-reactions > button")).toHaveCount(1);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /聊天设置/ }).click();
  await page.getByRole("switch", { name: "紧凑会话密度" }).check();
  await expect(page.locator("html")).toHaveClass(/compact-chat/);
  expect(await horizontalOverflow(page)).toBe(false);
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
  const product = page.getByRole("button", { name: /产品讨论/ });
  const mia = page.getByRole("button", { name: /Mia Chen/ });

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
});

test("video uses its poster and custom streaming controls", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const row = page.locator('[data-message-id="p-video"]');
  const player = row.locator(".video-player");
  const video = player.locator("video");

  await expect(player).toBeVisible();
  await expect(video).toHaveAttribute("poster", /mock-video-poster\.jpg/);
  await expect(video).not.toHaveAttribute("controls", "");
  await expect(player.getByRole("slider", { name: "播放进度" })).toBeVisible();
  await expect(player.getByRole("slider", { name: "音量" })).toBeVisible();

  await player.getByRole("button", { name: /播放 交互预览/ }).click();
  await expect(video).toHaveAttribute("src", /mock-video\.mp4/);
  await expect.poll(() => video.evaluate((element) => !(element as HTMLVideoElement).paused))
    .toBe(true);
});

test("photo bubbles preserve media geometry and rounded clipping", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /产品讨论/ }).first().click();
  const squareRow = page.locator('[data-message-id="p-5"]');
  const tallRow = page.locator('[data-message-id="p-tall"]');
  await expect(squareRow).toBeVisible();
  await expect(tallRow).toBeVisible();
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
    for (const row of [tallRow, squareRow]) {
      await row.scrollIntoViewIfNeeded();
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
          naturalRatio: image.naturalWidth / image.naturalHeight,
          previewRatio: previewBounds.width / previewBounds.height,
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
          borderRadius: getComputedStyle(bubble).borderRadius,
          overflow: getComputedStyle(bubble).overflow,
        };
      });
      expect(geometry).toBeDefined();
      expect(geometry?.shellInsideStack).toBe(true);
      expect(geometry?.bubbleGap).toBeLessThanOrEqual(1);
      expect(geometry?.imageHorizontalGap).toBeLessThanOrEqual(1);
      expect(geometry?.imageVerticalGap).toBeLessThanOrEqual(1);
      expect(Math.abs((geometry?.naturalRatio ?? 0) - (geometry?.previewRatio ?? 1)))
        .toBeLessThan(0.002);
      expect(geometry?.borderRadius).toBe("12px");
      expect(geometry?.overflow).toBe("hidden");
    }
  }

  const tallWidth = await tallRow.locator(".message-bubble-shell").evaluate(
    (shell) => shell.getBoundingClientRect().width,
  );
  expect(tallWidth).toBeCloseTo(210, 0);
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
      previewWidth: preview?.getBoundingClientRect().width,
      borderRadius: bubble ? getComputedStyle(bubble).borderRadius : "",
      overflow: bubble ? getComputedStyle(bubble).overflow : "",
    };
  });
  expect(Math.abs((failedState.shellWidth ?? 0) - (failedState.previewWidth ?? 1)))
    .toBeLessThanOrEqual(1);
  expect(failedState.shellWidth).toBeCloseTo(tallWidth, 0);
  expect(failedState.borderRadius).toBe("12px");
  expect(failedState.overflow).toBe("hidden");
});

test("saved and direct messages align to the conversation edges", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /收藏夹/ }).click();
  const savedMessage = page.locator('[data-message-id="s-2"]');
  await expect(savedMessage).toBeVisible();
  await expect(savedMessage).toHaveClass(/is-outgoing/);

  await page.getByRole("button", { name: /Mia Chen/ }).click();
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
  await expect(notice.locator(".message-meta, .message-action-trigger")).toHaveCount(0);
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
});

test("conversation scroll state follows, restores, counts, and resets to latest", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-row")).not.toHaveCount(0);
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);

  await scrollAwayFromBottom(page);
  const savedAnchor = await visibleMessageAnchor(page);
  expect(savedAnchor.id).toBeTruthy();

  await page.getByRole("button", { name: /Mia Chen/ }).click();
  await expect(page.locator(".conversation-title h2")).toHaveText("Mia Chen");
  await page.getByRole("button", { name: /产品讨论/ }).click();
  await expect(page.locator(".conversation-title h2")).toHaveText("产品讨论");
  await expect.poll(async () => (await visibleMessageAnchor(page)).id).toBe(savedAnchor.id);
  await expect.poll(async () => Math.abs(
    (await visibleMessageAnchor(page)).offset - savedAnchor.offset,
  )).toBeLessThanOrEqual(2);

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
  await page.getByRole("button", { name: /产品讨论/ }).dblclick();
  await expect(page.locator(".conversation-title h2")).toHaveText("产品讨论");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom).toBeLessThanOrEqual(1);
});

test("loading older messages preserves the visible message anchor", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-row")).toHaveCount(30);

  const list = page.locator(".message-list");
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
  await expect(page.locator(".message-row")).toHaveCount(48);
  const offset = await page.locator(`[data-message-id="${before.id}"]`).evaluate(
    (row) => row.getBoundingClientRect().top -
      (row.closest(".message-list")?.getBoundingClientRect().top ?? 0),
  );
  expect(Math.abs(offset - before.offset)).toBeLessThanOrEqual(2);
});
