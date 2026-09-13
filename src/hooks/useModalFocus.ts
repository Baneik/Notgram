import { useLayoutEffect, useRef, type RefObject } from "react";
import { captureActiveComposerFocus } from "./useComposerFocus";
import { isAvailableFocusTarget, isUnclaimedFocus } from "../utils/focusPolicy";

const FOCUSABLE_SELECTOR = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";
const focusableElements = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(isAvailableFocusTarget);

interface ModalSession {
  container: HTMLElement;
  previous?: HTMLElement;
  last?: HTMLElement;
  restored: boolean;
  suspended: () => boolean;
  focusInitial: () => void;
  restore?: () => void;
}

const sessions: ModalSession[] = [];
const isolated = new Set<HTMLElement>();
let observer: MutationObserver | undefined;
const exiting = (session: ModalSession) => !session.container.isConnected ||
  Boolean(session.container.closest('[data-motion-state="exiting"]'));
const topSession = () => sessions.filter(session => !exiting(session) && !session.suspended() &&
  !session.container.closest('[hidden], [aria-hidden="true"]'))
  .reduce<ModalSession | undefined>((top, session) =>
    top && session.container.contains(top.container) ? top : session, undefined);

const restoreSession = (session: ModalSession) => {
  if (session.restored) return;
  session.restored = true;
  const active = document.activeElement;
  // An exit animation must not restore focus over a newer user operation.
  if (!isUnclaimedFocus(active) && !session.container.contains(active)) return;
  const top = topSession();
  if (!top && session.restore) {
    session.restore();
  } else if (isAvailableFocusTarget(session.previous) && (!top || top.container.contains(session.previous))) {
    session.previous.focus({ preventScroll: true });
  } else if (top) {
    top.focusInitial();
  } else {
    captureActiveComposerFocus()();
  }
};

const syncIsolation = () => {
  const top = topSession();
  const desired = new Set<HTMLElement>();
  if (top?.container.getAttribute("aria-modal") === "true") {
    // Isolate siblings at each level so nested dialogs never inert their own ancestors.
    for (let branch: HTMLElement = top.container; branch.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (!(sibling instanceof HTMLElement) || sibling === branch ||
          sibling.matches("script, style, link, [role='menu'], .context-menu-surface")) continue;
        desired.add(sibling);
      }
      if (branch.parentElement === document.body) break;
    }
  }
  for (const element of isolated) {
    if (!desired.has(element)) {
      element.inert = false;
      isolated.delete(element);
    }
  }
  for (const element of desired) {
    if (!element.inert) {
      element.inert = true;
      isolated.add(element);
    }
  }
  for (const session of sessions) {
    if (exiting(session)) restoreSession(session);
  }
};

export const useModalFocus = <T extends HTMLElement>(
  onClose: () => void,
  closeDisabled = false,
  initialFocusRef?: RefObject<HTMLElement | null>,
  suspended = false,
  restoreFocus?: () => void,
) => {
  const containerRef = useRef<T>(null);
  const options = useRef({ onClose, closeDisabled, suspended });
  useLayoutEffect(() => { options.current = { onClose, closeDisabled, suspended }; syncIsolation(); });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const session: ModalSession = {
      container,
      previous: document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
      restored: false,
      suspended: () => options.current.suspended,
      restore: restoreFocus,
      focusInitial: () => {
        const target = [session.last, initialFocusRef?.current, ...focusableElements(container), container]
          .find(isAvailableFocusTarget);
        target?.focus({ preventScroll: true });
      },
    };
    sessions.push(session);
    syncIsolation();
    if (!observer) {
      observer = new MutationObserver(syncIsolation);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true,
        attributeFilter: ["inert", "hidden", "aria-hidden", "data-motion-state"] });
    }
    const timer = setTimeout(() => { if (topSession() === session) session.focusInitial(); }, 0);
    const handleFocus = (event: FocusEvent) => {
      if (topSession() !== session || container.getAttribute("aria-modal") !== "true") return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (container.contains(target)) session.last = target;
      else if (!target.closest('[role="menu"]')) session.focusInitial();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (topSession() !== session || event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape" && !options.current.closeDisabled) {
        event.preventDefault();
        options.current.onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(container);
      if (!focusable.length) {
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && activeIndex <= 0) {
        event.preventDefault();
        focusable.at(-1)?.focus({ preventScroll: true });
      } else if (!event.shiftKey && (activeIndex < 0 || activeIndex === focusable.length - 1)) {
        event.preventDefault();
        focusable[0].focus({ preventScroll: true });
      }
    };
    document.addEventListener("focusin", handleFocus);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("focusin", handleFocus);
      document.removeEventListener("keydown", handleKeyDown);
      sessions.splice(sessions.indexOf(session), 1);
      syncIsolation();
      restoreSession(session);
      if (!sessions.length) { observer?.disconnect(); observer = undefined; }
    };
  }, [initialFocusRef]);

  return containerRef;
};
