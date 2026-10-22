import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { horizontalOverflow } from "./helpers";

async function openBackup(page: Page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "Notgram", exact: true }).click();
  const backup = page.locator(".backup-settings");
  await backup.scrollIntoViewIfNeeded();
  await expect(backup.getByRole("heading", { name: "备份与恢复" })).toBeVisible();
  return backup;
}

for (const width of [1366, 390]) {
  test(`settings backup round-trips basic preferences without personal fields at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.locator(".app-shell")).toBeVisible();
    await page.evaluate(async () => {
      const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
      preferencesStore.getState().setPreference("chatFontSize", 18);
      preferencesStore.getState().setPreference("adBlockKeywords", ["推广", "测试😀"]);
      preferencesStore.getState().setPreference("shortcuts", { ...preferencesStore.getState().shortcuts, nextChat: "Alt+KeyN" });
      localStorage.setItem("private-record", JSON.stringify({ phone: "+12345678", password: "private-secret", chat: "private chat" }));
    });
    const backup = await openBackup(page);
    const downloaded = page.waitForEvent("download");
    await backup.getByRole("button", { name: "导出设置", exact: true }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe("notgram-settings.txt");
    const bytes = readFileSync((await download.path())!);
    expect(bytes.toString()).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const data = JSON.parse(Buffer.from(bytes.toString(), "base64").toString("utf8"));
    expect(data.preferences.adBlockKeywords).toEqual(["推广", "测试😀"]);
    expect(data.preferences.shortcuts.nextChat).toBe("Alt+KeyN");
    expect(JSON.stringify(data)).not.toMatch(/private-secret|private chat|phone|password|username|account|proxy|downloadPath|developerMode/);
    await page.evaluate(async () => {
      const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
      preferencesStore.getState().setPreference("chatFontSize", 14);
      preferencesStore.getState().setPreference("adBlockKeywords", []);
    });
    await backup.getByLabel("选择设置备份文件").setInputFiles({ name: "backup.txt", mimeType: "text/plain", buffer: bytes });
    await expect(backup.locator(".backup-feedback")).toContainText("设置备份已导入");
    await expect(backup.locator(".preference-policy-note")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--chat-font-size"))).toBe("18px");
    await expect(page.locator(".ad-keyword-chip")).toHaveText(["推广", "测试😀"]);
    expect(await horizontalOverflow(page)).toBe(false);
    await backup.screenshot({ path: testInfo.outputPath(`backup-${width}.png`) });
  });
}

test("invalid and unsupported backup files do not change preferences", async ({ page }) => {
  await page.goto("/");
  const backup = await openBackup(page);
  const before = await page.evaluate(() => localStorage.getItem("notgram:preferences:v1"));
  for (const text of ["not a backup", Buffer.from(JSON.stringify({ format: "notgram-settings", version: 2, preferences: { chatFontSize: 20 } })).toString("base64")]) {
    await backup.getByLabel("选择设置备份文件").setInputFiles({ name: "invalid.txt", mimeType: "text/plain", buffer: Buffer.from(text) });
    await expect(backup.getByRole("alert")).toHaveText("无效的备份文件");
    expect(await page.evaluate(() => localStorage.getItem("notgram:preferences:v1"))).toBe(before);
  }
});

async function installDavFixture(page: Page, failure: boolean | "stall" = false) {
  await page.evaluate(async failure => {
    const bridge = await import("/src/backup/webdavBridge.ts" as string) as typeof import("../../src/backup/webdavBridge");
    bridge.webdavBridge.available = () => true;
    let config = { enabled: false, url: "https://dav.example.test/backups/", username: "private-dav-user", password: "private-dav-password" };
    let body = "";
    let version = 0;
    const calls: Array<{ method: string; body?: string }> = [];
    const summary = () => ({ enabled: config.enabled, url: config.url, hasUsername: !!config.username, hasPassword: !!config.password, generation: "one" });
    Object.assign(window, { backupDavCalls: calls, __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { config?: typeof config; method?: string; body?: string }) => {
        if (command === "notgram_webdav_settings") return summary();
        if (command === "notgram_webdav_edit_settings") return { ...config };
        if (command === "notgram_webdav_save_settings") { config = args.config!; return summary(); }
        if (command === "notgram_webdav_request") {
          calls.push({ method: args.method!, body: args.body });
          if (failure === "stall") return new Promise(() => {});
          if (failure) throw new Error("network");
          if (args.method === "PUT") { body = args.body!; version += 1; return { status: 204, body: "", etag: `"${version}"` }; }
          return { status: body ? 200 : 404, body, etag: body ? `"${version}"` : null };
        }
        return null;
      },
    } });
  }, failure);
}

for (const width of [1366, 390]) {
test(`WebDAV masks both credentials outside editing and only uploads changed settings at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await expect(page.locator(".app-shell")).toBeVisible();
  await installDavFixture(page);
  const backup = await openBackup(page);
  await expect(backup.locator(".backup-webdav-summary dd").nth(1)).toHaveText("••••••••");
  await expect(backup.locator(".backup-webdav-summary dd").nth(2)).toHaveText("••••••••");
  await expect(backup).not.toContainText("private-dav");
  await backup.getByRole("button", { name: "编辑 WebDAV" }).click();
  await expect(backup.getByLabel("WebDAV 用户名", { exact: true })).toHaveValue("private-dav-user");
  await expect(backup.getByLabel("WebDAV 密码", { exact: true })).toHaveAttribute("type", "password");
  await backup.getByLabel("WebDAV 用户名", { exact: true }).fill("discard-this-edit");
  await backup.getByRole("button", { name: "取消", exact: true }).click();
  expect(await backup.innerHTML()).not.toMatch(/private-dav-user|private-dav-password|discard-this-edit/);
  await backup.getByRole("button", { name: "编辑 WebDAV" }).click();
  await expect(backup.getByLabel("WebDAV 用户名", { exact: true })).toHaveValue("private-dav-user");
  await backup.getByRole("switch", { name: "WebDAV 自动同步" }).check();
  await backup.getByRole("button", { name: "保存 WebDAV" }).click();
  await expect(backup.locator(".backup-webdav-form")).toHaveCount(0);
  expect(await backup.innerHTML()).not.toMatch(/private-dav-user|private-dav-password/);
  await expect.poll(() => page.evaluate(() => (window as unknown as { backupDavCalls: unknown[] }).backupDavCalls.length)).toBe(1);
  await expect(backup.getByText("已同步", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { backupDavCalls: { method: string }[] }).backupDavCalls.map(call => call.method))).toEqual(["GET"]);
  await page.evaluate(async () => {
    const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
    for (const value of [16, 17, 18]) preferencesStore.getState().setPreference("chatFontSize", value);
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { backupDavCalls: { method: string }[] }).backupDavCalls.filter(call => call.method === "PUT").length)).toBe(1);
  const encoded = await page.evaluate(() => (window as unknown as { backupDavCalls: { method: string; body?: string }[] }).backupDavCalls.find(call => call.method === "PUT")!.body!);
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  expect(JSON.parse(decoded).preferences.chatFontSize).toBe(18);
  expect(decoded).not.toMatch(/private-dav|username|password|https:/);
  expect(await horizontalOverflow(page)).toBe(false);
  await backup.screenshot({ path: testInfo.outputPath("backup-webdav-masked.png") });
});
}

