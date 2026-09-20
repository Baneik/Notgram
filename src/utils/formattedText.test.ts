import { describe, expect, it } from "vitest";
import type { MessageTextEntity } from "../telegram/types";
import { equalFormattedText } from "./formattedText";
import { composerDocument, composerFormattedText } from "./composerFormatting";

describe("formatted text equality", () => {
  it("compares current text exactly, including whitespace, newlines and emoji", () => {
    const text = " 🙂 original\ntext ";
    expect(equalFormattedText(text, [], text, undefined)).toBe(true);
    expect(equalFormattedText(text.trim(), [], text, [])).toBe(false);
    expect(equalFormattedText("changed", [], text, [])).toBe(false);
    expect(equalFormattedText("", [], "", undefined)).toBe(true);
  });

  it("ignores entity and property order after an editor round trip", () => {
    const text = "hello world";
    const entities: MessageTextEntity[] = [
      { kind: "underline", offset: 0, length: 5 },
      { kind: "bold", offset: 0, length: 5 },
      { kind: "mentionName", offset: 6, length: 5, userId: "test-user" },
    ];
    const restored = composerFormattedText(composerDocument(text, entities));
    expect(equalFormattedText(restored.text, restored.entities.reverse(), text, entities)).toBe(true);
  });

  it("detects formatting, entity metadata and duplicate differences", () => {
    const bold: MessageTextEntity = { kind: "bold", offset: 0, length: 5 };
    const link: MessageTextEntity = { kind: "textUrl", offset: 0, length: 5, href: "https://example.test/a" };
    expect(equalFormattedText("hello", [bold], "hello", [])).toBe(false);
    expect(equalFormattedText("hello", [bold], "hello", [{ ...bold, kind: "italic" }])).toBe(false);
    expect(equalFormattedText("hello", [link], "hello", [{ ...link, href: "https://example.test/b" }])).toBe(false);
    expect(equalFormattedText("hello", [bold, link], "hello", [bold, bold])).toBe(false);
    const date: MessageTextEntity = { kind: "dateTime", offset: 0, length: 5, dateTime: { unixTime: 10, mode: "relative" } };
    expect(equalFormattedText("hello", [date], "hello", [{ ...date, dateTime: { mode: "relative", unixTime: 10 } }])).toBe(true);
    expect(equalFormattedText("hello", [date], "hello", [{ ...date, dateTime: { mode: "absolute", unixTime: 10 } }])).toBe(false);
  });
});
