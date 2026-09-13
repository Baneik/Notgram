import { preferencesStore } from "../store/preferencesStore";

type ShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

const blockedControlKeys = new Set(["p", "r", "s", "u", "w"]);
const blockedDeveloperToolKeys = new Set(["c", "i", "j"]);

export const isBlockedWebviewShortcut = (event: ShortcutEvent, inComposer = false) => {
  const key = event.key.toLocaleLowerCase();
  const controlKey = event.ctrlKey || event.metaKey;

  if (key === "f5" || key === "f12") return true;
  if (event.shiftKey && key === "escape") return true;
  if (event.altKey && ["arrowleft", "arrowright", "home"].includes(key)) return true;
  if (!controlKey) return false;
  if (inComposer && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && key === "u") return false;
  if (blockedControlKeys.has(key)) return true;
  return event.shiftKey && blockedDeveloperToolKeys.has(key);
};

export const installWebviewGuards = () => {
  window.addEventListener("keydown", (event) => {
    const inComposer = event.target instanceof Element && Boolean(event.target.closest(".composer-input"));
    if (!isBlockedWebviewShortcut(event, inComposer)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });

  document.addEventListener("contextmenu", (event) => {
    if (event.button === 2 && event.ctrlKey && preferencesStore.getState().developerMode) return;
    event.preventDefault();
  }, { capture: true });
};
