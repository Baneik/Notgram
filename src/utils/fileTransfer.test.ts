import { describe, expect, it } from "vitest";
import { formatFileSize, isExecutableFile } from "./fileTransfer";

describe("file transfer presentation", () => {
  it("formats bytes with an adaptive unit", () => {
    expect(formatFileSize(850)).toBe("850 B");
    expect(formatFileSize(12 * 1024)).toBe("12 KB");
    expect(formatFileSize(2.5 * 1024 ** 2)).toBe("2.5 MB");
    expect(formatFileSize(3 * 1024 ** 3)).toBe("3 GB");
  });

  it("recognizes executable extensions and MIME types", () => {
    expect(isExecutableFile("setup.msi")).toBe(true);
    expect(isExecutableFile("deploy.sh")).toBe(true);
    expect(isExecutableFile("notes.txt")).toBe(false);
    expect(isExecutableFile("payload", "application/x-msdownload")).toBe(true);
  });
});
