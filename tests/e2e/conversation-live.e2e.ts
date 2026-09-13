import { expect, test } from "@playwright/test";
import type { Message } from "../../src/telegram/types";
import { messageListMetrics, latestMessageBottomGap } from "./helpers";

test("live messages animate without replaying history rows", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".message-row.is-entering-incoming, .message-row.is-entering-outgoing"))
    .toHaveCount(0);

  const entranceReport = page.evaluate(() => new Promise<{
    className: string;
    awaitingEntranceObserved: boolean;
    rowBottom: number;
    listBottom: number;
    composerTop: number;
    opacity: number;
    animationDuration: string;
  }>((resolve) => {
    let awaitingEntranceObserved = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector(".message-row.is-awaiting-entrance")) {
        awaitingEntranceObserved = true;
      }
      const entering = document.querySelector<HTMLElement>(".message-row.is-entering-outgoing");
      if (!entering) return;
      const list = entering.closest<HTMLElement>(".message-list");
      const composer = document.querySelector<HTMLElement>(".composer-wrap");
      observer.disconnect();
      resolve({
        className: entering.className,
        awaitingEntranceObserved,
        rowBottom: entering.getBoundingClientRect().bottom,
        listBottom: list?.getBoundingClientRect().bottom ?? Number.NEGATIVE_INFINITY,
        composerTop: composer?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
        opacity: Number.parseFloat(getComputedStyle(entering).opacity),
        animationDuration: getComputedStyle(entering).animationDuration,
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    globalThis.setTimeout(() => {
      observer.disconnect();
      resolve({
        className: "",
        awaitingEntranceObserved,
        rowBottom: Number.POSITIVE_INFINITY,
        listBottom: Number.NEGATIVE_INFINITY,
        composerTop: Number.NEGATIVE_INFINITY,
        opacity: 0,
        animationDuration: "",
      });
    }, 2_000);
  }));
  await page.getByRole("textbox", { name: "消息内容" }).fill("动画消息测试");
  await page.getByRole("button", { name: "发送消息" }).click();

  const report = await entranceReport;
  expect(report.className).toContain("is-entering-outgoing");
  expect(report.awaitingEntranceObserved).toBe(false);
  expect(report.rowBottom).toBeLessThanOrEqual(report.listBottom + 1);
  expect(report.listBottom).toBeLessThanOrEqual(report.composerTop + 1);
  expect(report.opacity).toBeGreaterThanOrEqual(0.99);
  expect(report.animationDuration).toBe("0.12s");
  await expect(page.getByText("动画消息测试", { exact: true })).toBeVisible();
  await expect(page.locator(".message-row.is-entering-outgoing")).toHaveCount(0);
});

test("new messages stay pinned without viewport rebound", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  const composer = page.getByRole("textbox", { name: "消息内容" });
  await composer.fill("逐帧滚动稳定性测试");
  const samplesPromise = page.evaluate(() => new Promise<Array<{
    scrollTop: number;
    distanceBottom: number;
    rowBottom?: number;
    rowVisible: boolean;
    listBottom: number;
  }>>((resolve) => {
    const samples: Array<{
      scrollTop: number;
      distanceBottom: number;
      rowBottom?: number;
      rowVisible: boolean;
      listBottom: number;
    }> = [];
    let frames = 0;
    const sample = () => {
      const list = document.querySelector<HTMLElement>(".message-list");
      const row = [...document.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find((candidate) => candidate.textContent?.includes("逐帧滚动稳定性测试"));
      if (list) {
        samples.push({
          scrollTop: list.scrollTop,
          distanceBottom: list.scrollHeight - list.clientHeight - list.scrollTop,
          rowBottom: row?.getBoundingClientRect().bottom,
          rowVisible: Boolean(row && getComputedStyle(row).visibility !== "hidden"),
          listBottom: list.getBoundingClientRect().bottom,
        });
      }
      frames += 1;
      if (frames < 90) requestAnimationFrame(sample);
      else resolve(samples);
    };
    requestAnimationFrame(sample);
  }));

  await page.getByRole("button", { name: "发送消息" }).click();
  const samples = await samplesPromise;
  const afterAppend = samples.findIndex((sample) => sample.rowBottom !== undefined);
  expect(afterAppend).toBeGreaterThanOrEqual(0);
  const visibleSamples = samples.slice(afterAppend);
  const viewportRebounds = visibleSamples.slice(1).filter((sample, index) =>
    sample.scrollTop < visibleSamples[index].scrollTop - 8,
  );
  expect(viewportRebounds, JSON.stringify(visibleSamples)).toHaveLength(0);
  const animatedSamples = visibleSamples.filter((sample) => sample.rowVisible);
  expect(
    animatedSamples.every((sample) =>
      sample.rowBottom !== undefined && sample.rowBottom <= sample.listBottom + 1
    ),
    JSON.stringify(visibleSamples),
  ).toBe(true);
  const bubbleRebounds = animatedSamples.slice(1).filter((sample, index) =>
    sample.rowBottom !== undefined && animatedSamples[index].rowBottom !== undefined &&
    sample.rowBottom > animatedSamples[index].rowBottom! + 0.5,
  );
  expect(bubbleRebounds, JSON.stringify(animatedSamples)).toHaveLength(0);
  expect(visibleSamples.at(-1)?.distanceBottom).toBeLessThanOrEqual(13);
  expect(Math.abs(
    (visibleSamples.at(-1)?.listBottom ?? 0) - (visibleSamples.at(-1)?.rowBottom ?? 0),
  )).toBeLessThanOrEqual(13);
});

