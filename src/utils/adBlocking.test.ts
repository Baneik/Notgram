import { describe, expect, it } from "vitest";
import type { Message } from "../telegram/types";
import {
  adBlockingTextForContent,
  isValidAdBlockRegex,
  messageMatchesAdBlockingRules,
  parseAdBlockRegex,
  sanitizeAdBlockEntries,
  textMatchesAdBlockingRules,
} from "./adBlocking";

const rules = {
  enabled: true,
  customEnabled: true,
  keywords: ["限时优惠"],
  regexRules: ["/(?:promo|sponsor)\\d+/iu"],
};

const message = (content: Message["content"], outgoing = false): Message => ({
  id: "message-1",
  chatId: "chat-1",
  senderId: "user-1",
  outgoing,
  sentAt: "2026-09-01T10:00:00.000Z",
  delivery: "sent",
  content,
});

describe("ad blocking rules", () => {
  it("normalizes keyword text and matches complete regular expressions", () => {
    expect(textMatchesAdBlockingRules("本周限時優惠", {
      ...rules,
      keywords: ["限時優惠"],
    })).toBe(true);
    expect(textMatchesAdBlockingRules("Campaign Sponsor42", rules)).toBe(true);
    expect(textMatchesAdBlockingRules("ordinary update", rules)).toBe(false);
  });

  it("matches captions and poll options but preserves outgoing messages", () => {
    expect(messageMatchesAdBlockingRules(message({
      kind: "media",
      mediaType: "photo",
      fileName: "image.jpg",
      sizeLabel: "1 MB",
      caption: "限时优惠",
    }), rules)).toBe(true);
    expect(messageMatchesAdBlockingRules(message({
      kind: "poll",
      question: "选择",
      pollId: "poll-1",
      options: [{ id: "0", position: 0, text: "Promo7", voterCount: 0, votePercentage: 0, chosen: false, beingChosen: false, correct: false }],
      totalVoterCount: 0,
      isAnonymous: true,
      type: "regular",
      allowsMultipleAnswers: false,
      allowsRevoting: false,
      isClosed: false,
      canSeeResults: true,
    }), rules)).toBe(true);
    expect(messageMatchesAdBlockingRules(message({ kind: "text", text: "限时优惠" }, true), rules))
      .toBe(false);
  });

  it("matches media captions but ignores attachment file names", () => {
    const captionRules = {
      enabled: true,
      customEnabled: true,
      keywords: ["promo"],
      regexRules: [],
    };
    const file = {
      kind: "media",
      mediaType: "photo",
      fileName: "promo.jpg",
      sizeLabel: "1 KB",
    } as const;
    expect(adBlockingTextForContent(file)).toBe("");
    expect(messageMatchesAdBlockingRules(message(file), captionRules)).toBe(false);
    expect(messageMatchesAdBlockingRules(message({
      kind: "media",
      mediaType: "photo",
      fileName: "image.jpg",
      sizeLabel: "1 KB",
      caption: "Promo details",
    }), captionRules)).toBe(true);
  });

  it("accepts literal and raw patterns while rejecting invalid flags and syntax", () => {
    expect(parseAdBlockRegex("/offer\\s+now/i")).toBeInstanceOf(RegExp);
    expect(parseAdBlockRegex("offer\\s+now")).toBeInstanceOf(RegExp);
    expect(isValidAdBlockRegex("/[a-/i")).toBe(false);
    expect(parseAdBlockRegex("/offer/ii")).toBe("flags");
  });

  it("bounds, trims, and deduplicates persisted entries", () => {
    expect(sanitizeAdBlockEntries([" offer ", "OFFER", 4 as unknown as string, "", "promo"] as unknown, 2, 5))
      .toEqual(["offer", "promo"]);
    expect(textMatchesAdBlockingRules("ordinary update", {
      enabled: true,
      customEnabled: true,
      keywords: [""],
      regexRules: [],
    })).toBe(false);
  });
});
