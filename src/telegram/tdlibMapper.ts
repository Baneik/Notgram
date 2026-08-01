import type { Chat, ChatFolder, Message, MessageContent, User } from "./types";

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
  mediaKind: "document" | "photo" | "video" | "audio" | "voice" | "animation" | "sticker",
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
  mediaKind,
  fileName,
  ...fileDetails(file),
  ...options,
});

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
      return fileContent("document", fileName, document?.document, {
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
      return fileContent("photo", "图片", largest?.photo, {
        caption: formattedText(content.caption) || undefined,
        thumbnailPath: localImagePath(smallest?.photo),
        width: tdNumber(largest?.width),
        height: tdNumber(largest?.height),
      });
    }
    case "messageVideo": {
      const video = asTdObject(content.video);
      return fileContent(
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
      return fileContent(
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
      return fileContent(
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
      return fileContent("voice", "语音消息", voice?.voice, {
        caption: formattedText(content.caption) || undefined,
        mimeType: typeof voice?.mime_type === "string" ? voice.mime_type : undefined,
      });
    }
    case "messageVideoNote":
      return { kind: "text", text: "[视频消息]" };
    case "messageSticker":
      return { kind: "text", text: "[贴纸]" };
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

export const mapTdMessage = (raw: TdObject): Message | undefined => {
  const id = tdId(raw.id);
  const chatId = tdId(raw.chat_id);
  if (!id || !chatId) return undefined;

  const sender = asTdObject(raw.sender_id);
  const senderId =
    sender?.["@type"] === "messageSenderUser"
      ? tdId(sender.user_id)
      : sender?.["@type"] === "messageSenderChat"
        ? `chat:${tdId(sender.chat_id)}`
        : "unknown";
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
  folders.push({ id: "archive", title: "已归档", iconName: "Archive" });
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
    avatar: { label: initials(displayName), color: colorFor(id) },
    presence: online ? "online" : "offline",
    lastSeenLabel: lastSeen ? new Date(lastSeen * 1000).toLocaleString("zh-CN") : undefined,
  };
};
