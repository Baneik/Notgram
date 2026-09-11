/// <reference types="vite/client" />
import { expect, test, type Page } from "@playwright/test";

const openMonitor = async (page: Page) => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "性能监控", exact: true }).click();
  return page.getByRole("switch", { name: "性能监控", exact: true });
};

const enabledIn = (page: Page) => page.evaluate(async () => {
  const monitor = await import("/src/utils/performanceMonitor.ts" as string) as typeof import("../../src/utils/performanceMonitor");
  return monitor.isPerformanceMonitoringEnabled();
});

test("monitoring stays disabled after settings remount and application reload, then resumes explicitly", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const initialMessage = page.locator("[data-message-id]").last();
  const initialNode = await initialMessage.elementHandle();
  const monitoring = await openMonitor(page);
  await expect(monitoring).toBeChecked();
  await monitoring.click();
  await expect(monitoring).not.toBeChecked();
  // Toggling diagnostics must not remount the conversation or replace its rows.
  expect(await initialNode!.evaluate(node => node.isConnected)).toBe(true);
  await page.locator(".settings-dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(await openMonitor(page)).not.toBeChecked();
  await page.reload();
  await expect(await openMonitor(page)).not.toBeChecked();
  await expect(page.getByText("性能监控已关闭", { exact: true })).toBeVisible();
  const disabled = await page.evaluate(async () => {
    const monitor = await import("/src/utils/performanceMonitor.ts" as string) as typeof import("../../src/utils/performanceMonitor");
    const trace = await import("/src/utils/conversationTrace.ts" as string) as typeof import("../../src/utils/conversationTrace");
    monitor.clearPerformanceRecords();
    const deadline = performance.now() + 100;
    while (performance.now() < deadline) { /* Exercise a real main-thread stall. */ }
    monitor.logPerformance("ui_history_merge", { durationMs: 100 });
    await new Promise(resolve => setTimeout(resolve, 1_200));
    return { records: monitor.getPerformanceRecords().length, trace: Boolean(trace.conversationTraceFor(document.querySelector(".message-list"))) };
  });
  expect(disabled).toEqual({ records: 0, trace: false });
  await monitoring.click();
  await expect(monitoring).toBeChecked();
  await page.evaluate(() => {
    const deadline = performance.now() + 100;
    while (performance.now() < deadline) { /* Verify fresh samples after explicit enable. */ }
  });
  await expect(page.locator(".performance-entry").filter({ hasText: /主线程长任务|长动画帧|掉帧/ }).first()).toBeVisible();
  await page.reload();
  await expect(await openMonitor(page)).toBeChecked();
});

test("the settings window synchronizes monitoring with existing and newly opened windows", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const settings = await context.newPage();
  await settings.goto("/settings-window.html");
  await settings.getByRole("button", { name: "性能监控", exact: true }).click();
  const toggle = settings.getByRole("switch", { name: "性能监控", exact: true });
  await toggle.click();
  await expect.poll(() => enabledIn(page)).toBe(false);
  await settings.close();
  const reopened = await context.newPage();
  await reopened.goto("/settings-window.html");
  await reopened.getByRole("button", { name: "性能监控", exact: true }).click();
  const reopenedToggle = reopened.getByRole("switch", { name: "性能监控", exact: true });
  await expect(reopenedToggle).not.toBeChecked();
  await reopenedToggle.click();
  await expect.poll(() => enabledIn(page)).toBe(true);
  await reopened.close();
});

test("disabling during a geometry burst cancels layout sampling and discards the old trace", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
  const result = await page.evaluate(async () => {
    const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
    const { observeConversationViewportDiagnostics } = await import("/src/utils/conversationViewportDiagnostics.ts" as string) as typeof import("../../src/utils/conversationViewportDiagnostics");
    const { conversationTraceFor } = await import("/src/utils/conversationTrace.ts" as string) as typeof import("../../src/utils/conversationTrace");
    const list = document.createElement("div");
    list.style.cssText = "position:fixed;top:0;left:0;width:200px;height:120px;overflow:auto";
    list.innerHTML = '<div class="message-list-content"><div data-index="0" data-known-size="10" style="height:200px"></div></div>';
    document.body.append(list);
    let reads = 0;
    const measure = list.getBoundingClientRect.bind(list);
    list.getBoundingClientRect = () => { reads++; return measure(); };
    const stop = observeConversationViewportDiagnostics(list, () => ({}), {
      chatId: "fixture", readState: () => ({}),
      readModel: () => ({ messages: [], indexes: new Map(), firstItemIndex: 0 }),
    });
    try {
      const oldTrace = conversationTraceFor(list)!;
      oldTrace.trigger(2);
      await new Promise(resolve => setTimeout(resolve, 350));
      const enabledReads = reads;
      preferencesStore.getState().setPreference("performanceMonitoringEnabled", false);
      const disabledReads = reads;
      list.dispatchEvent(new Event("scroll"));
      await new Promise(resolve => setTimeout(resolve, 1_200));
      const extraReads = reads - disabledReads;
      const unregistered = !conversationTraceFor(list);
      preferencesStore.getState().setPreference("performanceMonitoringEnabled", true);
      const newTrace = conversationTraceFor(list)!;
      newTrace.trigger(2);
      await new Promise(resolve => setTimeout(resolve, 350));
      return { enabledReads, extraReads, unregistered, newSession: oldTrace.session !== newTrace.session, resumedReads: reads - disabledReads };
    } finally {
      stop();
      list.remove();
    }
  });
  expect(result.enabledReads).toBeGreaterThan(0);
  expect(result.extraReads).toBe(0);
  expect(result.unregistered).toBe(true);
  expect(result.newSession).toBe(true);
  expect(result.resumedReads).toBeGreaterThan(0);
});
