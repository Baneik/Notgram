import { expect, test } from "@playwright/test";
import type { Message } from "../../src/telegram/types";
import { latestMessageBottomGap } from "./helpers";

test("a three-digit unread entry positions once without exposing intermediate jumps", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { chats: Map<string, { unreadCount: number }> };
        setState: (partial: { chats: Map<string, { unreadCount: number }> }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const chats = new Map(state.chats);
    const chat = chats.get("chat-chen");
    if (chat) chats.set("chat-chen", { ...chat, unreadCount: 120 });
    storeModule.telegramStore.setState({ chats });
  }, "/src/store/telegramStore.ts");
  const serverChat = page.locator('.chat-list[data-active=true] [data-chat-id="chat-chen"]');
  const unreadBadge = serverChat.locator(".unread-count");
  await expect(unreadBadge).toHaveText("120");
  await expect(unreadBadge).toHaveCSS("font-size", "11px");
  expect((await unreadBadge.boundingBox())!.height).toBe(18);
  await page.evaluate(() => {
    const diagnosticWindow = window as typeof window & {
      __notgramEntryFrames?: Array<{
        busy: string | null;
        placeholder: boolean;
        transitionCovered: boolean;
        snapshotCovered: boolean;
        snapshotMessageCount: number;
        snapshotVisibleMessageCount: number;
        messageCount: number;
        scrollTop: number;
      }>;
    };
    diagnosticWindow.__notgramEntryFrames = [];
    const startedAt = performance.now();
    const sample = () => {
      const activeChatId = document.querySelector<HTMLElement>(
        '.chat-list[data-active=true] .chat-row[aria-current="true"]',
      )?.dataset.chatId;
      const list = document.querySelector<HTMLElement>(".message-list");
      const shell = document.querySelector<HTMLElement>(".message-list-shell");
      if (activeChatId === "chat-chen" && list && shell) {
        diagnosticWindow.__notgramEntryFrames?.push({
          busy: list.getAttribute("aria-busy"),
          placeholder: Boolean(shell.querySelector(".message-positioning-placeholder")),
          transitionCovered: document.documentElement.classList.contains(
            "is-conversation-view-transition",
          ),
          snapshotCovered: Boolean(document.querySelector("[data-conversation-switch-snapshot]")),
          snapshotMessageCount: Number(document.querySelector<HTMLElement>(
            "[data-conversation-switch-snapshot]",
          )?.dataset.snapshotMessageCount ?? 0),
          snapshotVisibleMessageCount: Number(document.querySelector<HTMLElement>(
            "[data-conversation-switch-snapshot]",
          )?.dataset.snapshotVisibleMessageCount ?? 0),
          messageCount: list.querySelectorAll("[data-message-id]").length,
          scrollTop: Math.round(list.scrollTop),
        });
      }
      if (performance.now() - startedAt < 2_000) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  await serverChat.click();
  await expect(serverChat).toHaveAttribute("aria-current", "true");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-message-id="c-old-25"]')).toBeVisible();

  const result = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".message-list")!;
    const target = document.querySelector<HTMLElement>('[data-message-id="c-old-25"]')!;
    const latest = document.querySelector<HTMLElement>('[data-message-id="c-2"]');
    const listBounds = list.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    const frames = (window as typeof window & {
      __notgramEntryFrames?: Array<{
        busy: string | null;
        placeholder: boolean;
        transitionCovered: boolean;
        snapshotCovered: boolean;
        snapshotMessageCount: number;
        snapshotVisibleMessageCount: number;
        messageCount: number;
        scrollTop: number;
      }>;
    }).__notgramEntryFrames ?? [];
    const placeholderFrames = frames.filter((frame) => frame.placeholder);
    const transitionCoveredFrames = frames.filter((frame) => frame.transitionCovered);
    const snapshotCoveredFrames = frames.filter((frame) => frame.snapshotCovered);
    const exposedPositions = new Set(
      frames.filter(
        (frame) => frame.busy === "false" && !frame.placeholder && !frame.transitionCovered &&
          !frame.snapshotCovered && frame.messageCount > 0,
      )
        .map((frame) => frame.scrollTop),
    );
    return {
      targetOffset: targetBounds.top - listBounds.top,
      listHeight: listBounds.height,
      latestVisible: Boolean(
        latest && latest.getBoundingClientRect().top < listBounds.bottom &&
        latest.getBoundingClientRect().bottom > listBounds.top,
      ),
      placeholderFrameCount: placeholderFrames.length,
      transitionCoveredFrameCount: transitionCoveredFrames.length,
      snapshotCoveredFrameCount: snapshotCoveredFrames.length,
      emptySnapshotFrameCount: snapshotCoveredFrames.filter(
        (frame) => frame.snapshotMessageCount === 0 || frame.snapshotVisibleMessageCount === 0,
      ).length,
      exposedPositionCount: exposedPositions.size,
      exposedPositions: [...exposedPositions],
      exposedPositionSpan: exposedPositions.size > 0
        ? Math.max(...exposedPositions) - Math.min(...exposedPositions)
        : 0,
      scrollBehavior: getComputedStyle(list).scrollBehavior,
      pseudoOverlayContent: getComputedStyle(
        document.querySelector<HTMLElement>(".message-list-shell")!,
        "::after",
      ).content,
    };
  });
  expect(result.targetOffset, JSON.stringify(result)).toBeGreaterThanOrEqual(-1);
  expect(result.targetOffset, JSON.stringify(result)).toBeLessThan(result.listHeight);
  expect(result.latestVisible).toBe(false);
  expect(
    result.placeholderFrameCount + result.transitionCoveredFrameCount,
  ).toBe(0);
  expect(result.snapshotCoveredFrameCount).toBeGreaterThan(0);
  expect(result.emptySnapshotFrameCount).toBe(0);
  expect(result.exposedPositionSpan, JSON.stringify(result.exposedPositions)).toBeLessThanOrEqual(4);
  expect(result.scrollBehavior).toBe("auto");
  expect(result.pseudoOverlayContent).toBe("none");
  await expect.poll(() => page.evaluate(async (modulePath) => {
    const module = await import(modulePath) as {
      getPerformanceRecords: () => Array<{
        event: string;
        details: { navigationKind?: number; missingStageMask?: number };
      }>;
    };
    return module.getPerformanceRecords()
      .filter((record) => record.event === "ui_conversation_switch")
      .at(-1)?.details.missingStageMask;
  }, "/src/utils/performanceMonitor.ts")).toBe(0);
});

