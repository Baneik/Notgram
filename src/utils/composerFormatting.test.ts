import { describe, expect, it } from "vitest";
import { composerDocument, composerFormattedText, isPastingIntoComposerLink } from "./composerFormatting";
import type { MessageTextEntity } from "../telegram/types";

describe("composer formatting", () => {
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
