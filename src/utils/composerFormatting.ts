import type { JSONContent } from "@tiptap/core";
import type { MessageTextEntity, MessageTextEntityKind } from "../telegram/types";
import type { ComposerFormattedText } from "./composerMentions";

export const composerEntityKinds: MessageTextEntityKind[] = [
  "bold", "italic", "underline", "strikethrough", "spoiler", "blockquote",
  "code", "pre", "textUrl", "url", "mention", "mentionName", "hashtag",
  "email", "phone", "customEmoji", "dateTime",
];

export type ComposerFormat = "spoiler" | "strikethrough" | "underline" | "bold" | "blockquote" | "link";
export const composerFormatShortcuts: Record<string, ComposerFormat> = {
  m: "spoiler", x: "strikethrough", u: "underline", b: "bold", q: "blockquote", k: "link",
};

// A single preformatted text block keeps Telegram's UTF-16 offsets identical to
// editor positions (apart from the opening node), including newlines and emoji.
export const composerDocument = (text: string, entities: readonly MessageTextEntity[]): JSONContent => {
  const valid = entities.filter(entity => entity.offset >= 0 && entity.length > 0 &&
    entity.offset + entity.length <= text.length && composerEntityKinds.includes(entity.kind));
  const boundaries = [...new Set([0, text.length, ...valid.flatMap(entity => [entity.offset, entity.offset + entity.length])])]
    .sort((a, b) => a - b);
  const content = boundaries.slice(0, -1).flatMap((start, index) => {
    const end = boundaries[index + 1];
    const marks = valid.filter(entity => entity.offset <= start && entity.offset + entity.length >= end)
      .map(({ kind, offset: _offset, length: _length, ...attributes }) => ({ type: kind, attrs: { entity: attributes } }));
    const parts = text.slice(start, end).split("\n");
    return parts.flatMap((part, index): JSONContent[] => [
      ...(index ? [{ type: "hardBreak", marks }] : []),
      ...(part ? [{ type: "text", text: part, marks }] : []),
    ]);
  });
  return { type: "doc", content: [{ type: "paragraph", content }] };
};

export const composerFormattedText = (doc: JSONContent): ComposerFormattedText => {
  let text = "";
  const entities: MessageTextEntity[] = [];
  for (const node of doc.content?.[0]?.content ?? []) {
    const value = node.type === "hardBreak" ? "\n" : node.text ?? "";
    for (const mark of node.marks ?? []) {
      const kind = mark.type as MessageTextEntityKind;
      const attributes = mark.attrs?.entity ?? {};
      // Merge by mark attributes, so overlapping marks do not fragment entities.
      const adjacent = [...entities].reverse().find(entity => {
        const { offset, length, kind: candidateKind, ...rest } = entity;
        return candidateKind === kind && offset + length === text.length &&
          JSON.stringify(rest) === JSON.stringify(attributes);
      });
      if (adjacent) adjacent.length += value.length;
      else entities.push({ ...attributes, kind, offset: text.length, length: value.length });
    }
    text += value;
  }
  return { text, entities: entities.sort((a, b) => a.offset - b.offset || b.length - a.length) };
};

export const isPastingIntoComposerLink = (text: string, start: number, end: number) =>
  /\[[^\]\n]+\]\([^()\n]*$/.test(text.slice(0, start)) && /^[^()\n]*\)/.test(text.slice(end));
