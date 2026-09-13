import { expect, test } from "@playwright/test";
import type { Message } from "../../src/telegram/types";

// Timing budgets need a single attempt without trace recording overhead.
test.use({ trace: "off", screenshot: "only-on-failure" });
test.describe.configure({ retries: 0 });

test("incoming messages do not wait for a bottom pin while reading away from latest", { tag: "@performance" }, async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("button", { name: /^跳到最新消息/ })).toBeVisible();

  const messageId = "m-detached-incoming";
  const report = await page.evaluate(async ({ entrancePath, storePath, targetId }) => {
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Message[]> };
        setState: (partial: { messages: Map<string, Message[]> }) => void;
      };
    };
    const entranceModule = await import(entrancePath) as {
      markMessageEntrance: (message: Message) => void;
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-mia") ?? [])];
    const latest = current.at(-1);
    if (!latest) throw new Error("Missing incoming fixture");
    const appended: Message = {
      ...latest,
      id: targetId,
      renderKey: undefined,
      outgoing: false,
      senderId: "u-mia",
      sentAt: new Date(Date.now() + 2_000).toISOString(),
      content: { kind: "text", text: "离开底部时收到的新消息立即显示" },
    };
    entranceModule.markMessageEntrance(appended);
    current.push(appended);
    messages.set("chat-mia", current);
    const startedAt = performance.now();
    storeModule.telegramStore.setState({ messages });
    let mountedAt: number | undefined;
    while (performance.now() - startedAt < 500) {
      const row = document.querySelector<HTMLElement>(`[data-message-id="${targetId}"]`);
      if (row) {
        mountedAt ??= performance.now();
        const style = getComputedStyle(row);
        if (style.visibility !== "hidden" && Number.parseFloat(style.opacity) > 0) {
          return {
            mountedAt: mountedAt - startedAt,
            visibleAt: performance.now() - startedAt,
            className: row.className,
          };
        }
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    throw new Error("Detached incoming message stayed hidden");
  }, {
    entrancePath: "/src/utils/messageEntrance.ts",
    storePath: "/src/store/telegramStore.ts",
    targetId: messageId,
  });

  expect(report.visibleAt, JSON.stringify(report)).toBeLessThan(250);
  expect(report.className).not.toContain("is-preparing-entrance");
});

test("composer coalesces resizing and persists drafts without blocking input", { tag: "@performance" }, async ({ page }) => {
  await page.goto("/");
  const composer = page.locator(".composer .composer-input");
  await expect(composer).toBeVisible();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const result = await composer.evaluate(async (textarea) => {
    const input = textarea as HTMLElement & { value: string };
    const text = "responsive-input-".repeat(12);
    input.focus();

    const observer = new MutationObserver(() => undefined);
    observer.observe(input, { attributes: true, attributeFilter: ["style"] });
    const startedAt = performance.now();
    for (const [index, character] of [...text].entries()) {
      document.execCommand("insertText", false, character);
      if ((index + 1) % 24 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    const dispatchMs = performance.now() - startedAt;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const styleMutationCount = observer.takeRecords().length;
    observer.disconnect();
    return { dispatchMs, styleMutationCount, text, value: input.value };
  });

  expect(result.value).toBe(result.text);
  expect(result.dispatchMs).toBeLessThan(300);
  expect(result.styleMutationCount).toBeLessThanOrEqual(6);
  await expect.poll(() => page.evaluate(async ({ chatId, modulePath }) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { drafts: Map<string, { text: string }> };
      };
    };
    return storeModule.telegramStore.getState().drafts.get(chatId)?.text;
  }, {
    chatId: "chat-product",
    modulePath: "/src/store/telegramStore.ts",
  })).toBe(result.text);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
});

