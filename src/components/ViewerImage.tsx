import { useLayoutEffect, useRef } from "react";
import { retainViewerImage } from "../media/viewerImages";

interface Props {
  source: string;
  alt: string;
  onReady: (image: HTMLImageElement, cached: boolean) => void;
  onError: () => void;
}

/** Mount the same decoded node on navigation; retain its predecessor on upgrades. */
export function ViewerImage({ source, alt, onReady, onError }: Props) {
  const container = useRef<HTMLSpanElement>(null);
  const displayed = useRef<ReturnType<typeof retainViewerImage> | undefined>(undefined);
  const callbacks = useRef({ onReady, onError });
  useLayoutEffect(() => { callbacks.current = { onReady, onError }; });

  useLayoutEffect(() => {
    const host = container.current;
    if (!host) return;
    const retained = retainViewerImage(source);
    const image = retained.image;
    image.className = "stable-image media-viewer-image";
    image.alt = alt;
    image.draggable = false;
    image.dataset.imageTransition = "none";
    const previous = displayed.current;
    if (previous && previous.image !== image) previous.image.dataset.imageRetained = "true";
    image.dataset.imageState = retained.ready ? "ready" : "decoding";
    if (previous && previous.image !== image) {
      image.dataset.imagePending = "true";
      image.style.cssText = "position: absolute; inset: 0; pointer-events: none";
      image.setAttribute("aria-hidden", "true");
    }
    host.append(image);
    let active = true;
    const reveal = () => {
      if (!active || image.parentElement !== host) return;
      if (previous && previous !== retained) {
        if (previous.image !== image) previous.image.remove();
        previous.release();
      }
      delete image.dataset.imagePending;
      delete image.dataset.imageRetained;
      image.removeAttribute("style");
      image.removeAttribute("aria-hidden");
      image.dataset.imageState = "ready";
      displayed.current = retained;
      callbacks.current.onReady(image, retained.ready);
    };
    if (retained.ready) reveal();
    else void retained.promise.then(reveal).catch(() => {
      if (!active) return;
      image.remove();
      callbacks.current.onError();
    });
    return () => {
      active = false;
      if (displayed.current !== retained) {
        image.remove();
        retained.release();
      }
    };
  }, [source]);

  useLayoutEffect(() => {
    const image = displayed.current?.image;
    if (image) image.alt = alt;
  }, [alt]);

  useLayoutEffect(() => () => {
    displayed.current?.image.remove();
    displayed.current?.release();
    displayed.current = undefined;
  }, []);

  return <span ref={container} className="media-viewer-image-host" />;
}
