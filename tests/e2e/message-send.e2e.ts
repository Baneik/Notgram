import { expect, test, type Page } from "@playwright/test";

type StoreModule = typeof import("../../src/store/telegramStore");
type SendAudit = { finishes: (() => void)[]; failures: ((error: Error) => void)[] };

const delayTransport = async (page: Page, method: "sendMessage" | "sendFiles") => {
  await page.addInitScript(() => Object.assign(globalThis, { sendAudit: { finishes: [], failures: [] } }));
  await page.route("**/src/telegram/mockTransport.ts", async route => {
    const response = await route.fetch();
    const source = (await response.text()).replace(new RegExp(`(async ${method}\\([\\s\\S]*?\\) \\{)`), `$1
      await new Promise((resolve, reject) => {
        globalThis.sendAudit.finishes.push(resolve);
        globalThis.sendAudit.failures.push(reject);
      });`);
    await route.fulfill({ response, body: source });
  });
};

const expectBottom = async (page: Page) => {
  await expect.poll(() => page.locator(".message-list").evaluate(list =>
    list.scrollHeight - list.scrollTop - list.clientHeight)).toBeLessThanOrEqual(2);
  const overlap = await page.locator(".message-list").evaluate(list => {
    const last = [...list.querySelectorAll<HTMLElement>(".message-row")].at(-1);
    return last ? last.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom : 0;
  });
  expect(overlap).toBeLessThanOrEqual(2);
};

const ready = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 720 });
  await page.goto("/");
  if (width < 768) await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
};

for (const width of [1366, 390]) {
  test(`consecutive sends reveal the new bubble and retain the bottom at ${width}px`, async ({ page }) => {
    await ready(page, width);
    await page.evaluate(async () => {
      const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
      preferencesStore.setState({ interfaceScale: 125 });
    });
    const editor = page.getByRole("textbox", { name: "消息内容" });
    for (let index = 0; index < 6; index++) {
      const text = `send geometry ${index}` + (index % 2 ? "\nline".repeat(8) : "");
      await editor.fill(text);
      await page.evaluate(() => {
        const ids = new Set([...document.querySelectorAll<HTMLElement>(".message-list [data-message-id]")].map(row => row.dataset.messageId));
        const samples: { hidden: boolean; overlap: number; distance: number; time: number; id?: string }[] = [];
        const start = performance.now();
        const sample = () => {
          const list = document.querySelector<HTMLElement>(".message-list")!;
          const rows = [...list.querySelectorAll<HTMLElement>("[data-message-id]")].filter(row => !ids.has(row.dataset.messageId));
          const row = rows.at(-1);
          if (row) samples.push({ hidden: getComputedStyle(row).visibility === "hidden", overlap: row.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom,
            distance: list.scrollHeight - list.scrollTop - list.clientHeight, time: performance.now() - start, id: row.dataset.messageId });
          if (performance.now() - start < 1_200) requestAnimationFrame(sample);
        };
        Object.assign(globalThis, { sendGeometrySamples: samples });
        requestAnimationFrame(sample);
      });
      await editor.press("Enter");
      await expect(editor).toHaveText("");
      await expect(page.locator(".message-list .message-row").filter({ hasText: `send geometry ${index}` })).toBeVisible();
      await page.waitForTimeout(1_250);
      const samples = await page.evaluate(() => (globalThis as unknown as { sendGeometrySamples: { hidden: boolean; overlap: number; distance: number; time: number; id?: string }[] }).sendGeometrySamples);
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.filter(sample => sample.time > 350 && sample.hidden).slice(0, 3)).toEqual([]);
      expect(samples.filter(sample => sample.time > 350 && sample.overlap > 2).slice(0, 3)).toEqual([]);
      // CSS zoom can round the DOM's integer clientHeight by a fractional pixel.
      expect(samples.at(-1)!.distance).toBeLessThanOrEqual(2);
    }
  });
}

test("text stays visible while acknowledgements wait and subsequent typing remains available", async ({ page }) => {
  await delayTransport(page, "sendMessage");
  await ready(page, 390);
  const editor = page.getByRole("textbox", { name: "消息内容" });
  for (const text of ["first delayed text", "second delayed text\nwith multiple lines"]) {
    await editor.fill(text);
    await editor.press("Enter");
    await expect(editor).toHaveText("");
    const row = page.locator('[data-message-id^="local-send:"]').filter({ hasText: text.split("\n")[0] });
    await expect(row).toBeVisible({ timeout: 700 });
    await expect(row.locator('[data-delivery="sending"]')).toBeVisible();
    await expectBottom(page);
  }
  await editor.fill("a newer draft");
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sendAudit: SendAudit }).sendAudit.finishes.length)).toBe(2);
  await page.evaluate(() => (globalThis as unknown as { sendAudit: SendAudit }).sendAudit.finishes.forEach(finish => finish()));
  await expect(page.locator('[data-message-id^="local-send:"]')).toHaveCount(0);
  await expect(page.locator('.message-row').filter({ hasText: "first delayed text" })).toHaveCount(1);
  await expect(editor).toHaveText("a newer draft");
  await expectBottom(page);
});

