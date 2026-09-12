import { expect, test, type Page } from "@playwright/test";

const fixture = async (page: Page, options: { short?: boolean; middle?: boolean; last?: boolean; top?: boolean; album?: boolean } = {}) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async (options) => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const state = telegramStore.getState();
    const originals = state.messages.get("chat-product")!;
    const source = originals.find(message => message.id === "p-1")!;
    const before = Array.from({ length: options.short || options.top ? 0 : 65 }, (_, index) => ({ ...source, id: `before-${index}`,
      sentAt: new Date(Date.parse(source.sentAt) - (70 - index) * 1000).toISOString(), isPinned: false,
      content: { kind: "text" as const, text: `历史消息 ${index}，验证删除后的阅读位置。` } }));
    const ids = options.album ? ["p-1", "p-2", "p-3", "p-4", "p-tall", "p-5", "p-channel-reply", "p-video"] : options.last ? ["p-1", "p-2", "p-3", "p-4"]
      : ["p-1", "p-2", "p-3", "p-4", "p-channel-reply", "p-rich-entities", "p-bot-keyboard", "p-video"];
    const tail = ids.map((id, index) => ({ ...originals.find(message => message.id === id)!,
      mediaAlbumId: options.album ? originals.find(message => message.id === id)?.mediaAlbumId : undefined, replyMarkup: undefined, replyTo: undefined, forwardInfo: undefined,
      sentAt: new Date(Date.parse(source.sentAt) + index * 1000).toISOString(),
      content: options.album && ["p-tall", "p-5"].includes(id) ? originals.find(message => message.id === id)!.content : { kind: "text" as const, text: `${id}：${index === 3 ? "这条消息将被删除，下面的位置保持不动。" : "消息应平滑落到新的位置。"}` } }));
    const after = options.middle || options.top ? Array.from({ length: 35 }, (_, index) => ({ ...source, id: `after-${index}`,
      sentAt: new Date(Date.parse(source.sentAt) + (20 + index) * 1000).toISOString(), isPinned: false,
      content: { kind: "text" as const, text: `后续消息 ${index}` } })) : [];
    const messages = new Map(state.messages);
    messages.set("chat-product", [...before, ...tail, ...after]);
    const histories = new Map(state.histories);
    histories.set("chat-product", { loading: false, hasMore: false, initialized: true });
    telegramStore.setState({ messages, histories, loadMoreHistory: async () => undefined });
  }, options);
  const list = page.locator(".message-list");
  await list.press("End");
  if (options.top) {
    await list.hover();
    await page.mouse.wheel(0, -100000);
    await list.evaluate(element => { element.scrollTop = 0; });
  }
  if (options.middle) {
    await list.hover();
    await page.mouse.wheel(0, -800);
    await expect.poll(() => list.evaluate(element => {
      const target = element.querySelector('[data-message-id="p-4"]');
      if (target) { target.scrollIntoView({ block: "center" }); return true; }
      element.scrollTop -= 300;
      return false;
    })).toBe(true);
  }
  await expect(page.locator('[data-message-id="p-4"]')).toBeVisible();
  await page.waitForTimeout(600);
  if (options.top) expect(await list.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(1);
};

const sampleDeletion = (page: Page, ids = ["p-4"], stagger = 0) => page.evaluate(async ({ ids, stagger }) => {
  const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
  const list = document.querySelector<HTMLElement>(".message-list")!;
  const position = (id: string) => list.querySelector<HTMLElement>(`[data-message-id="${id}"] .message-bubble-shell`)?.getBoundingClientRect().top;
  const samples: Array<{ above?: number; below?: number; opacity?: number; settling: number; distance: number }> = [];
  const read = () => {
    const deleted = list.querySelector<HTMLElement>(`[data-message-id="${ids[0]}"]`);
    samples.push({ above: position("p-1"), below: position("p-channel-reply"), opacity: deleted ? Number(getComputedStyle(deleted).opacity) : undefined,
      settling: list.querySelectorAll('[data-removal-motion="settling"]').length,
      distance: list.scrollHeight - list.clientHeight - list.scrollTop });
  };
  read();
  const deleting = (async () => {
    const results = [];
    for (const [index, id] of ids.entries()) {
      if (index && stagger) await new Promise(resolve => setTimeout(resolve, stagger));
      results.push(await telegramStore.getState().deleteMessage(id, id === "p-2", "chat-product"));
    }
    return results;
  })();
  const start = performance.now();
  while (performance.now() - start < 1100 + stagger) {
    await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    read();
  }
  return { samples, results: await deleting };
}, { ids, stagger });

