import type { MessageTextEntity } from "../telegram/types";

export interface ComposerFormattedText {
  text: string;
  entities: MessageTextEntity[];
}

const editableStyleKinds = new Set(["bold", "italic", "underline", "strikethrough", "spoiler", "blockquote", "code", "pre"]);

const validComposerEntities = (
  text: string,
  entities: readonly MessageTextEntity[],
) => entities.filter((entity) =>
  (entity.kind !== "mentionName" || Boolean(entity.userId)) &&
  Number.isInteger(entity.offset) && Number.isInteger(entity.length) &&
  entity.offset >= 0 &&
  entity.length > 0 &&
  entity.offset + entity.length <= text.length
);

export const reconcileComposerMentionEntities = (
  previousText: string,
  nextText: string,
  entities: readonly MessageTextEntity[],
): MessageTextEntity[] => {
  if (previousText === nextText) return validComposerEntities(nextText, entities);

  let prefixLength = 0;
  const sharedLength = Math.min(previousText.length, nextText.length);
  while (
    prefixLength < sharedLength &&
    previousText[prefixLength] === nextText[prefixLength]
  ) prefixLength += 1;

  let suffixLength = 0;
  while (
    suffixLength < previousText.length - prefixLength &&
    suffixLength < nextText.length - prefixLength &&
    previousText[previousText.length - 1 - suffixLength] ===
      nextText[nextText.length - 1 - suffixLength]
  ) suffixLength += 1;

  const previousEditEnd = previousText.length - suffixLength;
  const nextEditEnd = nextText.length - suffixLength;
  const delta = nextEditEnd - previousEditEnd;

  return validComposerEntities(previousText, entities).flatMap((entity) => {
    const entityEnd = entity.offset + entity.length;
    if (previousEditEnd <= entity.offset) return [{ ...entity, offset: entity.offset + delta }];
    if (prefixLength >= entityEnd) return [entity];
    if (editableStyleKinds.has(entity.kind)) {
      const offset = Math.min(entity.offset, prefixLength);
      const end = entityEnd > previousEditEnd ? entityEnd + delta : nextEditEnd;
      return end > offset ? [{ ...entity, offset, length: end - offset }] : [];
    }
    return [];
  });
};

export const trimComposerFormattedText = (
  text: string,
  entities: readonly MessageTextEntity[],
): ComposerFormattedText => {
  const trimmedStart = text.length - text.trimStart().length;
  const trimmedText = text.trim();
  const trimmedEnd = trimmedStart + trimmedText.length;
  return {
    text: trimmedText,
    entities: validComposerEntities(text, entities).flatMap((entity) => {
      const start = Math.max(trimmedStart, entity.offset);
      const end = Math.min(trimmedEnd, entity.offset + entity.length);
      if (end <= start) return [];
      if (!editableStyleKinds.has(entity.kind) && (start !== entity.offset || end !== entity.offset + entity.length)) return [];
      return [{ ...entity, offset: start - trimmedStart, length: end - start }];
    }),
  };
};

export const prependComposerFormattedText = (
  prefix: ComposerFormattedText,
  suffixText: string,
  suffixEntities: readonly MessageTextEntity[],
): ComposerFormattedText => {
  if (!suffixText) return prefix;
  const separator = prefix.text ? "\n" : "";
  const offset = prefix.text.length + separator.length;
  return {
    text: `${prefix.text}${separator}${suffixText}`,
    entities: [
      ...prefix.entities,
      ...validComposerEntities(suffixText, suffixEntities).map((entity) => ({
        ...entity,
        offset: entity.offset + offset,
      })),
    ],
  };
};
