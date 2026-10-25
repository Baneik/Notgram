import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../telegram/mockData";
import type { Message } from "../telegram/types";
import { messageSelectionDeleteScopes } from "./messageSelection";

const message = (id: string, self: boolean, all: boolean, extra: Partial<Message> = {}): Message => ({
  ...mockSnapshot.messages[0], id,
  permissions: { canReply: true, canEdit: false, canForward: false, canDeleteOnlyForSelf: self, canDeleteForAllUsers: all },
  ...extra,
});

describe("message selection deletion scopes", () => {
  it("uses message capabilities independently of sender and forwarding permission", () => {
    const own = message("own", false, true, { outgoing: true });
    const member = message("member", false, true, { outgoing: false });
    const local = message("local", true, false);
    const both = message("both", true, true);
    const none = message("none", false, false);
    const scopes = messageSelectionDeleteScopes([own, member, local, both, none]);
    expect(scopes.self).toEqual([local, both]);
    expect(scopes.all).toEqual([own, member, both]);
  });

  it("treats archived copies as local and excludes removing and unresolved messages", () => {
    const archived = message("archived", false, true, { isLocallyDeleted: true });
    const scopes = messageSelectionDeleteScopes([
      archived, message("removing", true, true, { isRemoving: true }),
      message("unknown", true, true, { permissions: undefined }),
    ]);
    expect(scopes.self).toEqual([archived]);
    expect(scopes.all).toEqual([]);
  });
});
