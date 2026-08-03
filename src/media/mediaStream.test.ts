import { describe, expect, it } from "vitest";
import { formatTransferSpeed } from "./mediaStream";

describe("media stream status formatting", () => {
  it("formats live transfer speeds with readable binary units", () => {
    expect(formatTransferSpeed(0)).toBe("0 B/s");
    expect(formatTransferSpeed(1_024)).toBe("1.00 KB/s");
    expect(formatTransferSpeed(5.5 * 1024 * 1024)).toBe("5.50 MB/s");
  });
});
