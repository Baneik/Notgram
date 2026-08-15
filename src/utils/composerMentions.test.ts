import { describe, expect, it } from "vitest";
import {
  prependComposerFormattedText,
  reconcileComposerMentionEntities,
  trimComposerFormattedText,
} from "./composerMentions";

const mention = { offset: 6, length: 4, kind: "mentionName" as const, userId: "42" };

describe("composer mention entities", () => {
  it("moves intact mentions and removes mentions edited internally", () => {
    expect(reconcileComposerMentionEntities("hello @Ada", "say hello @Ada", [mention]))
      .toEqual([{ ...mention, offset: 10 }]);
    expect(reconcileComposerMentionEntities("hello @Ada", "hello @Ava", [mention]))
      .toEqual([]);
    expect(reconcileComposerMentionEntities("hello @Ada", "hello @Ada!", [mention]))
      .toEqual([mention]);
  });

  it("keeps offsets aligned when whitespace is trimmed", () => {
    expect(trimComposerFormattedText("  hello @Ada  ", [{ ...mention, offset: 8 }]))
      .toEqual({ text: "hello @Ada", entities: [mention] });
  });

  it("restores a failed formatted send ahead of a new draft", () => {
    expect(prependComposerFormattedText(
      { text: "hello @Ada", entities: [mention] },
      "next @Lin",
      [{ ...mention, offset: 5, userId: "43" }],
    )).toEqual({
      text: "hello @Ada\nnext @Lin",
      entities: [mention, { ...mention, offset: 16, userId: "43" }],
    });
  });
});
