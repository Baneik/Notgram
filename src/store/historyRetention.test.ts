import { expect, it } from "vitest";
import type { Message } from "../telegram/types";
import { HISTORY_MESSAGE_LIMIT, HISTORY_MESSAGE_TARGET, retainedHistoryMessages } from "./historyRetention";

const messages = (count: number): Message[] => Array.from({ length: count }, (_, index) => ({
  id: String(index), chatId: "7", senderId: "11", outgoing: false, delivery: "sent",
  sentAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(), content: { kind: "text", text: `message ${index}` },
}));

it("uses hysteresis and preserves unchanged arrays below the limit", () => {
  const source = messages(HISTORY_MESSAGE_LIMIT);
  expect(retainedHistoryMessages(source, [], new Set())).toBe(source);
  const trimmed = retainedHistoryMessages(messages(HISTORY_MESSAGE_LIMIT + 1), [], new Set());
  expect(trimmed).toHaveLength(HISTORY_MESSAGE_TARGET);
  expect(trimmed.at(-1)?.id).toBe(String(HISTORY_MESSAGE_LIMIT));
});

it("keeps every album member when the retention boundary crosses its caption", () => {
  const source = messages(3000).map((message, index) => index >= 994 && index <= 1003
    ? { ...message, mediaAlbumId: "album" } : message);
  const trimmed = retainedHistoryMessages(source, [], new Set());
  expect(trimmed.filter(message => message.mediaAlbumId === "album")).toHaveLength(10);
  expect(trimmed).toHaveLength(HISTORY_MESSAGE_TARGET + 6);
});

it("defers a positioning transaction and preserves mounted/selected records around a detached reader", () => {
  const source = messages(5000);
  expect(retainedHistoryMessages(source, [{ following: false, protectedIds: [], busy: true }], new Set())).toBe(source);
  const retained = retainedHistoryMessages(source, [{ following: false, anchorId: "1000", protectedIds: ["1", "4999"] }], new Set(["12"]));
  expect(retained.some(message => message.id === "1")).toBe(true);
  expect(retained.some(message => message.id === "12")).toBe(true);
  expect(retained.some(message => message.id === "1000")).toBe(true);
  expect(retained.at(-1)?.id).toBe("4999");
  expect(retained).toHaveLength(HISTORY_MESSAGE_TARGET + 2);
});
