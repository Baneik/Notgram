import { expect, it } from "vitest";
import type { Chat } from "../telegram/types";
import { ForumUnreadState } from "./forumUnreadState";

const chat = (unreadCount: number, overrides: Partial<Chat> = {}): Chat => ({
  id: "forum", kind: "supergroup", title: "Forum", isForum: true,
  unreadCount, unreadMentionCount: 0, unreadReactionCount: 0,
  folderIds: ["main"], pinned: false, muted: false, preview: "", ...overrides,
} as Chat);

it("subtracts only the read topic and ignores duplicate acknowledgements", () => {
  const state = new ForumUnreadState();
  state.observeChat(chat(4));
  const read = state.captureRead("forum", "12", "100", 3);
  expect(state.acknowledgeRead(read)).toBe(1);
  expect(state.acknowledgeRead(read)).toBe(1);
  expect(state.observeChat(chat(4, { title: "Renamed" }))).toMatchObject({ title: "Renamed", unreadCount: 1 });
  expect(state.acknowledgeRead(state.captureRead("forum", "18", "101", 1))).toBe(0);
});

it("absorbs a delayed group count decrease without subtracting twice", () => {
  const state = new ForumUnreadState();
  state.observeChat(chat(4));
  state.acknowledgeRead(state.captureRead("forum", "12", "100", 3));
  expect(state.observeChat(chat(1)).unreadCount).toBe(1);
  expect(state.observeChat(chat(2)).unreadCount).toBe(2);
});

it("does not deduct twice when a group update precedes the topic acknowledgement", () => {
  const state = new ForumUnreadState();
  state.observeChat(chat(4));
  const read = state.captureRead("forum", "12", "100", 3);
  expect(state.observeChat(chat(1)).unreadCount).toBe(1);
  expect(state.acknowledgeRead(read)).toBe(1);
});

it("preserves new messages in another topic while a read is pending", () => {
  const state = new ForumUnreadState();
  state.observeChat(chat(4));
  const read = state.captureRead("forum", "12", "100", 3);
  expect(state.observeChat(chat(5)).unreadCount).toBe(5);
  expect(state.acknowledgeRead(read)).toBe(2);
  expect(state.observeChat(chat(2)).unreadCount).toBe(2);
});

it("restores a badge when messages arrive after every topic was read", () => {
  const state = new ForumUnreadState();
  state.observeChat(chat(3));
  state.acknowledgeRead(state.captureRead("forum", "12", "100", 3));
  expect(state.observeChat(chat(4)).unreadCount).toBe(1);
  expect(state.acknowledgeRead(state.captureRead("forum", "12", "101", 1))).toBe(0);
});

it("does not reuse a stale topic count when reading a newer message after the previous boundary", () => {
  const state = new ForumUnreadState();
  state.observeChat(chat(4));
  state.acknowledgeRead(state.captureRead("forum", "12", "100", 3));
  expect(state.observeChat(chat(5)).unreadCount).toBe(2);
  expect(state.acknowledgeRead(state.captureRead("forum", "12", "101", 3, "100", 1))).toBe(1);
});

it("leaves counts unchanged without a successful acknowledgement", () => {
  const state = new ForumUnreadState();
  state.observeChat(chat(4));
  state.captureRead("forum", "12", "100", 3);
  expect(state.observeChat(chat(4)).unreadCount).toBe(4);
});

it("uses complete topic totals to repair an already stale group count", () => {
  const state = new ForumUnreadState();
  state.observeChat(chat(4));
  expect(state.reconcileTopics("forum", 1)).toBe(1);
  expect(state.observeChat(chat(4)).unreadCount).toBe(1);
  expect(state.reconcileTopics("forum", 4)).toBe(1);
  expect(state.reconcileTopics("forum", 0)).toBe(0);
});

it("does not deduct an in-flight read again after a complete topic refresh", () => {
  const state = new ForumUnreadState();
  state.observeChat(chat(4));
  const read = state.captureRead("forum", "12", "100", 3);
  state.reconcileTopics("forum", 1);
  expect(state.acknowledgeRead(read)).toBe(1);
});

it.each(["reset", "discard", "ordinary"])("rejects old reads after %s and keeps a new session's counts", action => {
  const state = new ForumUnreadState();
  state.observeChat(chat(4));
  const read = state.captureRead("forum", "12", "100", 3);
  if (action === "reset") state.reset();
  else if (action === "discard") state.discard("forum");
  else state.observeChat(chat(7, { isForum: false }));
  state.observeChat(chat(6));
  expect(state.acknowledgeRead(read)).toBeUndefined();
  expect(state.observeChat(chat(6)).unreadCount).toBe(6);
});

it("seeds cached chats without observing an already adjusted count as a server decrease", () => {
  const state = new ForumUnreadState();
  state.seedChat(chat(4));
  state.acknowledgeRead(state.captureRead("forum", "12", "100", 3));
  state.seedChat(chat(1));
  expect(state.observeChat(chat(4)).unreadCount).toBe(1);
});