for (const mode of ["bottom", "top", "middle", "short", "narrow", "last", "batch", "consecutive", "reduced", "album", "monitoring-off"] as const) {
  test(`deletion keeps lower messages fixed and smoothly drops upper messages (${mode})`, async ({ page }) => {
    if (mode === "narrow") await page.setViewportSize({ width: 390, height: 844 });
    if (mode === "reduced") await page.emulateMedia({ reducedMotion: "reduce" });
    if (mode === "monitoring-off") await page.addInitScript(() => {
      localStorage.setItem("notgram:preferences:v1", JSON.stringify({ performanceMonitoringEnabled: false }));
    });
    await fixture(page, { short: mode === "short", middle: mode === "middle", last: mode === "last", top: mode === "top", album: mode.startsWith("album") });
    const { samples, results } = await sampleDeletion(page, mode === "album" ? ["p-tall", "p-5"] : mode === "batch" || mode === "consecutive" ? ["p-4", "p-2"] : ["p-4"], mode === "consecutive" ? 280 : 0);
    expect(results.every(Boolean)).toBe(true);
    const details = JSON.stringify(samples.filter((sample, index) => index === 0 || index === samples.length - 1 || sample.above !== samples[index - 1]?.above || sample.below !== samples[index - 1]?.below));
    const first = samples[0]!, last = samples.at(-1)!;
    expect(last.above! - first.above!, details).toBeGreaterThan(15);
    if (mode !== "last") {
      expect(Math.max(...samples.map(sample => Math.abs(sample.below! - first.below!))), details).toBeLessThanOrEqual(1);
    }
    if (mode === "reduced") expect(samples.every(sample => sample.settling === 0), details).toBe(true);
    else {
      expect(samples.some(sample => sample.opacity !== undefined && sample.opacity < 0.8 && sample.opacity > 0.05), details).toBe(true);
      expect(samples.some(sample => sample.settling > 0), details).toBe(true);
      expect(samples.some(sample => sample.above! > first.above! + 2 && sample.above! < last.above! - 2), details).toBe(true);
      // No backwards bounce, including the frame that releases the transforms.
      expect(Math.min(...samples.slice(1).map((sample, index) => sample.above! - samples[index]!.above!)), details).toBeGreaterThanOrEqual(-1);
    }
    expect(last.opacity).toBeUndefined();
    expect(last.settling).toBe(0);
    if (mode !== "middle" && mode !== "top") expect(Math.abs(last.distance)).toBeLessThanOrEqual(1);
    if (mode === "monitoring-off") {
      const records = await page.evaluate(async () => {
        const monitor = await import("/src/utils/performanceMonitor.ts" as string) as typeof import("../../src/utils/performanceMonitor");
        return monitor.getPerformanceRecords().length;
      });
      expect(records).toBe(0);
    }
  });
}

for (const interruption of ["scroll", "switch", "reduce"] as const) {
  test(`deletion releases its animations on ${interruption}`, async ({ page }) => {
    await fixture(page);
    await page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      await telegramStore.getState().deleteMessage("p-4", false, "chat-product");
    });
    const moving = page.locator('[data-removal-motion="settling"]');
    await expect(moving.first()).toBeAttached();
    const animations = await moving.evaluateAll(elements => elements.flatMap(element => element.getAnimations()).length);
    expect(animations).toBeGreaterThan(0);
    if (interruption === "scroll") await page.locator(".message-list").press("PageUp");
    else if (interruption === "switch") await page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]').click();
    else await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(moving).toHaveCount(0);
    await page.waitForTimeout(400);
    await expect(moving).toHaveCount(0);
  });
}