test("conversation switch snapshot preserves the source message geometry", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const geometry = await page.evaluate(async () => {
    const snapshotModule = await (0, eval)(
      'import("/src/utils/conversationSwitchSnapshot.ts")',
    ) as {
      captureConversationSwitchSnapshot: (targetIdentity: string) => {
        element: HTMLElement;
        content: HTMLElement;
      } | undefined;
      removeConversationSwitchSnapshot: (
        snapshot: { element: HTMLElement; content: HTMLElement } | undefined,
      ) => void;
    };
    const sourceList = document.querySelector<HTMLElement>(
      ".conversation .message-list",
    );
    const sourceContent = sourceList?.querySelector<HTMLElement>(".message-list-content");
    if (!sourceList || !sourceContent) throw new Error("Source message list is unavailable");

    const readRows = (list: HTMLElement) => {
      const listBounds = list.getBoundingClientRect();
      return new Map(
        [...list.querySelectorAll<HTMLElement>("[data-message-id]")].flatMap((row) => {
          const bubble = row.querySelector<HTMLElement>(".message-bubble-shell");
          if (!row.dataset.messageId || !bubble) return [];
          const bubbleBounds = bubble.getBoundingClientRect();
          const textBounds = row.querySelector<HTMLElement>(".message-rich-text")
            ?.getBoundingClientRect();
          return [[row.dataset.messageId, {
            left: bubbleBounds.left - listBounds.left,
            right: listBounds.right - bubbleBounds.right,
            top: bubbleBounds.top - listBounds.top,
            bottom: listBounds.bottom - bubbleBounds.bottom,
            width: bubbleBounds.width,
            textWidth: textBounds?.width ?? 0,
            textHeight: textBounds?.height ?? 0,
          }] as const];
        }),
      );
    };
    const readList = (list: HTMLElement, content: HTMLElement) => ({
      clientWidth: list.clientWidth,
      clientHeight: list.clientHeight,
      contentWidth: content.getBoundingClientRect().width,
      scrollTop: list.scrollTop,
      scrollbarWidth: getComputedStyle(list).scrollbarWidth,
      hasPinnedBanner: Boolean(list.parentElement?.querySelector(".pinned-message-banner")),
    });

    const sourceRows = readRows(sourceList);
    const source = readList(sourceList, sourceContent);
    const sourceCanvases = [...sourceList.querySelectorAll<HTMLCanvasElement>("canvas")]
      .map((canvas) => canvas.toDataURL());
    const snapshot = snapshotModule.captureConversationSwitchSnapshot("geometry-test");
    if (!snapshot) throw new Error("Conversation switch snapshot was not captured");
    try {
      const cloneList = snapshot.content.closest<HTMLElement>(".message-list");
      if (!cloneList) throw new Error("Snapshot message list is unavailable");
      const cloneRows = readRows(cloneList);
      const cloneCanvases = [...cloneList.querySelectorAll<HTMLCanvasElement>("canvas")]
        .map((canvas) => canvas.toDataURL());
      const differences = [...sourceRows].flatMap(([id, sourceRow]) => {
        const cloneRow = cloneRows.get(id);
        if (!cloneRow) return [];
        return Object.keys(sourceRow).map((key) =>
          Math.abs(
            sourceRow[key as keyof typeof sourceRow] - cloneRow[key as keyof typeof cloneRow],
          )
        );
      });
      return {
        source,
        clone: readList(cloneList, snapshot.content),
        sharedRows: [...sourceRows.keys()].filter((id) => cloneRows.has(id)).length,
        maxRowDifference: Math.max(0, ...differences),
        canvasCount: sourceCanvases.length,
        canvasPixelsMatch: cloneCanvases.length === sourceCanvases.length &&
          cloneCanvases.every((canvas, index) => canvas === sourceCanvases[index]),
      };
    } finally {
      snapshotModule.removeConversationSwitchSnapshot(snapshot);
    }
  });

  expect(geometry.source.hasPinnedBanner).toBe(true);
  expect(geometry.clone.hasPinnedBanner).toBe(true);
  expect(geometry.clone.scrollbarWidth).toBe(geometry.source.scrollbarWidth);
  expect(geometry.clone.clientWidth).toBe(geometry.source.clientWidth);
  expect(geometry.clone.clientHeight).toBe(geometry.source.clientHeight);
  expect(geometry.clone.contentWidth).toBeCloseTo(geometry.source.contentWidth, 1);
  expect(geometry.clone.scrollTop).toBeCloseTo(geometry.source.scrollTop, 1);
  expect(geometry.sharedRows).toBeGreaterThan(0);
  expect(geometry.maxRowDifference).toBeLessThanOrEqual(0.1);
  expect(geometry.canvasCount).toBeGreaterThan(0);
  expect(geometry.canvasPixelsMatch).toBe(true);
});

