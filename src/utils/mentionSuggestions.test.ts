import { describe, expect, it } from "vitest";
import type { Message, User } from "../telegram/types";
import {
  MAX_MENTION_SUGGESTIONS,
  mentionSuggestionsFor,
  recentMentionUserIdsFor,
} from "./mentionSuggestions";

const user = (id: string, displayName: string, username?: string): User => ({
  id,
  displayName,
  username,
  avatar: { label: displayName.slice(0, 1), color: "#397a78" },
  presence: "offline",
});

const message = (
  id: string,
  userIds: string[],
  options?: { outgoing?: boolean; caption?: boolean },
): Message => {
  const entities = userIds.map((userId, index) => ({
    offset: index * 4,
    length: 3,
    kind: "mentionName" as const,
    userId,
  }));
  return {
    id,
    chatId: "group",
    senderId: options?.outgoing === false ? "other" : "self",
    outgoing: options?.outgoing !== false,
    sentAt: `2026-08-29T10:00:0${id}Z`,
    delivery: "read",
    content: options?.caption
      ? { kind: "file", fileName: "notes.txt", sizeLabel: "1 KB", captionEntities: entities }
      : { kind: "text", text: "mentions", entities },
  };
};

describe("mention suggestions", () => {
  it("orders previously mentioned users by frequency, then most recent use", () => {
    expect(recentMentionUserIdsFor([
      message("1", ["ada", "mia"]),
      message("2", ["mia"]),
      message("3", ["ada"]),
      message("4", ["lin", "lin", "lin"], { caption: true }),
      message("5", ["ignored"], { outgoing: false }),
    ])).toEqual(["lin", "ada", "mia"]);
  });

  it("shows only recent users for an empty query and caps all results at five", () => {
    const users = Array.from({ length: 7 }, (_, index) =>
      user(`u-${index}`, `Member ${index}`, `member_${index}`));

    expect(mentionSuggestionsFor(users, "", ["u-3", "missing", "u-1"]))
      .toEqual([users[3], users[1]]);
    expect(mentionSuggestionsFor(users, "member", [])).toHaveLength(MAX_MENTION_SUGGESTIONS);
  });

  it("matches both usernames and display names without returning bots", () => {
    const users = [
      user("mia", "Mia Chen", "sfas_k"),
      { ...user("bot", "sfas helper", "helper_bot"), isBot: true },
    ];

    expect(mentionSuggestionsFor(users, "sfas", []).map((item) => item.id)).toEqual(["mia"]);
    expect(mentionSuggestionsFor(users, "mia", []).map((item) => item.id)).toEqual(["mia"]);
  });
});
