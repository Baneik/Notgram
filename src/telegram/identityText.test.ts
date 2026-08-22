import { afterEach, describe, expect, it } from "vitest";
import {
  identityTextField,
  normalizeIdentityText,
  sanitizeIdentityText,
  setZalgoTextBlockingEnabled,
} from "./identityText";

afterEach(() => setZalgoTextBlockingEnabled(true));

describe("identity text", () => {
  it("removes stacked marks, controls, emoji, and decorative symbols", () => {
    const zalgo = "所\u0334\u035f\u030d謂\u034f\u035c星\u0337\u0361Ⓥ\u200d🔥\u202e";

    expect(normalizeIdentityText(zalgo)).toBe("所謂星V");
  });

  it("preserves ordinary letters and canonical accents after compatibility normalization", () => {
    expect(normalizeIdentityText("  Ｊｏｓｅ\u0301 · 林 然  ")).toBe("José · 林 然");
    expect(normalizeIdentityText("O'Connor-Li_2")).toBe("O'Connor-Li_2");
  });

  it("provides a bounded fallback for display values", () => {
    expect(sanitizeIdentityText("🔥\u200d", "Telegram 用户", 64)).toBe("Telegram 用户");
    expect(sanitizeIdentityText("abcdef", "用户", 4)).toBe("abcd");
  });

  it("rejects unsupported input instead of silently changing user edits", () => {
    expect(() => identityTextField("林\u0334\u035f然", 64, "名字", true))
      .toThrow("名字包含不支持的字符");
    expect(() => identityTextField("Lin🔥", 64, "名字", true))
      .toThrow("名字包含不支持的字符");
    expect(identityTextField(" Ｌｉｎ  Ran ", 64, "名字", true)).toBe("Lin Ran");
    expect(() => identityTextField("", 64, "名字", true)).toThrow("名字格式不正确");
    expect(() => identityTextField("abc", 2, "名字", true)).toThrow("名字格式不正确");
  });

  it("preserves original identity text when blocking is disabled", () => {
    const dirtyName = "所\u0334\u035f謂星Ⓥ🔥";
    setZalgoTextBlockingEnabled(false);

    expect(normalizeIdentityText(dirtyName)).toBe(dirtyName);
    expect(identityTextField(dirtyName, 64, "名字", true)).toBe(dirtyName);
  });
});
