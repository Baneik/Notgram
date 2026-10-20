import { afterEach, describe, expect, it } from "vitest";
import { applyLanguagePreference } from "../i18n";
import { mapTdMessageContent } from "../telegram/tdlibMapper";
import type { Chat, Message, MessageContent } from "../telegram/types";
import { replySenderId } from "../utils/localBlockedMessages";
import { replyPreviewFor } from "./conversationMessages";

afterEach(() => applyLanguagePreference("zh-CN"));

const chat = { id: "current", kind: "group", title: "Current" } as Chat;
const file = { id: 42, size: 1024 };
const formatted = (text: string) => ({ text, entities: [] });
const source = (content: MessageContent, overrides: Partial<Message> = {}): Message => ({
  id: "42", chatId: chat.id, senderId: "author", outgoing: false,
  sentAt: "2026-10-20T00:00:00.000Z", delivery: "sent", content, ...overrides,
});
const reply = (target: Message, quote?: string): Message => source({ kind: "text", text: "Reply" }, {
  id: "reply",
  replyTo: { kind: "message", chatId: target.chatId, messageId: target.id,
    senderId: target.senderId, content: target.content, quote },
});

// Behavioral fixtures follow Telegram Desktop v7.3.1 inReplyText / Media::toPreview.
const previews: Array<[string, Record<string, unknown>, string]> = [
  ["photo", { "@type": "messagePhoto", photo: { sizes: [] } }, "图片"],
  ["captioned photo", { "@type": "messagePhoto", caption: formatted("旅行照片") }, "图片，旅行照片"],
  ["whitespace caption", { "@type": "messagePhoto", caption: formatted(" \n ") }, "图片"],
  ["image document", { "@type": "messageDocument", document: { file_name: "image.png", mime_type: "image/png", document: file } }, "image.png"],
  ["document", { "@type": "messageDocument", document: { file_name: "report.pdf", document: file } }, "report.pdf"],
  ["captioned document", { "@type": "messageDocument", document: { file_name: "report.pdf", document: file }, caption: formatted("说明") }, "report.pdf，说明"],
  ["unnamed document", { "@type": "messageDocument", document: { document: file }, caption: formatted("说明") }, "文件，说明"],
  ["video", { "@type": "messageVideo", video: { file_name: "clip.mp4", video: file } }, "视频"],
  ["unnamed video", { "@type": "messageVideo", video: { video: file } }, "视频"],
  ["captioned video", { "@type": "messageVideo", video: { video: file }, caption: formatted("片段") }, "视频，片段"],
  ["video note", { "@type": "messageVideoNote", video_note: { video: file } }, "视频消息"],
  ["animation", { "@type": "messageAnimation", animation: { file_name: "animation.mp4", animation: file } }, "GIF"],
  ["voice", { "@type": "messageVoiceNote", voice_note: { voice: file } }, "语音消息"],
  ["song", { "@type": "messageAudio", audio: { file_name: "track.mp3", title: "歌名", performer: "歌手", audio: file } }, "歌手 – 歌名"],
  ["song title", { "@type": "messageAudio", audio: { file_name: "track.mp3", title: "歌名", audio: file } }, "歌名"],
  ["untagged audio", { "@type": "messageAudio", audio: { file_name: "track.mp3", audio: file } }, "track.mp3"],
  ["performer only", { "@type": "messageAudio", audio: { performer: "歌手", audio: file } }, "歌手 – Unknown Track"],
  ["unnamed audio", { "@type": "messageAudio", audio: { audio: file } }, "Unknown Track"],
  ["sticker", { "@type": "messageSticker", sticker: { emoji: "🙂", sticker: file } }, "🙂 贴纸"],
  ["unnamed sticker", { "@type": "messageSticker", sticker: { sticker: file } }, "贴纸"],
  ["animated emoji", { "@type": "messageAnimatedEmoji", animated_emoji: { emoji: "🙂", sticker: { sticker: file } } }, "🙂 贴纸"],
  ["contact", { "@type": "messageContact", contact: { first_name: "Alice", phone_number: "123456" } }, "联系人"],
  ["location", { "@type": "messageLocation" }, "位置"],
  ["live location", { "@type": "messageLiveLocation" }, "实时位置"],
  ["venue", { "@type": "messageVenue", venue: { title: "Cafe", address: "Road 1" } }, "位置，Cafe"],
  ["dice", { "@type": "messageDice", emoji: "🎲", value: 5 }, "🎲"],
  ["game", { "@type": "messageGame", game: { title: "Demo" } }, "🎮 Demo"],
  ["invoice", { "@type": "messageInvoice", title: "Order A" }, "Order A"],
  ["poll", { "@type": "messagePoll", poll: { question: formatted("选哪个？") } }, "选哪个？"],
  ["checklist", { "@type": "messageChecklist", checklist: { title: formatted("Todo") } }, "Todo"],
  ["paid media fallback", { "@type": "messagePaidMedia", caption: formatted("描述") }, "付费媒体，描述"],
  ["story", { "@type": "messageStory" }, "故事"],
  ["service", { "@type": "messageChatChangeTitle", title: "New group" }, "名称已更改：New group"],
  ["unsupported", { "@type": "messageFutureUnknown" }, "此消息暂不支持显示，请使用 Telegram 查看"],
];

