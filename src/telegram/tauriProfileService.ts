import {
  asTdObject,
  asTdObjects,
  mapTdFormattedText,
  mapTdMessageContent,
  mapTdUser,
  tdId,
  tdNumber,
  type TdObject,
} from "./tdlibMapper";
import { numericId } from "./tdlibRequests";
import { resolveTdlibDataCenter } from "./fileDataCenter";
import type {
  Chat,
  ChatProfile,
  ChatProfileMembersPage,
  ProfileAudio,
  ProfilePhoto,
  UpdateCurrentUserProfileInput,
  User,
} from "./types";

export const PROFILE_MEMBER_PAGE_SIZE = 50;
export const PROFILE_ADMIN_PAGE_SIZE = 200;
export const PROFILE_COMMON_GROUP_LIMIT = 100;
export const PROFILE_PHOTO_LIMIT = 100;
export const PROFILE_AUDIO_LIMIT = 100;

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
    const [full, dataCenter, groupsInCommon, profilePhotos, profileAudioPage] = await Promise.all([
      this.context.request({ "@type": "getUserFullInfo", user_id: numericId(userId) }),
      this.loadDataCenter(this.context.rawUsers.get(userId)),
      kind === "user"
        ? this.loadGroupsInCommon(userId).catch(() => [])
        : Promise.resolve([]),
      this.loadUserProfilePhotos(userId, user?.displayName ?? "用户").catch(() => []),
      this.loadUserProfileAudios(userId).catch(() => ({ totalCount: 0, audios: [] })),
    ]);
    if (!user) throw new Error("TDLib 未返回用户资料");
    const bio = mapTdFormattedText(full.bio);
    return {
      id: `user:${user.id}`,
      kind,
      userId: user.id,
      title: user.displayName,
      avatar: user.avatar,
      statusLabel: user.presence === "online" ? "在线" : user.lastSeenLabel ?? "离线",
      bio: bio.text || undefined,
      bioEntities: bio.entities,
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      phoneNumber: user.phoneNumber,
      dataCenterId: dataCenter.id,
      dataCenterLocation: dataCenter.location,
      members: [],
      canViewMembers: false,
      groupInCommonCount: tdNumber(full.group_in_common_count),
      groupsInCommon,
      profilePhotos,
      profileAudioCount: profileAudioPage.totalCount,
      profileAudios: profileAudioPage.audios,
    };
  }

  private async loadGroupsInCommon(userId: string): Promise<Chat[]> {
    const result = await this.context.request({
      "@type": "getGroupsInCommon",
      user_id: numericId(userId),
      offset_chat_id: 0,
      limit: PROFILE_COMMON_GROUP_LIMIT,
    });
    const chatIds = Array.isArray(result.chat_ids)
      ? result.chat_ids.map(tdId).filter(Boolean)
      : [];
    const chats = await Promise.all(chatIds.map(async (chatId) => {
      try {
        const raw = this.context.rawChats.get(chatId) ?? await this.context.request({
          "@type": "getChat",
          chat_id: numericId(chatId),
        });
        this.context.upsertChat(raw);
        return this.context.mapChat(raw);
      } catch {
        return undefined;
      }
    }));
    return chats.filter((chat): chat is Chat => chat?.kind === "group");
  }

  private async loadUserProfilePhotos(userId: string, displayName: string): Promise<ProfilePhoto[]> {
    const result = await this.context.request({
      "@type": "getUserProfilePhotos",
      user_id: numericId(userId),
      offset: 0,
      limit: PROFILE_PHOTO_LIMIT,
    });
    return asTdObjects(result.photos).flatMap((photo, index) => {
      const mapped = mapTdMessageContent({
        "@type": "messagePhoto",
        photo,
        caption: { "@type": "formattedText", text: "", entities: [] },
        has_spoiler: false,
      });
      if (mapped.kind !== "media" || mapped.mediaType !== "photo") return [];
      const addedAtSeconds = tdNumber(photo.added_date);
      const addedAt = addedAtSeconds && addedAtSeconds > 0
        ? new Date(addedAtSeconds * 1_000).toISOString()
        : undefined;
      const id = tdId(photo.id) || `${mapped.fileId ?? "photo"}:${index}`;
      return [{
        id,
        addedAt,
        content: {
          ...mapped,
          kind: "media" as const,
          mediaType: "photo" as const,
          fileName: index === 0
            ? `${displayName} 的当前头像.jpg`
            : `${displayName} 的历史头像 ${index}.jpg`,
          caption: index === 0 ? "当前头像" : "历史头像",
        },
      }];
    });
  }

  private async loadUserProfileAudios(userId: string): Promise<{
    totalCount: number;
    audios: ProfileAudio[];
  }> {
    const result = await this.context.request({
      "@type": "getUserProfileAudios",
      user_id: numericId(userId),
      offset: 0,
      limit: PROFILE_AUDIO_LIMIT,
    });
    const audios = asTdObjects(result.audios).flatMap((audio, index) => {
      const mapped = mapTdMessageContent({
        "@type": "messageAudio",
        audio,
        caption: { "@type": "formattedText", text: "", entities: [] },
      });
      if (mapped.kind !== "media" || mapped.mediaType !== "audio") return [];
      const id = tdId(asTdObject(audio.audio)?.id) || `${mapped.fileId ?? "audio"}:${index}`;
      const title = typeof audio.title === "string" ? audio.title.trim() : "";
      const performer = typeof audio.performer === "string" ? audio.performer.trim() : "";
      return [{
        id,
        title: title || undefined,
        performer: performer || undefined,
        content: {
          ...mapped,
          kind: "media" as const,
          mediaType: "audio" as const,
        },
      }];
    });
    return {
      totalCount: Math.max(tdNumber(result.total_count) ?? audios.length, audios.length),
      audios,
    };
  }

  private async loadDataCenter(rawUser?: TdObject) {
    const profilePhoto = asTdObject(rawUser?.profile_photo);
    const remoteIds = [profilePhoto?.small, profilePhoto?.big].map((size) => {
      const remoteId = asTdObject(asTdObject(size)?.remote)?.id;
      return typeof remoteId === "string" ? remoteId : undefined;
    });
    return resolveTdlibDataCenter(remoteIds, this.context.request);
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
