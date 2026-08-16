import { describe, expect, it } from "vitest";
import { conversationJumpMotion } from "./conversationJumpMotion";

describe("conversation jump motion", () => {
  it("moves old and new content in opposite directions", () => {
    const older = conversationJumpMotion("older");
    const newer = conversationJumpMotion("newer");

    expect(older.exit.at(-1)).toMatchObject({ opacity: 0.72, transform: "translateY(8px)" });
    expect(older.enter[0]).toMatchObject({ opacity: 0.72, transform: "translateY(-8px)" });
    expect(newer.exit.at(-1)).toMatchObject({ transform: "translateY(-8px)" });
    expect(Number(older.enterTiming.duration)).toBeGreaterThan(Number(older.exitTiming.duration));
  });
});
