import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => true }));

beforeEach(() => {
  vi.resetModules();
  invoke.mockReset().mockResolvedValue(null);
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("account metadata initialization", () => {
  it("loads independent keys and retries only failed reads without overwriting them", async () => {
    const metadata = await import("./accountMetadata");
    const [failedKey, healthyKey] = metadata.ACCOUNT_METADATA_KEYS;
    invoke.mockRejectedValueOnce(new Error("temporary read error"));
    await expect(metadata.initializeAccountMetadata()).rejects.toThrow("could not be loaded");
    expect(metadata.readAccountMetadata(healthyKey)).toBe("[]");
    expect(metadata.readAccountMetadata(failedKey)).toBeNull();
    metadata.writeAccountMetadata(failedKey, "[]");
    await metadata.flushAccountMetadata();
    expect(invoke.mock.calls.filter(([command]) => command === "telegram_write_account_metadata")).toHaveLength(0);
    await metadata.initializeAccountMetadata();
    expect(metadata.readAccountMetadata(failedKey)).toBe("[]");
    expect(invoke.mock.calls.filter(([, args]) => args.key === failedKey)).toHaveLength(2);
    expect(invoke.mock.calls.filter(([, args]) => args.key === healthyKey)).toHaveLength(1);
  });

  it("preserves malformed legacy data while making other keys available", async () => {
    const metadata = await import("./accountMetadata");
    const [key, otherKey] = metadata.ACCOUNT_METADATA_KEYS;
    localStorage.setItem(key, "{broken");
    await expect(metadata.initializeAccountMetadata()).rejects.toThrow();
    expect(localStorage.getItem(key)).toBe("{broken");
    expect(metadata.readAccountMetadata(otherKey)).toBe("[]");
    localStorage.setItem(key, "[]");
    await metadata.initializeAccountMetadata();
    expect(localStorage.getItem(key)).toBeNull();
    expect(invoke).toHaveBeenCalledWith("telegram_write_account_metadata", { key, records: [] });
  });
});
