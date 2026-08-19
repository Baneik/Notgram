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

const remoteId = (dcId: number, version = 4) => {
  const serialized = new Uint8Array(24);
  const view = new DataView(serialized.buffer);
  view.setInt32(0, 3, true);
  view.setInt32(4, dcId, true);
  view.setBigInt64(8, 123n, true);
  const bytes = Uint8Array.from([...zeroEncode(serialized), 42, version]);
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
    expect(parseTdlibRemoteFileDataCenter(remoteId(9))).toBeUndefined();
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
