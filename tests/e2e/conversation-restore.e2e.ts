import { expect, test, type Page } from "@playwright/test";
import { latestMessageBottomGap, scrollAwayFromBottom } from "./helpers";
import type { TelegramState } from "../../src/store/telegramStore.types";

const storePath = "/src/store/telegramStore.ts";
const memoryPath = "/src/hooks/conversationScrollState.ts";
const select = (page: Page, id: string) => page.locator(`.chat-list[data-active=true] [data-chat-id="${id}"]`).click();
const settled = async (page: Page) => {
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("[data-conversation-switch-snapshot]")).toHaveCount(0);
};
const savedPosition = (page: Page) => page.evaluate(async modulePath => {
  const module = await import(modulePath) as typeof import("../../src/hooks/conversationScrollState");
  return module.conversationScrollMemory.get("default:chat-product")!;
}, memoryPath);
const expectAnchor = async (page: Page, anchor: { messageId: string; offset: number }) => {
  await settled(page);
  await expect.poll(() => page.locator(".message-list").evaluate((element, anchor) => {
    const row = element.querySelector<HTMLElement>(`[data-message-id="${anchor.messageId}"]`);
    return row ? Math.abs(row.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset) : Infinity;
  }, anchor)).toBeLessThanOrEqual(2);
};
const appendMessages = (page: Page, count: number, batch: string) => page.evaluate(async ({ path, count, batch }) => {
  const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
  const state = telegramStore.getState();
  const messages = new Map(state.messages);
  const current = messages.get("chat-product")!;
  const last = current.at(-1)!;
  messages.set("chat-product", [...current, ...Array.from({ length: count }, (_, index) => ({
    ...last, id: `${batch}-${index}`, renderKey: undefined, senderId: "u-mia", outgoing: false,
    sentAt: new Date(Date.now() + index * 1_000).toISOString(),
    content: { kind: "text" as const, text: `New message ${batch} ${index}` },
  }))]);
  telegramStore.setState({ messages });
}, { path: storePath, count, batch });

test("away arrivals preserve the old bottom until the reader explicitly returns to latest", async ({ page }) => {
  await page.goto("/");
  await settled(page);
  await select(page, "chat-mia");
  const memory = await savedPosition(page);
  const anchor = { messageId: memory.anchorMessageId!, offset: memory.anchorOffset! };
  await appendMessages(page, 20, "away");
  await select(page, "chat-product");
  await expectAnchor(page, anchor);
  await expect(page.getByRole("button", { name: "跳到最新消息，20 条新消息" })).toBeVisible();
  await appendMessages(page, 2, "reading");
  await expectAnchor(page, anchor);
  await page.getByRole("button", { name: "跳到最新消息，22 条新消息" }).click();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator('[data-message-id="reading-1"]')).toBeVisible();
  await appendMessages(page, 1, "following");
  await expect(page.locator('[data-message-id="following-0"]')).toBeVisible();
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  await expect(page.locator(".jump-to-latest")).toHaveCount(0);
});

test("leaving captures the mounted viewport and a reading anchor even at the bottom", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  const before = await page.locator(".message-list").evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const anchor = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find(row => row.getBoundingClientRect().bottom > bounds.top + 1);
    const before = { id: anchor?.dataset.messageId, offset: anchor!.getBoundingClientRect().top - bounds.top,
      scrollTop: element.scrollTop,
      headerHeight: element.querySelector(".message-list-start-spacer")!.getBoundingClientRect().height };
    document.querySelector<HTMLElement>('.chat-list[data-active=true] [data-chat-id="chat-mia"]')!.click();
    return before;
  });
  expect(before.scrollTop).toBeGreaterThan(100);
  const saved = await page.evaluate(async modulePath => {
    const { conversationScrollMemory, conversationVirtuosoSnapshots } = await import(
      modulePath
    ) as typeof import("../../src/hooks/conversationScrollState");
    return {
      memory: conversationScrollMemory.get("default:chat-product"),
      snapshot: conversationVirtuosoSnapshots.get("default:chat-product")?.state,
    };
  }, "/src/hooks/conversationScrollState.ts");
  expect(saved.memory?.scrollTop).toBeCloseTo(before.scrollTop, 0);
  expect(saved.memory?.anchorMessageId).toBe(before.id);
  expect(saved.memory?.anchorOffset).toBeCloseTo(before.offset, 0);
  expect(saved.memory?.atBottom).toBe(true);
  // Virtuoso snapshots use a scroll offset relative to its measured Header.
  expect(saved.snapshot?.scrollTop).toBeCloseTo(before.scrollTop - before.headerHeight, 0);
  expect(saved.snapshot!.ranges.length).toBeGreaterThan(0);
});

