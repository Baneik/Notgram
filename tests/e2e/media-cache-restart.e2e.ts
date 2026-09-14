import { expect, test, type Page } from "@playwright/test";

// Keep server history empty: the visible image must recover through the real cached-message path.
const transportModule = `
import { MockTelegramTransport } from '/src/telegram/mockTransport.ts';
import { mockSnapshot } from '/src/telegram/mockData.ts';
class CachedMediaTransport extends MockTelegramTransport {
  constructor() {
    super();
    const run = Number(sessionStorage.getItem('media-run') || 0) + 1;
    sessionStorage.setItem('media-run', String(run));
    this.fileId = 91 + run * 100;
    window.__mediaRequests = [];
  }
  async loadCachedSnapshot() {
    return await super.loadCachedSnapshot() || {
      ...mockSnapshot, version: 4, savedAt: new Date().toISOString(), activeChatId: 'chat-product',
      messages: [{ ...mockSnapshot.messages[0], id: '900001', chatId: 'chat-product',
        sentAt: '2026-09-07T00:00:00Z', canSave: true, replyTo: undefined,
        content: { kind: 'media', mediaType: 'photo', fileName: 'cached-photo.jpg', sizeLabel: '83 KB',
          size: 85479, width: 589, height: 1280, fileId: 91, remoteId: 'cached-photo',
          remoteUniqueId: 'cached-photo-unique', canDownload: true, isDownloaded: false, isDownloading: true,
          previewDataUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="40"><rect width="20" height="40" fill="lightblue"/></svg>') }
      }]
    };
  }
  async saveCachedSnapshot(snapshot) {
    await super.saveCachedSnapshot(snapshot);
    window.__mediaSavedSnapshot = snapshot;
  }
  async loadChatHistory() { return { messages: [], messageIds: [], loadedCount: 0, hasMore: false }; }
  async resolveRemoteFile(remoteId) {
    window.__mediaRequests.push({ type: 'resolve', remoteId });
    await new Promise(resolve => setTimeout(resolve, 60));
    return { fileId: this.fileId, remoteId, remoteUniqueId: 'cached-photo-unique',
      size: 85479, sizeLabel: '83 KB', isDownloaded: false, isDownloading: false, localPath: undefined, canDownload: true };
  }
  async cacheFile(fileId) {
    window.__mediaRequests.push({ type: 'download', fileId });
    if (fileId !== this.fileId) throw new Error('Stale runtime file ID');
    const file = { fileId, remoteId: 'cached-photo', remoteUniqueId: 'cached-photo-unique',
      size: 85479, sizeLabel: '83 KB', canDownload: true };
    this.listener?.({ type: 'file.updated', file: { ...file, isDownloading: true, isDownloaded: false, progress: 0.5 } });
    await new Promise(resolve => setTimeout(resolve, 80));
    this.listener?.({ type: 'file.updated', file: { ...file, isDownloading: false, isDownloaded: true,
      progress: 1, downloadedSize: 85479, localPath: '/mock-video-poster.jpg' } });
  }
  async downloadFile(fileId) {
    await this.cacheFile(fileId);
    if (location.search.includes('saveError')) throw new Error('This message cannot be saved or has expired');
  }
}
export const createTelegramTransport = () => new CachedMediaTransport();
`;

const prepare = async (page: Page, automatic: boolean) => {
  await page.route(/\/src\/telegram\/createTransport\.ts(?:\?.*)?$/, route => route.fulfill({
    contentType: "application/javascript", body: transportModule,
  }));
  await page.addInitScript(automatic => {
    localStorage.setItem("notgram:preferences:v1", JSON.stringify({ autoDownloadImages: automatic, autoDownloadLimitMb: 10 }));
  }, automatic);
};

const requests = (page: Page) => page.evaluate(() =>
  (window as unknown as { __mediaRequests: Array<{ type: string; fileId?: number }> }).__mediaRequests);
const photoRow = (page: Page) => page.locator('[data-message-id="900001"]');

test("cached historical photos automatically load with newly bound file IDs after each restart", async ({ page }) => {
  await prepare(page, true);
  await page.goto("/");
  await expect(photoRow(page).locator('img[src*="mock-video-poster.jpg"]')).toBeVisible();
  expect((await requests(page)).filter(request => request.type === "download").map(request => request.fileId)).toEqual([191]);
  await expect.poll(() => page.evaluate(() => {
    const snapshot = (window as unknown as { __mediaSavedSnapshot?: { messages: Array<{ id: string; content: { fileId?: number; isDownloaded?: boolean } }> } }).__mediaSavedSnapshot;
    const content = snapshot?.messages.find(message => message.id === "900001")?.content;
    return content?.isDownloaded && content.fileId === undefined;
  }), { timeout: 15_000 }).toBe(true);
  await page.reload();
  await expect.poll(async () => (await requests(page)).filter(request => request.type === "download").map(request => request.fileId)).toEqual([291]);
  await expect(photoRow(page).locator('img[src*="mock-video-poster.jpg"]')).toBeVisible();
  await expect(photoRow(page).getByRole("button", { name: "下载 cached-photo.jpg", exact: true })).toHaveCount(0);
});

test("manual download updates an ordinary cached photo when automatic download is disabled", async ({ page }) => {
  await prepare(page, false);
  await page.goto("/");
  const button = photoRow(page).getByRole("button", { name: "下载 cached-photo.jpg", exact: true });
  await expect(button).toBeVisible();
  expect((await requests(page)).filter(request => request.type === "download")).toEqual([]);
  await button.click();
  await expect(photoRow(page).locator('img[src*="mock-video-poster.jpg"]')).toBeVisible();
  await expect(button).toHaveCount(0);
  expect((await requests(page)).filter(request => request.type === "download").map(request => request.fileId)).toEqual([191]);
});

test("manual save failures retain the concrete error and the successfully cached image", async ({ page }) => {
  await prepare(page, false);
  await page.goto("/?saveError=1");
  await photoRow(page).getByRole("button", { name: "下载 cached-photo.jpg", exact: true }).click();
  await expect(page.getByText("This message cannot be saved or has expired", { exact: true })).toBeVisible();
  await expect(photoRow(page).locator('img[src*="mock-video-poster.jpg"]')).toBeVisible();
});