test("incoming animated messages remain visible while following latest", async ({ page }) => {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
  await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: /^跳到最新消息/ }).click();
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);

  const appendIncoming = (id: string, text: string) => page.evaluate(async ({
    storePath,
    entrancePath,
    messageId,
    messageText,
  }) => {
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const entranceModule = await import(entrancePath) as {
      markMessageEntrance: (message: Record<string, unknown>) => void;
    };
    const state = storeModule.telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-mia") ?? [])];
    const latest = current.at(-1);
    if (!latest) return;
    const appended = {
      ...latest,
      id: messageId,
      renderKey: undefined,
      outgoing: false,
      senderId: "u-mia",
      sentAt: new Date(Date.now() + 2_000).toISOString(),
      content: { kind: "text", text: messageText },
    };
    entranceModule.markMessageEntrance(appended);
    current.push(appended);
    messages.set("chat-mia", current);
    storeModule.telegramStore.setState({ messages });
  }, {
    storePath: "/src/store/telegramStore.ts",
    entrancePath: "/src/utils/messageEntrance.ts",
    messageId: id,
    messageText: text,
  });

  const samplesPromise = page.evaluate(() => new Promise<Array<{
    animationName: string;
    distanceBottom: number;
    rowBottom: number;
    listBottom: number;
    rowVisible: boolean;
    opacity: number;
  }>>((resolve) => {
    const samples: Array<{
      animationName: string;
      distanceBottom: number;
      rowBottom: number;
      listBottom: number;
      rowVisible: boolean;
      opacity: number;
    }> = [];
    let frames = 0;
    const sample = () => {
      const list = document.querySelector<HTMLElement>(".message-list");
      const row = document.querySelector<HTMLElement>('[data-message-id="m-live-incoming"]');
      if (!list || !row) {
        requestAnimationFrame(sample);
        return;
      }
      const style = getComputedStyle(row);
      samples.push({
        animationName: style.animationName,
        distanceBottom: list.scrollHeight - list.clientHeight - list.scrollTop,
        rowBottom: row.getBoundingClientRect().bottom,
        listBottom: list.getBoundingClientRect().bottom,
        rowVisible: style.visibility !== "hidden",
        opacity: Number.parseFloat(style.opacity),
      });
      frames += 1;
      if (frames < 24) requestAnimationFrame(sample);
      else resolve(samples);
    };
    requestAnimationFrame(sample);
  }));

  await appendIncoming("m-live-incoming", "实时收到的新消息需要完整播放入场动画");

  const samples = await samplesPromise;
  const animatedSamples = samples.filter(
    (sample) => sample.animationName === "message-enter-incoming",
  );
  expect(animatedSamples.length, JSON.stringify(samples)).toBeGreaterThan(0);
  expect(
    samples.filter((sample) => sample.rowVisible)
      .every((sample) => sample.rowBottom <= sample.listBottom + 1),
    JSON.stringify(samples),
  ).toBe(true);
  expect(
    animatedSamples.every((sample) => sample.rowBottom <= sample.listBottom + 1),
    JSON.stringify(samples),
  ).toBe(true);
  expect(
    animatedSamples.every((sample) => sample.distanceBottom <= 1),
    JSON.stringify(samples),
  ).toBe(true);
  expect(
    animatedSamples.every((sample) => sample.opacity >= 0.99),
    JSON.stringify(samples),
  ).toBe(true);
  expect(samples.at(-1)?.distanceBottom).toBeLessThanOrEqual(1);
  await appendIncoming("m-live-incoming-next", "下一条实时消息仍应自动跟随");
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeLessThanOrEqual(1);
  await expect.poll(() => page.locator('[data-message-id="m-live-incoming-next"]')
    .evaluate((row) => {
      const list = row.closest<HTMLElement>(".message-list");
      return list ? list.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom : -1;
    })).toBeGreaterThanOrEqual(-1);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);
});

