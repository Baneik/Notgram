import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Message } from "../../src/telegram/types";
import { messageListMetrics, latestMessageBottomGap, visibleMessageAnchor, scrollAwayFromBottom, revealVirtualMessage, openConversationMessageSearch, chooseMessageMenuItem } from "./helpers";

interface BottomGeometrySample {
  context: string;
  distanceBottom: number;
  latestGap: number;
}

const traceBottomGeometryWhileClicking = (
  trigger: Locator,
  frameCount = 30,
): Promise<BottomGeometrySample[]> => trigger.evaluate(async (element, frames) => {
  const read = (): BottomGeometrySample => {
    const list = document.querySelector<HTMLElement>(".message-list");
    const rows = list?.querySelectorAll<HTMLElement>("[data-message-id]");
    const latest = rows?.item((rows?.length ?? 1) - 1);
    const listBounds = list?.getBoundingClientRect();
    return {
      context: document.querySelector<HTMLElement>(".composer-context")?.className ?? "",
      distanceBottom: list
        ? list.scrollHeight - list.clientHeight - list.scrollTop
        : Number.POSITIVE_INFINITY,
      latestGap: listBounds && latest
        ? listBounds.bottom - latest.getBoundingClientRect().bottom
        : Number.POSITIVE_INFINITY,
    };
  };
  const samples = [read()];
  (element as HTMLElement).click();
  for (let frame = 0; frame < frames; frame += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => {
      globalThis.setTimeout(resolve, 0);
    }));
    samples.push(read());
  }
  return samples;
}, frameCount);

const expectStableFollowingGeometry = (
  samples: BottomGeometrySample[],
  contextClass: "is-editing" | "",
) => {
  const matching = samples.filter(({ context }) => contextClass
    ? context.includes(contextClass)
    : context === "");
  expect(matching.length, JSON.stringify(samples)).toBeGreaterThan(2);
  expect(
    Math.max(...matching.map(({ distanceBottom }) => Math.abs(distanceBottom))),
    JSON.stringify(samples),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.max(...matching.map(({ latestGap }) => Math.abs(latestGap - 12))),
    JSON.stringify(samples),
  ).toBeLessThanOrEqual(1.5);
};

const messageViewportOffset = (page: Page, messageId: string) =>
  page.locator(`[data-message-id="${messageId}"]`).evaluate((element) => {
    const list = element.closest<HTMLElement>(".message-list");
    if (!list) return Number.POSITIVE_INFINITY;
    return element.getBoundingClientRect().top - list.getBoundingClientRect().top;
  });

test("conversation navigation records only links opened inside a conversation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "后退" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "前进" })).toHaveCount(0);

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");

  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointerdown", {
      button: 3,
      bubbles: true,
      cancelable: true,
    }));
  });
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");

  const forwardedMessage = page.locator('[data-message-id="p-channel-reply"]');
  await forwardedMessage.getByRole("button", { name: "打开频道原消息：Release editor" }).click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Release Notes");

  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointerdown", {
      button: 3,
      bubbles: true,
      cancelable: true,
    }));
  });
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");

  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointerdown", {
      button: 4,
      bubbles: true,
      cancelable: true,
    }));
  });
  await expect(page.locator(".conversation-title strong")).toHaveText("Release Notes");

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointerdown", {
      button: 3,
      bubbles: true,
      cancelable: true,
    }));
  });
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
});