test("read conversations settle behind a non-empty switch snapshot", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const sampleChenSwitch = () => page.evaluate(async () => {
    const row = document.querySelector<HTMLElement>('.chat-list[data-active=true] [data-chat-id="chat-chen"]')!;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    const samples: Array<{
      busy: string | null;
      placeholder: boolean;
      transitionCovered: boolean;
      snapshotCovered: boolean;
      messageCount: number;
      distanceBottom: number;
    }> = [];
    let settledFrames = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const activeChatId = document.querySelector<HTMLElement>(
        '.chat-list[data-active=true] .chat-row[aria-current="true"]',
      )?.dataset.chatId;
      const list = document.querySelector<HTMLElement>(".message-list");
      const shell = document.querySelector<HTMLElement>(".message-list-shell");
      if (activeChatId !== "chat-chen" || !list || !shell) continue;
      const sample = {
        busy: list.getAttribute("aria-busy"),
        placeholder: Boolean(shell.querySelector(".message-positioning-placeholder")),
        transitionCovered: document.documentElement.classList.contains(
          "is-conversation-view-transition",
        ),
        snapshotCovered: Boolean(document.querySelector("[data-conversation-switch-snapshot]")),
        messageCount: list.querySelectorAll("[data-message-id]").length,
        distanceBottom: Math.round(list.scrollHeight - list.clientHeight - list.scrollTop),
      };
      samples.push(sample);
      settledFrames = sample.busy === "false" && sample.messageCount > 0 &&
          !sample.transitionCovered && !sample.snapshotCovered
        ? settledFrames + 1
        : 0;
      if (settledFrames >= 8) break;
    }
    return samples;
  });
  const expectOnlyBottomFrames = (frames: Awaited<ReturnType<typeof sampleChenSwitch>>) => {
    const positioned = frames.filter(
      (frame) => frame.busy === "false" && frame.messageCount > 0,
    );
    expect(positioned.length, JSON.stringify(frames)).toBeGreaterThan(0);
    expect(Math.max(...positioned.map((frame) => Math.abs(frame.distanceBottom))))
      .toBeLessThanOrEqual(1);
    expect(frames.some((frame) => frame.snapshotCovered), JSON.stringify(frames)).toBe(true);
  };

  expectOnlyBottomFrames(await sampleChenSwitch());
  await expect(page.locator('[data-message-id="c-2"]')).toBeVisible();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  expectOnlyBottomFrames(await sampleChenSwitch());
});

