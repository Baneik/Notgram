import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { usePreferencesStore } from "../store/preferencesStore";
import { motionDuration } from "../utils/motionTokens";

const EXIT_FALLBACK_BUFFER = 40;

export type MotionPresenceVariant = "modal" | "drawer" | "toast" | "popover";

interface MotionPresenceProps {
  present: boolean;
  children: ReactElement | null;
  exitDuration?: number;
  variant?: MotionPresenceVariant;
}

/** Owns the enter/exit lifetime of a transient surface, including interrupted exits. */
export function MotionPresence({
  present,
  children,
  exitDuration = motionDuration.standard,
  variant = "modal",
}: MotionPresenceProps) {
  const reduceMotion = usePreferencesStore((state) => state.effectiveReduceMotion);
  const lastChildRef = useRef<ReactNode>(children);
  const wasPresentRef = useRef(present);
  const [rendered, setRendered] = useState(present);
  const [session, setSession] = useState(0);
  const [motionState, setMotionState] = useState<"entering" | "entered" | "exiting">(
    present ? "entering" : "exiting",
  );

  const finishExit = useCallback(() => {
    if (!present) setRendered(false);
  }, [present]);

  const handleAnimationEnd = useCallback((event: AnimationEvent<HTMLDivElement>) => {
    if (
      present ||
      motionState !== "exiting" ||
      event.target !== event.currentTarget.firstElementChild
    ) return;
    finishExit();
  }, [finishExit, motionState, present]);

  if (present && children) lastChildRef.current = children;

  useLayoutEffect(() => {
    let frame: number | undefined;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const opening = present && !wasPresentRef.current;
    wasPresentRef.current = present;
    if (present) {
      setRendered(true);
      if (opening) setSession((current) => current + 1);
      setMotionState("entering");
      frame = requestAnimationFrame(() => setMotionState("entered"));
    } else if (rendered) {
      setMotionState("exiting");
      timer = globalThis.setTimeout(
        finishExit,
        reduceMotion ? 0 : exitDuration + EXIT_FALLBACK_BUFFER,
      );
    }
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [exitDuration, finishExit, present, reduceMotion, rendered]);

  if (!rendered || !lastChildRef.current) return null;
  const renderedMotionState = present ? motionState : "exiting";
  return (
    <div
      className="motion-presence"
      data-motion-state={renderedMotionState}
      data-motion-variant={variant}
      inert={!present || undefined}
      aria-hidden={!present || undefined}
      onAnimationEnd={handleAnimationEnd}
    >
      <Fragment key={session}>{lastChildRef.current}</Fragment>
    </div>
  );
}