test("expired entrance metadata does not delay appended-message anchoring", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  const firstMountedFrame = page.evaluate(() => new Promise<{
    className: string;
    visibility: string;
    rowBottom: number;
    listBottom: number;
  }>((resolve) => {
    const observer = new MutationObserver(() => {
      const row = document.querySelector<HTMLElement>('[data-message-id="p-expired-entrance"]');
      const list = document.querySelector<HTMLElement>(".message-list");
      if (!row || !list) return;
      observer.disconnect();
      resolve({
        className: row.className,
        visibility: getComputedStyle(row).visibility,
        rowBottom: row.getBoundingClientRect().bottom,
        listBottom: list.getBoundingClientRect().bottom,
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  }));

  await page.evaluate(async ({ storePath, entrancePath }) => {
    const storeModule = await import(storePath) as {
      telegramStore: {
        getState: () => { messages: Map<string, Array<Record<string, unknown>>> };
        setState: (partial: { messages: Map<string, Array<Record<string, unknown>>> }) => void;
      };
    };
    const entranceModule = await import(entrancePath) as {
      markMessageEntrance: (message: Record<string, unknown>) => void;
    };
    const { telegramStore } = storeModule;
    const { markMessageEntrance } = entranceModule;
    const state = telegramStore.getState();
    const messages = new Map(state.messages);
    const current = [...(messages.get("chat-product") ?? [])];
    const latest = current.at(-1);
    if (!latest) return;
    const appended = {
      ...latest,
      id: "p-expired-entrance",
      renderKey: undefined,
      outgoing: false,
      senderId: "u-mia",
      sentAt: new Date(Date.now() + 2_000).toISOString(),
      content: { kind: "text", text: "延迟挂载的新消息" },
    };
    markMessageEntrance(appended);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_100));
    current.push(appended);
    messages.set("chat-product", current);
    telegramStore.setState({ messages });
  }, {
    storePath: "/src/store/telegramStore.ts",
    entrancePath: "/src/utils/messageEntrance.ts",
  });

  const report = await firstMountedFrame;
  expect(report.className).not.toContain("is-entering-");
  expect(
    report.visibility === "hidden" || report.rowBottom <= report.listBottom + 1,
    JSON.stringify(report),
  ).toBe(true);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator('[data-message-id="p-expired-entrance"]')).toBeVisible();
});

test("downward wheel input at the exact bottom never rebounds", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await page.waitForTimeout(400);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);

  const samplesPromise = page.evaluate(() => new Promise<number[]>((resolve) => {
    const samples: number[] = [];
    let frames = 0;
    const sample = () => {
      const list = document.querySelector<HTMLElement>(".message-list");
      if (list) samples.push(list.scrollHeight - list.clientHeight - list.scrollTop);
      frames += 1;
      if (frames < 45) requestAnimationFrame(sample);
      else resolve(samples);
    };
    requestAnimationFrame(sample);
  }));
  await messageList.hover();
  for (let attempt = 0; attempt < 8; attempt += 1) await page.mouse.wheel(0, 600);
  const samples = await samplesPromise;
  const directions = samples.slice(1)
    .map((sample, index) => sample - samples[index])
    .filter((delta) => Math.abs(delta) > 1)
    .map((delta) => Math.sign(delta));
  const reversals = directions.slice(1)
    .filter((direction, index) => direction !== directions[index]);
  expect(reversals, JSON.stringify(samples)).toHaveLength(0);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
});

