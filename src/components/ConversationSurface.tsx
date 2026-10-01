import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { conversationGeometryKey } from "../hooks/conversationScrollState";
import { usePreferencesStore } from "../store/preferencesStore";

const ConversationGeometryContext = createContext({ width: 0, key: "" });
export const useConversationGeometry = () => useContext(ConversationGeometryContext);

/** The surface survives conversation remounts, so the next list can validate
 * measured geometry before its scroller exists. */
export function ConversationSurface({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollbarRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const geometryKey = usePreferencesStore(conversationGeometryKey);
  const { i18n } = useTranslation();
  useLayoutEffect(() => {
    const element = ref.current!;
    // The list reserves a stable thin scrollbar gutter. Measure that native
    // metric without mounting destination rows or assuming a Windows/DPI size.
    const update = () => {
      const probe = scrollbarRef.current!;
      setWidth(element.clientWidth - (probe.offsetWidth - probe.clientWidth));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [geometryKey]);
  const geometry = useMemo(() => ({ width, key: `${geometryKey}:${i18n.resolvedLanguage}` }), [width, geometryKey, i18n.resolvedLanguage]);
  return <div ref={ref} className="conversation-surface">
    <div ref={scrollbarRef} className="conversation-scrollbar-probe" aria-hidden="true" />
    <ConversationGeometryContext value={geometry}>{children}</ConversationGeometryContext>
  </div>;
}
