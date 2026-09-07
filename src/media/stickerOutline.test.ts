import { expect, it } from "vitest";
import { stickerOutlinePath } from "./stickerOutline";

it("accepts numeric SVG paths and rejects markup or unbounded input", () => {
  expect(stickerOutlinePath("M0,0C10 20,30 40,50 60z")).toBe("M0,0C10 20,30 40,50 60z");
  for (const value of [undefined, "", "<svg onload='alert(1)'/>", "M0 0 url(x)", "M" + "0".repeat(65_536)]) {
    expect(stickerOutlinePath(value)).toBe("");
  }
});
