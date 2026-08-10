import type {
  ChatAdminRightKey,
  ChatAdminRights,
  ChatManagementCapabilities,
  ChatEventLogFilters,
  ChatPermissionKey,
  ChatPermissions,
  ManagedChatType,
  ManagedMemberStatus,
} from "./types";

export const CHAT_PERMISSION_LABELS: Record<ChatPermissionKey, string> = {
  canSendBasicMessages: "发送文字",
  canSendAudios: "发送音乐",
  canSendDocuments: "发送文件",
  canSendPhotos: "发送照片",
  canSendVideos: "发送视频",
  canSendVideoNotes: "发送视频消息",
  canSendVoiceNotes: "发送语音消息",
  canSendPolls: "发送投票",
  canSendOtherMessages: "发送贴纸和 GIF",
  canAddLinkPreviews: "添加链接预览",
  canReactToMessages: "添加消息回应",
  canEditTag: "编辑成员标签",
  canChangeInfo: "修改群资料",
  canInviteUsers: "邀请成员",
  canPinMessages: "置顶消息",
  canCreateTopics: "创建话题",
};

export const CHAT_ADMIN_RIGHT_LABELS: Record<ChatAdminRightKey, string> = {
  canManageChat: "管理群组",
  canChangeInfo: "修改资料",
  canPostMessages: "发布消息",
  canEditMessages: "编辑消息",
  canDeleteMessages: "删除消息",
  canInviteUsers: "邀请成员",
  canRestrictMembers: "限制成员",
  canPinMessages: "置顶消息",
  canManageTopics: "管理话题",
  canPromoteMembers: "添加管理员",
  canManageVideoChats: "管理视频聊天",
  canPostStories: "发布故事",
  canEditStories: "编辑故事",
  canDeleteStories: "删除故事",
  canManageDirectMessages: "管理私信",
  canManageTags: "管理标签",
  isAnonymous: "匿名管理员",
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
