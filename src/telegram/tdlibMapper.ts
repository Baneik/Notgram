import type {
  Chat,
  ChatDraft,
  ChatFolder,
  Message,
  MessageContent,
  MessageForwardInfo,
  MessageInteraction,
  MessageOrigin,
  MessagePermissions,
  MessageReaction,
  MessageReactionType,
  MessageReplyTarget,
  User,
} from "./types";

export type TdObject = Record<string, unknown>;

const avatarColors = [
  "#397a78",
  "#75579a",
  "#3f6e9d",
  "#b0604c",
  "#557a46",
  "#9a6b32",
];

export const asTdObject = (value: unknown): TdObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as TdObject)
    : undefined;

export const asTdObjects = (value: unknown): TdObject[] =>
  Array.isArray(value)
    ? value.map(asTdObject).filter((item): item is TdObject => Boolean(item))
    : [];

export const tdId = (value: unknown): string =>
  typeof value === "number" || typeof value === "string" ? String(value) : "";

export const tdNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const initials = (name: string) => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return Array.from(parts[0]).slice(0, 2).join("");
  return `${Array.from(parts[0])[0] ?? ""}${Array.from(parts.at(-1) ?? "")[0] ?? ""}`;
};

const colorFor = (id: string) => {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return avatarColors[Math.abs(hash) % avatarColors.length];
};

const unixDate = (value: unknown) => {
  const seconds = tdNumber(value) ?? 0;
  return new Date(seconds * 1000).toISOString();
};

const optionalUnixDate = (value: unknown) => {
  const seconds = tdNumber(value) ?? 0;
  return seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
};

const formattedText = (value: unknown) => {
  const object = asTdObject(value);
  return typeof object?.text === "string" ? object.text : "";
};

const localImagePath = (value: unknown) => {
  const file = asTdObject(value);
  const local = asTdObject(file?.local);
  return local?.is_downloading_completed === true && typeof local.path === "string" && local.path
    ? local.path
    : undefined;
};

