import type { MessageTextEntity } from "../telegram/types";

// Editor marks and native echoes can enumerate the same fields differently.
export const textEntitySignature = (entity: MessageTextEntity) => JSON.stringify([
  entity.offset,
  entity.length,
  entity.kind,
  entity.href,
  entity.language,
  entity.customEmojiId,
  entity.userId,
  entity.dateTime && [
    entity.dateTime.unixTime,
    entity.dateTime.mode,
    entity.dateTime.timePrecision,
    entity.dateTime.datePrecision,
    entity.dateTime.showDayOfWeek,
  ],
]);

export const equalFormattedText = (
  text: string,
  entities: readonly MessageTextEntity[] | undefined,
  otherText: string,
  otherEntities: readonly MessageTextEntity[] | undefined,
) => {
  if (text !== otherText) return false;
  if (entities === otherEntities) return true;
  if ((entities?.length ?? 0) !== (otherEntities?.length ?? 0)) return false;
  if (!entities?.length) return true;
  // Compare entity multisets in linear time without serializing the message text.
  const counts = new Map<string, number>();
  for (const entity of entities ?? []) {
    const key = textEntitySignature(entity);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const entity of otherEntities ?? []) {
    const key = textEntitySignature(entity);
    const count = counts.get(key);
    if (!count) return false;
    counts.set(key, count - 1);
  }
  return true;
};