test("reply previews jump to their source and channel senders keep their identity", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const channelMessage = page.locator('[data-message-id="p-channel-reply"]');
  await expect(channelMessage).toBeVisible();
  await expect(channelMessage.locator(".message-sender")).toHaveText("Release Notes");
  await expect(channelMessage.locator(".message-forward-label")).toHaveCount(0);
  await expect(channelMessage.locator('[aria-label="转发 23 次"]')).toHaveText("23");
  await expect(channelMessage.locator('[aria-label="22200 次观看"]')).toHaveText("22.2K");
  await expect(channelMessage.locator(".message-channel-author")).toHaveText("Release editor");
  await expect(page.locator('.message-group:has([data-message-id="p-channel-reply"]) .message-group-avatar .avatar')).toContainText("R");
  await expect(channelMessage.locator(".message-reply-preview")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  const [replyBounds, bubbleBounds] = await Promise.all([
    channelMessage.locator(".message-reply-preview").boundingBox(),
    channelMessage.locator(".message-bubble").boundingBox(),
  ]);
  expect(Math.abs(
    replyBounds!.x + replyBounds!.width - (bubbleBounds!.x + bubbleBounds!.width - 10),
  )).toBeLessThanOrEqual(1);
  await expect(channelMessage.getByRole("button", { name: "前往频道原消息" })).toHaveCount(0);

  await page.evaluate(() => {
    type JumpSample = {
      scrollTop: number;
      placeholder: boolean;
      snapshot: boolean;
    };
    const state = { samples: [] as JumpSample[], running: false };
    const globalState = globalThis as typeof globalThis & {
      __notgramJumpTrace?: typeof state;
    };
    globalState.__notgramJumpTrace = state;
    document.querySelector('[data-message-id="p-channel-reply"] .message-reply-preview')
      ?.addEventListener("pointerdown", () => {
        if (state.running) return;
        state.running = true;
        const startedAt = performance.now();
        const sample = () => {
          const list = document.querySelector<HTMLElement>(".message-list");
          state.samples.push({
            scrollTop: list?.scrollTop ?? -1,
            placeholder: Boolean(document.querySelector(".message-positioning-placeholder")),
            snapshot: Boolean(document.querySelector(
              "[data-conversation-switch-snapshot], [data-conversation-motion-snapshot]",
            )),
          });
          if (performance.now() - startedAt < 700) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, { once: true });
  });
  await channelMessage.locator(".message-reply-preview").click();
  const target = page.locator('[data-message-id="p-old-8"]');
  await expect(target).toHaveClass(/is-notification-target/);
  await expect.poll(() => target.evaluate((element) => {
    const list = element.closest(".message-list")?.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    if (!list) return Number.POSITIVE_INFINITY;
    return Math.abs((row.top + row.bottom) / 2 - (list.top + list.bottom) / 2);
  })).toBeLessThan(2);
  await page.waitForTimeout(720);
  const jumpReport = await page.evaluate(() => {
    type JumpSample = { scrollTop: number; placeholder: boolean; snapshot: boolean };
    const globalState = globalThis as typeof globalThis & {
      __notgramJumpTrace?: { samples: JumpSample[] };
    };
    const samples = globalState.__notgramJumpTrace?.samples ?? [];
    let direction = 0;
    let visibleReversals = 0;
    for (let index = 1; index < samples.length; index += 1) {
      // The long-jump relocation is intentionally hidden by the snapshot.
      // Ignore both sides of that hand-off so it cannot look like a visible
      // reversal when the deceleration segment starts.
      if (samples[index].snapshot || samples[index - 1].snapshot) continue;
      const delta = samples[index].scrollTop - samples[index - 1].scrollTop;
      if (Math.abs(delta) < 0.5) continue;
      const nextDirection = Math.sign(delta);
      if (direction && direction !== nextDirection) visibleReversals += 1;
      direction = nextDirection;
    }
    return {
      visibleReversals,
      placeholderFrames: samples.filter((sample) => sample.placeholder).length,
      snapshotFrames: samples.filter((sample) => sample.snapshot).length,
    };
  });
  expect(jumpReport.visibleReversals).toBe(0);
  expect(jumpReport.placeholderFrames).toBe(0);
  expect(jumpReport.snapshotFrames).toBeGreaterThan(0);
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeFocused();
  await expect(target.locator(".message-bubble")).toHaveCSS("outline-style", "none");

  await openConversationMessageSearch(page);
  const search = page.getByRole("searchbox", { name: "搜索会话和消息" });
  await search.fill("Release Notes channel posted this reply");
  await page.locator('.chat-search-results-panel [data-search-message-id="p-channel-reply"]').click();
  await page.locator('[data-message-id="p-channel-reply"] .message-sender').click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await expect(profile.getByRole("heading", { name: "Release Notes" })).toBeVisible();
  await profile.getByRole("button", { name: "关闭资料" }).click();

});

test("distant message jumps keep relocation still and reveal one settling motion", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const source = page.locator('[data-message-id="p-channel-reply"]');
  await source.scrollIntoViewIfNeeded();
  await expect(page.locator('[data-message-id="p-old-8"]')).toHaveCount(0);
  await page.evaluate(() => {
    const originalAnimate = Element.prototype.animate;
    const records: Array<{
      duration: number;
      firstOpacity?: number;
      lastOpacity?: number;
      firstTransform?: string;
      lastTransform?: string;
    }> = [];
    (globalThis as typeof globalThis & { __notgramJumpAnimations?: typeof records })
      .__notgramJumpAnimations = records;
    Element.prototype.animate = function (keyframes, options) {
      if (this.classList.contains("message-list-content") && Array.isArray(keyframes)) {
        const timing = typeof options === "number" ? { duration: options } : options;
        records.push({
          duration: Number(timing?.duration ?? 0),
          firstOpacity: Number(keyframes[0]?.opacity),
          lastOpacity: Number(keyframes.at(-1)?.opacity),
          firstTransform: String(keyframes[0]?.transform ?? ""),
          lastTransform: String(keyframes.at(-1)?.transform ?? ""),
        });
      }
      return originalAnimate.call(this, keyframes, options);
    };
  });

  await source.locator(".message-reply-preview").click();
  const target = page.locator('[data-message-id="p-old-8"]');
  await expect(target).toHaveClass(/is-notification-target/);
  await page.waitForTimeout(720);
  const animations = await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __notgramJumpAnimations?: Array<{
        duration: number;
        firstOpacity?: number;
        lastOpacity?: number;
        firstTransform?: string;
        lastTransform?: string;
      }>;
    }
  ).__notgramJumpAnimations ?? []);
  expect(animations).toEqual([]);
  await expect.poll(() => target.evaluate((element) => {
    const list = element.closest(".message-list")?.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    return list
      ? Math.abs((row.top + row.bottom) / 2 - (list.top + list.bottom) / 2)
      : Number.POSITIVE_INFINITY;
  })).toBeLessThan(2);
  await expect(page.locator(".message-list")).not.toHaveClass(/is-jump-transitioning/);
});

