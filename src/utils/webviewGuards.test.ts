import { describe, expect, it } from "vitest";
import { isBlockedWebviewShortcut } from "./webviewGuards";

const shortcut = (
  key: string,
  modifiers: Partial<Omit<Parameters<typeof isBlockedWebviewShortcut>[0], "key">> = {},
) => ({
  altKey: false,
  ctrlKey: false,
  key,
  metaKey: false,
  shiftKey: false,
  ...modifiers,
});

describe("webview shortcut guards", () => {
  it.each([
    shortcut("F5"),
    shortcut("F12"),
    shortcut("Escape", { shiftKey: true }),
    shortcut("r", { ctrlKey: true }),
    shortcut("R", { ctrlKey: true, shiftKey: true }),
    shortcut("i", { ctrlKey: true, shiftKey: true }),
    shortcut("ArrowLeft", { altKey: true }),
  ])("blocks browser-owned shortcut $key", (event) => {
    expect(isBlockedWebviewShortcut(event)).toBe(true);
  });

  it.each([
    shortcut("Escape"),
    shortcut("k", { ctrlKey: true }),
    shortcut("c", { ctrlKey: true }),
    shortcut("i", { ctrlKey: true }),
  ])("leaves application and editing shortcut $key available", (event) => {
    expect(isBlockedWebviewShortcut(event)).toBe(false);
  });
});
