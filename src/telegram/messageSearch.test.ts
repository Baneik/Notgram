import { describe, expect, it } from "vitest";
import {
  chatMessageSearchFilterDisallowsQueryOrSender,
  localDateSearchRange,
  messageSearchMatches,
} from "./messageSearch";

describe("message search query", () => {
  it("keeps regular search case-insensitive", () => {
    expect(messageSearchMatches("Desktop layout review", " Layout ")).toBe(true);
    expect(messageSearchMatches("unrelated", "Layout")).toBe(false);
  });

  it("identifies TDLib filters that cannot combine with a query or sender", () => {
    expect(chatMessageSearchFilterDisallowsQueryOrSender("unreadMention")).toBe(true);
    expect(chatMessageSearchFilterDisallowsQueryOrSender("unreadReaction")).toBe(true);
    expect(chatMessageSearchFilterDisallowsQueryOrSender("poll")).toBe(false);
  });

  it("converts a local calendar date into a server timestamp range", () => {
    expect(localDateSearchRange("2026-08-09")).toEqual({
      minDate: new Date(2026, 7, 9).getTime() / 1000,
      maxDate: new Date(2026, 7, 10).getTime() / 1000 - 1,
    });
    expect(localDateSearchRange("2026-02-30")).toBeUndefined();
  });
});