test("forward source labels open the original message", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const forwardedMessage = page.locator('[data-message-id="p-channel-reply"]');
  const sourceButton = forwardedMessage.getByRole("button", { name: "打开频道原消息：Release editor" });
  await expect(sourceButton).toBeVisible();
  await sourceButton.click();

  await expect(page.locator(".conversation-title strong")).toHaveText("Release Notes");
  const originalMessage = page.locator('[data-message-id="release-post-1"]');
  await expect(originalMessage).toBeVisible();
  await expect(originalMessage).toHaveClass(/is-notification-target/);
});

test("reply context resizes the latest viewport without moving a detached anchor", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(13);

  const latest = page.locator('[data-message-id="p-video"]');
  await latest.locator(".message-bubble-shell").click({ button: "right" });
  await chooseMessageMenuItem(page, "回复");
  await expect(page.locator(".composer-context.is-replying")).toBeVisible();
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(13);
  const readLatestGap = () => latest.evaluate((element) => {
    const replyContext = document.querySelector<HTMLElement>(".composer-context.is-replying");
    return replyContext
      ? replyContext.getBoundingClientRect().top - element.getBoundingClientRect().bottom
      : Number.NEGATIVE_INFINITY;
  });
  await expect.poll(readLatestGap).toBeGreaterThanOrEqual(11);
  const latestGap = await readLatestGap();
  expect(latestGap).toBeLessThanOrEqual(13);

  await page.getByRole("button", { name: "取消回复", exact: true }).click();
  await scrollAwayFromBottom(page);
  const anchorBeforeReply = await visibleMessageAnchor(page);
  const detachedReplyTargetId = await messageList.evaluate((list) => {
    const bounds = list.getBoundingClientRect();
    return [...list.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((row) => {
        const rowBounds = row.getBoundingClientRect();
        return row.querySelector(".message-bubble-shell") &&
          rowBounds.top >= bounds.top + 40 && rowBounds.bottom <= bounds.bottom - 40;
      })?.dataset.messageId;
  });
  expect(detachedReplyTargetId).toBeTruthy();
  await page.evaluate(async ({ modulePath, messageId }) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { drafts: Map<string, unknown> };
        setState: (partial: { drafts: Map<string, unknown> }) => void;
      };
    };
    const drafts = new Map(storeModule.telegramStore.getState().drafts);
    drafts.set("chat-product", {
      chatId: "chat-product",
      text: "",
      replyToMessageId: messageId,
      updatedAt: new Date().toISOString(),
      pending: false,
    });
    storeModule.telegramStore.setState({ drafts });
  }, {
    modulePath: "/src/store/telegramStore.ts",
    messageId: detachedReplyTargetId!,
  });
  await expect(page.locator(".composer-context.is-replying")).toBeVisible();
  const anchorAfterReply = await visibleMessageAnchor(page);
  expect(anchorAfterReply.id).toBe(anchorBeforeReply.id);
  expect(Math.abs(anchorAfterReply.offset - anchorBeforeReply.offset)).toBeLessThanOrEqual(1);
});

test("long message editing keeps the bottom stable through cancel and save", async ({ page }) => {
  await page.goto("/");
  const messageList = page.getByRole("log", { name: "消息列表" });
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");

  const longText = Array.from(
    { length: 18 },
    (_, index) => `编辑稳定性第 ${index + 1} 行：保持末条消息贴底`,
  ).join("\n");
  await composer.fill(longText);
  await page.getByRole("button", { name: "发送消息" }).click();
  const sent = page.locator(".message-row.is-outgoing", {
    hasText: "编辑稳定性第 18 行",
  }).last();
  await expect(sent).toBeVisible();
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);

  const openEditor = async () => {
    await sent.locator(".message-bubble-shell").click({ button: "right" });
    const edit = page.getByRole("menuitem", { name: "编辑", exact: true });
    await expect(edit).toBeVisible();
    const samples = await traceBottomGeometryWhileClicking(edit);
    await expect(page.locator(".composer-context.is-editing")).toBeVisible();
    expectStableFollowingGeometry(samples, "is-editing");
  };

  await openEditor();
  const cancelSamples = await traceBottomGeometryWhileClicking(
    page.getByRole("button", { name: "取消编辑", exact: true }),
  );
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  expectStableFollowingGeometry(cancelSamples, "");

  await openEditor();
  const savedText = `${longText}\n保存后仍保持稳定`;
  await composer.fill(savedText);
  const saveSamples = await traceBottomGeometryWhileClicking(
    page.getByRole("button", { name: "保存编辑", exact: true }),
    40,
  );
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  await expect(sent).toContainText("保存后仍保持稳定");
  expectStableFollowingGeometry(saveSamples, "");
});

