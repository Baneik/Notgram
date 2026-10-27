import { expect, test } from "@playwright/test";

for (const width of [1366, 390]) {
  test(`startup restoration completes without duplicate lookups while switching and typing at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: `${await response.text()}\n{
        const gate = new Promise(resolve => { window.releaseMediaRecovery = resolve; });
        window.mediaRecoveryRequests = [];
        MockTelegramTransport.prototype.loadCachedSnapshot = async function() {
          return { ...mockSnapshot, version: 4, savedAt: new Date().toISOString(),
            messages: [], activeChatId: "chat-product",
            locallyDeletedMessages: Array.from({ length: 400 }, (_, index) => ({
              ...mockSnapshot.messages[0], chatId: "background-archive", id: "startup-" + index,
              replyTo: undefined, isLocallyDeleted: true, locallyDeletedAt: new Date().toISOString(),
              content: { kind: "file", fileName: "startup.txt", sizeLabel: "1 KB", remoteId: "startup-" + index },
            })),
          };
        };
        MockTelegramTransport.prototype.resolveRemoteFile = async function(id) {
          if (!id.startsWith("startup-")) return undefined;
          window.mediaRecoveryRequests.push(id);
          await gate;
          return { fileId: 10000 + Number(id.slice(8)), remoteId: id, sizeLabel: "1 KB", canDownload: true };
        };
      }` });
    });
    await page.goto("/");
    const requests = () => page.evaluate(() => (window as unknown as { mediaRecoveryRequests: string[] }).mediaRecoveryRequests);
    await expect.poll(() => requests().then(items => items.length)).toBe(4);
    await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    for (const [id, title] of [["chat-mia", "Mia Chen"], ["chat-product", "产品讨论"], ["chat-mia", "Mia Chen"]]) {
      const back = page.getByRole("button", { name: "返回会话列表", exact: true });
      if (width === 390 && await back.isVisible()) await back.click();
      await page.locator(`.chat-list[data-active=true] [data-chat-id="${id}"]`).click();
      await expect(page.locator(".conversation-title strong")).toHaveText(title);
      await expect(page.locator(".message-list")).toHaveAttribute("aria-busy", "false");
    }
    await page.locator(".composer-input").fill("draft before recovery");
    await page.evaluate(() => (window as unknown as { releaseMediaRecovery: () => void }).releaseMediaRecovery());
    await page.locator(".composer-input").press("End");
    await page.locator(".composer-input").pressSequentially(" and while recovering", { delay: 2 });
    await expect(page.locator(".composer-input")).toHaveText("draft before recovery and while recovering");
    const frames = await page.evaluate(async () => {
      let count = 0;
      const started = performance.now();
      while (performance.now() - started < 250) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        count++;
      }
      return count;
    });
    expect(frames).toBeGreaterThan(5);
    await expect.poll(() => requests().then(items => items.length), { timeout: 15_000 }).toBe(400);
    await expect.poll(() => page.evaluate(async () => {
      const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
      return telegramStore.getState().messages.get("background-archive")?.filter(message =>
        message.content.kind === "file" && message.content.fileId !== undefined).length;
    }), { timeout: 15_000 }).toBe(400);
    const queried = await requests();
    expect(new Set(queried).size).toBe(400);
    expect(queried).toHaveLength(400);
    await expect(page.locator(".conversation-title strong")).toHaveText("Mia Chen");
    await expect(page.locator(".composer-input")).toHaveText("draft before recovery and while recovering");
  });
}