test("downward wheel input consumes the remaining end gap above the composer", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
    const messages = new Map(telegramStore.getState().messages);
    const text = "最后一条消息的正文保持完整，时间和引用来源应当位于输入栏上方。\n\nSource";
    messages.set("chat-product", messages.get("chat-product")!.map(message => message.id === "p-video"
      ? { ...message, content: { kind: "text", text, entities: [
        { kind: "bold", offset: 0, length: text.length },
        { kind: "blockquote", offset: text.indexOf("Source"), length: 6 },
      ] } }
      : message));
    telegramStore.setState({ messages });
  });
  const latest = page.locator('[data-message-id="p-video"]');
  await expect(latest.locator(".rich-blockquote")).toBeVisible();
  await messageList.press("End");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await page.waitForTimeout(500);

  for (const remaining of [13, 8, 2]) {
    // A small upward wheel leaves following mode before setting a deterministic
    // final downward step; only real wheel input may finish the scroll.
    await messageList.hover();
    await messageList.dispatchEvent("wheel", { deltaY: -1 });
    await messageList.evaluate((element, gap) => {
      element.scrollTop = element.scrollHeight - element.clientHeight - gap;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, remaining);
    await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
      .toBeCloseTo(remaining, 0);
    await page.mouse.wheel(0, 100);
    await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
      .toBeLessThanOrEqual(1);
    const geometry = await latest.evaluate(element => {
      const composerTop = document.querySelector(".composer")!.getBoundingClientRect().top;
      return {
        gap: composerTop - element.getBoundingClientRect().bottom,
        metadataGap: composerTop - element.querySelector(".message-meta")!.getBoundingClientRect().bottom,
      };
    });
    expect(geometry.gap).toBeGreaterThanOrEqual(10);
    expect(geometry.gap).toBeLessThanOrEqual(13);
    expect(geometry.metadataGap).toBeGreaterThanOrEqual(10);
  }
});

test("blank message viewport clicks never force a bottom correction", async ({ page }) => {
  await page.goto("/");
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await page.waitForTimeout(400);

  // Establish the offset with user input. A script-only displacement while
  // following latest now correctly requests a bounded bottom settlement.
  await messageList.hover();
  await page.mouse.wheel(0, -26);
  await page.waitForTimeout(400);
  const before = await messageList.evaluate(element => ({
    top: element.scrollTop,
    distance: element.scrollHeight - element.clientHeight - element.scrollTop,
  }));
  expect(before.distance).toBeGreaterThan(1);
  const bounds = await messageList.boundingBox();
  if (!bounds) throw new Error("Message viewport is not visible");
  await page.mouse.click(bounds.x + 3, bounds.y + bounds.height * 0.45);
  await page.waitForTimeout(120);

  await expect.poll(() => messageList.evaluate((element) => element.scrollTop))
    .toBeCloseTo(before.top, 0);
});