test("editing while detached preserves the visible message anchor", async ({ page }) => {
  await page.goto("/");
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await scrollAwayFromBottom(page);
  const anchorBefore = await visibleMessageAnchor(page);
  const editableMessageId = await messageList.evaluate((list) => {
    const bounds = list.getBoundingClientRect();
    return [...list.querySelectorAll<HTMLElement>(".message-row.is-outgoing[data-message-id]")]
      .find((row) => {
        const rowBounds = row.getBoundingClientRect();
        return row.querySelector(".message-rich-text") &&
          rowBounds.top >= bounds.top + 40 && rowBounds.bottom <= bounds.bottom - 40;
      })?.dataset.messageId;
  });
  expect(editableMessageId).toBeTruthy();

  const editable = page.locator(`[data-message-id="${editableMessageId}"]`);
  await editable.locator(".message-bubble-shell").click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  await expect(page.locator(".composer-context.is-editing")).toBeVisible();
  const anchorDuring = await visibleMessageAnchor(page);
  expect(anchorDuring.id).toBe(anchorBefore.id);
  expect(Math.abs(anchorDuring.offset - anchorBefore.offset)).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "取消编辑", exact: true }).click();
  await expect(page.locator(".composer-context.is-editing")).toHaveCount(0);
  const anchorAfter = await visibleMessageAnchor(page);
  expect(anchorAfter.id).toBe(anchorBefore.id);
  expect(Math.abs(anchorAfter.offset - anchorBefore.offset)).toBeLessThanOrEqual(1);
});

test("message jumps return through prior reading positions before returning to latest", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const source = await revealVirtualMessage(page, "p-channel-reply");
  const originalSourceOffset = await messageViewportOffset(page, "p-channel-reply");

  await source.locator(".message-reply-preview").click();
  const firstTarget = page.locator('[data-message-id="p-old-8"]');
  await expect(firstTarget).toHaveClass(/is-notification-target/);
  await expect.poll(() => firstTarget.evaluate((element) => {
    const list = element.closest(".message-list")?.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    return list
      ? Math.abs((row.top + row.bottom) / 2 - (list.top + list.bottom) / 2)
      : Number.POSITIVE_INFINITY;
  })).toBeLessThan(2);
  await expect(page.getByRole("button", { name: "返回跳转前位置，可回退 1 次" })).toBeVisible();
  const firstTargetOffset = await messageViewportOffset(page, "p-old-8");

  await page.locator(".pinned-message-preview").click();
  await expect(page.locator('[data-message-id="p-4"]')).toBeVisible();
  const returnButton = page.getByRole("button", { name: "返回跳转前位置，可回退 2 次" });
  await expect(returnButton).toBeVisible();

  await returnButton.click();
  await expect(firstTarget).toBeAttached();
  await expect.poll(async () => Math.abs(
    await messageViewportOffset(page, "p-old-8") - firstTargetOffset,
  )).toBeLessThanOrEqual(2);

  await page.getByRole("button", { name: "返回跳转前位置，可回退 1 次" }).click();
  await expect(source).toBeAttached();
  await expect.poll(async () => Math.abs(
    await messageViewportOffset(page, "p-channel-reply") - originalSourceOffset,
  )).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: /^返回跳转前位置/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^跳到最新消息/ })).toBeVisible();
});

test("returning from a reply jump to the latest message clears navigation state", async ({ page }) => {
  await page.goto("/");
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect(messageList.locator("[data-message-id]")).not.toHaveCount(0);

  const targetMessageId = await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    const target = current.at(-Math.min(12, Math.max(2, current.length)));
    if (!latest || !target || target === latest || typeof target.id !== "string") return undefined;
    current.push({
      ...latest,
      id: "p-latest-reply-jump",
      renderKey: undefined,
      senderId: "u-mia",
      outgoing: false,
      sentAt: new Date(Date.now() + 10_000).toISOString(),
      replyTo: {
        kind: "message",
        chatId: "chat-product",
        messageId: target.id,
        content: target.content,
      },
      content: { kind: "text", text: "最新消息引用了前文" },
    });
    messages.set("chat-product", current);
    module.telegramStore.setState({ messages });
    return target.id;
  }, "/src/store/telegramStore.ts");
  expect(targetMessageId).toBeTruthy();

  const latestReply = page.locator('[data-message-id="p-latest-reply-jump"]');
  await expect(latestReply).toBeVisible();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await latestReply.locator(".message-reply-preview").click();

  const target = messageList.locator(`[data-message-id="${targetMessageId}"]`);
  await expect(target).toHaveClass(/is-notification-target/);
  const returnButton = page.getByRole("button", { name: "返回跳转前位置，可回退 1 次" });
  await expect(returnButton).toBeVisible();
  const returnTrace = await returnButton.evaluate((button) => {
    const list = document.querySelector<HTMLElement>(".message-list");
    const samples: number[] = [];
    const started = performance.now();
    const record = () => {
      if (list) samples.push(list.scrollTop);
      if (performance.now() - started < 900) requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
    (button as HTMLElement).click();
    return new Promise<number[]>((resolve) => globalThis.setTimeout(() => resolve(samples), 950));
  });

  const upwardRebounds = returnTrace.slice(1).filter((scrollTop, index) =>
    scrollTop < returnTrace[index] - 1
  );
  expect(upwardRebounds, JSON.stringify(returnTrace)).toHaveLength(0);

  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);
  await page.waitForTimeout(700);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);
});

