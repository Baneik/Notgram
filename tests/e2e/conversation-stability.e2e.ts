/// <reference types="vite/client" />
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const ready = async (page: Page) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
};

const validateDiagnosticRecords = (records: Array<{ event: string; details: Readonly<Record<string, number | boolean>> }>) => {
  const native = readFileSync(new URL("../../src-tauri/src/telegram.rs", import.meta.url), "utf8");
  const allowed = new Set([...native.split("const ALLOWED_PERFORMANCE_DETAIL_FIELDS")[1]!.split("];", 1)[0]!.matchAll(/"([A-Za-z0-9]+)"/g)].map(match => match[1]));
  for (const record of records) {
    expect(Object.keys(record.details).length).toBeLessThanOrEqual(48);
    expect(record.details.windowId, record.event).toBeDefined();
    expect(record.details.observedAtMs, record.event).toBeDefined();
    for (const [key, value] of Object.entries(record.details)) {
      expect(allowed.has(key), key).toBe(true);
      expect(typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)), key).toBe(true);
    }
  }
};

test("diagnostic bursts correlate wrong row measurements and clamped writes without changing layout", async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const { observeConversationViewportDiagnostics } = await import("/src/utils/conversationViewportDiagnostics.ts" as string) as typeof import("../../src/utils/conversationViewportDiagnostics");
    const { recordConversationMessage, conversationTraceFor, writeConversationScrollTop } = await import("/src/utils/conversationTrace.ts" as string) as typeof import("../../src/utils/conversationTrace");
    const { getPerformanceRecords, subscribePerformanceRecords } = await import("/src/utils/performanceMonitor.ts" as string) as typeof import("../../src/utils/performanceMonitor");
    const list = document.createElement("div");
    list.className = "message-list";
    list.style.cssText = "position:fixed;top:10px;left:10px;width:200px;height:120px;overflow:auto;";
    list.innerHTML = '<div class="message-list-content"><div data-index="5" data-item-index="1005" data-known-size="10" style="height:160px"><div data-virtual-block-id="PRIVATE-PARTITION"><div data-message-id="PRIVATE-ID">PRIVATE CONTENT</div></div></div></div>';
    document.body.append(list);
    const message = { id: "PRIVATE-ID", chatId: "PRIVATE-CHAT", senderId: "PRIVATE-USER", outgoing: false,
      sentAt: "2026-09-11T00:00:00Z", delivery: "read" as const, content: { kind: "text" as const, text: "PRIVATE CONTENT" } };
    const collected: ReturnType<typeof getPerformanceRecords>[number][] = [];
    let expectedIndex = 5;
    const stop = observeConversationViewportDiagnostics(list, () => ({ followLatest: false }), {
      chatId: message.chatId, readState: () => ({ generation: 4 }),
      readModel: () => ({ messages: [message], indexes: new Map([[message.id, expectedIndex]]), firstItemIndex: 1000 }),
    });
    const session = conversationTraceFor(list)!.session;
    const unsubscribe = subscribePerformanceRecords(() => {
      const last = getPerformanceRecords().at(-1)!;
      if (last.details.traceSession === session) collected.push(last);
    });
    const before = { top: list.scrollTop, height: list.scrollHeight, html: list.innerHTML };
    // Let the actual geometry detector trigger, without manually starting a trace.
    await new Promise(resolve => setTimeout(resolve, 1300));
    const after = { top: list.scrollTop, height: list.scrollHeight, html: list.innerHTML };
    expectedIndex = 6;
    await new Promise(resolve => setTimeout(resolve, 300));
    recordConversationMessage(message.chatId, message.id, 16, message, { remote: true });
    writeConversationScrollTop(list, 200, 1);
    const clamped = list.scrollTop;
    await new Promise(resolve => setTimeout(resolve, 200));
    stop(); unsubscribe(); list.remove();
    return { before, after, clamped, records: collected };
  });
  expect(result.after).toEqual(result.before);
  expect(result.records.some(record => record.details.triggerKind === 2)).toBe(true);
  const row = result.records.find(record => record.event === "ui_conversation_row")!.details;
  expect(row).toMatchObject({ knownHeight: 10, rowHeight: 160, blockIndex: 5, itemIndex: 1005, mappingMismatch: false });
  const removed = result.records.find(record => record.details.traceKind === 16)!.details;
  expect(row.firstMessageToken).toBe(removed.messageToken);
  expect(result.records.some(record => record.event === "ui_conversation_member" && record.details.expectedIndex === 6)).toBe(true);
  expect(result.records.some(record => record.details.mappingMismatch === true)).toBe(true);
  expect(result.records.find(record => record.details.traceKind === 4)?.details).toMatchObject({ requestedTop: 200, actualTop: result.clamped });
  expect(JSON.stringify(result.records)).not.toContain("PRIVATE");
  validateDiagnosticRecords(result.records);
});

