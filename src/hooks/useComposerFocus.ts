import { useLayoutEffect, useMemo, type PointerEvent, type RefObject } from "react";
import { activeModal, hasTextSelection, isAvailableFocusTarget, isUnclaimedFocus } from "../utils/focusPolicy";

type FocusReason = "intent" | "entry" | "return";
interface FocusOptions { reason?: FocusReason; cursor?: number }

export interface ComposerFocus {
  request: (options?: FocusOptions) => void;
  capture: (waitForWindow?: boolean) => () => void;
}

interface Owner {
  input: RefObject<HTMLTextAreaElement | null>;
  generation: number;
  timers: Set<ReturnType<typeof setTimeout>>;
  focus: ComposerFocus;
}

const owners = new Set<Owner>();
let interaction = 0;
let composing = false;
let pendingWindowRestore: (() => void) | undefined;
const recordInteraction = () => { interaction += 1; pendingWindowRestore = undefined; };
const startComposition = () => { composing = true; recordInteraction(); };
const endComposition = () => { composing = false; };

const returnToWindow = () => {
  if (pendingWindowRestore) {
    const restore = pendingWindowRestore;
    pendingWindowRestore = undefined;
    restore();
    return;
  }
  const owner = [...owners].reverse().find(candidate => isAvailableFocusTarget(candidate.input.current));
  owner?.focus.request({ reason: "return" });
};

const listen = (enabled: boolean) => {
  const method = enabled ? "addEventListener" : "removeEventListener";
  document[method]("pointerdown", recordInteraction, true);
  document[method]("keydown", recordInteraction, true);
  document[method]("focusin", recordInteraction, true);
  document[method]("compositionstart", startComposition, true);
  document[method]("compositionend", endComposition, true);
  window[method]("focus", returnToWindow);
};

const createOwner = (input: Owner["input"]): Owner => {
  const capture = (options: FocusOptions = {}, waitForWindow = false) => {
    const target = input.current;
    const generation = owner.generation;
    const revision = interaction;
    const valid = () => owners.has(owner) && owner.generation === generation &&
      input.current === target && interaction === revision;
    const restore = () => {
      if (!valid()) return;
      const timer = setTimeout(() => {
        owner.timers.delete(timer);
        if (!valid() || !isAvailableFocusTarget(target) || composing) return;
        if (document.visibilityState !== "visible" || !document.hasFocus()) {
          if (waitForWindow) pendingWindowRestore = restore;
          return;
        }
        const modal = activeModal();
        if (modal && !modal.contains(target)) return;
        const active = document.activeElement;
        if (options.reason && options.reason !== "intent") {
          if (hasTextSelection()) return;
          const chatRow = options.reason === "entry" && active instanceof Element &&
            active.closest(".chat-row") && !matchMedia("(forced-colors: active)").matches;
          if (active !== target && !isUnclaimedFocus(active) && !chatRow) return;
        }
        target.focus({ preventScroll: true });
        if (options.cursor !== undefined) target.setSelectionRange(options.cursor, options.cursor);
      }, 0);
      owner.timers.add(timer);
    };
    return restore;
  };
  const owner: Owner = {
    input, generation: 0, timers: new Set(),
    focus: {
      request: options => capture(options)(),
      // Capture before awaiting work, never after it: later user intent owns focus.
      capture: waitForWindow => capture({}, waitForWindow),
    },
  };
  return owner;
};

/** A lease belongs to an account/conversation and is revoked whenever its surface is hidden. */
export function useComposerFocus(input: Owner["input"], identity: string, enabled = true): ComposerFocus {
  const owner = useMemo(() => createOwner(input), [identity, input]);
  useLayoutEffect(() => {
    if (!enabled) return;
    if (!owners.size) listen(true);
    owners.add(owner);
    owner.generation += 1;
    return () => {
      owners.delete(owner);
      owner.generation += 1;
      owner.timers.forEach(clearTimeout);
      owner.timers.clear();
      if (!owners.size) {
        listen(false);
        pendingWindowRestore = undefined;
        composing = false;
      }
    };
  }, [enabled, owner]);
  return owner.focus;
}

export function focusComposerFromPointer(event: PointerEvent<HTMLElement>, focus: ComposerFocus) {
  if (event.button !== 0 || event.defaultPrevented || hasTextSelection()) return;
  const target = event.target;
  if (!(target instanceof Element) || target.closest("[data-composer-scope]") !== event.currentTarget) return;
  if (target.closest("button, a, input, textarea, select, video, audio, [contenteditable], [role='button'], [role='dialog'], [role='menu']")) return;
  focus.request();
}

const activeOwner = () => {
  const active = document.activeElement;
  const scope = active instanceof Element ? active.closest("[data-composer-scope]") : null;
  return [...owners].reverse().find(candidate => isAvailableFocusTarget(candidate.input.current) &&
    (!scope || candidate.input.current?.closest("[data-composer-scope]") === scope));
};

export function captureActiveComposerFocus(waitForWindow = false) {
  return activeOwner()?.focus.capture(waitForWindow) ?? (() => undefined);
}

/** Modal-local interactions are expected; only the originating editor may receive the return. */
export function rememberActiveComposerFocus() {
  const owner = activeOwner();
  const input = owner?.input.current;
  return () => {
    // A responsive layout may suspend and resume this same editor while the modal is open.
    if (owner && owners.has(owner) && owner.input.current === input) owner.focus.request();
  };
}