test("manual bottom navigation and conversation switches clear reply jump history", async ({ page }) => {
  await page.goto("/");
  const source = await revealVirtualMessage(page, "p-channel-reply");
  await source.locator(".message-reply-preview").click();
  await expect(page.getByRole("button", { name: "返回跳转前位置，可回退 1 次" })).toBeVisible();

  const messageList = page.getByRole("log", { name: "消息列表" });
  await messageList.focus();
  await page.keyboard.press("End");
  await expect(page.getByRole("button", { name: /^返回跳转前位置/ })).toHaveCount(0);

  await page.locator(".pinned-message-preview").click();
  await expect(page.getByRole("button", { name: "返回跳转前位置，可回退 1 次" })).toBeVisible();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect(page.getByRole("button", { name: /^返回跳转前位置/ })).toHaveCount(0);
});

test("conversation scroll state follows, restores, counts, and resets to latest", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-row")).not.toHaveCount(0);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  await scrollAwayFromBottom(page);
  const savedAnchor = await visibleMessageAnchor(page);
  expect(savedAnchor.id).toBeTruthy();

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await page.getByRole("button", { name: /产品讨论/ }).click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect.poll(async () => (await visibleMessageAnchor(page)).id).toBe(savedAnchor.id);
  await expect.poll(async () => Math.abs(
    (await visibleMessageAnchor(page)).offset - savedAnchor.offset,
  )).toBeLessThanOrEqual(2);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  for (const text of ["滚动定位测试一", "滚动定位测试二"]) {
    await page.getByRole("textbox", { name: "消息内容" }).fill(text);
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveJSProperty("value", "");
  }
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.getByText("滚动定位测试二", { exact: true })).toBeVisible();
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);

  await page.getByRole("textbox", { name: "消息内容" }).fill("底部自动跟随测试");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);

  await page.locator(".message-list").hover();
  for (let attempt = 0; attempt < 5; attempt += 1) await page.mouse.wheel(0, 600);
  await page.waitForTimeout(180);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  await scrollAwayFromBottom(page);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
});

test("local reading anchor wins over an older unread cursor after switching conversations", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await scrollAwayFromBottom(page);
  const savedAnchor = await visibleMessageAnchor(page);
  expect(savedAnchor.id).toBeTruthy();

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          chats: Map<string, Record<string, unknown>>;
          messages: Map<string, Array<Record<string, unknown>>>;
        };
        setState: (partial: {
          chats: Map<string, Record<string, unknown>>;
          messages: Map<string, Array<Record<string, unknown>>>;
        }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const chats = new Map(state.chats);
    const messages = new Map(state.messages);
    const product = chats.get("chat-product");
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    if (!product || !latest) return;
    chats.set("chat-product", {
      ...product,
      unreadCount: 3,
      lastReadInboxMessageId: current[1]?.id ?? current[0]?.id,
    });
    current.push({
      ...latest,
      id: "p-anchor-regression-live",
      renderKey: undefined,
      senderId: "u-mia",
      outgoing: false,
      delivery: "read",
      sentAt: new Date(Date.now() + 3_000).toISOString(),
      content: { kind: "text", text: "切换期间到达、但不应改变阅读锚点的新消息" },
    });
    messages.set("chat-product", current);
    module.telegramStore.setState({ chats, messages });
  }, "/src/store/telegramStore.ts");

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => (await visibleMessageAnchor(page)).id).toBe(savedAnchor.id);
  await expect.poll(async () => Math.abs(
    (await visibleMessageAnchor(page)).offset - savedAnchor.offset,
  )).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: /跳到最新消息/ })).toBeVisible();
});

