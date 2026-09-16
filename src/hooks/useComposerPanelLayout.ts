import { useLayoutEffect, type RefObject } from "react";

/** Keep composer panels inside their conversation, including scaled discussion panes. */
export function useComposerPanelLayout(composerRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const composer = composerRef.current;
    const wrap = composer?.closest<HTMLElement>(".composer-wrap");
    const scope = wrap?.closest<HTMLElement>("[data-composer-scope]");
    const header = scope?.querySelector<HTMLElement>(":scope > header");
    if (!composer || !wrap || !scope || !header) return;

    const measure = () => {
      const bounds = composer.getBoundingClientRect();
      const scale = bounds.height / composer.offsetHeight;
      if (!scale) return;
      const top = Math.max(0, header.getBoundingClientRect().bottom);
      // DOM bounds include UI zoom; CSS lengths must stay in local coordinates.
      wrap.style.setProperty("--composer-input-height", `${bounds.height / scale}px`);
      wrap.style.setProperty("--composer-panel-height", `${Math.max(0, (bounds.top - top) / scale - 12)}px`);
      wrap.style.setProperty("--composer-available-height", `${Math.max(0, (scope.getBoundingClientRect().bottom - top) / scale)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    [composer, scope, header].forEach(element => observer.observe(element));
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [composerRef]);
}
