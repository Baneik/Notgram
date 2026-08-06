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
      throw new Error(`unexpected request: ${String(request["@type"])}`);
    };

    const profile = await transport.getUserProfile("12");

    expect(profile).toMatchObject({
      dataCenterId: 4,
      dataCenterLocation: "Amsterdam, NL",
    });
    expect(requests.map((request) => request["@type"]))
      .toEqual(["getUser", "getUserFullInfo"]);
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
});