for (const geometry of [
  { width: 1280, height: 760, scale: 100 },
  { width: 900, height: 650, scale: 100 },
  { width: 1280, height: 760, scale: 125 },
]) {
  test(`bottom reentry remains stable without new messages (${geometry.width}px, ${geometry.scale}%)`, async ({ page }) => {
    await page.setViewportSize(geometry);
    await page.goto("/");
    await settled(page);
    await page.evaluate(async ({ path, scale }) => {
      const { preferencesStore } = await import(path) as typeof import("../../src/store/preferencesStore");
      preferencesStore.setState({ interfaceScale: scale });
    }, { path: "/src/store/preferencesStore.ts", scale: geometry.scale });
    await expect.poll(() => page.locator(".message-list").evaluate(x => x.scrollHeight - x.clientHeight - x.scrollTop))
      .toBeLessThanOrEqual(1);
    for (let cycle = 0; cycle < 4; cycle++) {
      await select(page, "chat-mia");
      await settled(page);
      await select(page, "chat-product");
      await settled(page);
      const frames = await page.locator(".message-list").evaluate(async element => {
        const frames: Array<{ distance: number; gap: number; tail: string | undefined }> = [];
        for (let frame = 0; frame < 30; frame++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => { setTimeout(resolve, 0); }));
          const last = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].at(-1)!;
          frames.push({ distance: element.scrollHeight - element.clientHeight - element.scrollTop,
            gap: element.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom,
            tail: last.dataset.messageId });
        }
        return frames;
      });
      expect(frames.every(frame => frame.tail === "p-video"), JSON.stringify(frames)).toBe(true);
      expect(Math.max(...frames.map(frame => Math.abs(frame.distance))), JSON.stringify(frames)).toBeLessThanOrEqual(1);
      expect(Math.max(...frames.map(frame => Math.abs(frame.gap - 12 * geometry.scale / 100))), JSON.stringify(frames))
        .toBeLessThanOrEqual(1.5);
    }
  });
}

const suspendAnchorLoad = async (page: Page, messageId: string, deleted = false) => {
  await page.evaluate(async ({ path, messageId, deleted }) => {
    const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const load = state.loadMessage;
    const messages = new Map(state.messages);
    messages.set("chat-product", messages.get("chat-product")!.filter(message => message.id !== messageId));
    telegramStore.setState({ messages, loadMessage: async (...args: Parameters<TelegramState["loadMessage"]>) => {
      if (args[0] === "chat-product" && args[1] === messageId) {
        await new Promise<void>(resolve => {
          (window as typeof window & { __releaseEntryLoad?: () => void }).__releaseEntryLoad = resolve;
        });
        if (deleted) return false;
      }
      return load(...args);
    } });
  }, { path: storePath, messageId, deleted });
};
const releaseAnchorLoad = (page: Page) => page.evaluate(() => {
  (window as typeof window & { __releaseEntryLoad?: () => void }).__releaseEntryLoad?.();
});

test("an unloaded saved anchor is hydrated before reentry finishes", async ({ page }) => {
  await page.goto("/");
  await settled(page);
  await scrollAwayFromBottom(page);
  await select(page, "chat-mia");
  const memory = await savedPosition(page);
  await suspendAnchorLoad(page, memory.anchorMessageId!);
  await select(page, "chat-product");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "true");
  await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __releaseEntryLoad?: () => void }).__releaseEntryLoad)))
    .toBe(true);
  await releaseAnchorLoad(page);
  await expectAnchor(page, { messageId: memory.anchorMessageId!, offset: memory.anchorOffset! });
});

test("a deleted saved anchor restores a surviving visible neighbor at its old offset", async ({ page }) => {
  await page.goto("/");
  await settled(page);
  await scrollAwayFromBottom(page);
  await select(page, "chat-mia");
  const memory = await savedPosition(page);
  const neighbor = memory.nearbyAnchors![1];
  expect(neighbor).toBeTruthy();
  await suspendAnchorLoad(page, memory.anchorMessageId!, true);
  await select(page, "chat-product");
  await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __releaseEntryLoad?: () => void }).__releaseEntryLoad)))
    .toBe(true);
  await releaseAnchorLoad(page);
  await expectAnchor(page, neighbor);
});

