import { describe, expect, it } from "vitest";
import { retainedMessageQuote, retainHydratedContent } from "./retainedMessages";
import { inputMediaCopy } from "./mediaCopy";
import type { MessageContent } from "./types";
import { inputTextEntityType } from "./tdlibTextEntities";

describe("retained message content", () => {
  it("quotes the sender as a real Telegram mention and keeps UTF-16 body offsets", () => {
    const quote = retainedMessageQuote({ kind: "text", text: "什么🤔",
      entities: [{ kind: "bold", offset: 2, length: 2 }] }, "Lucy 😀", undefined, "12345");
    expect(quote.text).toBe("@Lucy 😀:\n什么🤔");
    expect(quote.entities).toEqual([
      { kind: "blockquote", offset: 0, length: quote.text.length },
      { kind: "mentionName", offset: 0, length: "@Lucy 😀".length, userId: "12345" },
      { kind: "bold", offset: "@Lucy 😀:\n什么".length, length: 2 },
    ]);
    expect(inputTextEntityType(quote.entities[1])).toEqual({ "@type": "textEntityTypeMentionName", user_id: 12345 });
  });

  it("does not turn a channel sender into a user mention", () => {
    const quote = retainedMessageQuote({ kind: "text", text: "news" }, "Channel", undefined, "chat:-10012345");
    expect(quote.text).toBe("Channel:\nnews");
    expect(quote.entities).toHaveLength(1);
  });

  it("quotes only selected text and shifts its UTF-16 entities after the author", () => {
    const quote = retainedMessageQuote({ kind: "text", text: "before selected after",
      entities: [{ offset: 0, length: 6, kind: "bold" }] }, "Alice 😀", {
      text: "selected", position: 7, entities: [{ offset: 0, length: 8, kind: "spoiler" }],
    });
    expect(quote.text).toBe("Alice 😀:\nselected");
    expect(quote.entities).toEqual([
      { offset: 0, length: quote.text.length, kind: "blockquote" },
      { offset: "Alice 😀:\n".length, length: 8, kind: "spoiler" },
    ]);
  });

  it("does not inherit source entity offsets when a selected quote has no entities", () => {
    const quote = retainedMessageQuote({ kind: "text", text: "before selected after",
      entities: [{ offset: 0, length: 6, kind: "bold" }] }, "Alice", { text: "selected", position: 7 });
    expect(quote.entities).toHaveLength(1);
  });

  it("covers the author and final character without nesting existing block quotes", () => {
    const quote = retainedMessageQuote({ kind: "text", text: "last!",
      entities: [{ offset: 0, length: 5, kind: "blockquote" }] }, "Alice");
    expect(quote.text.slice(quote.entities[0].offset, quote.entities[0].length)).toBe("Alice:\nlast!");
    expect(quote.entities).toHaveLength(1);
  });

  it("does not attach a cached path to a different file identifier", () => {
    const existing: MessageContent = { kind: "media", mediaType: "photo", fileName: "old.jpg", sizeLabel: "4 KB",
      fileId: 1, localPath: "C:/cache/old.jpg", isDownloaded: true };
    const snapshot = { ...existing, fileId: 2, localPath: undefined, isDownloaded: false };
    expect(retainHydratedContent(snapshot, existing)).toMatchObject({ fileId: 2, localPath: undefined, isDownloaded: false });
  });

  it.each([
    ["photo", "inputMessagePhoto", "photo"], ["video", "inputMessageVideo", "video"],
    ["animation", "inputMessageAnimation", "animation"], ["audio", "inputMessageAudio", "audio"],
    ["voice", "inputMessageVoiceNote", "voice_note"], ["videoNote", "inputMessageVideoNote", "video_note"],
    ["sticker", "inputMessageSticker", "sticker"],
  ] as const)("copies %s as a Telegram media file", (mediaType, type, field) => {
    const request = inputMediaCopy({ kind: "media", mediaType, fileId: 42, fileName: "cached", sizeLabel: "4 KB" });
    expect(request["@type"]).toBe(type);
    expect(request[field]).toMatchObject({ [field]: { "@type": "inputFileId", id: 42 } });
    expect(JSON.stringify(request)).not.toContain("inputFileLocal");
  });

  it("preserves document captions and rejects media without a usable file identifier", () => {
    const content = { kind: "file" as const, fileName: "a.pdf", sizeLabel: "4 KB", fileId: 42,
      caption: "caption", captionEntities: [{ offset: 0, length: 7, kind: "bold" as const }] };
    expect(inputMediaCopy(content)).toMatchObject({ "@type": "inputMessageDocument",
      caption: { text: "caption", entities: [{ offset: 0, length: 7, type: { "@type": "textEntityTypeBold" } }] } });
    expect(() => inputMediaCopy({ ...content, fileId: undefined })).toThrow("文件标识");
  });
});
