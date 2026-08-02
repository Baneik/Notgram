import type { KeyboardEvent as ReactKeyboardEvent } from "react";

const enabledButtons = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];

export const focusFirstMenuButton = (container: HTMLElement | null) => {
  if (!container) return false;
  const first = enabledButtons(container)[0];
  first?.focus();
  return Boolean(first);
};

export const handleMenuKeyboard = (
  event: ReactKeyboardEvent<HTMLElement>,
  onDismiss: () => void,
) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    onDismiss();
    return;
  }
  if (event.key === "Tab") {
    onDismiss();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) {
    return;
  }
  const buttons = enabledButtons(event.currentTarget);
  if (buttons.length === 0) return;
  event.preventDefault();
  const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? buttons.length - 1
      : ["ArrowDown", "ArrowRight"].includes(event.key)
        ? (currentIndex + 1 + buttons.length) % buttons.length
        : (currentIndex - 1 + buttons.length) % buttons.length;
  buttons[nextIndex].focus();
};