test("remote deletion and temporary bot expiry share diagnostic identities through ghost cleanup", async ({ page }) => {
  await page.route("**/src/telegram/createTransport.ts", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(
      "return new MockTelegramTransport(", "return window.__diagnosticTransport = new MockTelegramTransport(",
    ) });
  });
  await ready(page);
  await page.locator(".message-list").press("End");
  await page.waitForTimeout(700);
  const result = await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
    const { getPerformanceRecords, subscribePerformanceRecords } = await import("/src/utils/performanceMonitor.ts" as string) as typeof import("../../src/utils/performanceMonitor");
    const { conversationTraceFor } = await import("/src/utils/conversationTrace.ts" as string) as typeof import("../../src/utils/conversationTrace");
    const transport = (window as unknown as { __diagnosticTransport: { listener: (event: import("../../src/telegram/types").TelegramEvent) => void } }).__diagnosticTransport;
    const list = document.querySelector<HTMLElement>(".message-list")!;
    const trace = conversationTraceFor(list)!;
    const session = trace.session;
    const collected: ReturnType<typeof getPerformanceRecords>[number][] = [];
    const unsubscribe = subscribePerformanceRecords(() => {
      const last = getPerformanceRecords().at(-1)!;
      if (last.details.traceSession === session) collected.push(last);
    });
    preferencesStore.setState({ deletedMessageArchiveEnabled: false });
    const state = telegramStore.getState();
    const source = state.messages.get("chat-product")!.find(message => message.id === "p-4")!;
    const bot = { ...source, id: "PRIVATE-BOT-MESSAGE", senderId: "PRIVATE-BOT", isPinned: false,
      sentAt: new Date(Date.parse(state.messages.get("chat-product")!.at(-1)!.sentAt) + 1000).toISOString(),
      replyTo: { kind: "message" as const, messageId: source.id, content: source.content },
      content: { kind: "text" as const, text: "PRIVATE MODERATION NOTICE" } };
    const users = new Map(state.users);
    users.set(bot.senderId, { ...users.values().next().value!, id: bot.senderId, isBot: true });
    telegramStore.setState({ users });
    transport.listener({ type: "message.remove", chatId: source.chatId, messageId: source.id, source: "remote", permanent: true });
    transport.listener({ type: "message.upsert", message: bot, animateEntrance: true });
    await new Promise(resolve => setTimeout(resolve, 700));
    transport.listener({ type: "message.remove", chatId: bot.chatId, messageId: bot.id, source: "remote", permanent: true });
    await new Promise(resolve => setTimeout(resolve, 900));
    trace.flush(); unsubscribe();
    return { records: collected, remainingGhosts: telegramStore.getState().removingMessages.get(source.chatId)?.length ?? 0 };
  });
  const deletions = result.records.filter(record => record.details.traceKind === 16);
  expect(deletions).toHaveLength(2);
  expect(deletions.some(record => record.details.isBot === true)).toBe(true);
  for (const deletion of deletions) {
    expect(deletion.details.remote).toBe(true);
    for (const phase of [17, 18]) expect(result.records.some(record => record.details.traceKind === phase &&
      record.details.messageToken === deletion.details.messageToken)).toBe(true);
  }
  expect(result.remainingGhosts).toBe(0);
  expect(result.records.some(record => record.details.traceKind === 22)).toBe(true);
  expect(result.records.some(record => record.event === "ui_conversation_row")).toBe(true);
  expect(JSON.stringify(result.records)).not.toContain("PRIVATE");
  validateDiagnosticRecords(result.records);
});

