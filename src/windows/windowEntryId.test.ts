import { describe, expect, it } from "vitest";
import { windowEntryId } from "./windowEntryId";

describe("windowEntryId", () => {
  it("reads the identifier from an isolated window route", () => {
    expect(windowEntryId("?id=viewer%201")).toBe("viewer 1");
  });

  it("rejects an entry route without an identifier", () => {
    expect(() => windowEntryId("")).toThrow("window identifier is missing");
  });
});