test("repeated virtual range changes do not restart detached anchor settlement", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await scrollAwayFromBottom(page);
  const savedAnchor = await visibleMessageAnchor(page);
  expect(savedAnchor.id).toBeTruthy();

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await expect(messageList).toHaveAttribute("aria-busy", "false");

  const result = await page.evaluate(async () => {
    const style = document.createElement("style");
    style.textContent = [
      ".message-list [data-message-id] {",
      "  padding-bottom: var(--notgram-range-churn, 0px) !important;",
      "}",
    ].join("\n");
    document.head.append(style);

    document.querySelector<HTMLElement>('.chat-list[data-active=true] [data-chat-id="chat-product"]')?.click();
    let destinationFrame: number | undefined;
    let settledFrame: number | undefined;
    try {
      for (let frame = 0; frame < 54; frame += 1) {
        document.documentElement.style.setProperty(
          "--notgram-range-churn",
          frame % 2 === 0 ? "0px" : "48px",
        );
        await new Promise<void>((resolve) => requestAnimationFrame(() => {
          globalThis.setTimeout(resolve, 0);
        }));
        const isDestination = document.querySelector(".conversation-title strong")?.textContent ===
          "产品讨论";
        if (!isDestination) continue;
        destinationFrame ??= frame;
        const list = document.querySelector<HTMLElement>(".message-list");
        const settled = list?.getAttribute("aria-busy") === "false" &&
          !document.querySelector("[data-conversation-switch-snapshot]");
        if (settled && settledFrame === undefined) {
          settledFrame = frame - destinationFrame;
        }
      }
    } finally {
      document.documentElement.style.removeProperty("--notgram-range-churn");
      style.remove();
    }

    for (let frame = 0; frame < 30; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const performanceModule = await import("/src/utils/performanceMonitor.ts" as string) as {
      getPerformanceRecords: () => Array<{
        event: string;
        durationMs?: number;
        details: { missingStageMask?: number; timedOut?: boolean };
      }>;
    };
    const trace = performanceModule.getPerformanceRecords()
      .filter((record) => record.event === "ui_conversation_switch")
      .at(-1);
    return {
      settledFrame,
      finalBusy: document.querySelector(".message-list")?.getAttribute("aria-busy"),
      snapshotPresent: Boolean(document.querySelector("[data-conversation-switch-snapshot]")),
      traceDurationMs: trace?.durationMs,
      missingStageMask: trace?.details.missingStageMask,
      timedOut: trace?.details.timedOut,
    };
  });

  expect(result.settledFrame, JSON.stringify(result)).toBeDefined();
  // Allow the 18-frame anchor reconciliation and the bounded snapshot release.
  expect(result.settledFrame!, JSON.stringify(result)).toBeLessThanOrEqual(40);
  expect(result.finalBusy).toBe("false");
  expect(result.snapshotPresent).toBe(false);
  expect(result.missingStageMask).toBe(0);
  expect(result.timedOut).not.toBe(true);
  expect(result.traceDurationMs, JSON.stringify(result)).toBeLessThan(750);
  await expect.poll(async () => (await visibleMessageAnchor(page)).id).toBe(savedAnchor.id);
});

test("window resizing and new messages preserve the user's follow intent", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  await scrollAwayFromBottom(page);
  await expect(page.getByRole("button", { name: "跳到最新消息", exact: true })).toBeVisible();
  const savedAnchor = await visibleMessageAnchor(page);
  expect(savedAnchor.id).toBeTruthy();

  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    if (!latest) return;
    current.push({
      ...latest,
      id: "p-live-resize",
      senderId: "u-mia",
      outgoing: false,
      delivery: "read",
      sentAt: new Date(Date.now() + 1_000).toISOString(),
      content: { kind: "text", text: "缩放期间的锚点消息" },
    });
    messages.set("chat-product", current);
    module.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");
  for (const width of [1180, 1320, 1210, 1280]) {
    await page.setViewportSize({ width, height: 760 });
  }
  await page.waitForTimeout(160);

  const afterResize = await visibleMessageAnchor(page);
  expect(afterResize.id).toBe(savedAnchor.id);
  expect(Math.abs(afterResize.offset - savedAnchor.offset)).toBeLessThanOrEqual(2);
  const jumpButton = page.getByRole("button", { name: "跳到最新消息，1 条新消息" });
  await expect(jumpButton).toBeVisible();

  await jumpButton.click();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await page.getByRole("textbox", { name: "消息内容" }).fill("缩放期间自动跟随");
  await page.getByRole("button", { name: "发送消息" }).click();
  for (const width of [1240, 1340, 1260, 1280]) {
    await page.setViewportSize({ width, height: 760 });
  }
  await page.waitForTimeout(160);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);
});

test("a chat left at the bottom follows a small arrival when the old tail remains visible", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const state = module.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    if (!latest) return;
    current.push({
      ...latest,
      id: "p-return-latest",
      senderId: "u-mia",
      outgoing: false,
      delivery: "read",
      sentAt: new Date(Date.now() + 2_000).toISOString(),
      content: { kind: "text", text: "返回时仍在最新位置" },
    });
    messages.set("chat-product", current);
    module.telegramStore.setState({ messages });
  }, "/src/store/telegramStore.ts");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByText("返回时仍在最新位置", { exact: true })).toBeVisible();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);
  await expect.poll(() => page.locator('[data-message-id="p-video"]').evaluate(row =>
    row.getBoundingClientRect().top - row.closest(".message-list")!.getBoundingClientRect().top))
    .toBeGreaterThanOrEqual(0);
});