test("viewport diagnostics distinguish a reached scroll maximum from ancestor clipping", async ({ page }) => {
  await ready(page);
  const list = page.locator(".message-list");
  await list.press("End");
  const latestDiagnostic = () => page.evaluate(async () => {
    const { getPerformanceRecords } = await import("/src/utils/performanceMonitor.ts" as string) as typeof import("../../src/utils/performanceMonitor");
    return getPerformanceRecords().filter(record => record.event === "ui_conversation_viewport").at(-1)?.details;
  });
  await expect.poll(async () => (await latestDiagnostic())?.latestRowPresent).toBe(true);
  const healthy = (await latestDiagnostic())!;
  expect(healthy.viewportClipPx).toBe(0);
  expect(Number(healthy.latestGapPx)).toBeGreaterThanOrEqual(10);

  // Deliberately extend the scroller behind its clipping shell. Raw scroll
  // metrics alone still report "at bottom", although the message is obscured.
  await list.evaluate(element => { element.style.height = "calc(100% + 18px)"; });
  await list.press("End");
  await expect.poll(async () => Number((await latestDiagnostic())?.viewportClipPx)).toBeGreaterThanOrEqual(17);
  const clipped = (await latestDiagnostic())!;
  expect(Math.abs(Number(clipped.bottomDistancePx))).toBeLessThanOrEqual(1);
  expect(Number(clipped.footerGapPx)).toBeLessThan(-16);
  expect(Number(clipped.latestGapPx)).toBeLessThan(0);
  expect(clipped.followLatest).toBe(true);
  expect(Object.values(clipped).every(value => typeof value === "number" || typeof value === "boolean")).toBe(true);

  // The diagnostic reader neither repairs the fixture nor writes a new offset.
  const top = await list.evaluate(element => element.scrollTop);
  await page.waitForTimeout(2200);
  expect(await list.evaluate(element => element.scrollTop)).toBe(top);
});

for (const width of [390, 1280]) {
  test(`late row resizes preserve every bottom frame across viewport changes (${width}px)`, async ({ page }) => {
    await ready(page);
    await page.locator('.chat-row[data-chat-id="chat-product"]').click();
    await page.setViewportSize({ width, height: 844 });
    const list = page.locator(".message-list");
    await expect(list).toBeVisible();
    await list.press("End");
    await expect(page.locator('[data-message-id="p-video"]')).toBeVisible();
    // Begin after the entry and bottom-follow transactions have settled.
    await page.waitForTimeout(700);

    const result = await list.evaluate(async (element) => {
      const latest = element.querySelector<HTMLElement>('[data-message-id="p-video"]')!;
      const deferredContent = document.createElement("div");
      latest.querySelector(".message-bubble")!.append(deferredContent);
      const samples: Array<{ distance: number; gap: number; height: number }> = [];
      const read = () => samples.push({
        distance: element.scrollHeight - element.clientHeight - element.scrollTop,
        gap: element.getBoundingClientRect().bottom - latest.getBoundingClientRect().bottom,
        height: latest.getBoundingClientRect().height,
      });
      read();
      // Model late child content growth/shrinkage without a parent React commit.
      // Consecutive frames also deliver resizes to an already active request.
      for (const padding of [32, 64, 16, 48, 0]) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => {
          deferredContent.style.height = `${padding}px`;
          setTimeout(resolve, 0);
        }));
        read();
      }
      deferredContent.remove();
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        read();
      }
      const rowMeasurementErrors = [...element.querySelectorAll<HTMLElement>(".message-list-content > [data-index]")]
        .map((row) => Math.abs(Number(row.dataset.knownSize) - row.getBoundingClientRect().height));
      const rows = [...element.querySelectorAll<HTMLElement>(".message-list-content > [data-index]")];
      const subpixelDistances: number[] = [];
      // Each row changes by less than half a pixel, but their sum is visible.
      for (const padding of [0.375, 0.75, 0.375, 0]) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => {
          rows.forEach((row) => { row.style.paddingBottom = `${padding}px`; });
          setTimeout(resolve, 0);
        }));
        subpixelDistances.push(element.scrollHeight - element.clientHeight - element.scrollTop);
      }
      rows.forEach((row) => row.style.removeProperty("padding-bottom"));
      return { samples, paddingTop: getComputedStyle(element).paddingTop, rowMeasurementErrors, subpixelDistances };
    });
    expect(result.paddingTop).toBe("0px");
    expect(Math.max(...result.rowMeasurementErrors), JSON.stringify(result)).toBeLessThanOrEqual(0.05);
    expect(Math.max(...result.samples.map(({ height }) => height)) -
      Math.min(...result.samples.map(({ height }) => height))).toBeGreaterThan(30);
    expect(Math.max(...result.samples.map(({ distance }) => Math.abs(distance))), JSON.stringify(result))
      .toBeLessThanOrEqual(1);
    expect(Math.max(...result.subpixelDistances.map(Math.abs)), JSON.stringify(result)).toBeLessThanOrEqual(1);
    // Integer scroll metrics can differ from the reachable fractional edge.
    expect(Math.min(...result.samples.map(({ gap }) => gap)), JSON.stringify(result)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...result.samples.map(({ gap }) => gap)), JSON.stringify(result)).toBeLessThanOrEqual(13);
    expect(Math.max(...result.samples.map(({ gap }) => gap)) - Math.min(...result.samples.map(({ gap }) => gap)), JSON.stringify(result))
      .toBeLessThanOrEqual(1);
  });
}