test("conversation selection, header, and rows commit to one target", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const samples = await page.evaluate(async () => {
    document.querySelector<HTMLElement>('.chat-list[data-active=true] [data-chat-id="chat-chen"]')?.click();
    const frames: Array<{
      activeChatId?: string;
      title?: string;
      snapshot: boolean;
      sourceRowsInTarget: number;
    }> = [];
    let settledFrames = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const activeChatId = document.querySelector<HTMLElement>(
        '.chat-list[data-active=true] .chat-row[aria-current="true"]',
      )?.dataset.chatId;
      if (activeChatId !== "chat-chen") continue;
      const snapshot = document.querySelector<HTMLElement>(
        "[data-conversation-switch-snapshot]",
      );
      const list = document.querySelector<HTMLElement>(".message-list");
      frames.push({
        activeChatId,
        title: document.querySelector<HTMLElement>(".conversation-title strong")?.textContent ??
          undefined,
        snapshot: Boolean(snapshot),
        sourceRowsInTarget: list
          ? [...list.querySelectorAll<HTMLElement>("[data-message-id]")]
            .filter((row) => row.dataset.messageId?.startsWith("p-")).length
          : 0,
      });
      settledFrames = !snapshot && list?.getAttribute("aria-busy") === "false"
        ? settledFrames + 1
        : 0;
      if (settledFrames >= 6) break;
    }
    return frames;
  });

  expect(samples.length).toBeGreaterThan(0);
  expect(samples.every((sample) => sample.activeChatId === "chat-chen"), JSON.stringify(samples))
    .toBe(true);
  expect(samples.every((sample) => sample.title === "陈默"), JSON.stringify(samples)).toBe(true);
  expect(samples.some((sample) => sample.snapshot), JSON.stringify(samples)).toBe(true);
  expect(samples.some((sample) => sample.sourceRowsInTarget > 0), JSON.stringify(samples)).toBe(false);

  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.chat-list[data-active=true] [data-chat-id="chat-product"]')?.click();
    globalThis.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("[data-conversation-switch-snapshot]")).toHaveCount(0);
});

