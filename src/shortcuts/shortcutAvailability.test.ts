import { afterEach, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { checkShortcutAvailability } from "./shortcutAvailability";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
afterEach(() => vi.clearAllMocks());

it("passes normalized modifiers to the native check and preserves conflicts", async () => {
  vi.mocked(invoke).mockResolvedValue("conflict");
  await expect(checkShortcutAvailability("Ctrl+Shift+KeyG")).resolves.toBe("conflict");
  expect(invoke).toHaveBeenCalledWith("notgram_check_shortcut", { shortcut: {
    code: "KeyG", ctrl: true, alt: false, shift: true, meta: false,
  } });
});
it("propagates probe failures and never reports browser mode as conflict-free", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("native unavailable"));
  await expect(checkShortcutAvailability("Ctrl+ArrowUp")).rejects.toThrow("native unavailable");
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(checkShortcutAvailability("Ctrl+ArrowUp")).resolves.toBe("unsupported");
});
