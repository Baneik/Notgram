export const REGEX_SEARCH_PREFIX = "reg:";

export type MessageSearchPattern =
  | { kind: "text"; query: string; serverQuery: string }
  | { kind: "regex"; query: string; serverQuery: ""; expression: string; regex: RegExp };

export const isRegexMessageSearchQuery = (query: string) =>
  query.trim().startsWith(REGEX_SEARCH_PREFIX);

export const parseMessageSearchQuery = (query: string): MessageSearchPattern => {
  const normalized = query.trim();
  if (!normalized.startsWith(REGEX_SEARCH_PREFIX)) {
    return { kind: "text", query: normalized, serverQuery: normalized };
  }

  const expression = normalized.slice(REGEX_SEARCH_PREFIX.length);
  if (!expression) throw new Error("正则表达式不能为空");
  try {
    return {
      kind: "regex",
      query: normalized,
      serverQuery: "",
      expression,
      regex: new RegExp(expression, "iu"),
    };
  } catch {
    throw new Error("无效的正则表达式");
  }
};

export const messageSearchMatches = (value: string, pattern: MessageSearchPattern) =>
  pattern.kind === "regex"
    ? pattern.regex.test(value)
    : value.toLocaleLowerCase().includes(pattern.query.toLocaleLowerCase());
