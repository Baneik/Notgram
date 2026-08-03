type ShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

const blockedControlKeys = new Set(["p", "r", "s", "u", "w"]);
const blockedDeveloperToolKeys = new Set(["c", "i", "j"]);

export const isBlockedWebviewShortcut = (event: ShortcutEvent) => {
  const key = event.key.toLocaleLowerCase();
  const controlKey = event.ctrlKey || event.metaKey;

  if (key === "f5" || key === "f12") return true;
  if (event.shiftKey && key === "escape") return true;
  if (event.altKey && ["arrowleft", "arrowright", "home"].includes(key)) return true;
  if (!controlKey) return false;
  if (blockedControlKeys.has(key)) return true;
  return event.shiftKey && blockedDeveloperToolKeys.has(key);
};

export const installWebviewGuards = () => {
  window.addEventListener("keydown", (event) => {
    if (!isBlockedWebviewShortcut(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });

  document.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  }, { capture: true });
};