test("middle mouse scrolling detaches instead of fighting bottom following", async ({ page }) => {
  await page.goto("/");
  const messageList = page.getByRole("log", { name: "消息列表" });
  const composer = page.getByRole("textbox", { name: "消息内容" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await page.waitForTimeout(400);
  await composer.focus();
  const bounds = await messageList.boundingBox();
  if (!bounds) throw new Error("Message viewport is not visible");

  await page.mouse.click(bounds.x + 3, bounds.y + bounds.height * 0.45, {
    button: "middle",
  });
  await expect(composer).toBeFocused();
  await messageList.evaluate((element) => {
    const maximum = element.scrollHeight - element.clientHeight;
    element.scrollTop = Math.max(0, maximum - 420);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await messageList.evaluate((element) => {
    element.scrollTop = Math.min(
      element.scrollHeight - element.clientHeight,
      element.scrollTop + 180,
    );
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeGreaterThan(160);
  await page.waitForTimeout(120);

  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeGreaterThan(160);
  await expect.poll(() => page.evaluate(async () => {
    const state = await (0, eval)('import("/src/hooks/conversationScrollState.ts")') as {
      conversationScrollMemory: Map<string, { followLatest: boolean }>;
    };
    return [...state.conversationScrollMemory.values()].at(-1)?.followLatest;
  })).toBe(false);
});

test("primary pointer scrolling still detaches from latest messages", async ({ page }) => {
  await page.goto("/");
  const messageList = page.getByRole("log", { name: "消息列表" });
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  const bounds = await messageList.boundingBox();
  if (!bounds) throw new Error("Message viewport is not visible");

  await page.mouse.move(bounds.x + 3, bounds.y + bounds.height * 0.45);
  await page.mouse.down();
  await messageList.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollTop - 240);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeGreaterThan(32);
  await expect.poll(() => page.evaluate(async () => {
    const state = await (0, eval)('import("/src/hooks/conversationScrollState.ts")') as {
      conversationScrollMemory: Map<string, { followLatest: boolean }>;
    };
    return [...state.conversationScrollMemory.values()].at(-1)?.followLatest;
  })).toBe(false);
  await page.mouse.up();
  await page.waitForTimeout(120);

  await expect.poll(async () => (await messageListMetrics(page)).distanceBottom)
    .toBeGreaterThan(32);
  await expect(page.getByRole("button", { name: /跳到最新消息/ })).toBeVisible();
});

test("appended mixed-height row growth during downward wheel input stays pinned", async ({ page }) => {
  await page.goto("/");
  const messageList = page.locator(".message-list");
  await expect(messageList).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await page.waitForTimeout(400);

  await messageList.hover();
  await messageList.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    }));
  });

  const samplesPromise = page.evaluate(() => new Promise<Array<{
    scrollTop: number;
    distanceBottom: number;
  }>>((resolve) => {
    const samples: Array<{ scrollTop: number; distanceBottom: number }> = [];
    let frames = 0;
    const sample = () => {
      const list = document.querySelector<HTMLElement>(".message-list");
      if (list) {
        samples.push({
          scrollTop: list.scrollTop,
          distanceBottom: list.scrollHeight - list.clientHeight - list.scrollTop,
        });
      }
      frames += 1;
      if (frames < 90) requestAnimationFrame(sample);
      else resolve(samples);
    };
    requestAnimationFrame(sample);
  }));

  const growingMessage = "组合高度变化滚动稳定性测试";
  await page.getByRole("textbox", { name: "消息内容" }).fill(growingMessage);
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByText(growingMessage, { exact: true })).toBeVisible();
  await page.evaluate(async (messageText) => {
    const list = document.querySelector<HTMLElement>(".message-list");
    const row = [...document.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((candidate) => candidate.textContent?.includes(messageText));
    const lastItem = row?.closest<HTMLElement>("[data-index]");
    if (!list || !lastItem) throw new Error("Growing latest virtual item is not mounted");
    const spacer = document.createElement("div");
    spacer.dataset.delayedMeasurement = "true";
    spacer.style.height = "0px";
    lastItem.appendChild(spacer);
    for (let frame = 1; frame <= 16; frame += 1) {
      list.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 120,
      }));
      spacer.style.height = `${frame * 6}px`;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, growingMessage);

  const samples = await samplesPromise;
  const rebounds = samples.slice(1).filter((sample, index) =>
    sample.scrollTop < samples[index].scrollTop - 1 && sample.distanceBottom > 1
  );
  expect(rebounds, JSON.stringify(samples)).toHaveLength(0);
  expect(samples.at(-1)?.distanceBottom).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate(async () => {
    const state = await (0, eval)('import("/src/hooks/conversationScrollState.ts")') as {
      conversationScrollMemory: Map<string, { followLatest: boolean }>;
    };
    return [...state.conversationScrollMemory.values()].at(-1)?.followLatest;
  })).toBe(true);
});

test("history loading hides transient scrollbar geometry until anchoring settles", async ({ page }) => {
  await page.addInitScript(() => {
    const state = { observed: false };
    Object.assign(globalThis, { __notgramHistoryScrollbar: state });
    globalThis.addEventListener("DOMContentLoaded", () => {
      const observer = new MutationObserver(() => {
        if (document.querySelector(".message-list.is-history-adjusting")) state.observed = true;
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    });
  });
  await page.goto("/");

  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __notgramHistoryScrollbar: { observed: boolean } }
  ).__notgramHistoryScrollbar.observed)).toBe(true);
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".message-list")).not.toHaveClass(/is-history-adjusting/);
});