describe("Telegram Desktop reply summaries", () => {
  it.each(previews)("formats %s with and without the source in local history", (_name, raw, expected) => {
    const target = source(mapTdMessageContent(raw));
    const message = reply(target);
    for (const messages of [new Map([[target.id, target]]), new Map<string, Message>()]) {
      expect(replyPreviewFor(message, messages, new Map(), chat)?.text).toBe(expected);
    }
  });

  it("keeps legacy photo and sticker transport names out of summaries", () => {
    for (const [content, expected] of [
      [{ kind: "media", mediaType: "photo", fileName: "image.png", sizeLabel: "" }, "图片"],
      [{ kind: "media", mediaType: "sticker", fileName: "sticker.webp", sizeLabel: "" }, "贴纸"],
      [{ kind: "media", mediaType: "sticker", fileName: "🙂", sizeLabel: "" }, "🙂 贴纸"],
    ] as Array<[MessageContent, string]>) {
      expect(replyPreviewFor(reply(source(content)), new Map(), new Map(), chat)?.text).toBe(expected);
    }
  });

  it("keeps an explicit quote authoritative and normalizes blank quotes", () => {
    const target = source(mapTdMessageContent({ "@type": "messagePhoto", caption: formatted("说明") }));
    expect(replyPreviewFor(reply(target, "选中的\n  内容"), new Map(), new Map(), chat)?.text).toBe("选中的 内容");
    expect(replyPreviewFor(reply(target, " \n "), new Map(), new Map(), chat)?.text).toBe("图片，说明");
  });

  it("never resolves an external reply to an unrelated local message with the same ID", () => {
    const external = source({ kind: "file", fileName: "correct.zip", sizeLabel: "" }, { chatId: "external", senderId: "external-author" });
    const local = source({ kind: "file", fileName: "wrong.pdf", sizeLabel: "" });
    const messages = new Map([[local.id, local]]);
    expect(replyPreviewFor(reply(external), messages, new Map(), chat)).toMatchObject({
      text: "correct.zip", chatId: "external", messageId: external.id,
    });
    expect(replySenderId(reply(external), messages)).toBe("external-author");
    expect(replyPreviewFor(reply(local), new Map([[external.id, external]]), new Map(), chat)?.text).toBe("wrong.pdf");
  });

  it("localizes media labels, caption separators and sticker descriptions", () => {
    applyLanguagePreference("en");
    const target = source(mapTdMessageContent({ "@type": "messageSticker", sticker: { emoji: "🙂", sticker: file } }));
    expect(replyPreviewFor(reply(target), new Map(), new Map(), chat)?.text).toBe("🙂 Sticker");
    applyLanguagePreference("ja");
    expect(replyPreviewFor(reply(target), new Map(), new Map(), chat)?.text).toBe("🙂 ステッカー");
  });

  it("keeps rich media labels without changing the source text or cutting a quote at 72 characters", () => {
    const target = source(mapTdMessageContent({ "@type": "messageRichMessage", message: { blocks: [
      { "@type": "pageBlockVideo", video: { file_name: "transport.mp4", video: file } },
    ] } }));
    expect(target.content).toMatchObject({ kind: "rich", text: "transport.mp4" });
    expect(replyPreviewFor(reply(target), new Map(), new Map(), chat)?.text).toBe("视频");
    const quote = `${"a".repeat(71)}👨‍👩‍👧‍👦${"b".repeat(50)}`;
    expect(replyPreviewFor(reply(target, quote), new Map(), new Map(), chat)?.text).toBe(quote);
  });
});
