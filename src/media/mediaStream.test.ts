import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatTransferSpeed, updateMediaStreamPlayback } from "./mediaStream";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

describe("media stream status formatting", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("formats live transfer speeds with readable binary units", () => {
    expect(formatTransferSpeed(0)).toBe("0 B/s");
    expect(formatTransferSpeed(1_024)).toBe("1.00 KB/s");
    expect(formatTransferSpeed(5.5 * 1024 * 1024)).toBe("5.50 MB/s");
  });

  it("forwards audio playback progress so the native buffer window can advance", async () => {
    await updateMediaStreamPlayback(77, 42.5, 300, false);

    expect(invoke).toHaveBeenCalledWith("telegram_update_media_stream", {
      fileId: 77,
      currentTime: 42.5,
      duration: 300,
      paused: false,
    });
  });
});