test("a delayed visibility observer does not hide a pinned outgoing bubble", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeObserver = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class extends NativeObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        const entrance = Array.isArray(options?.threshold) && options.threshold.includes(0.99);
        super(entrance ? () => undefined : callback, options);
      }
    };
  });
  await delayTransport(page, "sendMessage");
  await ready(page, 1366);
  const editor = page.getByRole("textbox", { name: "消息内容" });
  await editor.fill("visible without observer callback");
  await editor.press("Enter");
  await expect(page.locator('[data-message-id^="local-send:"]')).toBeVisible({ timeout: 650 });
  await expectBottom(page);
});

test("image preparation and upload do not hold the composer or cover the pending bubble", async ({ page }) => {
  await delayTransport(page, "sendFiles");
  await ready(page, 390);
  await page.locator('input[type="file"]').setInputFiles("tests/fixtures/public/mock-video-poster.jpg");
  const editor = page.getByRole("textbox", { name: "消息内容" });
  await editor.fill("delayed photo caption");
  await editor.press("Enter");
  const pending = page.locator('[data-message-id^="local-send:"]');
  await expect(pending).toBeVisible({ timeout: 700 });
  await expect(pending.locator('[data-delivery="sending"]')).toBeVisible();
  await expect(editor).toHaveText("");
  await expectBottom(page);
  await page.screenshot({ path: test.info().outputPath("pending-image-position.png") });
  await editor.fill("text during image upload");
  await editor.press("Enter");
  await expect(page.locator('.message-row').filter({ hasText: "text during image upload" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sendAudit: SendAudit }).sendAudit.finishes.length)).toBe(1);
  await page.locator('input[type="file"]').setInputFiles({ name: "newer.txt", mimeType: "text/plain", buffer: Buffer.from("new attachment") });
  await page.evaluate(() => (globalThis as unknown as { sendAudit: SendAudit }).sendAudit.finishes[0]());
  await expect(pending).toHaveCount(0);
  await expect(page.locator('.message-row').filter({ hasText: "delayed photo caption" })).toHaveCount(1);
  await expect.poll(() => page.evaluate(async () => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as StoreModule;
    return telegramStore.getState().localAttachmentDrafts.get("chat-product")?.attachments.map(item => item.name);
  })).toEqual(["newer.txt"]);
  await expectBottom(page);
});

test("a rejected background send restores attachments and preserves newer text", async ({ page }) => {
  await delayTransport(page, "sendFiles");
  await ready(page, 1366);
  await page.locator('input[type="file"]').setInputFiles("tests/fixtures/public/mock-video-poster.jpg");
  const preview = page.getByRole("region", { name: "待发送附件" });
  await preview.getByRole("checkbox", { name: "剧透" }).check();
  const editor = page.getByRole("textbox", { name: "消息内容" });
  await editor.fill("original caption");
  await editor.press("Enter");
  await expect(preview).toHaveCount(0);
  await editor.fill("newer draft");
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sendAudit: SendAudit }).sendAudit.failures.length)).toBe(1);
  await page.evaluate(() => (globalThis as unknown as { sendAudit: SendAudit }).sendAudit.failures[0](new Error("permission denied")));
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("checkbox", { name: "剧透" })).toBeChecked();
  await expect(editor).toHaveJSProperty("value", "original caption\nnewer draft");
  await expect(page.locator('[data-message-id^="local-send:"]')).toHaveCount(0);
  await expectBottom(page);
});

test("upload preparation uses the photo worker with the existing dimensions and quality", async ({ page }) => {
  await ready(page, 1366);
  const result = await page.evaluate(async () => {
    const { prepareHighQualityPhoto } = await import("/src/media/outgoingAttachments.ts" as string) as typeof import("../../src/media/outgoingAttachments");
    const response = await fetch("/mock-video-poster.jpg");
    const file = new File([await response.blob()], "upload.jpg", { type: "image/jpeg" });
    const documentCreateElement = document.createElement.bind(document);
    let canvases = 0;
    document.createElement = ((...args: Parameters<typeof document.createElement>) => {
      if (args[0] === "canvas") canvases++;
      return documentCreateElement(...args);
    }) as typeof document.createElement;
    try {
      const prepared = await prepareHighQualityPhoto(file);
      const bitmap = await createImageBitmap(prepared);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return { canvases, encoded: prepared !== file, type: prepared.type, ...size };
    } finally { document.createElement = documentCreateElement; }
  });
  expect(result).toMatchObject({ canvases: 0, encoded: true, type: "image/jpeg" });
  expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(2560);
});
