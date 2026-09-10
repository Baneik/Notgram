import { describe, expect, it } from "vitest";
import { isLargeEmojiText } from "./largeEmoji";

describe("large emoji messages", () => {
  it.each(["😂", " 👍🏽 ", "👩🏽‍💻", "👨‍👩‍👧‍👦", "❤️", "🇨🇳", "1️⃣", "#️⃣"])(
    "enlarges one emoji grapheme: %s", (text) => {
      expect(isLargeEmojiText(text)).toBe(true);
    },
  );

  it.each([
    "", " ", "hello", "1", "#", "*", "😂😂", "😂😂😂", "😂😂😂😂",
    "😂 😂", "😂\n😂", "hello 😂", "👩🏽‍💻👩🏽‍💻", "🇨🇳🇯🇵", "1️⃣2️⃣",
  ])("keeps multiple emoji and ordinary text at the message size: %s", (text) => {
    expect(isLargeEmojiText(text)).toBe(false);
  });
});
