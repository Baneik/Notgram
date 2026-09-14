import { translate } from "../i18n";
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
    if (value === 0) {
      if (index + 1 >= encoded.length) return undefined;
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
  if (remoteId.length > 16_384) return undefined;
  const encoded = decodeBase64Url(remoteId.trim());
  if (!encoded || encoded.length < 4) return undefined;
  const version = encoded.at(-1);
  if (version !== 2 && version !== 4) return undefined;
  if (version === 4 && encoded.at(-2)! > 61) return undefined;

  // TDLib persistent file IDs contain zero_encode(serialize(FullRemoteFileLocation)),
  // followed by the schema byte (v4 only) and persistent ID version. Match
  // FullRemoteFileLocation::{store,parse} and FileNode::get_persistent_id in
  // the bundled TDLib: the file type includes flags, not just the enum value.
  const decoded = zeroDecode(encoded.subarray(0, version === 4 ? -2 : -1));
  if (!decoded || decoded.length < 24) return undefined;
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const rawType = view.getInt32(0, true);
  const webLocationFlag = 1 << 24;
  const fileReferenceFlag = 1 << 25;
  const fileType = rawType & ~fileReferenceFlag;
  const dataCenterId = view.getInt32(4, true);
  // Web locations and generated IDs do not identify a Telegram storage DC.
  if ((rawType & webLocationFlag) !== 0 || fileType < 0 || fileType >= 28 || fileType === 7 ||
      dataCenterId < 1 || dataCenterId > 1000) return undefined;
  if ((rawType & fileReferenceFlag) !== 0) {
    const first = decoded[8]!;
    if (first === 255) return undefined;
    const header = first === 254 ? 4 : 1;
    const length = first === 254 ? decoded[9]! + (decoded[10]! << 8) + (decoded[11]! << 16) : first;
    if (8 + Math.ceil((header + length) / 4) * 4 + 16 > decoded.length) return undefined;
  }
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
    if (id) return { id, location: DATA_CENTER_LOCATIONS[id] ?? translate("Telegram 数据中心") };
  }

  try {
    const option = await request({ "@type": "getOption", name: "dc_id" });
    const rawId = option.value;
    const id = typeof rawId === "number" ? rawId : Number(rawId);
    if (Number.isFinite(id) && id > 0) {
      return { id, location: DATA_CENTER_LOCATIONS[id] ?? translate("Telegram 数据中心") };
    }
  } catch {
    // TDLib builds may not expose the internal dc_id option.
  }

  return { id: undefined, location: translate("Telegram 自动选择") };
};
