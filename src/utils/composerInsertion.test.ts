import { describe, expect, it } from "vitest";
import { insertComposerText, mentionTextForUser } from "./composerInsertion";

describe("composer insertion", () => {
  it("uses a Telegram username when one is available", () => {
    expect(mentionTextForUser({ displayName: "Ada Lovelace", username: "@ada" }))
      .toBe("@ada");
  });

  it("falls back to the member display name", () => {
    expect(mentionTextForUser({ displayName: "Ada Lovelace" })).toBe("@Ada Lovelace");
  });

  it("inserts at the selection with readable spacing", () => {
    expect(insertComposerText("hello there", "@ada", 6, 11)).toEqual({
      value: "hello @ada ",
      cursor: 11,
    });
    expect(insertComposerText("hello", "@ada", 5)).toEqual({
      value: "hello @ada ",
      cursor: 11,
    });
  });
});
