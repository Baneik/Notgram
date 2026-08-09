import { describe, expect, it } from "vitest";
import {
  knownUnsupportedTelegramLink,
  parseTelegramUrl,
} from "./telegramLinks";

describe("Telegram link compatibility", () => {
  it("recognizes Telegram web and deep-link hosts", () => {
    expect(parseTelegramUrl("https://t.me/mia_design")?.hostname).toBe("t.me");
    expect(parseTelegramUrl("tg://resolve?domain=mia_design")?.protocol).toBe("tg:");
    expect(parseTelegramUrl("https://example.com/t.me/mia_design")).toBeUndefined();
  });

  it.each([
    ["https://t.me/addtheme/NotgramTheme", "internalLinkTypeTheme", "Telegram 主题链接与 Notgram 不兼容"],
    ["https://t.me/+AbCdEfGh", "internalLinkTypeChatInvite", "Telegram 邀请链接与 Notgram 不兼容"],
    ["tg://proxy?server=127.0.0.1&port=443", "internalLinkTypeProxy", "Telegram 代理链接与 Notgram 不兼容"],
  ])("classifies reserved link %s before username lookup", (url, linkType, reason) => {
    expect(knownUnsupportedTelegramLink(url)).toEqual({
      kind: "unsupported",
      linkType,
      reason,
    });
  });

  it("leaves public chats and message links for transport resolution", () => {
    expect(knownUnsupportedTelegramLink("https://t.me/mia_design")).toBeUndefined();
    expect(knownUnsupportedTelegramLink("https://t.me/release_channel/123")).toBeUndefined();
    expect(knownUnsupportedTelegramLink("https://t.me/c/72/123")).toBeUndefined();
  });
});
