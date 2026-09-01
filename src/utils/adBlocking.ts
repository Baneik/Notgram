import { messageContentText } from "../telegram/messageContent";
import type { Message, MessageContent } from "../telegram/types";

export const AD_BLOCK_KEYWORD_LIMIT = 100;
export const AD_BLOCK_KEYWORD_LENGTH_LIMIT = 128;
export const AD_BLOCK_REGEX_LIMIT = 50;
export const AD_BLOCK_REGEX_LENGTH_LIMIT = 512;

const MATCH_TEXT_LENGTH_LIMIT = 16_384;
const SUPPORTED_REGEX_FLAGS = new Set(["d", "g", "i", "m", "s", "u", "v", "y"]);

export interface AdBlockingRules {
  enabled: boolean;
  customEnabled: boolean;
  keywords: readonly string[];
  regexRules: readonly string[];
}

export type AdBlockRegexError = "empty" | "flags" | "syntax";

const normalizeKeyword = (value: string) => value.normalize("NFKC").toLocaleLowerCase();

export const sanitizeAdBlockEntries = (
  value: unknown,
  maximumEntries: number,
  maximumLength: number,
) => {
  if (!Array.isArray(value)) return [];
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const entry = candidate.trim().slice(0, maximumLength);
    const identity = normalizeKeyword(entry);
    if (!entry || seen.has(identity)) continue;
    seen.add(identity);
    entries.push(entry);
    if (entries.length >= maximumEntries) break;
  }
  return entries;
};

const closingSlashIndex = (value: string) => {
  if (!value.startsWith("/")) return -1;
  for (let index = value.length - 1; index > 0; index -= 1) {
    if (value[index] !== "/") continue;
    let escapeCount = 0;
    for (let previous = index - 1; previous >= 0 && value[previous] === "\\"; previous -= 1) {
      escapeCount += 1;
    }
    if (escapeCount % 2 === 0) return index;
  }
  return -1;
};

export const parseAdBlockRegex = (value: string): RegExp | AdBlockRegexError => {
  const source = value.trim();
  if (!source) return "empty";
  const closingSlash = closingSlashIndex(source);
  const pattern = closingSlash > 0 ? source.slice(1, closingSlash) : source;
  const flags = closingSlash > 0 ? source.slice(closingSlash + 1) : "iu";
  if (
    [...flags].some((flag) => !SUPPORTED_REGEX_FLAGS.has(flag)) ||
    new Set(flags).size !== flags.length ||
    (flags.includes("u") && flags.includes("v"))
  ) return "flags";
  try {
    return new RegExp(pattern, flags);
  } catch {
    return "syntax";
  }
};

export const isValidAdBlockRegex = (value: string) => parseAdBlockRegex(value) instanceof RegExp;

const pollText = (content: Extract<MessageContent, { kind: "poll" }>) => [
  content.question,
  ...content.options.map((option) => option.text),
].join("\n");

export const adBlockingTextForContent = (content: MessageContent) => {
  const text = content.kind === "poll"
    ? pollText(content)
    : content.kind === "media" || content.kind === "file"
      ? content.caption ?? ""
      : messageContentText(content);
  return text.slice(0, MATCH_TEXT_LENGTH_LIMIT);
};

export const textMatchesAdBlockingRules = (text: string, rules: AdBlockingRules) => {
  if (!rules.enabled || !rules.customEnabled || !text) return false;
  const boundedText = text.slice(0, MATCH_TEXT_LENGTH_LIMIT);
  const normalizedText = normalizeKeyword(boundedText);
  if (rules.keywords.some((keyword) => {
    const normalizedKeyword = normalizeKeyword(keyword.trim());
    return normalizedKeyword.length > 0 && normalizedText.includes(normalizedKeyword);
  })) {
    return true;
  }
  return rules.regexRules.some((rule) => {
    const expression = parseAdBlockRegex(rule);
    if (!(expression instanceof RegExp)) return false;
    expression.lastIndex = 0;
    return expression.test(boundedText);
  });
};

export const messageMatchesAdBlockingRules = (message: Message, rules: AdBlockingRules) =>
  !message.outgoing && textMatchesAdBlockingRules(adBlockingTextForContent(message.content), rules);
