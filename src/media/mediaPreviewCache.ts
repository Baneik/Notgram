type PreviewSurface = HTMLCanvasElement | SVGSVGElement;
type Preview = { surface: PreviewSurface; bytes: number };

const MAX_ENTRIES = 256;
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_SVG_BYTES = 2 * 1024 * 1024;
const MAX_RASTER_EDGE = 384;
const previews = new Map<string, Preview>();
let bytes = 0;
let generation = 0;
let cloneId = 0;

export const mediaPreviewGeneration = () => generation;
export const hasMediaPreview = (source: string) => previews.has(source);

export const forgetMediaPreview = (source: string) => {
  const previous = previews.get(source);
  if (previous) bytes -= previous.bytes;
  previews.delete(source);
};

export const clearMediaPreviewCache = () => {
  generation++;
  previews.clear();
  bytes = 0;
};

/** Keep only a bounded still frame, never a live player or its listeners. */
export const rememberMediaPreview = (
  source: string,
  media: HTMLImageElement | HTMLVideoElement | SVGSVGElement,
  ownerGeneration: number,
  { replace = false }: { replace?: boolean } = {},
) => {
  if (ownerGeneration !== generation || (!replace && previews.has(source))) return;
  let preview: Preview;
  if (media instanceof SVGSVGElement) {
    const estimatedBytes = media.outerHTML.length * 2 + media.querySelectorAll("*").length * 128;
    if (estimatedBytes > MAX_SVG_BYTES) return;
    preview = { surface: media.cloneNode(true) as SVGSVGElement, bytes: estimatedBytes };
  } else {
    const image = media instanceof HTMLImageElement;
    const width = image ? media.naturalWidth : media.videoWidth;
    const height = image ? media.naturalHeight : media.videoHeight;
    if (width < 1 || height < 1 || (image ? !media.complete : media.readyState < 2)) return;
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, MAX_RASTER_EDGE / Math.max(width, height));
    canvas.width = Math.max(1, Math.ceil(width * scale));
    canvas.height = Math.max(1, Math.ceil(height * scale));
    try {
      const context = canvas.getContext("2d");
      if (!context) return;
      // Copy display pixels without encoding them or starting another decode.
      context.drawImage(media, 0, 0, canvas.width, canvas.height);
    } catch { return; }
    preview = { surface: canvas, bytes: canvas.width * canvas.height * 4 };
  }
  forgetMediaPreview(source);
  previews.set(source, preview);
  bytes += preview.bytes;
  while (previews.size > MAX_ENTRIES || bytes > MAX_BYTES) {
    forgetMediaPreview(previews.keys().next().value!);
  }
};

export const cloneMediaPreview = (source: string): PreviewSurface | undefined => {
  const preview = previews.get(source);
  if (!preview) return;
  previews.delete(source);
  previews.set(source, preview);
  const clone = preview.surface.cloneNode(true) as PreviewSurface;
  if (clone instanceof HTMLCanvasElement) {
    const context = clone.getContext("2d");
    if (!context) return;
    context.drawImage(preview.surface as HTMLCanvasElement, 0, 0);
  } else {
    // Lottie uses document-wide clip/gradient IDs. Each mounted copy needs its
    // own references, including when the same sticker occurs twice in a chat.
    const prefix = `media-preview-${++cloneId}-`;
    const nodes = [clone, ...clone.querySelectorAll("*")];
    const ids = new Map(nodes.filter(node => node.id).map(node => [node.id, prefix + node.id]));
    for (const node of nodes) {
      for (const attribute of [...node.attributes]) {
        if (attribute.name === "id") node.id = ids.get(attribute.value) ?? attribute.value;
        else {
          const value = attribute.value.replace(/#([\w-]+)/g, (match, id: string) => ids.has(id) ? `#${ids.get(id)}` : match);
          if (value !== attribute.value) node.setAttributeNS(attribute.namespaceURI, attribute.name, value);
        }
      }
    }
  }
  return clone;
};