const anchor = (page: Page) => page.locator(".message-list").evaluate((list) => {
  const bounds = list.getBoundingClientRect();
  const row = [...list.querySelectorAll<HTMLElement>("[data-message-id]")].find((item) => {
    const rect = item.getBoundingClientRect();
    return rect.bottom > bounds.top + 1 && rect.top < bounds.bottom - 1;
  });
  if (!row?.dataset.messageId) throw new Error("Missing reading anchor");
  return { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - bounds.top };
});

const traceViewport = (page: Page, chatId: string, messageId: string) => page.evaluate(({ chatId, messageId }) => {
  const frames: Array<{ offset: number | null; covered: boolean; first?: string }> = [];
  Object.assign(window, { stabilityFrames: frames, stopStabilityTrace: false });
  const sample = () => {
    const list = document.querySelector<HTMLElement>(".message-list");
    if (list && document.querySelector<HTMLElement>('.chat-row[aria-current="true"]')?.dataset.chatId === chatId) {
      const bounds = list.getBoundingClientRect();
      const target = list.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
      const content = list.querySelector<HTMLElement>(".message-list-content") ?? list;
      frames.push({
        offset: target ? target.getBoundingClientRect().top - bounds.top : null,
        covered: getComputedStyle(content).visibility === "hidden" || Boolean(document.querySelector(
          "[data-conversation-switch-snapshot], [data-conversation-motion-snapshot], .message-positioning-placeholder",
        )),
      });
    }
    if (!(window as unknown as { stopStabilityTrace: boolean }).stopStabilityTrace) {
      requestAnimationFrame(() => setTimeout(sample, 0));
    }
  };
  requestAnimationFrame(sample);
}, { chatId, messageId });

const exposedOffsets = (page: Page) => page.evaluate(() => {
  const state = window as unknown as {
    stopStabilityTrace: boolean;
    stabilityFrames: Array<{ offset: number | null; covered: boolean }>;
  };
  state.stopStabilityTrace = true;
  return state.stabilityFrames.filter((frame) => !frame.covered).map((frame) => frame.offset);
});

