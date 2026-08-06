import type {
  ChatAdminRightKey,
  ChatAdminRights,
  ChatEventLogFilters,
  ChatPermissionKey,
  ChatPermissions,
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
};

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
