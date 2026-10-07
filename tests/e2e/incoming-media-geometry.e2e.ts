import { expect, test } from "@playwright/test";
import { scrollAwayFromBottom } from "./helpers";
import type { Message, MessageRichMedia } from "../../src/telegram/types";

interface Scenario {
  mediaType: "video" | "photo" | "animation";
  width: number;
  spoiler: boolean;
  detached: boolean;
  missingSize: boolean;
  scale?: number;
  reducedMotion?: boolean;
  collection?: boolean;
  fullSource?: boolean;
}

const scenarios: Scenario[] = [
  { mediaType: "video", width: 1366, spoiler: false, detached: false, missingSize: false },
  { mediaType: "video", width: 390, spoiler: true, detached: false, missingSize: false },
  { mediaType: "photo", width: 1366, spoiler: false, detached: false, missingSize: false },
  { mediaType: "animation", width: 390, spoiler: true, detached: false, missingSize: false },
  { mediaType: "video", width: 1366, spoiler: false, detached: true, missingSize: false },
  { mediaType: "photo", width: 1366, spoiler: false, detached: false, missingSize: true },
  { mediaType: "video", width: 1366, spoiler: false, detached: false, missingSize: true },
  { mediaType: "photo", width: 1366, spoiler: false, detached: false, missingSize: false, collection: true, fullSource: true },
  { mediaType: "animation", width: 1366, spoiler: false, detached: false, missingSize: false, fullSource: true },
  { mediaType: "video", width: 390, spoiler: true, detached: false, missingSize: false, scale: 125, reducedMotion: true },
];
for (const scenario of scenarios) {
  test(`incoming rich ${scenario.mediaType} keeps its frame through delayed previews (${JSON.stringify(scenario)})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: 812 });
    await page.goto("/");
    if (scenario.width < 600) await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
    if (scenario.scale || scenario.reducedMotion) await page.evaluate(async (scenario) => {
      const { preferencesStore } = await (0, eval)('import("/src/store/preferencesStore.ts")') as typeof import("../../src/store/preferencesStore");
      preferencesStore.setState({ interfaceScale: scenario.scale ?? 100, reduceMotion: scenario.reducedMotion ?? false });
    }, scenario);
    const list = page.getByRole("log", { name: "消息列表" });
    await expect(list).toHaveAttribute("aria-busy", "false");
    await expect.poll(() => list.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(1);
    if (scenario.detached) await scrollAwayFromBottom(page);

    await page.evaluate(async (scenario) => {
      const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
      const { markMessageEntrance } = await (0, eval)('import("/src/utils/messageEntrance.ts")') as typeof import("../../src/utils/messageEntrance");
      const media: MessageRichMedia = {
        mediaType: scenario.mediaType, fileName: "received-media", sizeLabel: "4 MB", duration: 9,
        width: scenario.missingSize ? undefined : 1080, height: scenario.missingSize ? undefined : 1420,
        hasSpoiler: scenario.spoiler, autoplay: false, loop: false, url: scenario.mediaType === "photo" ? "https://example.com/photo" : undefined,
      };
      const message: Message = {
        id: "incoming-geometry", chatId: "chat-product", senderId: "u-chen", outgoing: false,
        sentAt: new Date(Date.now() + 1000).toISOString(), delivery: "sent",
        replyTo: { kind: "message", messageId: "p-1", quote: "Synthetic quoted source" },
        content: { kind: "rich", text: "Synthetic caption Source", isRtl: false, isFull: true,
          blocks: [scenario.collection ? { kind: "collection", layout: "collage", blocks: [{ kind: "media", media }] }
            : { kind: "media", media }, { kind: "paragraph", text: [{ text: "Synthetic caption" }] },
            { kind: "paragraph", text: [{ text: "Source", href: "https://example.com/" }] }] },
      };
      markMessageEntrance(message);
      const state = telegramStore.getState();
      const messages = new Map(state.messages);
      messages.set(message.chatId, [...messages.get(message.chatId)!, message]);
      telegramStore.setState({ messages });
    }, scenario);
    const row = list.locator('[data-message-id="incoming-geometry"]');
    await expect(row).toHaveCount(1);
    await expect(row).toBeVisible();
    await expect(row).not.toHaveClass(/is-entering|is-awaiting/);

    // Sampling begins only after the new message has settled. Preview requests,
    // decoding and source upgrades must not move this established geometry.
    const report = await page.evaluate(async ({ mediaType, detached, fullSource }) => {
      const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as typeof import("../../src/store/telegramStore");
      const host = document.querySelector<HTMLElement>('.message-list[role="log"]')!;
      const read = () => {
        const frame = host.querySelector<HTMLElement>('[data-message-id="incoming-geometry"] .rich-media-visual')!;
        const bounds = frame.getBoundingClientRect();
        return { top: host.scrollTop, distance: host.scrollHeight - host.clientHeight - host.scrollTop,
          frameTop: bounds.top, frameWidth: bounds.width, frameHeight: bounds.height };
      };
      let previous = read();
      let stableFrames = 0;
      for (let frame = 0; frame < 40 && stableFrames < 4; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const next = read();
        stableFrames = Math.abs(next.frameTop - previous.frameTop) < 0.01 &&
          Math.abs(next.frameHeight - previous.frameHeight) < 0.01 ? stableFrames + 1 : 0;
        previous = next;
      }
      const before = read();
      const samples: Array<ReturnType<typeof read>> = [];
      let sampling = true;
      const sample = () => { samples.push(read()); if (sampling) requestAnimationFrame(sample); };
      requestAnimationFrame(sample);
      const update = (patch: Partial<MessageRichMedia>) => {
        const patchBlock = (block: import("../../src/telegram/types").MessageRichBlock): import("../../src/telegram/types").MessageRichBlock =>
          block.kind === "media" ? { ...block, media: { ...block.media, ...patch } }
            : block.kind === "collection" ? { ...block, blocks: block.blocks.map(patchBlock) } : block;
        const messages = new Map(telegramStore.getState().messages);
        messages.set("chat-product", messages.get("chat-product")!.map(message => message.id === "incoming-geometry" && message.content.kind === "rich"
          ? { ...message, content: { ...message.content, blocks: message.content.blocks.map(patchBlock) } } : message));
        telegramStore.setState({ messages });
      };
      const poster = (width: number, height: number) => {
        const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
        canvas.getContext("2d")!.fillRect(0, 0, width, height);
        return canvas.toDataURL("image/png");
      };
      const waitFrames = async (count: number) => {
        for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      };
      update({ isDownloading: true, progress: 0.25 });
      await waitFrames(8);
      update({ previewDataUrl: poster(1080, 1420), progress: 0.7 });
      await waitFrames(16);
      update({ previewDataUrl: poster(1920, 1080), isDownloading: false });
      await waitFrames(16);
      update({ previewDataUrl: undefined });
      await waitFrames(8);
      update({ previewDataUrl: poster(1080, 1420) });
      await waitFrames(16);
      if (fullSource) {
        update({ localPath: mediaType === "animation" ? "/mock-video.mp4" : poster(1080, 1420),
          mimeType: mediaType === "animation" ? "video/mp4" : "image/png", isDownloaded: true });
        await waitFrames(16);
      }
      sampling = false;
      const image = host.querySelector<HTMLImageElement>('[data-message-id="incoming-geometry"] img');
      const video = host.querySelector<HTMLVideoElement>('[data-message-id="incoming-geometry"] video');
      return { before, samples, imageReady: Boolean(image?.complete && image.naturalWidth > 0) || Boolean(video && video.readyState >= 2), mediaType, detached };
    }, scenario);
    expect(report.imageReady).toBe(true);
    expect(report.before.frameHeight).toBeGreaterThan(100);
    const error = (key: "frameTop" | "frameHeight" | "frameWidth" | "top") =>
      Math.max(...report.samples.map(sample => Math.abs(sample[key] - report.before[key])));
    expect(error("frameHeight"), JSON.stringify(report)).toBeLessThanOrEqual(0.5);
    expect(error("frameWidth"), JSON.stringify(report)).toBeLessThanOrEqual(0.5);
    expect(error("frameTop"), JSON.stringify(report)).toBeLessThanOrEqual(0.5);
    expect(error("top"), JSON.stringify(report)).toBeLessThanOrEqual(1);
    if (!scenario.detached) expect(Math.max(...report.samples.map(sample => sample.distance)), JSON.stringify(report)).toBeLessThanOrEqual(1);
    if (scenario.spoiler) {
      const before = await row.locator(".rich-media-visual").boundingBox();
      await row.getByRole("button", { name: "显示遮罩媒体" }).click();
      const after = await row.locator(".rich-media-visual").boundingBox();
      expect(after).toEqual(before);
    }
    if (scenario.mediaType === "video" && !scenario.detached && !scenario.missingSize) {
      await page.screenshot({ path: testInfo.outputPath("received-media.png") });
    }
  });
}
