export const hasTextSelection = () => {
  const selection = globalThis.getSelection();
  return Boolean(selection && !selection.isCollapsed);
};

export const isAvailableFocusTarget = (element: HTMLElement | null | undefined): element is HTMLElement =>
  Boolean(element?.isConnected && !element.closest("[inert], [hidden], [aria-hidden='true']") &&
    !element.matches(":disabled") && element.getClientRects().length &&
    getComputedStyle(element).visibility !== "hidden");

export const activeModal = () => [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')]
  .filter(isAvailableFocusTarget).at(-1);

export const isUnclaimedFocus = (element: Element | null) =>
  !element || element === document.body || element === document.documentElement;
