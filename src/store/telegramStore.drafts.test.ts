import { afterEach, describe, expect, it, vi } from "vitest";
import { mapTdChatDraft } from "../telegram/tdlibMapper";
import { formattedTextObject } from "../telegram/tdlibRequests";
import type { ChatDraft, MessageTextEntity } from "../telegram/types";
import { composerDocument, composerFormattedText } from "../utils/composerFormatting";
import { DraftSyncController, draftSignature } from "./telegramStore.drafts";

const localDraft = (entities: MessageTextEntity[]): ChatDraft => ({
  chatId: "-1007",
  ...composerFormattedText(composerDocument("@Mia hello", entities)),
  updatedAt: "2026-09-20T00:00:00Z",
  pending: true,
});

const serverEcho = (draft: ChatDraft): ChatDraft => mapTdChatDraft(draft.chatId, {
  date: 1_789_862_400,
  content: {
    "@type": "draftMessageContentText",
    text: formattedTextObject(draft.text, draft.entities),
  },
})!;

function fixture(local: ChatDraft) {
  let drafts = new Map([[local.chatId, local]]);
  const discardLocalAttachments = vi.fn();
  const controller = new DraftSyncController({
    isReady: () => true,
    getDrafts: () => drafts,
    setDrafts: next => { drafts = next; },
    sendDraft: vi.fn(async () => undefined),
    reportError: vi.fn(),
    scheduleCacheWrite: vi.fn(),
    discardLocalAttachments,
  });
  return { controller, discardLocalAttachments, getDraft: () => drafts.get(local.chatId) };
}

afterEach(() => vi.useRealTimers());

describe("draft content identity", () => {
  it.each<MessageTextEntity>([
    { kind: "mentionName", offset: 0, length: 4, userId: "11" },
    { kind: "bold", offset: 0, length: 4 },
    { kind: "textUrl", offset: 0, length: 4, href: "https://example.test" },
    { kind: "pre", offset: 0, length: 4, language: "ts" },
    { kind: "customEmoji", offset: 0, length: 4, customEmojiId: "42" },
    { kind: "dateTime", offset: 0, length: 4, dateTime: {
      showDayOfWeek: true, datePrecision: "long", timePrecision: "short", mode: "absolute", unixTime: 123,
    } },
  ])("matches an editor $kind entity to its native draft echo", entity => {
    const local = localDraft([entity]);
    expect(draftSignature(serverEcho(local))).toBe(draftSignature(local));
  });

  it("ignores entity ordering without changing the editor's entities", () => {
    const local = localDraft([
      { kind: "mentionName", offset: 0, length: 4, userId: "11" },
      { kind: "bold", offset: 0, length: 4 },
    ]);
    const original = structuredClone(local);
    const incoming = serverEcho(local);
    incoming.entities!.reverse();
    expect(draftSignature(incoming)).toBe(draftSignature(local));
    expect(local).toEqual(original);
  });

  it.each<Partial<MessageTextEntity>>([
    { userId: "12" }, { offset: 1 }, { length: 3 }, { kind: "bold", userId: undefined },
  ])("distinguishes meaningful entity changes: %j", change => {
    const local = localDraft([{ kind: "mentionName", offset: 0, length: 4, userId: "11" }]);
    const changed = { ...local, entities: [{ ...local.entities![0], ...change }] };
    expect(draftSignature(changed)).not.toBe(draftSignature(local));
  });
});

describe("attachment draft synchronization", () => {
  it.each(["pending", "settled", "snapshot"] as const)(
    "preserves attachments when a %s draft returns through the native mapper",
    state => {
      vi.useFakeTimers();
      const local = localDraft([{ kind: "mentionName", offset: 0, length: 4, userId: "11" }]);
      local.pending = state === "pending";
      const { controller, discardLocalAttachments, getDraft } = fixture(local);
      if (state === "pending") controller.expect(local.chatId, local);
      if (state === "snapshot") controller.replaceServerDrafts([serverEcho(local)], [local.chatId]);
      else expect(controller.acceptServerDraft(local.chatId, serverEcho(local))).toBe(true);
      expect(discardLocalAttachments).not.toHaveBeenCalled();
      expect(getDraft()).toMatchObject({ text: local.text, pending: false });
      controller.clear();
    },
  );

  it.each(["old caption", ""])("ignores stale draft %j without discarding attachments", text => {
    vi.useFakeTimers();
    const local = localDraft([{ kind: "mentionName", offset: 0, length: 4, userId: "11" }]);
    const { controller, discardLocalAttachments, getDraft } = fixture(local);
    controller.expect(local.chatId, local);
    expect(controller.acceptServerDraft(local.chatId, text ? { ...local, text, entities: [] } : undefined)).toBe(false);
    expect(getDraft()).toEqual(local);
    expect(discardLocalAttachments).not.toHaveBeenCalled();
    expect(controller.acceptServerDraft(local.chatId, serverEcho(local))).toBe(true);
    expect(discardLocalAttachments).not.toHaveBeenCalled();
    controller.clear();
  });
});
