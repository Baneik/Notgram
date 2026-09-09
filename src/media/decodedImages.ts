// Resource knowledge survives virtual row lifetimes. Keep only bounded URL
// metadata, never decoded bitmaps or DOM nodes. A hit is not proof that a new
// element has loaded: callers must also check its complete/naturalWidth state.
const decodedSources = new Set<string>();
const MAX_DECODED_SOURCES = 256;

export const hasDecodedImage = (source: string) => decodedSources.has(source);

export const rememberDecodedImage = (source: string) => {
  decodedSources.delete(source);
  decodedSources.add(source);
  if (decodedSources.size > MAX_DECODED_SOURCES) {
    decodedSources.delete(decodedSources.values().next().value!);
  }
};

export const forgetDecodedImage = (source: string) => decodedSources.delete(source);
