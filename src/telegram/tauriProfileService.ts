import {
  asTdObject,
  asTdObjects,
  mapTdUser,
  tdId,
  tdNumber,
  type TdObject,
} from "./tdlibMapper";
import { numericId } from "./tdlibRequests";
import { parseTdlibRemoteFileDataCenter } from "./fileDataCenter";
import type {
  Chat,
  ChatProfile,
  ChatProfileMembersPage,
  UpdateCurrentUserProfileInput,
  User,
} from "./types";

export const PROFILE_MEMBER_PAGE_SIZE = 50;
export const PROFILE_ADMIN_PAGE_SIZE = 200;

export const profileField = (
  value: string,
  maximum: number,
  label: string,
  required = false,
) => {
  const normalized = value.trim();
  if ((required && !normalized) || [...normalized].length > maximum) {
    throw new Error(`${label}格式不正确`);
  }
  return normalized;
};

const DATA_CENTER_LOCATIONS: Record<number, string> = {
  1: "Miami, US",
  2: "Amsterdam, NL",
  3: "Miami, US",
  4: "Amsterdam, NL",
  5: "Singapore, SG",
};

const profileText = (value: unknown) => {
  const object = asTdObject(value);
  return typeof object?.text === "string" ? object.text.trim() : "";
};

const profileMemberRole = (value: unknown) => {
  switch (asTdObject(value)?.["@type"]) {
    case "chatMemberStatusCreator": return "owner" as const;
    case "chatMemberStatusAdministrator": return "administrator" as const;
    default: return "member" as const;
  }
};

export interface TauriProfileServiceContext {
  request: (request: TdObject) => Promise<TdObject>;
  rawChats: Map<string, TdObject>;
  rawUsers: Map<string, TdObject>;
  getCurrentUserId: () => string | undefined;
  setCurrentUserId: (userId: string | undefined) => void;
  upsertChat: (raw?: TdObject) => void;
  upsertUser: (raw?: TdObject) => void;
  mapChat: (raw: TdObject) => Chat | undefined;
  requestPreparedProfilePhoto: () => Promise<boolean>;
}

export class TauriProfileService {
  constructor(private readonly context: TauriProfileServiceContext) {}

  async getCurrentUserProfile(): Promise<ChatProfile> {
    let userId = this.context.getCurrentUserId();
    if (!userId) {
      const me = await this.context.request({ "@type": "getMe" });
      this.context.upsertUser(me);
      userId = tdId(me.id);
      this.context.setCurrentUserId(userId || undefined);
    }
    if (!userId) throw new Error("TDLib 未返回当前用户");
    return this.loadUserProfile(userId, "self");
  }

  async updateCurrentUserProfile(input: UpdateCurrentUserProfileInput): Promise<ChatProfile> {
    const firstName = profileField(input.firstName, 64, "名字", true);
    const lastName = profileField(input.lastName, 64, "姓氏");
    const username = profileField(input.username, 32, "用户名");
    const bio = profileField(input.bio, 140, "签名");
    if (username && (!/^[A-Za-z0-9_]+$/.test(username) || username.length < 5)) {
      throw new Error("用户名需包含 5 至 32 个英文字母、数字或下划线");
    }

    await this.context.request({ "@type": "setName", first_name: firstName, last_name: lastName });
    await this.context.request({ "@type": "setBio", bio });
    await this.context.request({ "@type": "setUsername", username });
    const me = await this.context.request({ "@type": "getMe" });
    this.context.upsertUser(me);
    const userId = tdId(me.id) || this.context.getCurrentUserId();
    if (!userId) throw new Error("TDLib 未返回当前用户");
    this.context.setCurrentUserId(userId);
    return this.loadUserProfile(userId, "self");
  }

  async setCurrentUserAvatar(file?: File): Promise<ChatProfile | undefined> {
    void file;
    if (!await this.context.requestPreparedProfilePhoto()) return undefined;
    const me = await this.context.request({ "@type": "getMe" });
    this.context.upsertUser(me);
    const userId = tdId(me.id) || this.context.getCurrentUserId();
    if (!userId) throw new Error("TDLib 未返回当前用户");
    this.context.setCurrentUserId(userId);
    return this.loadUserProfile(userId, "self");
  }

