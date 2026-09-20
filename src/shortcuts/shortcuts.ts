import { translate } from "../i18n";

export const shortcutActions = [
  { id: "previousChat", label: () => translate("上一个会话"), defaultBinding: "Ctrl+ArrowUp" },
  { id: "nextChat", label: () => translate("下一个会话"), defaultBinding: "Ctrl+ArrowDown" },
  { id: "previousFolder", label: () => translate("上一个文件夹"), defaultBinding: "Ctrl+PageUp" },
  { id: "nextFolder", label: () => translate("下一个文件夹"), defaultBinding: "Ctrl+PageDown" },
  { id: "editLastMessage", label: () => translate("重新编辑上一条消息"), defaultBinding: "Ctrl+KeyR" },
] as const;

export type ShortcutAction = typeof shortcutActions[number]["id"];
export type ShortcutBindings = Record<ShortcutAction, string | null>;
export const defaultShortcutBindings = Object.fromEntries(
  shortcutActions.map(action => [action.id, action.defaultBinding]),
) as ShortcutBindings;

type KeyEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "isComposing" | "keyCode"> &
  Partial<Pick<KeyboardEvent, "getModifierState">>;
const supportedCode = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Arrow(Up|Down|Left|Right)|Page(Up|Down)|Home|End|Insert|Delete|Backspace|Space)$/;
const modifierOrder = ["Ctrl", "Alt", "Shift", "Meta"];

export const shortcutFromEvent = (event: KeyEvent): string | undefined => {
  if (event.isComposing || event.keyCode === 229 || event.getModifierState?.("AltGraph") || event.key === "AltGraph" ||
    ["Control", "Alt", "Shift", "Meta"].includes(event.key)) return undefined;
  const code = event.code || (/^[a-z]$/i.test(event.key) ? `Key${event.key.toUpperCase()}`
    : /^\d$/.test(event.key) ? `Digit${event.key}` : event.key);
  if (!supportedCode.test(code)) return undefined;
  return [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta", code]
    .filter(Boolean).join("+");
};

export const parseShortcut = (binding: string) => {
  const parts = binding.split("+");
  const code = parts.pop() ?? "";
  if (!supportedCode.test(code) || parts.some(part => !modifierOrder.includes(part)) ||
    new Set(parts).size !== parts.length ||
    modifierOrder.filter(part => parts.includes(part)).join("+") !== parts.join("+")) return undefined;
  return { code, ctrl: parts.includes("Ctrl"), alt: parts.includes("Alt"), shift: parts.includes("Shift"), meta: parts.includes("Meta") };
};

// Preserve text editing, composer formatting and the application's existing commands.
export const shortcutValidationError = (binding: string): string | undefined => {
  const parsed = parseShortcut(binding);
  if (!parsed) return translate("请选择组合键或功能键");
  if (parsed.meta || parsed.code === "F12" ||
    (parsed.alt && ["F4", "Space"].includes(parsed.code)) ||
    (parsed.ctrl && parsed.alt && parsed.code === "Delete")) return translate("此快捷键由系统保留");
  if (!parsed.ctrl && !parsed.alt && !/^F\d+$/.test(parsed.code)) return translate("请选择组合键或功能键");
  if ((parsed.ctrl && !parsed.alt && (
    ["KeyA", "KeyC", "KeyV", "KeyX", "KeyZ", "KeyY", "KeyF", "KeyJ", "KeyK", "KeyP", "KeyS", "KeyU", "KeyW", "KeyI", "KeyB"].includes(parsed.code) ||
    (parsed.shift && ["KeyM", "KeyQ", "KeyR"].includes(parsed.code))
  )) || parsed.code === "F5" || (parsed.shift && parsed.code === "F10") ||
    (parsed.alt && ["ArrowLeft", "ArrowRight", "Home"].includes(parsed.code))) return translate("此快捷键已被应用占用");
  return undefined;
};

export const normalizeShortcutBindings = (value: unknown): ShortcutBindings => {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result = { ...defaultShortcutBindings };
  const used = new Set<string>();
  for (const action of shortcutActions) {
    const binding = source[action.id];
    const candidate = binding === null ? null : typeof binding === "string" && !shortcutValidationError(binding)
      ? binding : action.defaultBinding;
    result[action.id] = candidate && used.has(candidate) ? null : candidate;
    if (result[action.id]) used.add(result[action.id]!);
  }
  return result;
};

const keyLabels: Record<string, string> = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", PageUp: "PgUp", PageDown: "PgDn", Meta: "Win",
};
export const formatShortcut = (binding: string | null) => binding
  ? binding.split("+").map(part => keyLabels[part] ?? part.replace(/^(Key|Digit)/, "")).join(" + ")
  : translate("未设置");

export const shortcutActionForEvent = (event: KeyEvent, bindings: ShortcutBindings) => {
  const binding = shortcutFromEvent(event);
  return binding ? shortcutActions.find(action => bindings[action.id] === binding)?.id : undefined;
};