test("late row measurements yield to middle autoscroll after the input timeout", async ({ page }) => {
  await ready(page);
  const list = page.locator(".message-list");
  const bounds = await list.boundingBox();
  if (!bounds) throw new Error("Missing message viewport");
  await page.mouse.click(bounds.x + 3, bounds.y + bounds.height * 0.45, { button: "middle" });
  await list.evaluate((element) => {
    element.scrollTop = Math.max(100, element.scrollHeight - element.clientHeight - 500);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(list).toHaveClass(/is-detached/);
  // Middle autoscroll continues after pointerup and the wheel/key quiet window.
  await page.waitForTimeout(700);
  const result = await list.evaluate(async (element) => {
    const top = element.getBoundingClientRect().top;
    const preceding = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((row) => row.getBoundingClientRect().bottom < top && row.querySelector(".message-bubble"));
    if (!preceding) throw new Error("Missing overscanned row above the reading viewport");
    const before = preceding.getBoundingClientRect().height;
    const writes: number[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    Object.defineProperty(element, "scrollTop", {
      configurable: true,
      get() { return descriptor.get!.call(this) as number; },
      set(value: number) { writes.push(value); descriptor.set!.call(this, value); },
    });
    const deferredContent = document.createElement("div");
    deferredContent.style.height = "37px";
    try {
      preceding.querySelector(".message-bubble")!.append(deferredContent);
      for (let frame = 0; frame < 18; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      }
      return { writes, growth: preceding.getBoundingClientRect().height - before };
    } finally {
      Reflect.deleteProperty(element, "scrollTop");
      deferredContent.remove();
    }
  });
  expect(result.growth).toBeGreaterThan(30);
  expect(result.writes, JSON.stringify(result)).toHaveLength(0);
});

const deferReplyContext = (page: Page) => page.evaluate(async () => {
  const { MockTelegramTransport } = await import("/src/telegram/mockTransport.ts" as string) as typeof import("../../src/telegram/mockTransport");
  const original = MockTelegramTransport.prototype.getMessageContext;
  MockTelegramTransport.prototype.getMessageContext = async function (...args) {
    await new Promise<void>((resolve) => Object.assign(window, { releaseContext: resolve }));
    return original.apply(this, args);
  };
});

for (const count of [1, 2, 4]) {
  test(`partial sender history preserves mounted media and every revealed frame (${count} messages)`, async ({ page }) => {
    await ready(page);
    await page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      const source = telegramStore.getState().messages.get("chat-product")![0];
      const messages = Array.from({ length: 40 }, (_, index) => ({
        ...source, id: `stable-partition-${index + 20}`, mediaAlbumId: undefined,
        sentAt: new Date(Date.UTC(2026, 8, 9, 0, index + 20)).toISOString(),
        content: { kind: "media" as const, mediaType: "photo" as const,
          fileName: "cached.jpg", sizeLabel: "18 KB", localPath: "/mock-video-poster.jpg", width: 480, height: 240,
          isDownloaded: true, canDownload: false },
      }));
      telegramStore.setState({ messages: new Map(telegramStore.getState().messages).set("chat-product", messages) });
    });
    const list = page.locator(".message-list");
    await expect(page.locator('[data-message-id="stable-partition-59"] img')).toHaveCSS("opacity", "1");
    await list.hover();
    await page.mouse.wheel(0, -350);
    await page.waitForTimeout(400);
    const result = await page.evaluate(async (count) => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      const list = document.querySelector<HTMLElement>(".message-list")!;
      const bounds = list.getBoundingClientRect();
      const rows = [...list.querySelectorAll<HTMLElement>("[data-message-id]")].filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > bounds.top + 1 && rect.top < bounds.bottom - 1;
      });
      const anchor = rows[0];
      const y = anchor.getBoundingClientRect().y;
      const current = telegramStore.getState().messages.get("chat-product")!;
      telegramStore.setState({ messages: new Map(telegramStore.getState().messages).set("chat-product", [
        ...Array.from({ length: count }, (_, index) => ({ ...current[0], id: `stable-partition-${20 - count + index}`,
          sentAt: new Date(Date.UTC(2026, 8, 9, 0, 20 - count + index)).toISOString() })), ...current,
      ]) });
      const frames = [];
      for (let frame = 0; frame < 40; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const covered = Boolean(document.querySelector("[data-conversation-history-snapshot]"));
        frames.push({ covered,
          sameNodes: rows.every((row) => list.querySelector(`[data-message-id="${row.dataset.messageId}"]`) === row),
          shift: Math.abs(anchor.getBoundingClientRect().y - y),
          opacities: rows.map((row) => Number(getComputedStyle(row.querySelector("img")!).opacity)),
        });
      }
      return frames;
    }, count);
    expect(result.every((frame) => frame.sameNodes), JSON.stringify(result)).toBe(true);
    const exposed = result.filter((frame) => !frame.covered);
    expect(exposed.length).toBeGreaterThan(0);
    expect(exposed.every((frame) => frame.shift <= 2 && frame.opacities.every((opacity) => opacity === 1)), JSON.stringify(result)).toBe(true);
  });
}

