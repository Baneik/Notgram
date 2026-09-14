import { describe, expect, it, vi } from "vitest";
import { parseTdlibRemoteFileDataCenter, resolveTdlibDataCenter } from "./fileDataCenter";

const zeroEncode = (bytes: Uint8Array) => {
  const encoded: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index]!;
    encoded.push(value);
    if (value !== 0) continue;
    let count = 1;
    while (count < 250 && bytes[index + count] === 0) count += 1;
    encoded.push(count);
    index += count - 1;
  }
  return encoded;
};

const remoteId = (dcId: number, version = 4, flags = 0) => {
  const serialized = new Uint8Array(flags & (1 << 25) ? 32 : 24);
  const view = new DataView(serialized.buffer);
  view.setInt32(0, 2 | flags, true);
  view.setInt32(4, dcId, true);
  if (flags & (1 << 25)) serialized.set([4, 11, 22, 33, 44, 0, 0, 0], 8);
  view.setBigInt64(flags & (1 << 25) ? 16 : 8, 123n, true);
  const bytes = Uint8Array.from([...zeroEncode(serialized), ...(version === 2 ? [] : [61]), version]);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

describe("parseTdlibRemoteFileDataCenter", () => {
  it.each([1, 2, 3, 4, 5])("extracts DC%s from current TDLib persistent file IDs", (dcId) => {
    expect(parseTdlibRemoteFileDataCenter(remoteId(dcId))).toBe(dcId);
  });

  it("rejects unrelated, malformed, and unsupported identifiers", () => {
    expect(parseTdlibRemoteFileDataCenter("not-a-file-id")).toBeUndefined();
    expect(parseTdlibRemoteFileDataCenter(remoteId(5, 3))).toBeUndefined();
    expect(parseTdlibRemoteFileDataCenter(remoteId(1001))).toBeUndefined();
    expect(parseTdlibRemoteFileDataCenter(remoteId(0))).toBeUndefined();
    expect(parseTdlibRemoteFileDataCenter(remoteId(4, 4, 1 << 24))).toBeUndefined();
    expect(parseTdlibRemoteFileDataCenter(remoteId(4, 4, 1 << 26))).toBeUndefined();
  });

  it.each([1, 2, 3, 4, 5])("reads DC%s when the file-reference flag is present", (dcId) => {
    expect(parseTdlibRemoteFileDataCenter(remoteId(dcId, 4, 1 << 25))).toBe(dcId);
  });

  it("supports legacy v2 remote IDs and TDLib's raw DC range", () => {
    expect(parseTdlibRemoteFileDataCenter(remoteId(4, 2))).toBe(4);
    expect(parseTdlibRemoteFileDataCenter(remoteId(203))).toBe(203);
  });

  it("rejects truncated zero runs, payloads, and file references", () => {
    expect(parseTdlibRemoteFileDataCenter(btoa(String.fromCharCode(2, 0, 61, 4)))).toBeUndefined();
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, 2 | (1 << 25), true);
    view.setInt32(4, 4, true);
    bytes[8] = 100;
    expect(parseTdlibRemoteFileDataCenter(btoa(String.fromCharCode(...zeroEncode(bytes), 61, 4))))
      .toBeUndefined();
  });

  it("uses the avatar file identifier before querying the TDLib option", async () => {
    const request = vi.fn();

    await expect(resolveTdlibDataCenter([remoteId(4)], request)).resolves.toEqual({
      id: 4,
      location: "Amsterdam, NL",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("falls back to the active TDLib data center when file identifiers cannot be parsed", async () => {
    const request = vi.fn().mockResolvedValue({ "@type": "optionValueInteger", value: 5 });

    await expect(resolveTdlibDataCenter(["not-a-file-id", undefined], request)).resolves.toEqual({
      id: 5,
      location: "Singapore, SG",
    });
    expect(request).toHaveBeenCalledWith({ "@type": "getOption", name: "dc_id" });
  });

  it("reports automatic selection when TDLib doesn't expose its active data center", async () => {
    const request = vi.fn().mockRejectedValue(new Error("Option not found"));

    await expect(resolveTdlibDataCenter([], request)).resolves.toEqual({
      id: undefined,
      location: "Telegram 自动选择",
    });
  });
});
