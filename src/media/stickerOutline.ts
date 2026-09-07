/** TDLib returns path data only; never accept a complete SVG document or markup. */
export const stickerOutlinePath = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 65_536) return "";
  const path = value.trim();
  return /^[Mm]/.test(path) && /^[MmLlHhVvCcSsQqTtAaZzEe0-9+.,\s-]+$/.test(path) ? path : "";
};
