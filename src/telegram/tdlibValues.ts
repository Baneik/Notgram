export type TdObject = Record<string, unknown>;

export const asTdObject = (value: unknown): TdObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as TdObject) : undefined;

export const asTdObjects = (value: unknown): TdObject[] =>
  Array.isArray(value)
    ? value.map(asTdObject).filter((item): item is TdObject => Boolean(item)) : [];

export const tdId = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

export const tdNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};