test("leaving during anchor hydration preserves the checkpoint and rejects its late result", async ({ page }) => {
  await page.goto("/");
  await settled(page);
  await scrollAwayFromBottom(page);
  await select(page, "chat-mia");
  const memory = await savedPosition(page);
  await suspendAnchorLoad(page, memory.anchorMessageId!);
  await select(page, "chat-product");
  await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __releaseEntryLoad?: () => void }).__releaseEntryLoad)))
    .toBe(true);
  await select(page, "chat-chen");
  await settled(page);
  await releaseAnchorLoad(page);
  await expect(page.locator(".conversation-title strong")).toHaveText("陈默");
  const after = await savedPosition(page);
  expect(after.anchorMessageId).toBe(memory.anchorMessageId);
  expect(after.anchorOffset).toBe(memory.anchorOffset);
  expect(after.scrollTop).toBe(memory.scrollTop);
  await expect.poll(() => page.evaluate(async ({ path, id }) => {
    const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
    return telegramStore.getState().messages.get("chat-product")!.some(message => message.id === id);
  }, { path: storePath, id: memory.anchorMessageId })).toBe(false);
});

test("context success without a projected anchor cannot leave reentry waiting forever", async ({ page }) => {
  await page.goto("/");
  await settled(page);
  await scrollAwayFromBottom(page);
  await select(page, "chat-mia");
  const memory = await savedPosition(page);
  await page.evaluate(async ({ path, id }) => {
    const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const messages = new Map(state.messages);
    messages.set("chat-product", messages.get("chat-product")!.filter(message => message.id !== id));
    // A loaded message may remain excluded by the current display projection.
    telegramStore.setState({ messages, loadMessage: async () => true });
  }, { path: storePath, id: memory.anchorMessageId });
  await select(page, "chat-product");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false", { timeout: 12_000 });
  await expectAnchor(page, memory.nearbyAnchors![1]);
});

for (const { count, scale } of [{ count: 1, scale: 100 }, { count: 20, scale: 100 },
  { count: 1, scale: 125 }, { count: 20, scale: 125 }]) {
  test(`a short bottom-aligned conversation keeps its old viewport after ${count} away arrivals (${scale}%)`, async ({ page }) => {
    await page.goto("/");
    await settled(page);
    await page.evaluate(async ({ path, scale }) => {
      const { preferencesStore } = await import(path) as typeof import("../../src/store/preferencesStore");
      preferencesStore.setState({ interfaceScale: scale });
    }, { path: "/src/store/preferencesStore.ts", scale });
    await page.evaluate(async path => {
      const { telegramStore } = await import(path) as typeof import("../../src/store/telegramStore");
      const state = telegramStore.getState();
      const source = state.messages.get("chat-product")!.find(message => message.id === "p-1")!;
      const messages = new Map(state.messages);
      messages.set("chat-product", [0, 1].map(index => ({ ...source, id: `short-${index}`, renderKey: undefined,
        sentAt: new Date(Date.now() + index * 1000).toISOString(), isPinned: false,
        content: { kind: "text" as const, text: `Short conversation ${index}` } })));
      const histories = new Map(state.histories);
      histories.set("chat-product", { loading: false, hasMore: false, initialized: true });
      telegramStore.setState({ messages, histories, loadMoreHistory: async () => undefined });
    }, storePath);
    await page.locator(".message-list").press("End");
    await expect(page.locator(".message-removal-ghost")).toHaveCount(0);
    await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13 * scale / 100);
    await select(page, "chat-mia");
    const memory = await savedPosition(page);
    expect(memory.anchorOffset).toBeGreaterThan(200);
    const anchor = { messageId: memory.anchorMessageId!, offset: memory.anchorOffset! };
    await appendMessages(page, count, "short-away");
    await select(page, "chat-product");
    await expectAnchor(page, anchor);
    await select(page, "chat-mia");
    await select(page, "chat-product");
    await expectAnchor(page, anchor);
    if (count === 1) await page.locator(".message-list").press("End");
    else await page.getByRole("button", { name: `跳到最新消息，${count} 条新消息` }).click();
    await expect(page.locator(`[data-message-id="short-away-${count - 1}"]`)).toBeVisible();
    await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13 * scale / 100);
  });
}

test("explicit latest navigation cancels an entry anchor that is still loading", async ({ page }) => {
  await page.goto("/");
  await settled(page);
  await scrollAwayFromBottom(page);
  await select(page, "chat-mia");
  const memory = await savedPosition(page);
  await suspendAnchorLoad(page, memory.anchorMessageId!);
  await select(page, "chat-product");
  await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __releaseEntryLoad?: () => void }).__releaseEntryLoad)))
    .toBe(true);
  await expect(page.locator("[data-conversation-switch-snapshot]")).toHaveCount(0);
  await select(page, "chat-product");
  await settled(page);
  await expect(page.locator('[data-message-id="p-video"]')).toBeVisible();
  await releaseAnchorLoad(page);
  await expect.poll(() => latestMessageBottomGap(page)).toBeLessThanOrEqual(13);
  expect((await savedPosition(page)).followLatest).toBe(true);
});
