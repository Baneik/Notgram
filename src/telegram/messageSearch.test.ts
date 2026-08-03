import { describe, expect, it } from "vitest";
import {
  isRegexMessageSearchQuery,
  messageSearchMatches,
  parseMessageSearchQuery,
} from "./messageSearch";

describe("message search query", () => {
  it("keeps regular search case-insensitive", () => {
    const pattern = parseMessageSearchQuery(" Layout ");

    expect(pattern).toMatchObject({ kind: "text", serverQuery: "Layout" });
    expect(messageSearchMatches("Desktop layout review", pattern)).toBe(true);
    expect(messageSearchMatches("unrelated", pattern)).toBe(false);
  });

  it("parses reg: expressions as case-insensitive Unicode regular expressions", () => {
    const pattern = parseMessageSearchQuery(" reg:^消息\\s+\\d+$ ");

    expect(pattern).toMatchObject({ kind: "regex", serverQuery: "" });
    expect(isRegexMessageSearchQuery(" reg:^消息")).toBe(true);
    expect(messageSearchMatches("消息 42", pattern)).toBe(true);
    expect(messageSearchMatches("消息 四十二", pattern)).toBe(false);
  });

  it("rejects missing and invalid regular expressions", () => {
    expect(() => parseMessageSearchQuery("reg:")).toThrow("正则表达式不能为空");
    expect(() => parseMessageSearchQuery("reg:[")).toThrow("无效的正则表达式");
  });
});
