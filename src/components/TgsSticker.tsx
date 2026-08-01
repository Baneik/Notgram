import { useEffect, useRef } from "react";

interface TgsStickerProps {
  src: string;
  label: string;
  autoplay: boolean;
  onError: () => void;
}

export function TgsSticker({ src, label, autoplay, onError }: TgsStickerProps) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const controller = new AbortController();
    let animation: import("lottie-web").AnimationItem | undefined;

    void Promise.all([
      fetch(src, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error(`Unable to load TGS sticker (${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
      }),
      import("pako"),
      import("lottie-web/build/player/lottie_light"),
    ])
      .then(([compressed, { ungzip }, lottieModule]) => {
        if (controller.signal.aborted) return;
        const serialized = ungzip(compressed, { toText: true });
        const animationData = JSON.parse(serialized) as Record<string, unknown>;
        animation = lottieModule.default.loadAnimation({
          container,
          renderer: "svg",
          loop: true,
          autoplay,
          animationData,
          rendererSettings: { preserveAspectRatio: "xMidYMid meet", progressiveLoad: true },
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        onErrorRef.current();
      });

    return () => {
      controller.abort();
      animation?.destroy();
      container.replaceChildren();
    };
  }, [autoplay, src]);

  return <span ref={containerRef} className="tgs-sticker" role="img" aria-label={label} />;
}
