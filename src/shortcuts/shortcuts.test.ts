import { describe, expect, it } from "vitest";
import { defaultShortcutBindings, formatShortcut, normalizeShortcutBindings, parseShortcut, shortcutActionForEvent, shortcutFromEvent, shortcutValidationError } from "./shortcuts";

const key = (code: string, extra: Partial<KeyboardEvent> = {}) => ({ code, key: code,
  ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, isComposing: false, keyCode: 0, ...extra });

describe("application shortcut bindings", () => {
  it("matches exactly and preserves the defaults", () => {
    expect(shortcutActionForEvent(key("ArrowUp"), defaultShortcutBindings)).toBe("previousChat");
    expect(shortcutActionForEvent(key("PageDown"), defaultShortcutBindings)).toBe("nextFolder");
    expect(shortcutActionForEvent(key("KeyR"), defaultShortcutBindings)).toBe("editLastMessage");
    expect(shortcutActionForEvent(key("Tab", { ctrlKey: false }), defaultShortcutBindings)).toBe("toggleMediaSendMode");
    expect(shortcutActionForEvent(key("ArrowUp", { shiftKey: true }), defaultShortcutBindings)).toBeUndefined();
    expect(shortcutActionForEvent(key("ArrowUp", { ctrlKey: false }), defaultShortcutBindings)).toBeUndefined();
    expect(formatShortcut(defaultShortcutBindings.previousChat)).toBe("Ctrl + ↑");
  });
  it("ignores composing input and modifier-only events", () => {
    expect(shortcutFromEvent(key("ArrowDown", { isComposing: true }))).toBeUndefined();
    expect(shortcutFromEvent(key("ArrowDown", { keyCode: 229 }))).toBeUndefined();
    expect(shortcutFromEvent(key("ControlLeft", { key: "Control" }))).toBeUndefined();
    expect(shortcutFromEvent(key("KeyG", { key: "п" }))).toBe("Ctrl+KeyG");
    expect(shortcutFromEvent(key("KeyG", { altKey: true, getModifierState: name => name === "AltGraph" }))).toBeUndefined();
  });
  it.each(["KeyA", "Shift+KeyA", "Ctrl+KeyC", "Ctrl+Shift+KeyM", "Ctrl+KeyK", "Alt+F4", "Ctrl+Meta+KeyG", "F12", "F5"])("rejects reserved or unsafe binding %s", binding => {
    expect(shortcutValidationError(binding)).toBeTruthy();
  });
  it.each(["Ctrl+ArrowUp", "Ctrl+PageDown", "Ctrl+KeyR", "Ctrl+Shift+KeyG", "Alt+KeyG", "F8"])("accepts binding %s for native verification", binding => {
    expect(shortcutValidationError(binding)).toBeUndefined();
  });
  it("migrates absent data and sanitizes corrupt and duplicate bindings", () => {
    expect(normalizeShortcutBindings(undefined)).toEqual(defaultShortcutBindings);
    expect(normalizeShortcutBindings({ previousChat: null, nextChat: "Ctrl+ArrowUp", previousFolder: "Ctrl+ArrowUp", nextFolder: "oops" }))
      .toEqual({ previousChat: null, nextChat: "Ctrl+ArrowUp", previousFolder: null, nextFolder: "Ctrl+PageDown", editLastMessage: "Ctrl+KeyR", toggleMediaSendMode: "Tab" });
    expect(parseShortcut("Shift+Ctrl+KeyG")).toBeUndefined();
    expect(parseShortcut("Ctrl+Ctrl+KeyG")).toBeUndefined();
  });
  it("preserves re-edit customization and reserves modified browser refresh", () => {
    expect(normalizeShortcutBindings({ editLastMessage: "Ctrl+Shift+KeyE" }).editLastMessage).toBe("Ctrl+Shift+KeyE");
    expect(normalizeShortcutBindings({ editLastMessage: null }).editLastMessage).toBeNull();
    expect(shortcutValidationError("Ctrl+Shift+KeyR")).toBeTruthy();
    expect(normalizeShortcutBindings({ previousChat: "Ctrl+KeyR" }).editLastMessage).toBeNull();
  });
  it("permits bare Tab only for media mode and migrates existing bindings", () => {
    expect(shortcutValidationError("Tab", "toggleMediaSendMode")).toBeUndefined();
    expect(shortcutValidationError("Tab", "previousChat")).toBeTruthy();
    expect(shortcutValidationError("Shift+Tab", "toggleMediaSendMode")).toBeTruthy();
    expect(shortcutValidationError("Ctrl+Tab", "toggleMediaSendMode")).toBeTruthy();
    expect(normalizeShortcutBindings({ previousChat: "Tab" }).previousChat).toBe("Ctrl+ArrowUp");
    expect(normalizeShortcutBindings({ editLastMessage: null }).toggleMediaSendMode).toBe("Tab");
    expect(normalizeShortcutBindings({ toggleMediaSendMode: "Ctrl+Shift+KeyG" }).toggleMediaSendMode).toBe("Ctrl+Shift+KeyG");
    expect(normalizeShortcutBindings({ toggleMediaSendMode: null }).toggleMediaSendMode).toBeNull();
    expect(normalizeShortcutBindings({ nextChat: "Ctrl+Shift+KeyG", toggleMediaSendMode: "Ctrl+Shift+KeyG" }).toggleMediaSendMode).toBeNull();
  });
});
