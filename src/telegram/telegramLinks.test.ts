import { describe, expect, it } from "vitest";
import {
  knownUnsupportedTelegramLink,
  parseTelegramUrl,
  telegramUrlDisplayText,
  telegramUsernameFromUrl,
  telegramInviteLink,
  telegramBotStartParameters,
} from "./telegramLinks";

describe("Telegram link compatibility", () => {
  it("keeps empty starts and accepts the full 64-character payload limit", () => {
    expect(telegramBotStartParameters("https://t.me/notgram_bot?start")?.parameter).toBe("");
    const parameter = `key=${"x".repeat(60)}`;
    expect(telegramBotStartParameters(`https://t.me/notgram_bot?start=${parameter}`)?.parameter).toBe(parameter);
  });

  it.each([
    "https://t.me/notgram_bot?start=SetGroupOperate=-1001234567890",
    "t.me/notgram_bot?start=SetGroupOperate%3D-1001234567890",
    "tg://resolve?domain=notgram_bot&start=SetGroupOperate%3D-1001234567890",
  ])("preserves legacy private bot start parameters in %s", (url) => {
    expect(telegramBotStartParameters(url)).toEqual({
      botUsername: "notgram_bot", parameter: "SetGroupOperate=-1001234567890",
    });
  });

  it.each([
    "https://example.com/notgram_bot?start=key=value",
    "https://t.me/notgram_bot/123?start=key=value",
    "https://t.me/notgram_bot?start=key=value&start=other",
    "https://t.me/notgram_bot?start=key=value&startgroup=other",
    "https://t.me/notgram_bot?start=key=value&startapp=other",
    "https://t.me/notgram_bot?start=key=value&profile",
    "https://t.me/notgram_bot?start=key=value#fragment",
    "tg://join?domain=notgram_bot&start=key=value",
    "tg://resolve/extra?domain=notgram_bot&start=key=value",
    "tg://resolve?domain=notgram_bot&start=key=value&post=123",
    "tg://resolve?domain=notgram_bot&domain=other_bot&start=key=value",
    "https://t.me/addtheme?start=key=value",
    "https://t.me/notgram_bot?start=key%253Dvalue",
    "https://t.me/notgram_bot?start=key=value%0Acommand",
    "https://t.me/notgram_bot?start=key=value%0A",
    "https://t.me/notgram_bot?start=key=value+command",
    `https://t.me/notgram_bot?start=${"x".repeat(64)}=`,
  ])("does not reinterpret ambiguous or invalid start links: %s", (url) => {
    expect(telegramBotStartParameters(url)).toBeUndefined();
  });

  it("recognizes Telegram web and deep-link hosts", () => {
    expect(parseTelegramUrl("https://t.me/mia_design")?.hostname).toBe("t.me");
    expect(parseTelegramUrl("t.me/sylphiette_grayrat_bot")?.href)
      .toBe("https://t.me/sylphiette_grayrat_bot");
    expect(parseTelegramUrl("WWW.TELEGRAM.ME/mia_design")?.href)
      .toBe("https://telegram.me/mia_design");
    expect(parseTelegramUrl("http://www.t.me/public_group")?.href).toBe("https://t.me/public_group");
    expect(telegramInviteLink("https://t.me/+1234567890")).toBe("https://t.me/+1234567890");
    expect(knownUnsupportedTelegramLink("https://t.me/+1234567890")).toBeUndefined();
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
    expect(telegramUrlDisplayText(url)).toBe(url.startsWith("tg:") ? `t.me/${username}` : url);
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
    ["tg://proxy?server=127.0.0.1&port=443", "internalLinkTypeProxy", "Telegram 代理链接与 Notgram 不兼容"],
  ])("classifies reserved link %s before username lookup", (url, linkType, reason) => {
    expect(knownUnsupportedTelegramLink(url)).toEqual({
      kind: "unsupported",
      linkType,
      reason,
    });
  });

  it("leaves public chats and message links for transport resolution", () => {
    for (const url of ["https://t.me/+AbCdEfGh", "https://telegram.me/joinchat/AbCdEfGh", "tg://join?invite=AbCdEfGh"]) {
      expect(telegramInviteLink(url)).toBe("https://t.me/+AbCdEfGh");
      expect(knownUnsupportedTelegramLink(url)).toBeUndefined();
    }
    for (const url of ["https://t.me/+", "tg://join?invite=a%22b", "https://t.me.evil/+abc", "https://t.me/+abc/path"]) {
      expect(telegramInviteLink(url)).toBeUndefined();
    }
    expect(knownUnsupportedTelegramLink("https://t.me/mia_design")).toBeUndefined();
    expect(knownUnsupportedTelegramLink("https://t.me/release_channel/123")).toBeUndefined();
    expect(knownUnsupportedTelegramLink("https://t.me/c/72/123")).toBeUndefined();
  });
});
