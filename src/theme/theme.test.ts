import { describe, expect, it } from "vitest";
import {
  THEME_COLOR_TOKENS,
  THEME_DEFINITIONS,
  THEME_IDS,
  colorThemeForThemeId,
  isThemeId,
  resolveThemeId,
  themeIdForColorTheme,
} from "./theme";

describe("theme registry", () => {
  it("keeps identifiers, definitions, and native color schemes aligned", () => {
    expect(Object.keys(THEME_DEFINITIONS)).toEqual([...THEME_IDS]);
    expect(themeIdForColorTheme("light")).toBe("notgram-light");
    expect(themeIdForColorTheme("dark")).toBe("notgram-dark");
    expect(colorThemeForThemeId("notgram-light")).toBe("light");
    expect(colorThemeForThemeId("notgram-dark")).toBe("dark");
  });

  it("migrates legacy colorTheme values without accepting unknown theme ids", () => {
    expect(resolveThemeId("notgram-dark", "light")).toBe("notgram-dark");
    expect(resolveThemeId(undefined, "dark")).toBe("notgram-dark");
    expect(resolveThemeId("third-party-theme", "light")).toBe("notgram-light");
    expect(isThemeId("notgram-dark")).toBe(true);
    expect(isThemeId("dark")).toBe(false);
  });

  it("exposes a unique semantic token contract", () => {
    expect(THEME_COLOR_TOKENS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(THEME_COLOR_TOKENS).size).toBe(THEME_COLOR_TOKENS.length);
    expect(THEME_COLOR_TOKENS.every((token) => token.startsWith("--color-"))).toBe(true);
  });
});
