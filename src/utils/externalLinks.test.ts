import { describe, expect, it, vi } from "vitest";
import { openExternalLink, safeExternalHref } from "./externalLinks";

describe("external links", () => {
  it("normalizes supported links and rejects navigation-capable schemes", () => {
    expect(safeExternalHref("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
    expect(safeExternalHref("mailto:user@example.com")).toBe("mailto:user@example.com");
    expect(safeExternalHref("tg://resolve?domain=telegram")).toBe("tg://resolve?domain=telegram");
    expect(safeExternalHref("javascript:alert(1)")).toBeUndefined();
    expect(safeExternalHref("file:///C:/secret.txt")).toBeUndefined();
    expect(safeExternalHref(" https://example.com")).toBeUndefined();
    expect(safeExternalHref("https://example.com\nmalicious")).toBeUndefined();
  });

  it("uses a noopener browser window outside Tauri", async () => {
    const opened = { opener: {} } as Window;
    const open = vi.fn(() => opened);
    vi.stubGlobal("open", open);

    await openExternalLink("https://example.com");

    expect(open).toHaveBeenCalledWith(
      "https://example.com/",
      "_blank",
      "noopener,noreferrer",
    );
    expect(opened.opener).toBeNull();
    vi.unstubAllGlobals();
  });
});