  async getChatProfile(chatId: string): Promise<ChatProfile> {
    const rawChat = this.context.rawChats.get(chatId) ?? await this.context.request({
      "@type": "getChat",
      chat_id: numericId(chatId),
    });
    this.context.upsertChat(rawChat);
    const chat = this.context.mapChat(rawChat);
    if (!chat) throw new Error("TDLib 未返回聊天资料");
    const type = asTdObject(rawChat.type);
    if (type?.["@type"] === "chatTypePrivate") {
      const userId = tdId(type.user_id);
      if (!userId) throw new Error("聊天缺少用户标识");
      const profile = await this.loadUserProfile(
        userId,
        userId === this.context.getCurrentUserId() ? "self" : "user",
      );
      return { ...profile, chatId: chat.id };
    }
    if (type?.["@type"] === "chatTypeSecret") {
      const secret = await this.context.request({
        "@type": "getSecretChat",
        secret_chat_id: numericId(tdId(type.secret_chat_id)),
      });
      const userId = tdId(secret.user_id);
      if (!userId) throw new Error("秘密聊天缺少用户标识");
      return { ...await this.loadUserProfile(userId, "user"), chatId: chat.id };
    }
    if (type?.["@type"] === "chatTypeBasicGroup") {
      const full = await this.context.request({
        "@type": "getBasicGroupFullInfo",
        basic_group_id: numericId(tdId(type.basic_group_id)),
      });
      const members = await this.loadProfileMembers(asTdObjects(full.members));
      return {
        id: `chat:${chat.id}`,
        kind: "group",
        chatId: chat.id,
        title: chat.title,
        avatar: chat.avatar,
        statusLabel: `${members.length} 位成员`,
        bio: typeof full.description === "string" && full.description.trim()
          ? full.description.trim()
          : undefined,
        memberCount: members.length,
        members,
        canViewMembers: true,
        memberOffset: members.length,
        memberHasMore: false,
      };
    }
    if (type?.["@type"] === "chatTypeSupergroup") {
      const supergroupId = tdId(type.supergroup_id);
      const full = await this.context.request({
        "@type": "getSupergroupFullInfo",
        supergroup_id: numericId(supergroupId),
      });
      const canViewMembers = full.can_get_members === true;
      const [administratorResult, memberResult] = canViewMembers
        ? await Promise.all([
            this.context.request({
              "@type": "getSupergroupMembers",
              supergroup_id: numericId(supergroupId),
              filter: { "@type": "supergroupMembersFilterAdministrators" },
              offset: 0,
              limit: PROFILE_ADMIN_PAGE_SIZE,
            }).catch(() => undefined),
            this.context.request({
              "@type": "getSupergroupMembers",
              supergroup_id: numericId(supergroupId),
              filter: { "@type": "supergroupMembersFilterRecent" },
              offset: 0,
              limit: PROFILE_MEMBER_PAGE_SIZE,
            }).catch(() => undefined),
          ])
        : [undefined, undefined];
      const recentValues = asTdObjects(memberResult?.members);
      const members = await this.loadProfileMembers([
        ...asTdObjects(administratorResult?.members),
        ...recentValues,
      ]);
      const memberCount = tdNumber(full.member_count);
      const isChannel = type.is_channel === true;
      return {
        id: `chat:${chat.id}`,
        kind: isChannel ? "channel" : "group",
        chatId: chat.id,
        title: chat.title,
        avatar: chat.avatar,
        statusLabel: memberCount
          ? `${memberCount.toLocaleString("zh-CN")} 位${isChannel ? "订阅者" : "成员"}`
          : isChannel ? "频道" : "群组",
        bio: typeof full.description === "string" && full.description.trim()
          ? full.description.trim()
          : undefined,
        memberCount,
        members,
        canViewMembers,
        memberOffset: recentValues.length,
        memberHasMore: recentValues.length === PROFILE_MEMBER_PAGE_SIZE &&
          (memberCount === undefined || recentValues.length < memberCount),
      };
    }
    throw new Error("暂不支持此聊天资料类型");
  }

