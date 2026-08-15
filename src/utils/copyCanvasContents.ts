export const copyCanvasContents = (source: ParentNode, clone: ParentNode) => {
  const sourceCanvases = source.querySelectorAll<HTMLCanvasElement>("canvas");
  const cloneCanvases = clone.querySelectorAll<HTMLCanvasElement>("canvas");
  sourceCanvases.forEach((sourceCanvas, index) => {
    const cloneCanvas = cloneCanvases[index];
    if (!cloneCanvas) return;
    try {
      cloneCanvas.getContext("2d")?.drawImage(
        sourceCanvas,
        0,
        0,
        cloneCanvas.width,
        cloneCanvas.height,
      );
    } catch {
      // A protected media canvas can be tainted; its surrounding layout still remains usable.
    }
  });
};
