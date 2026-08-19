const decodeBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
};

const zeroDecode = (encoded: Uint8Array) => {
  const decoded: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    const value = encoded[index]!;
    if (value === 0 && index + 1 < encoded.length) {
      const count = encoded[index + 1]!;
      if (count === 0) return undefined;
      for (let repeat = 0; repeat < count; repeat += 1) decoded.push(0);
      index += 1;
    } else {
      decoded.push(value);
    }
  }
  return Uint8Array.from(decoded);
};

export const parseTdlibRemoteFileDataCenter = (remoteId: string) => {
  const encoded = decodeBase64Url(remoteId.trim());
  if (!encoded || encoded.length < 4 || encoded.at(-1) !== 4) return undefined;

  // TDLib persistent file IDs contain zero_encode(serialize(FullRemoteFileLocation)),
  // followed by the schema byte and persistent ID version. The serialized location
  // starts with an int32 file type and an int32 data-center identifier.
  const decoded = zeroDecode(encoded.subarray(0, -2));
  if (!decoded || decoded.length < 8) return undefined;
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const fileType = view.getInt32(0, true);
  const dataCenterId = view.getInt32(4, true);
  if (fileType < 0 || fileType > 255 || dataCenterId < 1 || dataCenterId > 5) return undefined;
  return dataCenterId;
};

const DATA_CENTER_LOCATIONS: Record<number, string> = {
  1: "Miami, US",
  2: "Amsterdam, NL",
  3: "Miami, US",
  4: "Amsterdam, NL",
  5: "Singapore, SG",
};

export interface TdlibDataCenterDetails {
  id?: number;
  location: string;
}

export const resolveTdlibDataCenter = async (
  remoteIds: Iterable<string | undefined>,
  request: (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<TdlibDataCenterDetails> => {
  for (const remoteId of remoteIds) {
    if (!remoteId) continue;
    const id = parseTdlibRemoteFileDataCenter(remoteId);
    if (id) return { id, location: DATA_CENTER_LOCATIONS[id] ?? "Telegram 数据中心" };
  }

  try {
    const option = await request({ "@type": "getOption", name: "dc_id" });
    const rawId = option.value;
    const id = typeof rawId === "number" ? rawId : Number(rawId);
    if (Number.isFinite(id) && id > 0) {
      return { id, location: DATA_CENTER_LOCATIONS[id] ?? "Telegram 数据中心" };
    }
  } catch {
    // TDLib builds may not expose the internal dc_id option.
  }

  return { id: undefined, location: "Telegram 自动选择" };
};