  async getChatProfileMembers(
    chatId: string,
    offset: number,
    limit = PROFILE_MEMBER_PAGE_SIZE,
  ): Promise<ChatProfileMembersPage> {
    const rawChat = this.context.rawChats.get(chatId) ?? await this.context.request({
      "@type": "getChat",
      chat_id: numericId(chatId),
    });
    this.context.upsertChat(rawChat);
    const type = asTdObject(rawChat.type);
    if (type?.["@type"] !== "chatTypeSupergroup") {
      return { members: [], offset: Math.max(0, offset), hasMore: false };
    }
    const pageOffset = Math.max(0, offset);
    const pageLimit = Math.min(Math.max(1, limit), 200);
    const result = await this.context.request({
      "@type": "getSupergroupMembers",
      supergroup_id: numericId(tdId(type.supergroup_id)),
      filter: { "@type": "supergroupMembersFilterRecent" },
      offset: pageOffset,
      limit: pageLimit,
    });
    const values = asTdObjects(result.members);
    return {
      members: await this.loadProfileMembers(values),
      offset: pageOffset + values.length,
      hasMore: values.length === pageLimit,
    };
  }

  async getUserProfile(userId: string): Promise<ChatProfile> {
    return this.loadUserProfile(
      userId,
      userId === this.context.getCurrentUserId() ? "self" : "user",
    );
  }

  async getContacts(): Promise<User[]> {
    const result = await this.context.request({ "@type": "getContacts" });
    const userIds = Array.isArray(result.user_ids)
      ? result.user_ids.map(tdId).filter(Boolean)
      : [];
    const users = await Promise.all(userIds.map((userId) => this.loadUser(userId)));
    return users.filter((user): user is User => Boolean(user))
      .sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
  }

  async loadUser(userId: string): Promise<User | undefined> {
    let raw = this.context.rawUsers.get(userId);
    if (!raw) {
      raw = await this.context.request({ "@type": "getUser", user_id: numericId(userId) });
      this.context.upsertUser(raw);
    }
    return mapTdUser(raw);
  }

  private async loadUserProfile(userId: string, kind: "self" | "user"): Promise<ChatProfile> {
    const user = await this.loadUser(userId);
    const [full, dataCenter] = await Promise.all([
      this.context.request({ "@type": "getUserFullInfo", user_id: numericId(userId) }),
      this.loadDataCenter(this.context.rawUsers.get(userId)),
    ]);
    if (!user) throw new Error("TDLib 未返回用户资料");
    const bio = profileText(full.bio);
    return {
      id: `user:${user.id}`,
      kind,
      userId: user.id,
      title: user.displayName,
      avatar: user.avatar,
      statusLabel: user.presence === "online" ? "在线" : user.lastSeenLabel ?? "离线",
      bio: bio || undefined,
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      phoneNumber: user.phoneNumber,
      dataCenterId: dataCenter.id,
      dataCenterLocation: dataCenter.location,
      members: [],
      canViewMembers: false,
      groupInCommonCount: tdNumber(full.group_in_common_count),
    };
  }

  private async loadDataCenter(rawUser?: TdObject) {
    const profilePhoto = asTdObject(rawUser?.profile_photo);
    for (const size of [profilePhoto?.small, profilePhoto?.big]) {
      const remoteId = asTdObject(asTdObject(size)?.remote)?.id;
      if (typeof remoteId !== "string") continue;
      const id = parseTdlibRemoteFileDataCenter(remoteId);
      if (id) return { id, location: DATA_CENTER_LOCATIONS[id] ?? "Telegram 数据中心" };
    }
    try {
      const option = await this.context.request({ "@type": "getOption", name: "dc_id" });
      const id = tdNumber(option.value);
      if (id !== undefined && id > 0) {
        return { id, location: DATA_CENTER_LOCATIONS[id] ?? "Telegram 数据中心" };
      }
    } catch {
      // TDLib builds may not expose the internal dc_id option.
    }
    return { id: undefined, location: "Telegram 自动选择" };
  }

  private async loadProfileMembers(values: TdObject[]) {
    const seen = new Set<string>();
    const details = values.flatMap((member) => {
      const sender = asTdObject(member.member_id);
      const userId = sender?.["@type"] === "messageSenderUser"
        ? tdId(sender.user_id)
        : "";
      if (!userId || seen.has(userId)) return [];
      seen.add(userId);
      return [{ userId, role: profileMemberRole(member.status) }];
    });
    const users = await Promise.all(details.map(({ userId }) => this.loadUser(userId)));
    return details.flatMap((detail, index) => {
      const user = users[index];
      return user ? [{ user, role: detail.role }] : [];
    });
  }
}
