import { rasterImageAsPng } from "./clipboard";

export const isComposerImageSource = (source: string, origin: string) => {
  try {
    const url = new URL(source);
    if (url.username || url.password) return false;
    if (url.protocol === "data:") return /^data:image\/(?:png|jpeg|webp|gif|bmp);base64,/i.test(source);
    if (url.protocol === "blob:") return url.origin === origin;
    // Native assets still pass the account-scoped protocol authorization on fetch.
    if (url.protocol === "notgram-asset:") return url.hostname === "localhost";
    if (url.protocol === "http:" && url.hostname === "notgram-asset.localhost" && !url.port) return true;
    return ["http:", "https:"].includes(url.protocol) && url.origin === origin;
  } catch { return false; }
};

export const composerDroppedImage = (data: DataTransfer) => {
  const template = document.createElement("template");
  template.innerHTML = data.getData("text/html");
  const images = template.content.querySelectorAll("img");
  return images.length === 1 ? images[0].getAttribute("src") ?? undefined : undefined;
};

export const readComposerDroppedImage = async (source: string, signal: AbortSignal) => {
  if (!isComposerImageSource(source, location.origin)) throw new Error("Unsupported dropped image source");
  // Inline previews are allowed by img-src, not connect-src. Decode them through
  // the image pipeline without expanding CSP to permit arbitrary fetches.
  if (/^(blob:|data:)/.test(source)) {
    return new File([await rasterImageAsPng(source, signal)], "dropped-image.png", { type: "image/png" });
  }
  const response = await fetch(source, { signal });
  if (!response.ok) throw new Error("Unable to read dropped image");
  const blob = await response.blob();
  if (!/^image\/(png|jpeg|webp|gif|bmp)$/i.test(blob.type)) throw new Error("Unsupported dropped image type");
  return new File([blob], `dropped-image.${blob.type.split("/")[1].replace("jpeg", "jpg")}`, { type: blob.type });
};
