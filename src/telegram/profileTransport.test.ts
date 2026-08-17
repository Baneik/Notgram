import { describe, expect, it } from "vitest";
import { MockTelegramTransport } from "./mockTransport";
import { TauriTelegramTransport } from "./tauriTransport";
import type { TdObject } from "./tdlibMapper";

const rawUser = (id: number, name: string): TdObject => ({
  "@type": "user",
  id,
  first_name: name,
  last_name: "",
  status: { "@type": "userStatusOnline", expires: 1_900_000_000 },
});

const avatarRemoteId = (dcId: number) => {
  const serialized = new Uint8Array(24);
  const view = new DataView(serialized.buffer);
  view.setInt32(0, 3, true);
  view.setInt32(4, dcId, true);
  view.setBigInt64(8, 456n, true);
  const encoded: number[] = [];
  for (let index = 0; index < serialized.length; index += 1) {
    const value = serialized[index]!;
    encoded.push(value);
    if (value !== 0) continue;
    let count = 1;
    while (count < 250 && serialized[index + count] === 0) count += 1;
    encoded.push(count);
    index += count - 1;
  }
  return btoa(String.fromCharCode(...encoded, 42, 4))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

describe("profile transport", () => {
  it("exposes mock account, group, contacts, and a resolvable private chat", async () => {
    const transport = new MockTelegramTransport();
    const account = await transport.getCurrentUserProfile();
    const group = await transport.getChatProfile("chat-product");
    const contacts = await transport.getContacts();
    const privateChat = await transport.createPrivateChat("u-jules");

    expect(account).toMatchObject({ kind: "self", title: "林然" });
    expect(group).toMatchObject({ kind: "group", canViewMembers: true, memberCount: 4 });
    expect(group.members.map(({ role }) => role)).toEqual([
      "owner",
      "administrator",
      "member",
      "member",
    ]);
    expect(contacts.map(({ id }) => id)).toContain("u-jules");
    expect(privateChat).toMatchObject({ kind: "direct", peerId: "u-jules" });
  });

  it("creates mock groups and channels with their selected initial settings", async () => {
    const transport = new MockTelegramTransport();
    const group = await transport.createChat({
      kind: "supergroup",
      title: "桌面客户端协作",
      description: "Notgram 开发协作",
      memberUserIds: ["u-mia", "u-jules"],
      isPublic: true,
      username: "notgram_team",
      historyAvailable: true,
      permissionTemplate: "restricted",
    });
    const profile = await transport.getChatProfile(group.id);

    expect(group).toMatchObject({ kind: "group", title: "桌面客户端协作" });
    expect(profile).toMatchObject({
      kind: "group",
      bio: "Notgram 开发协作",
      username: "notgram_team",
      memberCount: 3,
    });
    expect(profile.members.map(({ user }) => user.id)).toEqual(["self", "u-mia", "u-jules"]);
  });

  it("loads current-user full info and remembers the resolved identity", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as {
      currentUserId?: string;
      request: (request: TdObject) => Promise<TdObject>;
    };
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getMe") return rawUser(11, "Ada");
      if (request["@type"] === "getUserFullInfo") {
        return {
          "@type": "userFullInfo",
          bio: { "@type": "formattedText", text: "Desktop client engineer", entities: [] },
          group_in_common_count: 3,
        };
      }
      return { "@type": "ok" };
    };

    const profile = await transport.getCurrentUserProfile();

    expect(profile).toMatchObject({
      kind: "self",
      userId: "11",
      title: "Ada",
      bio: "Desktop client engineer",
      groupInCommonCount: 3,
      dataCenterLocation: "Telegram 自动选择",
    });
    expect(internal.currentUserId).toBe("11");
    expect(requests.map((request) => request["@type"])).toEqual([
      "getMe",
      "getUserFullInfo",
      "getOption",
      "getUserProfilePhotos",
    ]);
  });

  it("derives a user's DC from the avatar remote file before using the option fallback", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as {
      request: (request: TdObject) => Promise<TdObject>;
    };
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getUser") {
        return {
          ...rawUser(12, "Lin"),
          profile_photo: {
            small: {
              "@type": "file",
              id: 44,
              remote: { "@type": "remoteFile", id: avatarRemoteId(4) },
              local: { "@type": "localFile", path: "" },
            },
          },
        };
      }
      if (request["@type"] === "getUserFullInfo") {
        return { "@type": "userFullInfo", group_in_common_count: 0 };
      }
      if (request["@type"] === "getGroupsInCommon") return { "@type": "chats", chat_ids: [] };
      if (request["@type"] === "getUserProfilePhotos") return { "@type": "chatPhotos", photos: [] };
      throw new Error(`unexpected request: ${String(request["@type"])}`);
    };

    const profile = await transport.getUserProfile("12");

    expect(profile).toMatchObject({
      dataCenterId: 4,
      dataCenterLocation: "Amsterdam, NL",
    });
    expect(requests.map((request) => request["@type"]))
      .toEqual(["getUser", "getUserFullInfo", "getGroupsInCommon", "getUserProfilePhotos"]);
  });

  it("loads concrete common groups and profile-photo history for a user", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as {
      request: (request: TdObject) => Promise<TdObject>;
    };
    const requests: TdObject[] = [];
    const file = (id: number, path: string): TdObject => ({
      "@type": "file",
      id,
      size: 120_000,
      local: {
        is_downloading_completed: true,
        is_downloading_active: false,
        can_be_downloaded: false,
        path,
      },
    });
    const rawPhoto = (id: number, path: string, addedDate: number): TdObject => ({
      "@type": "chatPhoto",
      id,
      added_date: addedDate,
      sizes: [
        { "@type": "photoSize", width: 160, height: 160, photo: file(id * 10, path) },
        { "@type": "photoSize", width: 640, height: 640, photo: file(id * 10 + 1, path) },
      ],
    });
    internal.request = async (request) => {
      requests.push(request);
      switch (request["@type"]) {
        case "getUser": return rawUser(12, "Lin");
        case "getUserFullInfo": return {
          "@type": "userFullInfo",
          bio: { "@type": "formattedText", text: "Design lead", entities: [] },
          group_in_common_count: 2,
        };
        case "getGroupsInCommon": return { "@type": "chats", chat_ids: [70, 71] };
        case "getUserProfilePhotos": return {
          "@type": "chatPhotos",
          photos: [
            rawPhoto(1, "C:\\avatars\\lin-current.jpg", 1_722_000_000),
            rawPhoto(2, "C:\\avatars\\lin-history.jpg", 1_710_000_000),
          ],
        };
        case "getChat": return {
          "@type": "chat",
          id: Number(request.chat_id),
          title: Number(request.chat_id) === 70 ? "Design Group" : "Product Group",
          type: { "@type": "chatTypeSupergroup", supergroup_id: Number(request.chat_id) + 1000, is_channel: false },
          member_count: 8,
          positions: [],
          unread_count: 0,
          notification_settings: { mute_for: 0 },
        };
        default: return { "@type": "ok" };
      }
    };

    const profile = await transport.getUserProfile("12");

    expect(profile.groupsInCommon?.map(({ title }) => title)).toEqual(["Design Group", "Product Group"]);
    expect(profile.profilePhotos?.map(({ content }) => content.fileName)).toEqual([
      "Lin 的当前头像.jpg",
      "Lin 的历史头像 1.jpg",
    ]);
    expect(profile.profilePhotos?.[0]?.content.localPath).toBe("C:\\avatars\\lin-current.jpg");
    expect(requests).toContainEqual(expect.objectContaining({
      "@type": "getGroupsInCommon",
      user_id: 12,
      offset_chat_id: 0,
      limit: 100,
    }));
    expect(requests).toContainEqual(expect.objectContaining({
      "@type": "getUserProfilePhotos",
      user_id: 12,
      offset: 0,
      limit: 100,
    }));
  });

  it("maps TDLib group members and resolves contacts and private chats on the server", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as {
      request: (request: TdObject) => Promise<TdObject>;
    };
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      switch (request["@type"]) {
        case "getChat":
          return {
            "@type": "chat",
            id: 70,
            title: "Design Group",
            type: { "@type": "chatTypeBasicGroup", basic_group_id: 700 },
            positions: [],
            unread_count: 0,
            notification_settings: { mute_for: 0 },
          };
        case "getBasicGroupFullInfo":
          return {
            "@type": "basicGroupFullInfo",
            description: "Design review",
            members: [
              {
                member_id: { "@type": "messageSenderUser", user_id: 11 },
                status: { "@type": "chatMemberStatusCreator" },
              },
              {
                member_id: { "@type": "messageSenderUser", user_id: 12 },
                status: { "@type": "chatMemberStatusMember" },
              },
            ],
          };
        case "getContacts":
          return { "@type": "users", user_ids: [12, 11] };
        case "getUser":
          return rawUser(Number(request.user_id), request.user_id === 11 ? "Ada" : "Lin");
        case "createPrivateChat":
          return {
            "@type": "chat",
            id: 80,
            title: "Ada",
            type: { "@type": "chatTypePrivate", user_id: 11 },
            positions: [],
            unread_count: 0,
            notification_settings: { mute_for: 0 },
          };
        default:
          return { "@type": "ok" };
      }
    };

    const profile = await transport.getChatProfile("70");
    const contacts = await transport.getContacts();
    const privateChat = await transport.createPrivateChat("11");

    expect(profile).toMatchObject({
      kind: "group",
      title: "Design Group",
      bio: "Design review",
      memberCount: 2,
    });
    expect(profile.members.map(({ user, role }) => [user.displayName, role])).toEqual([
      ["Ada", "owner"],
      ["Lin", "member"],
    ]);
    expect(contacts.map(({ displayName }) => displayName)).toEqual(["Ada", "Lin"]);
    expect(privateChat).toMatchObject({ id: "80", peerId: "11" });
    expect(requests.find((request) => request["@type"] === "createPrivateChat"))
      .toMatchObject({ user_id: 11, force: false });
  });

  it("maps a channel profile without requesting inaccessible members", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as {
      request: (request: TdObject) => Promise<TdObject>;
    };
    const requests: TdObject[] = [];
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getChat") {
        return {
          "@type": "chat",
          id: 90,
          title: "Release Notes",
          type: { "@type": "chatTypeSupergroup", supergroup_id: 900, is_channel: true },
          positions: [],
          unread_count: 0,
          notification_settings: { mute_for: 0 },
        };
      }
      if (request["@type"] === "getSupergroupFullInfo") {
        return {
          "@type": "supergroupFullInfo",
          description: "Desktop release announcements",
          member_count: 1_248,
          can_get_members: false,
        };
      }
      return { "@type": "ok" };
    };

    const profile = await transport.getChatProfile("90");

    expect(profile).toMatchObject({
      kind: "channel",
      memberCount: 1_248,
      canViewMembers: false,
      members: [],
    });
    expect(requests.some((request) => request["@type"] === "getSupergroupMembers"))
      .toBe(false);
  });

  it("loads supergroup administrators and recent members in pages", async () => {
    const transport = new TauriTelegramTransport();
    const internal = transport as unknown as {
      request: (request: TdObject) => Promise<TdObject>;
    };
    const requests: TdObject[] = [];
    const member = (userId: number, status: string): TdObject => ({
      "@type": "chatMember",
      member_id: { "@type": "messageSenderUser", user_id: userId },
      status: { "@type": status },
    });
    internal.request = async (request) => {
      requests.push(request);
      if (request["@type"] === "getChat") {
        return {
          "@type": "chat",
          id: 91,
          title: "Large Group",
          type: { "@type": "chatTypeSupergroup", supergroup_id: 901, is_channel: false },
          positions: [],
          unread_count: 0,
          notification_settings: { mute_for: 0 },
        };
      }
      if (request["@type"] === "getSupergroupFullInfo") {
        return {
          "@type": "supergroupFullInfo",
          description: "Paged members",
          member_count: 100_000,
          can_get_members: true,
        };
      }
      if (request["@type"] === "getSupergroupMembers") {
        const filter = (request.filter as TdObject | null)?.["@type"];
        if (filter === "supergroupMembersFilterAdministrators") {
          return { "@type": "chatMembers", members: [member(101, "chatMemberStatusCreator"), member(102, "chatMemberStatusAdministrator")] };
        }
        if (request.offset === 0) {
          return {
            "@type": "chatMembers",
            members: [
              member(102, "chatMemberStatusAdministrator"),
              ...Array.from({ length: 49 }, (_, index) => member(103 + index, "chatMemberStatusMember")),
            ],
          };
        }
        return { "@type": "chatMembers", members: [member(104, "chatMemberStatusMember")] };
      }
      if (request["@type"] === "getUser") {
        return rawUser(Number(request.user_id), `User ${request.user_id}`);
      }
      return { "@type": "ok" };
    };

    const profile = await transport.getChatProfile("91");
    expect(profile.members.slice(0, 3).map(({ user, role }) => [user.id, role])).toEqual([
      ["101", "owner"],
      ["102", "administrator"],
      ["103", "member"],
    ]);
    expect(profile.memberOffset).toBe(50);
    expect(profile.memberHasMore).toBe(true);
    expect(requests).toContainEqual(expect.objectContaining({
      "@type": "getSupergroupMembers",
      filter: { "@type": "supergroupMembersFilterAdministrators" },
      limit: 200,
    }));
    expect(requests).toContainEqual(expect.objectContaining({
      "@type": "getSupergroupMembers",
      filter: { "@type": "supergroupMembersFilterRecent" },
      offset: 0,
      limit: 50,
    }));

    const page = await transport.getChatProfileMembers("91", profile.memberOffset ?? 0);
    expect(page.members.map(({ user }) => user.id)).toEqual(["104"]);
    expect(page.offset).toBe(51);
    expect(page.hasMore).toBe(false);
  });
});