test("clicking the selected conversation repeatedly converges to its latest message", async ({ page }) => {
  await page.goto("/");
  const product = page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]');
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await product.click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await product.click();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  const messageList = page.locator(".message-list");
  const settledBottomTrace = await product.evaluate((button) => new Promise<{
    initialDistance: number;
    samples: number[];
  }>((resolve) => {
    const element = document.querySelector<HTMLElement>(".message-list")!;
    const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
    // Only the raw maximum is settled; the footer must remain fully visible.
    element.scrollTop = maximum;
    const initialDistance = element.scrollHeight - element.clientHeight - element.scrollTop;
    const samples: number[] = [element.scrollTop];
    let frames = 0;
    const sample = () => {
      samples.push(element.scrollTop);
      frames += 1;
      if (frames < 24) requestAnimationFrame(sample);
      else resolve({ initialDistance, samples });
    };
    (button as HTMLButtonElement).click();
    requestAnimationFrame(sample);
  }));
  expect(settledBottomTrace.initialDistance).toBeGreaterThanOrEqual(0);
  expect(settledBottomTrace.initialDistance).toBeLessThanOrEqual(1);
  expect(
    Math.max(...settledBottomTrace.samples) - Math.min(...settledBottomTrace.samples),
    JSON.stringify(settledBottomTrace.samples),
  ).toBeLessThanOrEqual(0.5);

  for (let iteration = 0; iteration < 3; iteration += 1) {
    await scrollAwayFromBottom(page);
    const listNode = await messageList.elementHandle();
    if (!listNode) throw new Error("Message list is not mounted");
    await product.click();
    expect(await page.evaluate(
      (node) => node === document.querySelector(".message-list"),
      listNode,
    )).toBe(true);
    await listNode.dispose();
    await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
    await expect(page.locator('[data-message-id="p-video"]')).toBeVisible();
  }
});

test("near and distant latest jumps finish smoothly without a bottom rebound", async ({ page }) => {
  await page.goto("/");
  const list = page.locator(".message-list");
  await expect(list).toHaveAttribute("aria-busy", "false");

  const sampleJump = async (mode: "near" | "far") => page.evaluate(async (jumpMode) => {
    const element = document.querySelector<HTMLElement>(".message-list")!;
    const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = jumpMode === "near"
      ? Math.max(0, maximum - 180)
      : Math.max(0, maximum - element.clientHeight * 2);
    element.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -120,
    }));
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const button = document.querySelector<HTMLButtonElement>(".jump-to-latest");
    if (!button) throw new Error(`Latest button missing for ${jumpMode} jump`);

    const startedAt = performance.now();
    const readSample = () => ({
      elapsed: performance.now() - startedAt,
      scrollTop: element.scrollTop,
      distanceBottom: Math.max(
        0,
        element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    });
    const samples: Array<ReturnType<typeof readSample>> = [readSample()];
    button.click();
    for (let frame = 0; frame < 55; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(readSample());
    }
    return { viewportHeight: element.clientHeight, samples };
  }, mode);

  const near = await sampleJump("near");
  const far = await sampleJump("far");
  for (const [mode, result] of [["near", near], ["far", far]] as const) {
    const distanceDeltas = result.samples.slice(1).map((sample, index) =>
      sample.distanceBottom - result.samples[index].distanceBottom);
    expect(
      distanceDeltas.filter((delta) => delta > 2),
      `${mode}: ${JSON.stringify(result.samples)}`,
    ).toHaveLength(0);
    expect(result.samples.at(-1)?.distanceBottom, mode).toBeLessThanOrEqual(1);
  }

  const nearDistanceDrops = near.samples.slice(1).map((sample, index) =>
    near.samples[index].distanceBottom - sample.distanceBottom);
  expect(Math.max(...nearDistanceDrops)).toBeLessThan(near.viewportHeight * 0.5);

  const farDistanceDrops = far.samples.slice(1).map((sample, index) =>
    far.samples[index].distanceBottom - sample.distanceBottom);
  const snapIndex = farDistanceDrops.findIndex((delta) => delta > far.viewportHeight);
  expect(snapIndex, JSON.stringify(far.samples)).toBeGreaterThanOrEqual(0);
  expect(
    farDistanceDrops.slice(snapIndex + 1).filter((delta) => delta > 0.5).length,
  ).toBeGreaterThan(1);

  const settleTime = (samples: typeof near.samples) => samples.find(
    (sample, index) => sample.distanceBottom <= 1 &&
      samples.slice(index, index + 3).every((next) => next.distanceBottom <= 1),
  )?.elapsed ?? Number.POSITIVE_INFINITY;
  expect(Math.abs(settleTime(near.samples) - settleTime(far.samples))).toBeLessThan(160);
});

