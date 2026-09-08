import { translate } from "../i18n";
import type {
  Chat,
  ChatAdminRightKey,
  ChatAdminRights,
  ChatManagementCapabilities,
  ChatEventLogFilters,
  ChatPermissionKey,
  ChatPermissions,
  ManagedChatType,
  ManagedMemberStatus,
} from "./types";
import { identityTextField } from "./identityText";

export const canPostToChannel = (chat?: Pick<Chat, "kind" | "management">) =>
  chat?.kind === "channel" && (chat.management?.status === "owner" || (
    chat.management?.status === "administrator" && chat.management.adminRights?.canPostMessages === true
  ));

export const CHAT_PERMISSION_LABELS: Record<ChatPermissionKey, string> = {
  get canSendBasicMessages() { return translate("发送文字"); },
  get canSendAudios() { return translate("发送音乐"); },
  get canSendDocuments() { return translate("发送文件"); },
  get canSendPhotos() { return translate("发送照片"); },
  get canSendVideos() { return translate("发送视频"); },
  get canSendVideoNotes() { return translate("发送视频消息"); },
  get canSendVoiceNotes() { return translate("发送语音消息"); },
  get canSendPolls() { return translate("发送投票"); },
  get canSendOtherMessages() { return translate("发送贴纸和 GIF"); },
  get canAddLinkPreviews() { return translate("添加链接预览"); },
  get canReactToMessages() { return translate("添加消息回应"); },
  get canEditTag() { return translate("编辑成员标签"); },
  get canChangeInfo() { return translate("修改群资料"); },
  get canInviteUsers() { return translate("邀请成员"); },
  get canPinMessages() { return translate("置顶消息"); },
  get canCreateTopics() { return translate("创建话题"); },
};

export const CHAT_ADMIN_RIGHT_LABELS: Record<ChatAdminRightKey, string> = {
  get canManageChat() { return translate("管理群组"); },
  get canChangeInfo() { return translate("修改资料"); },
  get canPostMessages() { return translate("发布消息"); },
  get canEditMessages() { return translate("编辑消息"); },
  get canDeleteMessages() { return translate("删除消息"); },
  get canInviteUsers() { return translate("邀请成员"); },
  get canRestrictMembers() { return translate("限制成员"); },
  get canPinMessages() { return translate("置顶消息"); },
  get canManageTopics() { return translate("管理话题"); },
  get canPromoteMembers() { return translate("添加管理员"); },
  get canManageVideoChats() { return translate("管理视频聊天"); },
  get canPostStories() { return translate("发布故事"); },
  get canEditStories() { return translate("编辑故事"); },
  get canDeleteStories() { return translate("删除故事"); },
  get canManageDirectMessages() { return translate("管理私信"); },
  get canManageTags() { return translate("管理标签"); },
  get isAnonymous() { return translate("匿名管理员"); },
};

export const DEFAULT_CHAT_PERMISSIONS: ChatPermissions = {
  canSendBasicMessages: true,
  canSendAudios: true,
  canSendDocuments: true,
  canSendPhotos: true,
  canSendVideos: true,
  canSendVideoNotes: true,
  canSendVoiceNotes: true,
  canSendPolls: true,
  canSendOtherMessages: true,
  canAddLinkPreviews: true,
  canReactToMessages: true,
  canEditTag: false,
  canChangeInfo: false,
  canInviteUsers: true,
  canPinMessages: false,
  canCreateTopics: false,
};

export const DEFAULT_CHAT_ADMIN_RIGHTS: ChatAdminRights = {
  canManageChat: true,
  canChangeInfo: true,
  canPostMessages: true,
  canEditMessages: true,
  canDeleteMessages: true,
  canInviteUsers: true,
  canRestrictMembers: true,
  canPinMessages: true,
  canManageTopics: true,
  canPromoteMembers: false,
  canManageVideoChats: true,
  canPostStories: true,
  canEditStories: true,
  canDeleteStories: true,
  canManageDirectMessages: true,
  canManageTags: true,
  isAnonymous: false,
};

export const CHAT_PERMISSION_FIELDS = [
  ["canSendBasicMessages", "can_send_basic_messages"],
  ["canSendAudios", "can_send_audios"],
  ["canSendDocuments", "can_send_documents"],
  ["canSendPhotos", "can_send_photos"],
  ["canSendVideos", "can_send_videos"],
  ["canSendVideoNotes", "can_send_video_notes"],
  ["canSendVoiceNotes", "can_send_voice_notes"],
  ["canSendPolls", "can_send_polls"],
  ["canSendOtherMessages", "can_send_other_messages"],
  ["canAddLinkPreviews", "can_add_link_previews"],
  ["canReactToMessages", "can_react_to_messages"],
  ["canEditTag", "can_edit_tag"],
  ["canChangeInfo", "can_change_info"],
  ["canInviteUsers", "can_invite_users"],
  ["canPinMessages", "can_pin_messages"],
  ["canCreateTopics", "can_create_topics"],
] as const;

