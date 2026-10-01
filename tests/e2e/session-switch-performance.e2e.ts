import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installSessionSwitchFixture } from "./fixtures/sessionSwitchFixture";

test.use({ trace: "off", screenshot: "only-on-failure" });
test.describe.configure({ retries: 0 });

test("dense warm conversations stay responsive through thirty switches", { tag: "@performance" }, async ({ page }, testInfo) => {
  const production = process.env.NOTGRAM_PRODUCTION_SWITCH_TEST === "1";
  if (!production) await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n(${installSessionSwitchFixture.toString()})(MockTelegramTransport);` });
  });
  await page.goto(process.env.NOTGRAM_SWITCH_BENCHMARK_PATH ?? "/");
  const product = page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]');
  const mia = page.locator('.chat-list[data-active=true] [data-chat-id="chat-mia"]');
  for (let round = 0; round < 3; round++) {
    await mia.click();
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    await product.click();
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  }
  await expect(page.locator("[data-conversation-switch-snapshot]")).toHaveCount(0);
  const profiling = process.env.NOTGRAM_SWITCH_PROFILE === "1";
  const session = profiling ? await page.context().newCDPSession(page) : undefined;
  if (session) { await session.send("Profiler.enable"); await session.send("Profiler.start"); }

  const report = await page.evaluate(async () => {
    const longTasks: number[] = [];
    const frames: number[] = [];
    const switches: Array<{ dispatchMs: number; title: string | null | undefined; inputMs: number; responseMs: number; text: string }> = [];
    const observer = new PerformanceObserver(list => {
      longTasks.push(...list.getEntries().map(entry => entry.duration));
    });
    observer.observe({ type: "longtask" });
    const originalRects = Range.prototype.getClientRects;
    let textMeasurements = 0;
    Range.prototype.getClientRects = function() {
      const node = this.commonAncestorContainer;
      const element = node instanceof Element ? node : node.parentElement;
      if (element?.closest(".message-rich-text")) textMeasurements++;
      return originalRects.call(this);
    };
    let previous = performance.now();
    let running = true;
    let frameId = 0;
    const sample = (time: number) => {
      frames.push(time - previous);
      previous = time;
      if (running) frameId = requestAnimationFrame(sample);
    };
    frameId = requestAnimationFrame(sample);
    const started = performance.now();
    try {
      for (let i = 0; i < 30; i++) {
        const id = i % 2 === 0 ? "chat-mia" : "chat-product";
        const row = document.querySelector<HTMLElement>(`.chat-list[data-active=true] [data-chat-id="${id}"]`)!;
        const before = performance.now();
        row.click();
        const dispatchMs = performance.now() - before;
        // Exercise the real editor in the first frame of the new conversation.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const input = document.querySelector<HTMLElement>(".composer-input")!;
        input.focus();
        const inputStart = performance.now();
        document.execCommand("selectAll");
        document.execCommand("insertText", false, "performance-" + i);
        switches.push({ dispatchMs, title: document.querySelector(".conversation-title strong")?.textContent,
          inputMs: performance.now() - inputStart, responseMs: performance.now() - before, text: input.textContent ?? "" });
        await new Promise(resolve => setTimeout(resolve, Math.max(0, started + (i + 1) * 250 - performance.now())));
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      return { longTasks, frames: frames.slice(2), switches, textMeasurements,
        mounted: document.querySelectorAll(".message-list [data-message-id]").length };
    } finally {
      running = false;
      cancelAnimationFrame(frameId);
      observer.disconnect();
      Range.prototype.getClientRects = originalRects;
    }
  });
  await testInfo.attach("session-switch-metrics", { body: JSON.stringify(report), contentType: "application/json" });
  if (session) {
    const result = await session.send("Profiler.stop");
    const path = testInfo.outputPath("session-switch.cpuprofile");
    await writeFile(path, JSON.stringify(result.profile));
    await testInfo.attach("session-switch-cpu", { path, contentType: "application/json" });
    await session.detach();
  }
  const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  const summary = { longTasks: report.longTasks, frameP95: percentile(report.frames, 0.95), frameMax: Math.max(...report.frames),
    dispatchP95: percentile(report.switches.map(s => s.dispatchMs), 0.95), inputP95: percentile(report.switches.map(s => s.inputMs), 0.95),
    responseP95: percentile(report.switches.map(s => s.responseMs), 0.95),
    textMeasurements: report.textMeasurements, mounted: report.mounted };
  console.log("SESSION_SWITCH_METRICS", JSON.stringify(summary));
  expect(report.switches.map(s => s.title)).toEqual(Array.from({ length: 30 }, (_, i) => i % 2 === 0 ? "Mia Chen" : "产品讨论"));
  expect(report.switches.every((s, i) => s.text === "performance-" + i)).toBe(true);
  // Vite's development JSX checks dominate its profiles. Apply user-facing
  // timing gates to the production build; both modes enforce cache/correctness.
  if (production) {
    expect(report.longTasks, JSON.stringify(summary)).toEqual([]);
    expect(summary.frameP95, JSON.stringify(summary)).toBeLessThan(22);
    expect(summary.frameMax, JSON.stringify(summary)).toBeLessThan(40);
    expect(summary.dispatchP95, JSON.stringify(summary)).toBeLessThan(16.7);
    expect(summary.inputP95, JSON.stringify(summary)).toBeLessThan(8);
    expect(summary.responseP95, JSON.stringify(summary)).toBeLessThan(40);
  }
  expect(report.textMeasurements, JSON.stringify(summary)).toBe(0);
});
