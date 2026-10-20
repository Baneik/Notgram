import { expect, test, type Page } from "@playwright/test";
import type { Message } from "../../src/telegram/types";
import { chooseMessageMenuItem, horizontalOverflow } from "./helpers";

const formatted = (text: string) => ({ text, entities: [] });
const file = { id: 991234, size: 1024 };
const cases: Array<[string, Record<string, unknown>, string]> = [
  ["photo", { "@type": "messagePhoto", caption: formatted("旅行照片") }, "图片，旅行照片"],
  ["image document", { "@type": "messageDocument", document: { file_name: "image.png", mime_type: "image/png", document: file } }, "image.png"],
  ["video", { "@type": "messageVideo", video: { video: file } }, "视频"],
  ["video note", { "@type": "messageVideoNote", video_note: { video: file } }, "视频消息"],
  ["animation", { "@type": "messageAnimation", animation: { file_name: "animation.mp4", animation: file } }, "GIF"],
  ["voice", { "@type": "messageVoiceNote", voice_note: { voice: file } }, "语音消息"],
  ["audio", { "@type": "messageAudio", audio: { file_name: "track.mp3", title: "歌名", performer: "歌手", audio: file } }, "歌手 – 歌名"],
  ["sticker", { "@type": "messageSticker", sticker: { emoji: "🙂", sticker: file } }, "🙂 贴纸"],
  ["document", { "@type": "messageDocument", document: { file_name: "report.pdf", document: file }, caption: formatted("说明") }, "report.pdf，说明"],
  ["contact", { "@type": "messageContact", contact: { first_name: "Alice", phone_number: "123456" } }, "联系人"],
  ["poll", { "@type": "messagePoll", poll: { question: formatted("选哪个？") } }, "选哪个？"],
  ["whitespace caption", { "@type": "messagePhoto", caption: formatted(" \n ") }, "图片"],
];

async function openConversation(page: Page) {
  await page.goto("/");
  await page.locator('.chat-list[data-active=true] [data-chat-id="chat-product"]').click();
  await expect(page.locator('[data-message-id="p-video"]')).toBeVisible();
}

async function showReply(page: Page, raw: Record<string, unknown>, cached: boolean, quote?: string, external = false) {
  await page.evaluate(async ({ raw, cached, quote, external }) => {
    const { telegramStore } = await import("/src/store/telegramStore.ts" as string) as typeof import("../../src/store/telegramStore");
    const { mapTdMessageContent } = await import("/src/telegram/tdlibMapper.ts" as string) as typeof import("../../src/telegram/tdlibMapper");
    const state = telegramStore.getState();
    const template = state.messages.get("chat-product")!.at(-1)!;
    const target: Message = {
      ...template, id: "p-2", chatId: "chat-product", senderId: "self",
      outgoing: true, isChannelPost: false, content: mapTdMessageContent(raw),
      replyTo: undefined, forwardInfo: undefined, interaction: undefined, mediaAlbumId: undefined,
      permissions: template.permissions ? { ...template.permissions, canReply: true } : undefined,
    };
    const reply: Message = {
      ...target, id: "reply-preview-result", outgoing: false, senderId: "u-mia",
      content: { kind: "text", text: "回复预览规范" },
      replyTo: {
        kind: "message", chatId: external ? "chat-notes" : target.chatId,
        messageId: target.id, senderId: "self", content: target.content, quote,
      },
    };
    const collision = { ...target, content: { kind: "text" as const, text: "不应显示的本地消息" } };
    telegramStore.setState({ messages: new Map(state.messages).set("chat-product",
      external ? [collision, reply] : cached ? [target, reply] : [reply]) });
  }, { raw, cached, quote, external });
  return page.locator('[data-message-id="reply-preview-result"] .message-reply-preview');
}

for (const width of [1366, 390]) {
  test(`reply media summaries match Desktop for cached and embedded sources (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await openConversation(page);
    for (const [name, raw, expected] of cases) {
      for (const cached of [false, true]) {
        const preview = await showReply(page, raw, cached);
        await expect(preview.locator("small"), `${name}, cached=${cached}`).toHaveText(expected);
        await expect(preview).toBeVisible();
        if (cached && ["photo", "image document", "audio", "sticker"].includes(name)) {
          await page.locator('[data-message-id="reply-preview-result"]').screenshot({ path: testInfo.outputPath(`${name.replaceAll(" ", "-")}.png`) });
        }
      }
    }
    expect(await horizontalOverflow(page)).toBe(false);
    await page.locator('[data-message-id="reply-preview-result"]').screenshot({ path: testInfo.outputPath("reply-preview.png") });
  });

  test(`composer and sent replies use the same media summary (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openConversation(page);
    for (const [, raw, expected] of cases.filter(([name]) => ["photo", "image document", "audio", "sticker", "document"].includes(name))) {
      await showReply(page, raw, true);
      const trigger = page.locator('[data-message-id="p-2"] .message-bubble-shell');
      await trigger.focus();
      await page.keyboard.press("Shift+F10");
      await chooseMessageMenuItem(page, "回复");
      await expect(page.locator(".composer-context.is-replying small")).toHaveText(expected);
      await page.getByRole("button", { name: "取消回复", exact: true }).click();
    }
    await showReply(page, cases[2][1], true);
    await page.locator('[data-message-id="p-2"] .message-bubble-shell').focus();
    await page.keyboard.press("Shift+F10");
    await chooseMessageMenuItem(page, "回复");
    await page.getByRole("textbox", { name: "消息内容", exact: true }).fill("规范化后发送");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-row.is-outgoing", { hasText: "规范化后发送" }).last()
      .locator(".message-reply-preview small")).toHaveText("视频");
  });

  test(`external replies ignore colliding local IDs and long quotes remain intact (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openConversation(page);
    let preview = await showReply(page, cases[2][1], true, undefined, true);
    await expect(preview.locator("small")).toHaveText("视频");
    await expect(preview).not.toContainText("不应显示的本地消息");
    const quote = `${"原文".repeat(50)}👨‍👩‍👧‍👦尾部`;
    preview = await showReply(page, cases[2][1], false, quote);
    await expect(preview.locator("small")).toHaveText(quote);
    await expect(preview.locator("small")).toHaveCSS("text-overflow", "ellipsis");
    expect(await horizontalOverflow(page)).toBe(false);
  });
}