for (const delay of [180, 250, 600]) {
  test(`entry feedback ends with viewport readiness (${delay}ms context)`, async ({ page }) => {
    await ready(page);
    await page.evaluate(async (delay) => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      const { MockTelegramTransport } = await import("/src/telegram/mockTransport.ts" as string) as typeof import("../../src/telegram/mockTransport");
      const original = MockTelegramTransport.prototype.getMessageContext;
      MockTelegramTransport.prototype.getMessageContext = async function (...args) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        return original.apply(this, args);
      };
      const chats = new Map(telegramStore.getState().chats);
      chats.set("chat-chen", { ...chats.get("chat-chen")!, unreadCount: 120, lastReadInboxMessageId: "c-old-8" });
      telegramStore.setState({ chats });
    }, delay);
    const frames = await page.evaluate(async () => {
      document.querySelector<HTMLElement>('[data-chat-id="chat-chen"]')!.click();
      const frames = [];
      for (let frame = 0; frame < 100; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const list = document.querySelector<HTMLElement>(".message-list")!;
        frames.push({ ready: list.getAttribute("aria-busy") === "false",
          placeholder: Boolean(document.querySelector(".message-positioning-placeholder")),
          target: Boolean(list.querySelector('[data-message-id="c-old-8"]')) });
      }
      return frames;
    });
    const readyFrames = frames.filter((frame) => frame.ready);
    expect(readyFrames.length).toBeGreaterThan(0);
    expect(readyFrames.every((frame) => frame.target && !frame.placeholder), JSON.stringify(frames)).toBe(true);
  });
}

test("media download updates do not interrupt wheel scrolling in either direction", async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const messages = new Map(telegramStore.getState().messages);
    const source = messages.get("chat-product")![0];
    messages.set("chat-product", Array.from({ length: 60 }, (_, index) => ({
      ...source, id: `scroll-media-${index}`, mediaAlbumId: undefined,
      sentAt: new Date(Date.UTC(2026, 8, 9, 0, index)).toISOString(),
      content: {
        kind: "media" as const, mediaType: index % 2 ? "photo" as const : "video" as const,
        fileName: `scroll-media-${index}.png`, fileId: 99000 + index,
        sizeLabel: "10 MB", size: 10_000_000, width: 480, height: 240,
        canDownload: true, isDownloaded: false, isDownloading: true,
        thumbnailIsDownloading: true, progress: 0.1,
      },
    })));
    telegramStore.setState({ messages });
  });
  const list = page.locator(".message-list");
  await expect(page.locator('[data-message-id="scroll-media-59"]')).toBeVisible();
  await expect.poll(() => list.evaluate(element =>
    element.scrollHeight - element.clientHeight - element.scrollTop,
  )).toBeLessThanOrEqual(13);
  await list.hover();
  await page.mouse.wheel(0, -1200);
  await page.waitForTimeout(450);

  const timer = await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    return window.setInterval(() => {
      const messages = new Map(telegramStore.getState().messages);
      messages.set("chat-product", messages.get("chat-product")!.map(message => (
        message.content.kind === "media" ? {
          ...message, content: { ...message.content, progress: ((message.content.progress ?? 0) + 0.01) % 0.9 },
        } : message
      )));
      telegramStore.setState({ messages });
    }, 30);
  });
  try {
    // Let an idle update acquire an anchor first, then exercise actual browser
    // wheel input while new updates arrive throughout each scroll interval.
    await page.waitForTimeout(120);
    for (const delta of [-160, 160]) {
      for (let step = 0; step < 5; step += 1) {
        const before = await list.evaluate(element => element.scrollTop);
        await page.mouse.wheel(0, delta);
        await page.waitForTimeout(220);
        const movement = await list.evaluate(element => element.scrollTop) - before;
        expect(Math.abs(movement - delta), `wheel ${delta}, step ${step}: moved ${movement}`)
          .toBeLessThanOrEqual(2);
      }
    }
    // Continued progress updates after input settles must not restore an old
    // reading position either.
    const beforeIdle = await anchor(page);
    await page.waitForTimeout(450);
    const afterIdle = await anchor(page);
    expect(afterIdle.id).toBe(beforeIdle.id);
    expect(Math.abs(afterIdle.offset - beforeIdle.offset)).toBeLessThanOrEqual(2);
  } finally {
    await page.evaluate(timer => window.clearInterval(timer), timer);
  }
});