test("stalled background history never leaves source messages over the destination chat", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-chen"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-message-id="c-2"]')).toBeVisible();
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => { histories: Map<string, unknown> };
        setState: (partial: { histories: Map<string, unknown> }) => void;
      };
    };
    const histories = new Map(storeModule.telegramStore.getState().histories);
    histories.set("chat-chen", { loading: true, hasMore: true, initialized: true });
    storeModule.telegramStore.setState({ histories });
  }, "/src/store/telegramStore.ts");

  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-chen"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("陈默");
  await expect(page.locator("[data-conversation-switch-snapshot]")).toHaveCount(0, {
    timeout: 1_000,
  });
  await expect.poll(() => page.locator('.message-list [data-message-id^="c-"]').count())
    .toBeGreaterThan(0);

  const messageIds = await page.locator(".message-list [data-message-id]")
    .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.messageId ?? ""));
  expect(messageIds.length).toBeGreaterThan(0);
  expect(messageIds.some((id) => id.startsWith("p-")), JSON.stringify(messageIds)).toBe(false);
  expect(messageIds.some((id) => id.startsWith("c-")), JSON.stringify(messageIds)).toBe(true);
});

test("initial history completion remounts the list at the latest message", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        };
        setState: (partial: {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const fullHistory = state.messages.get("chat-product") ?? [];
    (window as typeof window & { __notgramFullHistory?: unknown[] }).__notgramFullHistory = fullHistory;
    const messages = new Map(state.messages);
    messages.set("chat-product", fullHistory.slice(-1));
    const histories = new Map(state.histories);
    histories.set("chat-product", { loading: true, hasMore: true, initialized: false });
    storeModule.telegramStore.setState({ messages, histories });
  }, "/src/store/telegramStore.ts");
  await expect(page.locator(".message-list [data-message-id]")).toHaveCount(1);

  await page.evaluate(async (modulePath) => {
    const storeModule = await import(modulePath) as {
      telegramStore: {
        getState: () => {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        };
        setState: (partial: {
          messages: Map<string, unknown[]>;
          histories: Map<string, unknown>;
        }) => void;
      };
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set(
      "chat-product",
      (window as typeof window & { __notgramFullHistory?: unknown[] }).__notgramFullHistory ?? [],
    );
    const histories = new Map(state.histories);
    histories.set("chat-product", { loading: false, hasMore: true, initialized: true });
    storeModule.telegramStore.setState({ messages, histories });
  }, "/src/store/telegramStore.ts");

  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => page.locator(".message-list [data-message-id]").count())
    .toBeGreaterThan(3);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator('[data-message-id="p-video"]')).toBeVisible();
});

