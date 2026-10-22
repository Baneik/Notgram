import { describe, expect, it } from "vitest";
import type { Message } from "../telegram/types";
import { composerMessageTarget } from "./composerMessageTarget";

const scope = { chatId: "chat", hiddenUserIds: new Set<string>() };
const source: Message = {
  id: "42", chatId: "chat", senderId: "author", outgoing: false,
  sentAt: "2026-10-22T00:00:00Z", delivery: "sent", content: { kind: "text", text: "Source" },
};

describe("composer message targets", () => {
  it("restores a draft from the full cache without a mounted source row", () => {
    expect(composerMessageTarget(scope, [source], source.id)).toBe(source);
  });

  it("keeps the selected snapshot when its cache entry is evicted", () => {
    expect(composerMessageTarget(scope, [], source.id, source)).toBe(source);
    expect(composerMessageTarget(scope, [], source.id, source, true)).toBe(source);
  });

  it("uses refreshed content and deletion flags in preference to a stale snapshot", () => {
    const updated = { ...source, isLocallyDeleted: true };
    expect(composerMessageTarget(scope, [updated], source.id, source)).toBe(updated);
    expect(composerMessageTarget(scope, [updated], source.id, source, true)).toBeUndefined();
  });

  it("ignores a cached same-ID message from another chat", () => {
    const foreign = { ...source, chatId: "other", content: { kind: "text" as const, text: "Wrong" } };
    expect(composerMessageTarget(scope, [foreign], source.id, source)).toBe(source);
    expect(composerMessageTarget(scope, [foreign], source.id)).toBeUndefined();
    expect(composerMessageTarget(scope, [], source.id, foreign)).toBeUndefined();
  });

  it("rejects snapshots from a different message or forum topic", () => {
    expect(composerMessageTarget(scope, [], "43", source)).toBeUndefined();
    expect(composerMessageTarget({ ...scope, topicId: "topic" }, [], source.id, source)).toBeUndefined();
    const topicMessage = { ...source, topicId: "topic" };
    expect(composerMessageTarget({ ...scope, topicId: "topic" }, [], source.id, topicMessage)).toBe(topicMessage);
  });

  it("does not resurrect a hidden source from a snapshot", () => {
    const hiddenScope = { ...scope, hiddenUserIds: new Set([source.senderId]) };
    expect(composerMessageTarget(hiddenScope, [], source.id, source)).toBeUndefined();
    expect(composerMessageTarget(hiddenScope, [source], source.id)).toBeUndefined();
    const own = { ...source, outgoing: true };
    expect(composerMessageTarget(hiddenScope, [], own.id, own, true)).toBe(own);
  });

  it.each([
    { isRemoving: true },
    { isLocallyDeleted: true },
    { permissions: { canEdit: false } as Message["permissions"] },
    { content: { kind: "service", text: "Service" } as Message["content"] },
  ])("revokes edits for an explicitly invalid target: %j", change => {
    expect(composerMessageTarget(scope, [{ ...source, ...change }], source.id, source, true)).toBeUndefined();
  });

  it("never falls back to stale content while a source is being removed", () => {
    expect(composerMessageTarget(scope, [{ ...source, isRemoving: true }], source.id, source)).toBeUndefined();
  });
});
