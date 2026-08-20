import { describe, expect, it } from "vitest";
import {
  knownUnsupportedTelegramLink,
  parseTelegramUrl,
  telegramUrlDisplayText,
  telegramUsernameFromUrl,
} from "./telegramLinks";

describe("Telegram link compatibility", () => {
  it("recognizes Telegram web and deep-link hosts", () => {
    expect(parseTelegramUrl("https://t.me/mia_design")?.hostname).toBe("t.me");
    expect(parseTelegramUrl("t.me/sylphiette_grayrat_bot")?.href)
      .toBe("https://t.me/sylphiette_grayrat_bot");
    expect(parseTelegramUrl("WWW.TELEGRAM.ME/mia_design")?.href)
      .toBe("https://www.telegram.me/mia_design");
    expect(parseTelegramUrl("telegram.dog/mia_design")?.href)
      .toBe("https://telegram.dog/mia_design");
    expect(parseTelegramUrl("tg://resolve?domain=mia_design")?.protocol).toBe("tg:");
    expect(parseTelegramUrl("https://example.com/t.me/mia_design")).toBeUndefined();
    expect(parseTelegramUrl("https://t.me.evil.example/mia_design")).toBeUndefined();
    expect(parseTelegramUrl("ftp://t.me/mia_design")).toBeUndefined();
    expect(parseTelegramUrl("https://guest@t.me/mia_design")).toBeUndefined();
  });

  it.each([
    ["t.me/sylphiette_grayrat_bot", "sylphiette_grayrat_bot"],
    ["https://telegram.me/Mia_Design", "Mia_Design"],
    ["telegram.dog/mia_design/", "mia_design"],
    ["tg://resolve?domain=mia_design", "mia_design"],
  ])("extracts the public username from %s", (url, username) => {
    expect(telegramUsernameFromUrl(url)).toBe(username);
    expect(telegramUrlDisplayText(url)).toBe(`@${username}`);
  });

  it.each([
    "t.me/release_channel/123",
    "t.me/c/72/123",
    "t.me/notgram_bot?start=verify",
    "t.me/addtheme/NotgramTheme",
    "t.me/+AbCdEfGh",
    "tg://resolve?domain=notgram_bot&start=verify",
  ])("does not hide Telegram link semantics for %s", (url) => {
    expect(telegramUsernameFromUrl(url)).toBeUndefined();
    expect(telegramUrlDisplayText(url)).toBeUndefined();
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