test("notification routes select the destination before exact-message loading settles", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  const title = page.locator(".conversation-title strong");
  await expect(title).toHaveText("产品讨论");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  await page.evaluate(async (storePath) => {
    interface TestStoreState {
      activeAccountId: string;
      activeChatId?: string;
      chatListReady: boolean;
      histories: Map<string, { loading: boolean; hasMore: boolean; initialized: boolean }>;
      messages: Map<string, Message[]>;
      loadMessage: (chatId: string, messageId: string) => Promise<boolean>;
    }
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => TestStoreState;
        setState: (partial: Partial<TestStoreState>) => void;
        subscribe: (listener: (state: TestStoreState, previous: TestStoreState) => void) => () => void;
      };
    };
    const store = storeModule.telegramStore;
    const state = store.getState();
    const messages = new Map(state.messages);
    messages.set(
      "chat-mia",
      (messages.get("chat-mia") ?? []).filter((message) => message.id !== "m-3"),
    );
    const histories = new Map(state.histories);
    histories.set("chat-mia", { loading: false, hasMore: true, initialized: true });
    const loadMessage = state.loadMessage;
    store.setState({
      histories,
      messages,
      loadMessage: async (chatId, messageId) => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 1_600));
        return loadMessage(chatId, messageId);
      },
      chatListReady: false,
    });
    const diagnosticWindow = window as typeof window & {
      __notgramNotificationChatSelections?: string[];
    };
    diagnosticWindow.__notgramNotificationChatSelections = [];
    store.subscribe((next, previous) => {
      if (next.activeChatId !== previous.activeChatId && next.activeChatId) {
        diagnosticWindow.__notgramNotificationChatSelections?.push(next.activeChatId);
      }
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    window.sessionStorage.setItem("notgram.pending-notification-route", JSON.stringify({
      accountId: state.activeAccountId,
      chatId: "chat-mia",
      messageId: "m-3",
    }));
    store.setState({ chatListReady: true });
  }, "/src/store/telegramStore.ts");

  await expect(title).toHaveText("Mia Chen", { timeout: 750 });
  await expect(page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]')).toHaveAttribute("aria-current", "true");
  await expect.poll(() => page.evaluate(() => (
    window.sessionStorage.getItem("notgram.pending-notification-route")
  ))).toBeNull();
  await expect(page.locator('[data-message-id="m-3"]')).toHaveClass(/is-notification-target/, {
    timeout: 4_000,
  });
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __notgramNotificationChatSelections?: string[] }
  ).__notgramNotificationChatSelections)).toEqual(["chat-mia"]);
});

test("idle bottom following remains motionless after geometry settles", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await page.waitForTimeout(250);

  const samples = await messageList.evaluate(async (element) => {
    const frames: Array<{
      scrollTop: number;
      distanceBottom: number;
      latestGap: number;
    }> = [];
    for (let frame = 0; frame < 90; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const messages = element.querySelectorAll<HTMLElement>("[data-message-id]");
      const latest = messages.item(messages.length - 1);
      frames.push({
        scrollTop: element.scrollTop,
        distanceBottom: element.scrollHeight - element.clientHeight - element.scrollTop,
        latestGap: latest
          ? element.getBoundingClientRect().bottom - latest.getBoundingClientRect().bottom
          : 0,
      });
    }
    return frames;
  });
  const span = (values: number[]) => Math.max(...values) - Math.min(...values);
  expect(
    Math.max(...samples.map(({ latestGap }) => Math.abs(latestGap))),
    JSON.stringify(samples),
  )
    .toBeLessThanOrEqual(13);
  expect(span(samples.map(({ distanceBottom }) => distanceBottom))).toBeLessThanOrEqual(0.5);
  expect(span(samples.map(({ scrollTop }) => scrollTop))).toBeLessThanOrEqual(0.5);
  expect(span(samples.map(({ latestGap }) => latestGap))).toBeLessThanOrEqual(1);
});

test("rapid alternating conversation clicks commit every latest intent without a cooldown", async ({ page }) => {
  await page.goto("/");
  const product = page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]');
  const mia = page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]');
  await mia.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await product.click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");

  const observations = await page.evaluate(() => {
    const sequence = Array.from({ length: 24 }, (_, index) =>
      index % 2 === 0 ? "chat-mia" : "chat-product");
    return sequence.map((chatId) => {
      document.querySelector<HTMLElement>(`.chat-list[data-active=true] [data-chat-id="${chatId}"]`)?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }),
      );
      return {
        expected: chatId,
        active: document.querySelector<HTMLElement>('.chat-list[data-active=true] .chat-row[aria-current="true"]')?.dataset.chatId,
        transitionCovered: document.documentElement.classList.contains(
          "is-conversation-view-transition",
        ),
      };
    });
  });

  expect(observations.map(({ active }) => active))
    .toEqual(observations.map(({ expected }) => expected));
  expect(observations.some(({ transitionCovered }) => transitionCovered)).toBe(false);
  await expect(page.locator(".conversation-title strong")).toHaveText("产品讨论");
});