test("a cold unread cursor outside the first page exposes only its settled viewport", async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const { MockTelegramTransport } = await import("/src/telegram/mockTransport.ts" as string) as typeof import("../../src/telegram/mockTransport");
    const original = MockTelegramTransport.prototype.getMessageContext;
    MockTelegramTransport.prototype.getMessageContext = async function (...args) {
      await new Promise<void>((resolve) => Object.assign(window, { releaseContext: resolve }));
      return original.apply(this, args);
    };
    const chats = new Map(telegramStore.getState().chats);
    chats.set("chat-chen", { ...chats.get("chat-chen")!, unreadCount: 120, lastReadInboxMessageId: "c-old-8" });
    telegramStore.setState({ chats });
  });
  await traceViewport(page, "chat-chen", "c-old-8");
  await page.locator('[data-chat-id="chat-chen"]').click();
  await page.waitForFunction(() => Boolean((window as unknown as { releaseContext?: () => void }).releaseContext));
  await page.waitForTimeout(600);
  await page.evaluate(() => (window as unknown as { releaseContext: () => void }).releaseContext());
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-message-id="c-old-8"]')).toBeVisible();
  await page.waitForTimeout(200);
  const offsets = await exposedOffsets(page);
  expect(offsets.length).toBeGreaterThan(0);
  expect(offsets).not.toContain(null);
  const measured = offsets as number[];
  expect(Math.max(...measured) - Math.min(...measured), JSON.stringify(offsets)).toBeLessThanOrEqual(2);
});

for (const retainedPrefix of [false, true]) {
  test(`a delayed history page preserves the position reached while it was loading (retained prefix: ${retainedPrefix})`, async ({ page }) => {
    await ready(page);
    if (retainedPrefix) {
      await page.evaluate(async () => {
        const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
        const current = telegramStore.getState().messages.get("chat-product")!;
        const archive = { ...current[0], id: "old-retained-prefix", isLocallyDeleted: true,
          locallyDeletedAt: new Date().toISOString(), sentAt: "2020-01-01T00:00:00Z" };
        telegramStore.setState({ messages: new Map(telegramStore.getState().messages).set("chat-product", [archive, ...current]) });
      });
    }
    await page.evaluate(async () => {
      const { MockTelegramTransport } = await import("/src/telegram/mockTransport.ts" as string) as typeof import("../../src/telegram/mockTransport");
      const original = MockTelegramTransport.prototype.loadChatHistory;
      MockTelegramTransport.prototype.loadChatHistory = async function (...args) {
        await new Promise<void>((resolve) => Object.assign(window, { releaseHistory: resolve }));
        return original.apply(this, args);
      };
    });
    const list = page.locator(".message-list");
    await list.hover();
    await page.mouse.wheel(0, -10000);
    await page.waitForFunction(() => Boolean((window as unknown as { releaseHistory?: () => void }).releaseHistory));
    await page.mouse.wheel(0, 220);
    await page.waitForTimeout(450);
    const before = await anchor(page);
    await traceViewport(page, "chat-product", before.id);
    await page.evaluate(() => (window as unknown as { releaseHistory: () => void }).releaseHistory());
    await expect(list).toHaveAttribute("aria-busy", "false");
    await page.waitForTimeout(600);
    const offsets = await exposedOffsets(page);
    expect(offsets.length).toBeGreaterThan(0);
    expect(offsets).not.toContain(null);
    expect(Math.max(...offsets.map((offset) => Math.abs(offset! - before.offset))), JSON.stringify(offsets))
      .toBeLessThanOrEqual(2);
  });
}