test("one upward input loads exactly one history page", async ({ page }) => {
  await page.goto("/");
  const list = page.locator(".message-list");
  await expect(list).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { loadMoreHistory: (chatId: string) => Promise<void> };
        setState: (state: { loadMoreHistory: (chatId: string) => Promise<void> }) => void;
      };
    };
    const original = module.telegramStore.getState().loadMoreHistory;
    let calls = 0;
    module.telegramStore.setState({ loadMoreHistory: async (chatId: string) => {
      calls += 1;
      return original(chatId);
    } });
    Object.assign(globalThis, { __notgramHistoryPageCalls: () => calls });
  }, "/src/store/telegramStore.ts");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  await list.hover();
  await page.mouse.wheel(0, -10_000);
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramHistoryPageCalls: () => number }
  ).__notgramHistoryPageCalls())).toBe(1);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramHistoryPageCalls: () => number }
  ).__notgramHistoryPageCalls())).toBe(1);
});

test("loading older messages preserves the visible message anchor", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-row").first()).toBeAttached();

  const list = page.locator(".message-list");
  await expect(list).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      telegramStore: {
        getState: () => { loadMoreHistory: (chatId: string) => Promise<void> };
        setState: (state: { loadMoreHistory: (chatId: string) => Promise<void> }) => void;
      };
    };
    const original = module.telegramStore.getState().loadMoreHistory;
    let release: (() => void) | undefined;
    module.telegramStore.setState({ loadMoreHistory: async (chatId: string) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return original(chatId);
    } });
    Object.assign(globalThis, {
      __notgramHistoryLoadPending: () => Boolean(release),
      __notgramReleaseHistoryLoad: () => release?.(),
    });
  }, "/src/store/telegramStore.ts");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await list.hover();
  await page.mouse.wheel(0, -10_000);
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramHistoryLoadPending: () => boolean }
  ).__notgramHistoryLoadPending())).toBe(true);
  const before = await list.evaluate((element) => {
    const listBounds = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((candidate) => {
        const bounds = candidate.getBoundingClientRect();
        return bounds.bottom > listBounds.top + 1 && bounds.top < listBounds.bottom - 1;
      });
    return {
      id: row?.dataset.messageId,
      offset: row ? row.getBoundingClientRect().top - listBounds.top : 0,
    };
  });

  expect(before.id).toBeTruthy();
  const frameTrace = await page.evaluate(async ({ messageId }) => {
    const targetGlobal = globalThis as typeof globalThis & {
      __notgramReleaseHistoryLoad: () => void;
    };
    const element = document.querySelector<HTMLElement>(".message-list")!;
    const samples: Array<{
      frame: number;
      offset?: number;
      scrollTop: number;
      scrollHeight: number;
      firstVisibleMessageId?: string;
      snapshotCovered: boolean;
    }> = [];
    targetGlobal.__notgramReleaseHistoryLoad();
    for (let frame = 0; frame < 45; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => {
        globalThis.setTimeout(resolve, 0);
      }));
      const listBounds = element.getBoundingClientRect();
      const target = element.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      const firstVisible = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find((candidate) => {
          const bounds = candidate.getBoundingClientRect();
          return bounds.bottom > listBounds.top + 1 && bounds.top < listBounds.bottom - 1;
        });
      samples.push({
        frame,
        offset: target
          ? target.getBoundingClientRect().top - listBounds.top
          : undefined,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        firstVisibleMessageId: firstVisible?.dataset.messageId,
        snapshotCovered: Boolean(document.querySelector("[data-conversation-history-snapshot]")),
      });
    }
    return samples;
  }, { messageId: before.id! });
  const exposedUnstableFrames = frameTrace.filter((sample) => (
    !sample.snapshotCovered &&
    (sample.offset === undefined || Math.abs(sample.offset - before.offset) > 2)
  ));
  expect(exposedUnstableFrames, JSON.stringify(frameTrace)).toEqual([]);
  expect(frameTrace.some((sample) => sample.snapshotCovered)).toBe(true);
  expect(frameTrace.at(-1)?.snapshotCovered).toBe(false);
  await expect(page.locator("[data-conversation-history-snapshot]")).toHaveCount(0);
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<{ id: string }>> };
      };
    };
    return storeModule.telegramStore.getState().messages.get("chat-product")
      ?.some((message) => message.id === "p-old-1") ?? false;
  }, "/src/store/telegramStore.ts")).toBe(true);
  const loadedIds = await page.locator(".message-row").evaluateAll((rows) =>
    rows.map((row) => (row as HTMLElement).dataset.messageId),
  );
  expect(new Set(loadedIds).size).toBe(loadedIds.length);
  await expect.poll(() => page.locator(
    `.message-row[data-message-id="${before.id}"]`,
  ).evaluate((row, expectedOffset) => Math.abs(
    row.getBoundingClientRect().top -
    (row.closest(".message-list")?.getBoundingClientRect().top ?? 0) -
    expectedOffset,
  ), before.offset)).toBeLessThanOrEqual(2);
});
