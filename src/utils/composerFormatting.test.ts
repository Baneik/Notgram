import { describe, expect, it } from "vitest";
import { composerDocument, composerFormattedText, composerFormatShortcut, isPastingIntoComposerLink } from "./composerFormatting";
import type { MessageTextEntity } from "../telegram/types";

describe("composer formatting", () => {
  const modifiers = { ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
  it.each([
    ["M", "spoiler"], ["X", "strikethrough"], ["U", "underline"], ["B", "bold"], ["Q", "blockquote"], ["K", "link"],
  ])("recognizes the physical %s shortcut across keyboard layouts", (letter, format) => {
    expect(composerFormatShortcut({ ...modifiers, key: "Process", code: `Key${letter}` })).toBe(format);
    expect(composerFormatShortcut({ ...modifiers, key: "不", code: `Key${letter}` })).toBe(format);
    expect(composerFormatShortcut({ ...modifiers, key: letter.toLowerCase() })).toBe(format);
  });
  it("requires the exact format modifiers and does not reinterpret other physical keys", () => {
    const shortcut = { ...modifiers, key: "B", code: "KeyB" };
    for (const modifier of [{ ctrlKey: false }, { shiftKey: false }, { altKey: true }, { metaKey: true }]) {
      expect(composerFormatShortcut({ ...shortcut, ...modifier })).toBeUndefined();
    }
    expect(composerFormatShortcut({ ...shortcut, code: "KeyR" })).toBeUndefined();
    expect(composerFormatShortcut({ ...modifiers, key: "Process" })).toBeUndefined();
  });
  it("round trips overlapping formatting and UTF-16 offsets across emoji and newlines", () => {
    const text = "🙂 bold\n@Ada";
    const entities: MessageTextEntity[] = [
      { kind: "bold", offset: 0, length: text.length },
      { kind: "underline", offset: 3, length: 4 },
      { kind: "mentionName", offset: 8, length: 4, userId: "42" },
      { kind: "textUrl", offset: 3, length: 4, href: "https://example.test" },
    ];
    expect(composerFormattedText(composerDocument(text, entities))).toEqual({ text, entities: expect.arrayContaining(entities) });
    expect(composerFormattedText(composerDocument(text, entities)).entities).toHaveLength(4);
  });
  it("preserves empty lines and whitespace", () => {
    for (const text of ["", " \n\t", "\n\n", "text\n"]) {
      expect(composerFormattedText(composerDocument(text, []))).toEqual({ text, entities: [] });
    }
  });
  it("only completes a link when pasting inside its URL parentheses", () => {
    expect(isPastingIntoComposerLink("before [label]() after", 15, 15)).toBe(true);
    expect(isPastingIntoComposerLink("[label](url)", 8, 10)).toBe(true);
    expect(isPastingIntoComposerLink("[label]()", 3, 3)).toBe(false);
    expect(isPastingIntoComposerLink("[label]()", 9, 9)).toBe(false);
    expect(isPastingIntoComposerLink("plain ()", 7, 7)).toBe(false);
  });
});
