import { expect, test } from "@playwright/test";
import type { Message, TelegramEvent } from "../../src/telegram/types";
import { scrollAwayFromBottom, visibleMessageAnchor } from "./helpers";

interface AlbumWindow extends Window {
  __incomingAlbumDispatch: (event: TelegramEvent) => void;
}

for (const scenario of [
  { width: 1366, detached: false, count: 6, channel: false, scale: 100 },
  { width: 390, detached: false, count: 10, channel: false, scale: 125 },
  { width: 1366, detached: true, count: 6, channel: false, scale: 100 },
  { width: 1366, detached: false, count: 6, channel: true, scale: 100 },
]) {
  test(`staggered incoming album appears with every tile (${JSON.stringify(scenario)})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    await page.route(/\/src\/telegram\/mockTransport\.ts(?:\?.*)?$/, async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: `${await response.text()}\n{
        const connect = MockTelegramTransport.prototype.connect;
        MockTelegramTransport.prototype.connect = async function(listener) {
          globalThis.__incomingAlbumDispatch = listener;
          return connect.call(this, listener);
        };
      }` });
    });
    await page.goto("/");
    if (scenario.width < 600 || scenario.channel) {
      await page.locator(`.chat-list[data-active=true] [data-chat-id="${scenario.channel ? "chat-release" : "chat-product"}"]`).click();
    }
    const list = page.getByRole("log", { name: "消息列表" });
    await expect(list).toHaveAttribute("aria-busy", "false");
    await page.evaluate(async scale => {
      const { preferencesStore } = await (0, eval)('import("/src/store/preferencesStore.ts")') as typeof import("../../src/store/preferencesStore");
      preferencesStore.setState({ interfaceScale: scale, themeId: scale > 100 ? "notgram-dark" : "notgram-light" });
    }, scenario.scale);
    await list.press("End");
    await expect.poll(() => list.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
    if (scenario.detached) await scrollAwayFromBottom(page);
    const anchor = scenario.detached ? await visibleMessageAnchor(page) : undefined;

    const report = await page.evaluate(async scenario => {
      const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
      const dispatch = (window as unknown as AlbumWindow).__incomingAlbumDispatch;
      const chatId = scenario.channel ? "chat-release" : "chat-product";
      const members = () => (telegramStore.getState().messages.get(chatId) ?? [])
        .filter(message => message.mediaAlbumId === "staggered-album");
      const commits: number[] = [];
      const stop = telegramStore.subscribe((state, previous) => {
        if (state.messages !== previous.messages && members().length > 0) commits.push(members().length);
      });
      const canvas = document.createElement("canvas"); canvas.width = 800; canvas.height = 600;
      canvas.getContext("2d")!.fillRect(0, 0, 800, 600);
      const previewDataUrl = canvas.toDataURL();
      const sentAt = new Date(Date.now() + 1000).toISOString();
      const visibleCounts: number[] = [];
      let sampling = true;
      const sample = () => {
        visibleCounts.push(document.querySelectorAll('[data-message-id^="incoming-album-"]').length);
        if (sampling) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      for (let index = 0; index < scenario.count; index++) {
        const message: Message = {
          id: `incoming-album-${index}`, chatId, senderId: "u-chen", outgoing: false, delivery: "sent", sentAt,
          mediaAlbumId: "staggered-album", isChannelPost: scenario.channel,
          content: { kind: "media", mediaType: index === 2 ? "video" : "photo", fileName: `${index}.jpg`, sizeLabel: "1 KB",
            width: index % 2 ? 600 : 800, height: index % 2 ? 800 : 600, previewDataUrl,
            caption: index === 0 ? "Incoming album caption" : undefined },
        };
        dispatch({ type: "message.upsert", message, animateEntrance: true });
        await new Promise(resolve => setTimeout(resolve, 120));
      }
      const partial = members().length;
      await new Promise(resolve => setTimeout(resolve, 900));
      sampling = false;
      stop();
      return { partial, commits, visibleCounts: [...new Set(visibleCounts)] };
    }, scenario);
    expect(report.partial).toBe(0);
    expect(report.commits).toEqual([scenario.count]);
    // Virtuoso may mount the complete album in its overscan area while reading
    // history. No mounted frame may contain only a subset of its members.
    expect(report.visibleCounts.every(count => count === 0 || count === scenario.count)).toBe(true);
    if (!scenario.detached) expect(report.visibleCounts).toContain(scenario.count);
    if (scenario.detached && anchor) {
      const after = await visibleMessageAnchor(page);
      expect(after.id).toBe(anchor.id);
      expect(Math.abs(after.offset - anchor.offset)).toBeLessThanOrEqual(1);
    } else {
      const album = list.locator('[data-media-album-id="staggered-album"]');
      await expect(album.locator(".media-album-tile")).toHaveCount(scenario.count);
      await expect(album).toContainText("Incoming album caption");
      await expect.poll(() => list.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath("incoming-album.png") });
    }
  });
}
