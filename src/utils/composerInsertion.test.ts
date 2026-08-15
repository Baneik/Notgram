import { describe, expect, it } from "vitest";
import {
  composerInlineQueryForDraft,
  insertComposerMention,
  insertComposerText,
  mentionTextForUser,
} from "./composerInsertion";

describe("composer insertion", () => {
  it("always displays the member nickname", () => {
    expect(mentionTextForUser({ displayName: "Ada Lovelace", username: "@ada" }))
      .toBe("@Ada Lovelace");
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

  it("records a stable user mention over the visible nickname", () => {
    expect(insertComposerMention("hello", "@Ada Lovelace", "42", 5)).toEqual({
      value: "hello @Ada Lovelace ",
      cursor: 20,
      entity: { offset: 6, length: 13, kind: "mentionName", userId: "42" },
    });
  });

  it("does not treat a known non-bot mention as an inline query", () => {
    const knownNonBots = new Set(["mia_design"]);
    expect(composerInlineQueryForDraft("@MIA_DESIGN release notes", knownNonBots))
      .toBeUndefined();
  });

  it("keeps unknown usernames eligible for inline bot queries", () => {
    expect(composerInlineQueryForDraft("@release_bot latest", new Set()))
      .toEqual({ username: "release_bot", query: "latest" });
  });
});