const readableSize = (bytes: number) => {
  if (bytes <= 0) return "文件";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

const fileDetails = (value: unknown) => {
  const file = asTdObject(value);
  const local = asTdObject(file?.local);
  const remote = asTdObject(file?.remote);
  const size = tdNumber(file?.size) ?? tdNumber(file?.expected_size) ?? 0;
  const downloadedSize = tdNumber(local?.downloaded_size) ?? 0;
  const uploadedSize = tdNumber(remote?.uploaded_size) ?? 0;
  const transferredSize = Math.max(downloadedSize, uploadedSize);
  return {
    fileId: tdNumber(file?.id),
    size,
    sizeLabel: readableSize(size),
    localPath: localImagePath(file),
    canDownload: local?.can_be_downloaded === true,
    isDownloading: local?.is_downloading_active === true,
    isDownloaded: local?.is_downloading_completed === true,
    isUploading: remote?.is_uploading_active === true,
    downloadedSize,
    uploadedSize,
    progress: size > 0 && transferredSize > 0
      ? Math.min(1, transferredSize / size)
      : undefined,
  };
};

const thumbnailPath = (value: unknown) => {
  const thumbnail = asTdObject(value);
  return localImagePath(thumbnail?.file);
};

const fileContent = (
  fileName: string,
  file: unknown,
  options: {
    caption?: string;
    mimeType?: string;
    thumbnailPath?: string;
    width?: number;
    height?: number;
  } = {},
): MessageContent => ({
  kind: "file",
  fileName,
  ...fileDetails(file),
  ...options,
});

const mediaContent = (
  mediaType: "photo" | "video" | "videoNote" | "audio" | "voice" | "animation" | "sticker",
  fileName: string,
  file: unknown,
  options: {
    caption?: string;
    mimeType?: string;
    thumbnailPath?: string;
    previewDataUrl?: string;
    width?: number;
    height?: number;
  } = {},
): MessageContent => ({
  kind: "media",
  mediaType,
  fileName,
  ...fileDetails(file),
  ...options,
});

const minithumbnailDataUrl = (value: unknown) => {
  const minithumbnail = asTdObject(value);
  return typeof minithumbnail?.data === "string" && minithumbnail.data
    ? `data:image/jpeg;base64,${minithumbnail.data}`
    : undefined;
};

export const mapTdMessageContent = (value: unknown): MessageContent => {
  const content = asTdObject(value);
  switch (content?.["@type"]) {
    case "messageText":
      return { kind: "text", text: formattedText(content.text) };
    case "messageDocument": {
      const document = asTdObject(content.document);
      const caption = formattedText(content.caption);
      const fileName =
        typeof document?.file_name === "string" && document.file_name
          ? document.file_name
          : caption || "文档";
      return fileContent(fileName, document?.document, {
        caption: caption || undefined,
        mimeType: typeof document?.mime_type === "string" ? document.mime_type : undefined,
        thumbnailPath: thumbnailPath(document?.thumbnail),
      });
    }
    case "messagePhoto": {
      const photo = asTdObject(content.photo);
      const sizes = asTdObjects(photo?.sizes);
      const largest = sizes.reduce<TdObject | undefined>((best, candidate) => {
        const area = (tdNumber(candidate.width) ?? 0) * (tdNumber(candidate.height) ?? 0);
        const bestArea = (tdNumber(best?.width) ?? 0) * (tdNumber(best?.height) ?? 0);
        return area >= bestArea ? candidate : best;
      }, undefined);
      const smallest = sizes.reduce<TdObject | undefined>((best, candidate) => {
        const area = (tdNumber(candidate.width) ?? 0) * (tdNumber(candidate.height) ?? 0);
        const bestArea = (tdNumber(best?.width) ?? Number.POSITIVE_INFINITY) *
          (tdNumber(best?.height) ?? Number.POSITIVE_INFINITY);
        return area <= bestArea ? candidate : best;
      }, undefined);
      return mediaContent("photo", "图片", largest?.photo, {
        caption: formattedText(content.caption) || undefined,
        thumbnailPath: localImagePath(smallest?.photo),
        previewDataUrl: minithumbnailDataUrl(photo?.minithumbnail),
        width: tdNumber(largest?.width),
        height: tdNumber(largest?.height),
      });
    }
    case "messageVideo": {
      const video = asTdObject(content.video);
      return mediaContent(
        "video",
        typeof video?.file_name === "string" && video.file_name ? video.file_name : "视频",
        video?.video,
        {
          caption: formattedText(content.caption) || undefined,
          mimeType: typeof video?.mime_type === "string" ? video.mime_type : undefined,
          thumbnailPath: thumbnailPath(video?.thumbnail),
          width: tdNumber(video?.width),
          height: tdNumber(video?.height),
        },
      );
    }
    case "messageAnimation": {
      const animation = asTdObject(content.animation);
      return mediaContent(
        "animation",
        typeof animation?.file_name === "string" && animation.file_name ? animation.file_name : "动图",
        animation?.animation,
        {
          caption: formattedText(content.caption) || undefined,
          mimeType: typeof animation?.mime_type === "string" ? animation.mime_type : undefined,
          thumbnailPath: thumbnailPath(animation?.thumbnail),
          width: tdNumber(animation?.width),
          height: tdNumber(animation?.height),
        },
      );
    }
    case "messageAudio": {
      const audio = asTdObject(content.audio);
      return mediaContent(
        "audio",
        typeof audio?.file_name === "string" && audio.file_name ? audio.file_name : "音频",
        audio?.audio,
        {
          caption: formattedText(content.caption) || undefined,
          mimeType: typeof audio?.mime_type === "string" ? audio.mime_type : undefined,
          thumbnailPath: thumbnailPath(audio?.album_cover_thumbnail),
        },
      );
    }
    case "messageVoiceNote": {
      const voice = asTdObject(content.voice_note);
      return mediaContent("voice", "语音消息", voice?.voice, {
        caption: formattedText(content.caption) || undefined,
        mimeType: typeof voice?.mime_type === "string" ? voice.mime_type : undefined,
      });
    }
    case "messageVideoNote": {
      const videoNote = asTdObject(content.video_note);
      const length = tdNumber(videoNote?.length);
      return mediaContent("videoNote", "视频消息", videoNote?.video, {
        thumbnailPath: thumbnailPath(videoNote?.thumbnail),
        previewDataUrl: minithumbnailDataUrl(videoNote?.minithumbnail),
        width: length,
        height: length,
      });
    }
    case "messageSticker": {
      const sticker = asTdObject(content.sticker);
      const emoji = typeof sticker?.emoji === "string" ? sticker.emoji : "";
      return mediaContent("sticker", emoji || "贴纸", sticker?.sticker, {
        thumbnailPath: thumbnailPath(sticker?.thumbnail),
        width: tdNumber(sticker?.width),
        height: tdNumber(sticker?.height),
      });
    }
    case "messageContact":
      return { kind: "text", text: "[联系人]" };
    case "messageLocation":
    case "messageVenue":
      return { kind: "text", text: "[位置]" };
    case "messagePoll":
      return { kind: "text", text: "[投票]" };
    case "messageCall":
      return { kind: "text", text: "[通话]" };
    default:
      return { kind: "text", text: "[暂不支持的消息]" };
  }
};

export const messagePreview = (value: unknown) => {
  const content = mapTdMessageContent(asTdObject(value)?.content ?? value);
  return content.kind === "text" ? content.text : content.fileName;
};

const messageSenderId = (value: unknown) => {
  const sender = asTdObject(value);
  if (sender?.["@type"] === "messageSenderUser") return tdId(sender.user_id);
  if (sender?.["@type"] === "messageSenderChat") {
    const chatId = tdId(sender.chat_id);
    return chatId ? `chat:${chatId}` : "";
  }
  return "";
};

const mapTdMessageOrigin = (value: unknown): MessageOrigin | undefined => {
  const origin = asTdObject(value);
  switch (origin?.["@type"]) {
    case "messageOriginUser": {
      const userId = tdId(origin.sender_user_id);
      return userId ? { kind: "user", userId } : undefined;
    }
    case "messageOriginHiddenUser":
      return typeof origin.sender_name === "string" && origin.sender_name
        ? { kind: "hiddenUser", senderName: origin.sender_name }
        : undefined;
    case "messageOriginChat": {
      const chatId = tdId(origin.sender_chat_id);
      return chatId
        ? {
            kind: "chat",
            chatId,
            authorSignature: typeof origin.author_signature === "string" && origin.author_signature
              ? origin.author_signature
              : undefined,
          }
        : undefined;
    }
    case "messageOriginChannel": {
      const chatId = tdId(origin.chat_id);
      const messageId = tdId(origin.message_id);
      return chatId
        ? {
            kind: "channel",
            chatId,
            messageId: messageId && messageId !== "0" ? messageId : undefined,
            authorSignature: typeof origin.author_signature === "string" && origin.author_signature
              ? origin.author_signature
              : undefined,
          }
        : undefined;
    }
    default:
      return undefined;
  }
};

const mapTdReplyTarget = (value: unknown): MessageReplyTarget | undefined => {
  const reply = asTdObject(value);
  if (reply?.["@type"] === "messageReplyToStory") {
    const chatId = tdId(reply.story_poster_chat_id);
    const storyId = tdNumber(reply.story_id);
    return chatId && storyId !== undefined ? { kind: "story", chatId, storyId } : undefined;
  }
  if (reply?.["@type"] !== "messageReplyToMessage") return undefined;

  const chatId = tdId(reply.chat_id);
  const messageId = tdId(reply.message_id);
  const quote = formattedText(asTdObject(reply.quote)?.text).trim();
  const content = asTdObject(reply.content);
  return {
    kind: "message",
    chatId: chatId && chatId !== "0" ? chatId : undefined,
    messageId: messageId && messageId !== "0" ? messageId : undefined,
    quote: quote || undefined,
    origin: mapTdMessageOrigin(reply.origin),
    sentAt: optionalUnixDate(reply.origin_send_date),
    content: content ? mapTdMessageContent(content) : undefined,
  };
};

const mapTdForwardInfo = (value: unknown): MessageForwardInfo | undefined => {
  const forward = asTdObject(value);
  if (!forward) return undefined;
  const source = asTdObject(forward.source);
  const sourceChatId = tdId(source?.chat_id);
  const sourceMessageId = tdId(source?.message_id);
  const sourceSenderId = messageSenderId(source?.sender_id);
  return {
    origin: mapTdMessageOrigin(forward.origin),
    sentAt: optionalUnixDate(forward.date),
    source: source
      ? {
          chatId: sourceChatId && sourceChatId !== "0" ? sourceChatId : undefined,
          messageId: sourceMessageId && sourceMessageId !== "0" ? sourceMessageId : undefined,
          senderId: sourceSenderId || undefined,
          senderName: typeof source.sender_name === "string" && source.sender_name
            ? source.sender_name
            : undefined,
          sentAt: optionalUnixDate(source.date),
          outgoing: source.is_outgoing === true,
        }
      : undefined,
    publicServiceAnnouncementType:
      typeof forward.public_service_announcement_type === "string" &&
        forward.public_service_announcement_type
        ? forward.public_service_announcement_type
        : undefined,
  };
};

const mapTdReactionType = (value: unknown): MessageReactionType | undefined => {
  const reaction = asTdObject(value);
  switch (reaction?.["@type"]) {
    case "reactionTypeEmoji":
      return typeof reaction.emoji === "string" && reaction.emoji
        ? { kind: "emoji", emoji: reaction.emoji }
        : undefined;
    case "reactionTypeCustomEmoji": {
      const customEmojiId = tdId(reaction.custom_emoji_id);
      return customEmojiId ? { kind: "customEmoji", customEmojiId } : undefined;
    }
    case "reactionTypePaid":
      return { kind: "paid" };
    default:
      return undefined;
  }
};

const mapTdReaction = (value: unknown): MessageReaction | undefined => {
  const reaction = asTdObject(value);
  const type = mapTdReactionType(reaction?.type);
  if (!reaction || !type) return undefined;
  return {
    type,
    totalCount: Math.max(0, tdNumber(reaction.total_count) ?? 0),
    chosen: reaction.is_chosen === true,
    recentSenderIds: asTdObjects(reaction.recent_sender_ids)
      .map(messageSenderId)
      .filter(Boolean),
  };
};

const mapTdInteraction = (value: unknown): MessageInteraction | undefined => {
  const interaction = asTdObject(value);
  if (!interaction) return undefined;
  const replyInfo = asTdObject(interaction.reply_info);
  const reactions = asTdObjects(asTdObject(interaction.reactions)?.reactions)
    .map(mapTdReaction)
    .filter((reaction): reaction is MessageReaction => Boolean(reaction));
  return {
    viewCount: Math.max(0, tdNumber(interaction.view_count) ?? 0),
    forwardCount: Math.max(0, tdNumber(interaction.forward_count) ?? 0),
    replyCount: Math.max(0, tdNumber(replyInfo?.reply_count) ?? 0),
    reactions,
  };
};

export const mapTdMessageProperties = (raw: TdObject): MessagePermissions => ({
  canReply: raw.can_be_replied === true,
  canEdit: raw.can_be_edited === true,
  canDeleteOnlyForSelf: raw.can_be_deleted_only_for_self === true,
  canDeleteForAllUsers: raw.can_be_deleted_for_all_users === true,
  canForward: raw.can_be_forwarded === true,
});

export const mapTdMessage = (raw: TdObject): Message | undefined => {
  const id = tdId(raw.id);
  const chatId = tdId(raw.chat_id);
  if (!id || !chatId) return undefined;

  const senderId = messageSenderId(raw.sender_id) || "unknown";
  const sendingState = asTdObject(raw.sending_state);
  const failed = sendingState?.["@type"] === "messageSendingStateFailed";

  return {
    id,
    chatId,
    senderId,
    outgoing: raw.is_outgoing === true,
    sentAt: unixDate(raw.date),
    delivery: failed ? "failed" : sendingState ? "sending" : "sent",
    canRetry: failed && sendingState.can_retry === true,
    editedAt: optionalUnixDate(raw.edit_date),
    replyTo: mapTdReplyTarget(raw.reply_to),
    forwardInfo: mapTdForwardInfo(raw.forward_info),
    interaction: mapTdInteraction(raw.interaction_info),
    content: mapTdMessageContent(raw.content),
  };
};

export const tdChatListId = (value: unknown) => {
  const list = asTdObject(value);
  switch (list?.["@type"]) {
    case "chatListMain":
      return "main";
    case "chatListArchive":
      return "archive";
    case "chatListFolder": {
      const id = tdId(list.chat_folder_id);
      return id ? `folder:${id}` : "";
    }
    default:
      return "";
  }
};

const folderName = (value: unknown) => {
  const name = asTdObject(value);
  return formattedText(name?.text).trim();
};

export const mapTdChatFolders = (
  values: TdObject[],
  mainChatListPosition = 0,
): ChatFolder[] => {
  const custom = values.flatMap((value) => {
    const id = tdId(value.id);
    if (!id) return [];
    const icon = asTdObject(value.icon);
    return [{
      id: `folder:${id}`,
      title: folderName(value.name) || "聊天文件夹",
      iconName: typeof icon?.name === "string" ? icon.name : "Custom",
    }];
  });
  const folders: ChatFolder[] = [...custom];
  folders.splice(Math.min(Math.max(mainChatListPosition, 0), folders.length), 0, {
    id: "main",
    title: "全部聊天",
    iconName: "All",
  });
  return folders;
};

export const mapTdChat = (raw: TdObject, currentUserId?: string): Chat | undefined => {
  const id = tdId(raw.id);
  if (!id) return undefined;

  const type = asTdObject(raw.type);
  const peerId = type?.["@type"] === "chatTypePrivate" ? tdId(type.user_id) : undefined;
  const kind =
    peerId && peerId === currentUserId
      ? "saved"
      : type?.["@type"] === "chatTypePrivate" || type?.["@type"] === "chatTypeSecret"
        ? "direct"
        : type?.["@type"] === "chatTypeSupergroup" && type.is_channel === true
          ? "channel"
          : "group";
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title : "未命名会话";
  const positions = asTdObjects(raw.positions);
  const chatLists = asTdObjects(raw.chat_lists);
  const folderIds = new Set<string>();
  for (const position of positions) {
    if ((tdNumber(position.order) ?? 0) !== 0) {
      const folderId = tdChatListId(position.list);
      if (folderId) folderIds.add(folderId);
    }
  }
  for (const list of chatLists) {
    const folderId = tdChatListId(list);
    if (folderId) folderIds.add(folderId);
  }
  const lastMessage = asTdObject(raw.last_message);
  const notifications = asTdObject(raw.notification_settings);

  return {
    id,
    kind,
    folderIds: [...folderIds],
    title: kind === "saved" ? "收藏夹" : title,
    avatar: {
      label: kind === "saved" ? "我" : initials(title),
      color: colorFor(id),
      imagePath: localImagePath(asTdObject(raw.photo)?.small),
    },
    peerId,
    preview: lastMessage ? messagePreview(lastMessage) : "暂无消息",
    updatedAt: unixDate(lastMessage?.date),
    unreadCount: tdNumber(raw.unread_count) ?? 0,
    pinned: positions.some((position) => position.is_pinned === true),
    muted: (tdNumber(notifications?.mute_for) ?? 0) > 0,
  };
};

export const mapTdChatDraft = (
  chatIdValue: unknown,
  value: unknown,
): ChatDraft | undefined => {
  const chatId = tdId(chatIdValue);
  const draft = asTdObject(value);
  const content = asTdObject(draft?.content);
  if (!chatId || !draft || content?.["@type"] !== "draftMessageContentText") {
    return undefined;
  }
  const reply = asTdObject(draft.reply_to);
  const replyToMessageId = reply?.["@type"] === "inputMessageReplyToMessage"
    ? tdId(reply.message_id)
    : undefined;
  return {
    chatId,
    text: formattedText(content.text),
    replyToMessageId: replyToMessageId || undefined,
    updatedAt: unixDate(draft.date),
  };
};

export const mapTdUser = (raw: TdObject): User | undefined => {
  const id = tdId(raw.id);
  if (!id) return undefined;
  const firstName = typeof raw.first_name === "string" ? raw.first_name : "";
  const lastName = typeof raw.last_name === "string" ? raw.last_name : "";
  const displayName = `${firstName} ${lastName}`.trim() || "Telegram 用户";
  const status = asTdObject(raw.status);
  const online = status?.["@type"] === "userStatusOnline";
  const lastSeen = status?.["@type"] === "userStatusOffline" ? tdNumber(status.was_online) : undefined;

  return {
    id,
    displayName,
    avatar: {
      label: initials(displayName),
      color: colorFor(id),
      imagePath: localImagePath(asTdObject(raw.profile_photo)?.small),
    },
    presence: online ? "online" : "offline",
    lastSeenLabel: lastSeen ? new Date(lastSeen * 1000).toLocaleString("zh-CN") : undefined,
  };
};
