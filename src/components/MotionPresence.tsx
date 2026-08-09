import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { usePreferencesStore } from "../store/preferencesStore";

const DEFAULT_EXIT_DURATION = 180;

interface MotionPresenceProps {
  present: boolean;
  children: ReactElement | null;
  exitDuration?: number;
}

/** Keeps a surface mounted briefly so its exit motion can finish before unmounting. */
export function MotionPresence({
  present,
  children,
  exitDuration = DEFAULT_EXIT_DURATION,
}: MotionPresenceProps) {
  const reduceMotion = usePreferencesStore((state) => state.effectiveReduceMotion);
  const lastChildRef = useRef<ReactNode>(children);
  const [rendered, setRendered] = useState(present);
  const [motionState, setMotionState] = useState<"entering" | "entered" | "exiting">(
    present ? "entering" : "exiting",
  );

  if (present && children) lastChildRef.current = children;

  useEffect(() => {
    let frame: number | undefined;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    if (present) {
      setRendered(true);
      setMotionState("entering");
      frame = requestAnimationFrame(() => setMotionState("entered"));
    } else if (rendered) {
      setMotionState("exiting");
      timer = globalThis.setTimeout(() => setRendered(false), reduceMotion ? 0 : exitDuration);
    }
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [exitDuration, present, reduceMotion, rendered]);

  if (!rendered || !lastChildRef.current) return null;
  return (
    <div className="motion-presence" data-motion-state={motionState}>
      {lastChildRef.current}
    </div>
  );
}