test("background messages on both sides preserve a detached reading viewport", async ({ page }) => {
  await ready(page);
  const list = page.locator(".message-list");
  await list.hover();
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(450);
  const before = await anchor(page);
  await traceViewport(page, "chat-product", before.id);
  await page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const { upsertMessages } = await import("/src/store/telegramStore.messages.ts" as string) as typeof import("../../src/store/telegramStore.messages");
    const messages = new Map(telegramStore.getState().messages);
    const current = messages.get("chat-product")!;
    const source = current[0];
    const additions = Array.from({ length: 45 }, (_, index) => ({
      ...source, id: `background-older-${index}`, mediaAlbumId: undefined,
      sentAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      content: { kind: "text" as const, text: "Older variable height message. ".repeat(index % 7 + 1) },
    }));
    messages.set("chat-product", upsertMessages(current, [...additions, {
      ...source, id: "background-newer", sentAt: "2027-01-01T00:00:00Z",
      content: { kind: "text", text: "Newer background message" },
    }]));
    telegramStore.setState({ messages });
  });
  await page.waitForTimeout(750);
  const offsets = await exposedOffsets(page);
  expect(offsets.length).toBeGreaterThan(0);
  expect(offsets).not.toContain(null);
  expect(Math.max(...offsets.map((offset) => Math.abs(offset! - before.offset))), JSON.stringify(offsets))
    .toBeLessThanOrEqual(2);
});

test("a slow reply keeps its origin still and reveals one continuous target motion", async ({ page }) => {
  await ready(page);
  const reply = page.locator('[data-message-id="p-channel-reply"] .message-reply-preview');
  await page.locator(".message-list").hover();
  await page.mouse.wheel(0, -1);
  await reply.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await deferReplyContext(page);
  const before = await anchor(page);
  await traceViewport(page, "chat-product", before.id);
  await reply.click();
  await page.waitForFunction(() => Boolean((window as unknown as { releaseContext?: () => void }).releaseContext));
  await expect(page.getByRole("status", { name: "正在加载消息" })).toBeVisible();
  const originOffsets = await exposedOffsets(page);
  expect(originOffsets).not.toContain(null);
  expect(Math.max(...originOffsets.map((offset) => Math.abs(offset! - before.offset))))
    .toBeLessThanOrEqual(2);
  await traceViewport(page, "chat-product", "p-old-8");
  await page.evaluate(() => (window as unknown as { releaseContext: () => void }).releaseContext());
  await expect(page.locator('[data-message-id="p-old-8"]')).toHaveClass(/is-notification-target/);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const offsets = (await exposedOffsets(page)).filter((offset): offset is number => offset !== null);
  const changes = offsets.slice(1).map((offset, index) => offset - offsets[index]).filter((change) => Math.abs(change) > 2);
  expect(changes.some((change) => change > 0) && changes.some((change) => change < 0), JSON.stringify(offsets)).toBe(false);
  await expect(page.locator('[data-conversation-motion-snapshot]')).toHaveCount(0);
});

test("user scrolling cancels a reply that is still loading", async ({ page }) => {
  await ready(page);
  const reply = page.locator('[data-message-id="p-channel-reply"] .message-reply-preview');
  await page.locator(".message-list").hover();
  await page.mouse.wheel(0, -1);
  await reply.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await deferReplyContext(page);
  await reply.click();
  await page.waitForFunction(() => Boolean((window as unknown as { releaseContext?: () => void }).releaseContext));
  await page.locator(".message-list").hover();
  await page.mouse.wheel(0, -180);
  await page.waitForTimeout(400);
  const before = await anchor(page);
  await traceViewport(page, "chat-product", before.id);
  await page.evaluate(() => (window as unknown as { releaseContext: () => void }).releaseContext());
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.waitForTimeout(650);
  const offsets = await exposedOffsets(page);
  expect(offsets).not.toContain(null);
  expect(Math.max(...offsets.map((offset) => Math.abs(offset! - before.offset))), JSON.stringify(offsets))
    .toBeLessThanOrEqual(2);
  await expect(page.locator('[data-message-id="p-old-8"].is-notification-target')).toHaveCount(0);
});