export const CHAT_ADMIN_FIELDS = [
  ["canManageChat", "can_manage_chat"],
  ["canChangeInfo", "can_change_info"],
  ["canPostMessages", "can_post_messages"],
  ["canEditMessages", "can_edit_messages"],
  ["canDeleteMessages", "can_delete_messages"],
  ["canInviteUsers", "can_invite_users"],
  ["canRestrictMembers", "can_restrict_members"],
  ["canPinMessages", "can_pin_messages"],
  ["canManageTopics", "can_manage_topics"],
  ["canPromoteMembers", "can_promote_members"],
  ["canManageVideoChats", "can_manage_video_chats"],
  ["canPostStories", "can_post_stories"],
  ["canEditStories", "can_edit_stories"],
  ["canDeleteStories", "can_delete_stories"],
  ["canManageDirectMessages", "can_manage_direct_messages"],
  ["canManageTags", "can_manage_tags"],
  ["isAnonymous", "is_anonymous"],
] as const;

export const DEFAULT_EVENT_LOG_FILTERS: ChatEventLogFilters = {
  messageEdits: true,
  messageDeletions: true,
  messagePins: true,
  memberJoins: true,
  memberLeaves: true,
  memberInvites: true,
  memberPromotions: true,
  memberRestrictions: true,
  memberTagChanges: true,
  infoChanges: true,
  settingChanges: true,
  inviteLinkChanges: true,
  videoChatChanges: true,
  forumChanges: true,
  subscriptionExtensions: true,
};

export const cloneChatPermissions = (value: ChatPermissions): ChatPermissions => ({ ...value });
export const cloneChatAdminRights = (value: ChatAdminRights): ChatAdminRights => ({ ...value });

const CHAT_MEMBER_TAG_EMOJI = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\uFE0F\u20E3])/u;

export const chatMemberTagError = (value: string) => {
  const tag = value.trim();
  if (Array.from(tag).length > 16 || /[\r\n]/.test(value) || CHAT_MEMBER_TAG_EMOJI.test(tag)) {
    return translate("成员标签需要包含 0 至 16 个非表情字符且不能换行");
  }
  try {
    identityTextField(value, 16, translate("成员标签"));
  } catch {
    return translate("成员标签需要包含 0 至 16 个非表情字符且不能换行");
  }
  return undefined;
};

const tdObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export const mapChatPermissionsFromTd = (value: unknown): ChatPermissions => {
  const raw = tdObject(value);
  return Object.fromEntries(
    CHAT_PERMISSION_FIELDS.map(([key, field]) => [key, raw?.[field] === true]),
  ) as ChatPermissions;
};

export const mapChatAdminRightsFromTd = (value: unknown): ChatAdminRights => {
  const raw = tdObject(value);
  return Object.fromEntries(
    CHAT_ADMIN_FIELDS.map(([key, field]) => [key, raw?.[field] === true]),
  ) as ChatAdminRights;
};

export const managedMemberStatusFromTd = (value: unknown): ManagedMemberStatus => {
  switch (tdObject(value)?.["@type"]) {
    case "chatMemberStatusCreator": return "owner";
    case "chatMemberStatusAdministrator": return "administrator";
    case "chatMemberStatusRestricted": return "restricted";
    case "chatMemberStatusBanned": return "banned";
    case "chatMemberStatusLeft": return "left";
    default: return "member";
  }
};

export const deriveChatManagementCapabilities = (
  chatType: ManagedChatType,
  status: ManagedMemberStatus,
  adminRights?: ChatAdminRights,
): ChatManagementCapabilities => {
  const owner = status === "owner";
  const administrator = status === "administrator";
  const hasRight = (key: keyof ChatAdminRights) => owner || (administrator && adminRights?.[key] === true);
  const canRestrictMembers = hasRight("canRestrictMembers");

  return {
    chatType,
    status,
    ...(administrator && adminRights ? { adminRights: cloneChatAdminRights(adminRights) } : {}),
    canOpenManagement: owner || administrator,
    canAddMembers: hasRight("canInviteUsers"),
    canPromoteMembers: hasRight("canPromoteMembers"),
    canRestrictMembers,
    canManagePermissions: chatType !== "channel" && canRestrictMembers,
    canManageSlowMode: chatType === "supergroup" && canRestrictMembers,
    canTransferOwnership: owner,
    canManageInvites: hasRight("canInviteUsers"),
    canManageAllInvites: owner,
    canViewEventLog: owner || (administrator && adminRights?.canManageChat === true),
    canChangeInfo: hasRight("canChangeInfo"),
    canManageTopics: chatType === "supergroup" && hasRight("canManageTopics"),
    canManageTags: chatType !== "channel" && hasRight("canManageTags"),
  };
};

export const deriveChatManagementCapabilitiesFromTd = (
  chatType: ManagedChatType,
  statusValue: unknown,
) => {
  const statusObject = tdObject(statusValue);
  const status = managedMemberStatusFromTd(statusObject);
  const adminRights = status === "administrator"
    ? mapChatAdminRightsFromTd(statusObject?.rights)
    : undefined;
  return deriveChatManagementCapabilities(chatType, status, adminRights);
};