test("WebDAV failure leaves the app interactive and retries after another settings edit", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toBeVisible();
  await installDavFixture(page, true);
  const backup = await openBackup(page);
  await backup.getByRole("button", { name: "编辑 WebDAV" }).click();
  await backup.getByRole("switch", { name: "WebDAV 自动同步" }).check();
  await backup.getByRole("button", { name: "保存 WebDAV" }).click();
  await expect(backup.getByText("同步失败", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "聊天设置", exact: true }).click();
  await page.getByRole("spinbutton", { name: "消息字体大小" }).fill("19");
  await expect.poll(() => page.evaluate(() => (window as unknown as { backupDavCalls: unknown[] }).backupDavCalls.length)).toBe(2);
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--chat-font-size"))).toBe("19px");
});

test("a standalone settings restore updates the main window", async ({ page, context }) => {
  await page.goto("/");
  const settings = await context.newPage();
  await settings.goto("/windows/settings-window.html");
  await settings.getByRole("button", { name: "Notgram", exact: true }).click();
  const encoded = Buffer.from(JSON.stringify({ format: "notgram-settings", version: 1, preferences: { chatFontSize: 20, adBlockKeywords: ["独立窗口"] }, revisions: {} })).toString("base64");
  await settings.getByLabel("选择设置备份文件").setInputFiles({ name: "restore.txt", mimeType: "text/plain", buffer: Buffer.from(encoded) });
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--chat-font-size"))).toBe("20px");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("notgram:backup:revisions:v1") ? atob(localStorage.getItem("notgram:backup:revisions:v1")!) : "{}").revisions?.chatFontSize ?? 0)).toBeGreaterThan(0);
  await settings.close();
});

test("a stalled cloud request does not block settings interaction", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toBeVisible();
  await installDavFixture(page, "stall");
  const backup = await openBackup(page);
  await backup.getByRole("button", { name: "编辑 WebDAV" }).click();
  await backup.getByRole("switch", { name: "WebDAV 自动同步" }).check();
  await backup.getByLabel("WebDAV 用户名", { exact: true }).press("Enter");
  await expect(backup).toBeVisible();
  await expect(backup.getByText("同步中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "聊天设置", exact: true }).click();
  await page.getByRole("spinbutton", { name: "消息字体大小" }).fill("19");
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--chat-font-size"))).toBe("19px");
  expect(await page.evaluate(() => (window as unknown as { backupDavCalls: unknown[] }).backupDavCalls.length)).toBe(1);
});

for (const width of [1366, 390]) {
  test(`backup settings preserve contrast and editing layout in dark mode at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.locator(".app-shell")).toBeVisible();
    await installDavFixture(page);
    await page.evaluate(async () => {
      const { preferencesStore } = await import("/src/store/preferencesStore.ts" as string) as typeof import("../../src/store/preferencesStore");
      preferencesStore.getState().setPreference("themeId", "notgram-dark");
    });
    const backup = await openBackup(page);
    await expect(backup.locator(".backup-webdav-summary")).toBeVisible();
    expect(await backup.locator(".backup-webdav").evaluate(element => {
      const channels = getComputedStyle(element).backgroundColor.match(/\d+(?:\.\d+)?/g)!.slice(0, 3).map(Number);
      return Math.max(...channels);
    })).toBeLessThan(100);
    await backup.screenshot({ path: testInfo.outputPath(`backup-dark-${width}.png`) });
    await backup.getByRole("button", { name: "编辑 WebDAV" }).click();
    await expect(backup.getByLabel("WebDAV 用户名", { exact: true })).toBeVisible();
    await expect(backup.getByRole("button", { name: "保存 WebDAV" })).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(false);
    await backup.screenshot({ path: testInfo.outputPath(`backup-edit-dark-${width}.png`) });
    await backup.getByRole("button", { name: "取消", exact: true }).click();
    expect(await backup.innerHTML()).not.toMatch(/private-dav-user|private-dav-password/);
  });
}
