export interface PhotoPreviewTask {
  blob: Blob;
  width: number;
  height: number;
  cover: boolean;
}

globalThis.onmessage = async ({ data }: MessageEvent<PhotoPreviewTask>) => {
  let image: ImageBitmap | undefined;
  try {
    image = await createImageBitmap(data.blob);
    const sourceWidth = image.width;
    const sourceHeight = image.height;
    const scale = Math.min(data.width / sourceWidth, data.height / sourceHeight, 1);
    const width = data.cover ? data.width : Math.max(1, Math.round(sourceWidth * scale));
    const height = data.cover ? data.height : Math.max(1, Math.round(sourceHeight * scale));
    const ratio = width / height;
    const cropWidth = data.cover ? Math.min(sourceWidth, Math.round(sourceHeight * ratio)) : sourceWidth;
    const cropHeight = data.cover ? Math.min(sourceHeight, Math.round(sourceWidth / ratio)) : sourceHeight;
    let current: CanvasImageSource = image;
    let currentWidth = cropWidth;
    let currentHeight = cropHeight;
    let x = (sourceWidth - cropWidth) / 2;
    let y = (sourceHeight - cropHeight) / 2;
    // Halving first averages fine detail rather than undersampling a huge
    // source in one CSS draw. All bitmap work stays outside the UI thread.
    while (true) {
      const nextWidth = Math.max(width, Math.ceil(currentWidth / 2));
      const nextHeight = Math.max(height, Math.ceil(currentHeight / 2));
      const canvas = new OffscreenCanvas(nextWidth, nextHeight);
      const context = canvas.getContext("2d")!;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(current, x, y, currentWidth, currentHeight, 0, 0, nextWidth, nextHeight);
      if (current === image) { image.close(); image = undefined; }
      if (nextWidth === width && nextHeight === height) {
        const blob = await canvas.convertToBlob({ type: "image/png" });
        globalThis.postMessage({ blob, width, height, sourceWidth, sourceHeight });
        break;
      }
      current = canvas;
      currentWidth = nextWidth;
      currentHeight = nextHeight;
      x = y = 0;
    }
  } catch {
    globalThis.postMessage({ failed: true });
  } finally {
    image?.close();
  }
};
