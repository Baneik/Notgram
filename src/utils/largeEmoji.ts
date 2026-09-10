const emojiCluster = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\p{Emoji_Modifier}|\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})|[\u{E0020}-\u{E007E}])*$/u;
const flagEmoji = /^\p{Regional_Indicator}{2}$/u;
const keycapEmoji = /^[#*0-9]\uFE0F?\u20E3$/u;

export const isLargeEmojiText = (text: string) => {
  const value = text.trim();
  if (!value || /\s/u.test(value)) return false;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const graphemes = [...segmenter.segment(value)].map(({ segment }) => segment);
  return graphemes.length === 1 && (
    emojiCluster.test(value) || flagEmoji.test(value) || keycapEmoji.test(value)
  );
};
