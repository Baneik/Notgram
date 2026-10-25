import { afterEach, expect, it, vi } from "vitest";
import type { Message } from "../telegram/types";
import { createPendingSends } from "./telegramStore.pendingSends";

const setup = () => {
  const state = { activeAccountId: "first", currentUserId: "self", messages: new Map<string, Message[]>() };
  const pending = createPendingSends(() => state, patch => Object.assign(state, patch));
  return { state, pending, rows: () => state.messages.get("chat") ?? [] };
};

afterEach(() => vi.restoreAllMocks());

it("keeps chronological indexing valid when an earlier send gets its server timestamp", () => {
  const { pending, rows } = setup();
  pending.begin("chat", undefined, [{ content: { kind: "text", text: "first" } }]);
  pending.begin("chat", undefined, [{ content: { kind: "text", text: "second" } }]);
  const [first, second] = rows();
  const sentAt = new Date(Math.floor(Date.parse(first.sentAt) / 1000) * 1000).toISOString();
  pending.accept({ ...first, id: "server-first", sentAt, isPending: undefined });
  expect(rows().map(row => row.id)).toEqual(["server-first", second.id]);
});

it("shows separate immediate placeholders for identical sends and adopts only the matching TDLib identity", () => {
  const { pending, rows } = setup();
  const first = pending.begin("chat", "topic", [{ content: { kind: "text", text: "same" } }], "reply", { text: "quote" });
  const second = pending.begin("chat", "topic", [{ content: { kind: "text", text: "same" } }]);
  const [localFirst, localSecond] = rows();
  expect(localFirst).toMatchObject({ isPending: true, delivery: "sending", topicId: "topic", replyTo: { messageId: "reply", quote: "quote" } });
  expect(first.sendingId).not.toBe(second.sendingId);
  const unrelated = { ...localFirst, id: "unrelated", isPending: undefined, sendingId: undefined };
  expect(pending.accept(unrelated)).toBe(false);
  const realSecond = { ...localSecond, id: "td-second", isPending: undefined, renderKey: undefined };
  expect(pending.accept(realSecond)).toBe(true);
  expect(realSecond.renderKey).toBe(localSecond.renderKey);
  expect(rows().map(row => row.id)).toEqual([localFirst.id, "td-second"]);
  second.finish();
  expect(rows()).toHaveLength(2);
  first.finish();
  expect(rows().map(row => row.id)).toEqual(["td-second"]);
});

it("does not let duplicate TDLib updates consume the next member of an album", () => {
  const { pending, rows } = setup();
  const send = pending.begin("chat", undefined, [1, 2].map(index => ({
    mediaAlbumId: "local-album", content: { kind: "file", fileName: `${index}.txt`, sizeLabel: "1 KB" },
  })));
  const [first, second] = rows();
  const real = { ...first, id: "td-1", isPending: undefined, renderKey: undefined };
  expect(pending.accept(real)).toBe(true);
  expect(pending.accept({ ...real })).toBe(false);
  expect(rows().some(row => row.id === second.id)).toBe(true);
  expect(pending.accept({ ...second, id: "td-2", isPending: undefined })).toBe(true);
  send.finish();
  expect(rows().map(row => row.id)).toEqual(["td-1", "td-2"]);
});

it("creates visual previews before probing files and releases their URLs on completion", () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pending-preview");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const { pending, rows } = setup();
  const send = pending.beginFiles("chat", undefined, [{ kind: "photo", file: new File(["image"], "photo.jpg", { type: "image/jpeg" }),
    width: 640, height: 480, hasSpoiler: true }], "caption");
  expect(rows()[0].content).toMatchObject({ kind: "media", mediaType: "photo", width: 640, height: 480,
    previewDataUrl: "blob:pending-preview", caption: "caption", hasSpoiler: true });
  send.finish();
  send.finish();
  expect(rows()).toEqual([]);
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:pending-preview");
});

it("an old account's completion cannot remove a new account's send", () => {
  const { state, pending, rows } = setup();
  const old = pending.begin("chat", undefined, [{ content: { kind: "text", text: "old" } }]);
  pending.reset();
  expect(rows()).toEqual([]);
  state.activeAccountId = "second";
  state.messages = new Map();
  const current = pending.begin("chat", undefined, [{ content: { kind: "text", text: "current" } }]);
  old.finish();
  expect(rows()).toHaveLength(1);
  expect(rows()[0].sendingId).toBe(current.sendingId);
  current.finish();
});
