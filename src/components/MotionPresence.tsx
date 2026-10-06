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
import { motionDuration, motionEasing, motionLifecycleTiming } from "../utils/motionTokens";

export type MotionPresenceVariant = "modal" | "drawer" | "toast" | "popover" | "status";

interface MotionPresenceProps {
  present: boolean;
  children: ReactElement | null;
  exitDuration?: number;
  variant?: MotionPresenceVariant;
  placement?: "above" | "below";
}

interface MotionFrame extends Keyframe { opacity: string; transform: string }
interface MotionLayer { element: HTMLElement; pseudo?: string; animation: Animation; key: string }

/** Owns the enter/exit lifetime of a transient surface, including interrupted exits. */
export function MotionPresence({
  present,
  children,
  exitDuration,
  variant = "modal",
  placement = "below",
}: MotionPresenceProps) {
  const reduceMotion = usePreferencesStore((state) => state.effectiveReduceMotion);
  const lastChildRef = useRef<ReactNode>(children);
  const wasPresentRef = useRef(present);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const interruptedFramesRef = useRef(new Map<string, MotionFrame>());
  const managed = typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.animate === "function";
  const resolvedExitDuration = exitDuration ?? (variant === "modal" || variant === "drawer"
    ? motionDuration.standard : motionDuration.fast);
  const [rendered, setRendered] = useState(present);
  const [session, setSession] = useState(0);
  const [motionState, setMotionState] = useState<"entering" | "entered" | "exiting">(
    present ? "entering" : "exiting",
  );

  const finishExit = useCallback(() => {
    if (!present) setRendered(false);
  }, [present]);

  const handleAnimationEnd = useCallback((event: AnimationEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget.firstElementChild) return;
    if (present) setMotionState("entered");
    else if (motionState === "exiting") finishExit();
  }, [finishExit, motionState, present]);

  if (present && children) lastChildRef.current = children;

  useLayoutEffect(() => {
    const opening = present && !wasPresentRef.current;
    wasPresentRef.current = present;
    // Capture the old host before creating a fresh child session. Focus and local
    // state reset on reopen, while its presentation continues from the last frame.
    if (present && (!rendered || opening)) {
      setMotionState("entering");
      setRendered(true);
      if (opening) setSession((current) => current + 1);
      return;
    }
    if (!rendered) return;
    let active = true;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const layers: MotionLayer[] = [];
    const complete = () => {
      if (!active) return;
      if (present) setMotionState("entered");
      else finishExit();
    };
    const settle = () => {
      layers.forEach(({ animation }) => animation.cancel());
      interruptedFramesRef.current.clear();
      complete();
    };
    if (present) {
      setMotionState("entering");
    } else {
      setMotionState("exiting");
    }
    if (reduceMotion || document.hidden) {
      interruptedFramesRef.current.clear();
      complete();
      return;
    }
    const root = wrapperRef.current?.firstElementChild;
    if (managed && root instanceof HTMLElement) {
      const animate = (element: HTMLElement, key: string, hidden: MotionFrame, duration: number, pseudo?: string) => {
        const style = getComputedStyle(element, pseudo);
        const resting = { opacity: style.opacity, transform: style.transform };
        const from = interruptedFramesRef.current.get(key) ?? (present ? hidden : resting);
        let animation: Animation;
        try {
          animation = element.animate([from, present ? resting : hidden], {
            duration, easing: present ? motionEasing.enter : motionEasing.exit, fill: "both", pseudoElement: pseudo,
          });
        } catch {
          // Older WebViews can reject pseudo-element effects. Resting CSS and
          // the bounded exit fallback keep the surface usable in that case.
          return;
        }
        layers.push({ element, pseudo, animation, key });
      };
      const backdrop = variant === "modal" || variant === "drawer";
      const surface = backdrop ? root.firstElementChild : root;
      if (backdrop) animate(root, "scrim", { opacity: "0", transform: "none" },
        present ? motionDuration.standard : resolvedExitDuration, "::before");
      if (surface instanceof HTMLElement) {
        const base = getComputedStyle(surface).transform;
        // Resolve CSS distances before passing keyframes to WAAPI; transforms may
        // already contain centering used by loading and error notices.
        const distance = getComputedStyle(surface).getPropertyValue(
          variant === "modal" || variant === "drawer" || variant === "toast"
            ? "--motion-distance-standard" : "--motion-distance-near",
        ).trim() || "4px";
        const translated = variant === "drawer" ? `translateX(${distance})`
          : `translateY(${variant === "popover" && placement === "below" ? "-" : ""}${distance})`;
        const scale = variant === "modal" || variant === "popover" ? " scale(0.99)" : "";
        animate(surface, "surface", { opacity: "0", transform: `${base === "none" ? "" : `${base} `}${translated}${scale}` },
          present ? (backdrop ? motionDuration.slow : variant === "popover" ? motionDuration.standard : motionDuration.fast)
            : resolvedExitDuration);
      }
      interruptedFramesRef.current.clear();
      void Promise.all(layers.map(({ animation }) => animation.finished)).then(complete).catch(() => undefined);
    }
    if (!present) timer = globalThis.setTimeout(complete, resolvedExitDuration + motionLifecycleTiming.exitFallbackBuffer);
    const onVisibilityChange = () => { if (document.hidden) settle(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      // Sample before canceling, including the independent backdrop pseudo-element.
      interruptedFramesRef.current = new Map(layers.map(({ element, pseudo, key }) => {
        const style = getComputedStyle(element, pseudo);
        return [key, { opacity: style.opacity, transform: style.transform }];
      }));
      layers.forEach(({ animation }) => animation.cancel());
      if (timer !== undefined) globalThis.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [finishExit, managed, placement, present, reduceMotion, rendered, resolvedExitDuration, session, variant]);

  if (!rendered || !lastChildRef.current) return null;
  const renderedMotionState = present ? motionState : "exiting";
  return (
    <div
      className="motion-presence"
      ref={wrapperRef}
      data-motion-managed={managed || undefined}
      data-motion-state={renderedMotionState}
      data-motion-variant={variant}
      data-motion-placement={placement}
      inert={!present || undefined}
      aria-hidden={!present || undefined}
      onAnimationEnd={handleAnimationEnd}
    >
      <Fragment key={session}>{lastChildRef.current}</Fragment>
    </div>
  );
}
