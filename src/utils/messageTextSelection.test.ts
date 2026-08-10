import { describe, expect, it } from "vitest";
import { replyQuoteFromRenderedSelection } from "./messageTextSelection";

describe("message text reply quotes", () => {
  it("maps a plain rendered selection directly to the source", () => {
    expect(replyQuoteFromRenderedSelection("alpha beta", "alpha beta", 6, 10))
      .toEqual({ text: "beta", position: 6 });
  });

  it("keeps an exact source slice when Markdown syntax is hidden by rendering", () => {
    expect(replyQuoteFromRenderedSelection(
      "**粗体**普通文本",
      "粗体普通文本",
      0,
      6,
    )).toEqual({
      text: "粗体**普通文本",
      position: 2,
    });
  });

  it("uses the monotonic source occurrence for repeated rendered text", () => {
    expect(replyQuoteFromRenderedSelection(
      "**same** same",
      "same same",
      5,
      9,
    )).toEqual({ text: "same", position: 9 });
  });

  it("expands atomic quote entities and keeps all TDLib-required metadata", () => {
    expect(replyQuoteFromRenderedSelection(
      "A😀 2026B",
      "A😀 2026B",
      2,
      8,
      [
        { offset: 1, length: 2, kind: "customEmoji", customEmojiId: "99" },
        {
          offset: 4,
          length: 4,
          kind: "dateTime",
          dateTime: { unixTime: 1_800_000_000, mode: "relative" },
        },
      ],
    )).toEqual({
      text: "😀 2026",
      position: 1,
      entities: [
        { offset: 0, length: 2, kind: "customEmoji", customEmojiId: "99" },
        {
          offset: 3,
          length: 4,
          kind: "dateTime",
          dateTime: { unixTime: 1_800_000_000, mode: "relative" },
        },
      ],
    });
  });

  it("limits reply quotes to TDLib's maximum Unicode character count", () => {
    const sourceText = `\u{1F600}${"a".repeat(1_024)}`;

    const quote = replyQuoteFromRenderedSelection(
      sourceText,
      sourceText,
      0,
      sourceText.length,
    );

    expect(Array.from(quote?.text ?? "")).toHaveLength(1_024);
    expect(quote?.text.startsWith("\u{1F600}")).toBe(true);
    expect(quote?.text.endsWith("a")).toBe(true);
  });
});
