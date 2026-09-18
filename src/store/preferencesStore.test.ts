import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("local quote collapse preferences", () => {
  it.each([
    [undefined, 10], [null, 10], ["8", 10], [0, 1], [-4, 1], [101, 100], [8.4, 8], [12, 12],
  ])("normalizes a persisted threshold of %s to %s", async (quoteCollapseLines, expected) => {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ quoteCollapseLines }), setItem: vi.fn() });
    const { preferencesStore } = await import("./preferencesStore");
    expect(preferencesStore.getState().quoteCollapseLines).toBe(expected);
  });

  it("persists integer thresholds and falls back safely for non-finite input", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem });
    const { preferencesStore } = await import("./preferencesStore");
    for (const [input, expected] of [[8.8, 9], [0, 1], [500, 100], [NaN, 10], [Infinity, 10]]) {
      preferencesStore.getState().setPreference("quoteCollapseLines", input);
      expect(preferencesStore.getState().quoteCollapseLines).toBe(expected);
      expect(JSON.parse(setItem.mock.lastCall![1]).quoteCollapseLines).toBe(expected);
    }
  });
});
