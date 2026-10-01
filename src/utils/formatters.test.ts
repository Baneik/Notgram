import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({ language: "en" }));
vi.mock("../i18n", () => ({ currentLanguage: () => context.language, translate: (key: string) => key }));
const RealDateTimeFormat = Intl.DateTimeFormat;

describe("reusable date formatting", () => {
  beforeEach(() => { vi.resetModules(); context.language = "en"; vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T04:00:00Z")); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("formats repeated message timestamps without constructing or formatting again", async () => {
    const constructor = vi.spyOn(Intl, "DateTimeFormat");
    const { formatMessageTime } = await import("./formatters");
    const timestamp = "2026-09-30T12:34:56Z";
    const expected = new RealDateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(timestamp));
    for (let i = 0; i < 1000; i++) expect(formatMessageTime(timestamp)).toBe(expected);
    expect(constructor).toHaveBeenCalledTimes(2);
    expect(() => formatMessageTime("invalid")).toThrow(RangeError);
  });

  it("invalidates formatted results when the language changes", async () => {
    const { formatMessageTime, formatMessageDay } = await import("./formatters");
    const timestamp = "2025-01-05T12:34:56Z";
    for (const language of ["en", "ja", "zh-CN", "en"]) {
      context.language = language;
      expect(formatMessageTime(timestamp)).toBe(new RealDateTimeFormat(language, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(timestamp)));
      expect(formatMessageDay(timestamp)).toBe(new RealDateTimeFormat(language, { year: "numeric", month: "long", day: "numeric" }).format(new Date(timestamp)));
    }
  });

  it("refreshes the OS timezone during a running session", async () => {
    let zone = "UTC";
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function(locales, options) {
      return new RealDateTimeFormat(locales, options ?? { timeZone: zone });
    });
    const { formatMessageTime } = await import("./formatters");
    const timestamp = "2026-09-30T12:34:56Z";
    expect(formatMessageTime(timestamp)).toBe("12:34:56");
    zone = "Asia/Tokyo";
    vi.advanceTimersByTime(60_000);
    expect(formatMessageTime(timestamp)).toBe("21:34:56");
  });

  it("keeps today and yesterday relative to the supplied current date", async () => {
    const { formatMessageDay } = await import("./formatters");
    expect(formatMessageDay("invalid")).toBe("日期未知");
    const today = new Date(2026, 9, 1, 10);
    expect(formatMessageDay(new Date(2026, 9, 1, 8).toISOString(), today)).toBe("今天");
    expect(formatMessageDay(new Date(2026, 8, 30, 8).toISOString(), today)).toBe("昨天");
  });
});