test("warm conversation switches reuse messages and reveal content promptly", { tag: "@performance" }, async ({ page }) => {
  await page.goto("/");
  const product = page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]');
  const mia = page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]');

  await mia.click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await product.click();
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const messageCounts = async () => page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, unknown[]> };
      };
    };
    const state = storeModule.telegramStore.getState();
    return {
      product: state.messages.get("chat-product")?.length ?? 0,
      mia: state.messages.get("chat-mia")?.length ?? 0,
    };
  }, "/src/store/telegramStore.ts");
  const beforeCounts = await messageCounts();

  const timing = await page.evaluate(async () => {
    const row = document.querySelector<HTMLElement>('.chat-list[data-active=true] [data-chat-id="chat-mia"]')!;
    const startedAt = performance.now();
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    let headerMs: number | undefined;
    let firstMessageMs: number | undefined;
    let contentMs: number | undefined;
    let placeholderFrames = 0;
    let snapshotFrames = 0;
    let emptySnapshotFrames = 0;
    let emptyFramesAfterHeader = 0;
    while (performance.now() - startedAt < 2_000) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (
        headerMs === undefined &&
        document.querySelector(".conversation-title strong")?.textContent === "Mia Chen"
      ) {
        headerMs = performance.now() - startedAt;
      }
      const list = document.querySelector(".message-list");
      const messageCount = list?.querySelectorAll("[data-message-id]").length ?? 0;
      const placeholderVisible = Boolean(document.querySelector(".message-positioning-placeholder"));
      const snapshot = document.querySelector<HTMLElement>(
        "[data-conversation-switch-snapshot]",
      );
      const snapshotVisible = Boolean(snapshot);
      if (placeholderVisible) placeholderFrames += 1;
      if (snapshotVisible) {
        snapshotFrames += 1;
        if (
          Number(snapshot?.dataset.snapshotMessageCount ?? 0) === 0 ||
          Number(snapshot?.dataset.snapshotVisibleMessageCount ?? 0) === 0
        ) {
          emptySnapshotFrames += 1;
        }
      }
      if (
        headerMs !== undefined && messageCount === 0 &&
        !placeholderVisible && !snapshotVisible
      ) {
        emptyFramesAfterHeader += 1;
      }
      if (headerMs !== undefined && firstMessageMs === undefined && messageCount > 0) {
        firstMessageMs = performance.now() - startedAt;
      }
      if (
        firstMessageMs !== undefined &&
        list?.getAttribute("aria-busy") === "false" &&
        !snapshotVisible
      ) {
        contentMs = performance.now() - startedAt;
        break;
      }
    }
    return {
      headerMs,
      firstMessageMs,
      contentMs,
      placeholderFrames,
      snapshotFrames,
      emptySnapshotFrames,
      emptyFramesAfterHeader,
    };
  });

  expect(timing.headerMs).toBeDefined();
  expect(timing.headerMs!).toBeLessThan(100);
  expect(timing.firstMessageMs).toBeDefined();
  expect(timing.firstMessageMs!).toBeLessThan(100);
  expect(timing.contentMs).toBeDefined();
  expect(timing.contentMs!).toBeLessThan(300);
  expect(timing.placeholderFrames).toBe(0);
  expect(timing.snapshotFrames).toBeGreaterThan(0);
  expect(timing.emptySnapshotFrames).toBe(0);
  expect(timing.emptyFramesAfterHeader).toBe(0);

  await product.click();
  await mia.click();
  await product.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  expect(await messageCounts()).toEqual(beforeCounts);
});

test("warm conversation switching coalesces message-list geometry checks", { tag: "@performance" }, async ({ page }) => {
  await page.goto("/");
  const product = page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]');
  const mia = page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]');

  await mia.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await product.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await mia.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const result = await page.evaluate(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
    if (!descriptor?.get) throw new Error("Element.scrollHeight getter is unavailable");
    let scrollHeightReads = 0;
    let readsThisFrame = 0;
    let maxReadsPerFrame = 0;
    Object.defineProperty(Element.prototype, "scrollHeight", {
      ...descriptor,
      get() {
        if (this instanceof HTMLElement && this.classList.contains("message-list")) {
          scrollHeightReads += 1;
          readsThisFrame += 1;
        }
        return descriptor.get!.call(this);
      },
    });

    try {
      document.querySelector<HTMLElement>('.chat-list[data-active=true] [data-chat-id="chat-product"]')?.click();
      let stableFrames = 0;
      for (let frame = 0; frame < 120; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        maxReadsPerFrame = Math.max(maxReadsPerFrame, readsThisFrame);
        readsThisFrame = 0;
        const settled = document.querySelector(".conversation-title strong")?.textContent === "产品讨论" &&
          document.querySelector(".message-list")?.getAttribute("aria-busy") === "false" &&
          !document.querySelector("[data-conversation-switch-snapshot]");
        stableFrames = settled ? stableFrames + 1 : 0;
        if (stableFrames >= 2) break;
      }
      return {
        scrollHeightReads,
        maxReadsPerFrame,
        mountedMessages: document.querySelectorAll(".message-list [data-message-id]").length,
        settled: stableFrames >= 2,
      };
    } finally {
      Object.defineProperty(Element.prototype, "scrollHeight", descriptor);
    }
  });

  expect(result.settled, JSON.stringify(result)).toBe(true);
  expect(result.mountedMessages).toBeGreaterThan(3);
  expect(result.scrollHeightReads).toBeGreaterThan(0);
  expect(result.maxReadsPerFrame, JSON.stringify(result)).toBeLessThanOrEqual(12);
});
