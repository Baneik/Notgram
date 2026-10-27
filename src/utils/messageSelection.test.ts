import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../telegram/mockData";
import type { Message } from "../telegram/types";
import { addMessageSelectionGroups, messageSelectionDeleteScopes, messageSelectionGroups, toggleMessageSelectionGroup } from "./messageSelection";

const message = (id: string, self: boolean, all: boolean, extra: Partial<Message> = {}): Message => ({
  ...mockSnapshot.messages[0], id,
  permissions: { canReply: true, canEdit: false, canForward: false, canDeleteOnlyForSelf: self, canDeleteForAllUsers: all },
  ...extra,
});

describe("album selection", () => {
  const photo = (id: string, extra: Partial<Message> = {}): Message => message(id, true, true, {
    mediaAlbumId: "album", content: { kind: "media", mediaType: "photo", fileName: "photo.jpg", sizeLabel: "1 KB" }, ...extra,
  });

  it("keeps displayed albums atomic and excludes non-selectable rows", () => {
    const items = [message("before", true, true), photo("one"), photo("two"),
      message("notice", false, false, { content: { kind: "service", text: "Notice" } }),
      photo("removed", { isRemoving: true }), photo("other-chat", { chatId: "other" })];
    expect(messageSelectionGroups(items).map(group => group.map(item => item.id)))
      .toEqual([["before"], ["one", "two"], ["other-chat"]]);
  });

  it("retains independently rendered channel captions as separate selection groups", () => {
    const captioned = (id: string) => photo(id, { isChannelPost: true,
      content: { kind: "media", mediaType: "photo", fileName: "photo.jpg", sizeLabel: "1 KB", caption: id } });
    expect(messageSelectionGroups([captioned("one"), captioned("two")]).map(group => group.length)).toEqual([1, 1]);
  });

  it("completes a partially selected album before toggling the whole group off", () => {
    const album = [photo("one"), photo("two"), photo("three")];
    const complete = toggleMessageSelectionGroup(new Set(["before", "two"]), album);
    expect([...complete]).toEqual(["before", "two", "one", "three"]);
    expect([...toggleMessageSelectionGroup(complete, album)]).toEqual(["before"]);
  });

  it("does not partially select a range's last album at the 100-message limit", () => {
    const base = new Set(Array.from({ length: 98 }, (_, index) => `selected-${index}`));
    const album = [photo("one"), photo("two"), photo("three")];
    expect(addMessageSelectionGroups(base, [album])).toEqual(base);
    expect(toggleMessageSelectionGroup(base, album)).toEqual(base);
    base.delete("selected-0");
    const selected = addMessageSelectionGroups(base, [album]);
    expect(selected.size).toBe(100);
    expect(album.every(item => selected.has(item.id))).toBe(true);
    expect(addMessageSelectionGroups(selected, [album])).toEqual(selected);
  });
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
