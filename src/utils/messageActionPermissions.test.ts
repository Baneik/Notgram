import { describe, expect, it, vi } from "vitest";
import type { Message, MessagePermissions } from "../telegram/types";
import { loadMessageActionPermissions } from "./messageActionPermissions";

const message = (id: string, editedAt?: string) => ({
  id,
  chatId: "chat-product",
  senderId: "u-self",
  outgoing: true,
  sentAt: "2026-08-01T10:00:00+08:00",
  delivery: "sent",
  editedAt,
  content: { kind: "text", text: id, entities: [] },
} satisfies Message);

const permissions: MessagePermissions = {
  canReply: true,
  canEdit: true,
  canDeleteOnlyForSelf: false,
  canDeleteForAllUsers: true,
  canForward: true,
};

describe("loadMessageActionPermissions", () => {
  it("retries when a live update replaces the requested message snapshot", async () => {
    const first = message("p-4");
    const refreshed = message("p-4", "2026-08-25T12:00:00+08:00");
    let current = first;
    const load = vi.fn()
      .mockImplementationOnce(async () => {
        current = refreshed;
        return undefined;
      })
      .mockResolvedValueOnce(permissions);

    await expect(loadMessageActionPermissions({
      chatId: first.chatId,
      messageId: first.id,
      initialMessage: first,
      getCurrentMessage: () => current,
      load,
    })).resolves.toEqual(permissions);
  });

  it("does not retry an ordinary failed permission request", async () => {
    const initial = message("p-4");
    const load = vi.fn().mockResolvedValue(undefined);

    await expect(loadMessageActionPermissions({
      chatId: initial.chatId,
      messageId: initial.id,
      initialMessage: initial,
      getCurrentMessage: () => initial,
      load,
    })).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("bounds retries when the target keeps being refreshed", async () => {
    const initial = message("p-4");
    let generation = 0;
    const load = vi.fn().mockResolvedValue(undefined);

    await expect(loadMessageActionPermissions({
      chatId: initial.chatId,
      messageId: initial.id,
      initialMessage: initial,
      getCurrentMessage: () => ({ ...initial, editedAt: String(++generation) }),
      load,
    })).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(3);
  });
});
