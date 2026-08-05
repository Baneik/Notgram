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
