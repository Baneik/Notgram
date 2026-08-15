import type { MessageTextEntity } from "../telegram/types";

export interface ComposerFormattedText {
  text: string;
  entities: MessageTextEntity[];
}

const validMentionEntities = (
  text: string,
  entities: readonly MessageTextEntity[],
) => entities.filter((entity) =>
  entity.kind === "mentionName" &&
  Boolean(entity.userId) &&
  entity.offset >= 0 &&
  entity.length > 0 &&
  entity.offset + entity.length <= text.length
);

export const reconcileComposerMentionEntities = (
  previousText: string,
  nextText: string,
  entities: readonly MessageTextEntity[],
): MessageTextEntity[] => {
  if (previousText === nextText) return validMentionEntities(nextText, entities);

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

  return validMentionEntities(previousText, entities).flatMap((entity) => {
    const entityEnd = entity.offset + entity.length;
    if (previousEditEnd <= entity.offset) return [{ ...entity, offset: entity.offset + delta }];
    if (prefixLength >= entityEnd) return [entity];
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
    entities: validMentionEntities(text, entities).flatMap((entity) =>
      entity.offset >= trimmedStart && entity.offset + entity.length <= trimmedEnd
        ? [{ ...entity, offset: entity.offset - trimmedStart }]
        : []
    ),
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
      ...validMentionEntities(suffixText, suffixEntities).map((entity) => ({
        ...entity,
        offset: entity.offset + offset,
      })),
    ],
  };
};
