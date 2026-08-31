import { describe, expect, it } from "vitest";
import {
  detectSystemLanguage,
  isLanguagePreference,
  resolveLanguage,
  supportedLanguageFor,
} from "./language";

describe("application language resolution", () => {
  it("maps regional Chinese, English and Japanese language tags", () => {
    expect(supportedLanguageFor("zh-Hant-TW")).toBe("zh-CN");
    expect(supportedLanguageFor("en-GB")).toBe("en");
    expect(supportedLanguageFor("ja-JP")).toBe("ja");
  });

  it("uses the first supported PC language", () => {
    expect(detectSystemLanguage(["fr-FR", "ja-JP", "en-US"])).toBe("ja");
    expect(detectSystemLanguage(["de-DE", "zh-Hans-CN"])).toBe("zh-CN");
  });

  it("falls back to English when the PC language is unsupported", () => {
    expect(detectSystemLanguage(["fr-FR", "de-DE"])).toBe("en");
    expect(detectSystemLanguage([])).toBe("en");
  });

  it("keeps an explicit user selection instead of the PC language", () => {
    expect(resolveLanguage("ja", ["zh-CN"])).toBe("ja");
    expect(resolveLanguage("system", ["zh-CN"])).toBe("zh-CN");
  });

  it("accepts only persisted language preference values", () => {
    expect(isLanguagePreference("system")).toBe(true);
    expect(isLanguagePreference("en")).toBe(true);
    expect(isLanguagePreference("fr")).toBe(false);
    expect(isLanguagePreference(null)).toBe(false);
  });
});
