const emojiCluster = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\p{Emoji_Modifier}|\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})|[\u{E0020}-\u{E007E}])*$/u;

export const isLargeEmojiText = (text: string) => {
  const value = text.trim();
  if (!value || /\s/u.test(value)) return false;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const graphemes = [...segmenter.segment(value)].map(({ segment }) => segment);
  return graphemes.length <= 3 && graphemes.every((segment) => emojiCluster.test(segment));
};
