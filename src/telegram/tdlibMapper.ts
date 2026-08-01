import type { Chat, Message, MessageContent, User } from "./types";

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

const readableSize = (bytes: number) => {
  if (bytes <= 0) return "文件";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

const nestedFileSize = (value: unknown, key: string) => {
  const media = asTdObject(value);
  const file = asTdObject(media?.[key]);
  return tdNumber(file?.size) ?? tdNumber(file?.expected_size) ?? 0;
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
      return {
        kind: "file",
        fileName,
        sizeLabel: readableSize(nestedFileSize(document, "document")),
      };
    }
    case "messagePhoto":
      return { kind: "text", text: formattedText(content.caption) || "[图片]" };
    case "messageVideo":
      return { kind: "text", text: formattedText(content.caption) || "[视频]" };
    case "messageAnimation":
      return { kind: "text", text: formattedText(content.caption) || "[动图]" };
    case "messageAudio":
      return { kind: "text", text: formattedText(content.caption) || "[音频]" };
    case "messageVoiceNote":
      return { kind: "text", text: formattedText(content.caption) || "[语音]" };
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

  return {
    id,
    chatId,
    senderId,
    outgoing: raw.is_outgoing === true,
    sentAt: unixDate(raw.date),
    delivery: asTdObject(raw.sending_state) ? "sending" : "sent",
    content: mapTdMessageContent(raw.content),
  };
};

const chatListType = (position: TdObject) => asTdObject(position.list)?.["@type"];

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
  const archived =
    positions.some((position) => chatListType(position) === "chatListArchive") ||
    chatLists.some((list) => list["@type"] === "chatListArchive");
  const lastMessage = asTdObject(raw.last_message);
  const notifications = asTdObject(raw.notification_settings);

  return {
    id,
    kind,
    folder: archived ? "archive" : "main",
    title: kind === "saved" ? "收藏夹" : title,
    avatar: { label: kind === "saved" ? "我" : initials(title), color: colorFor(id) },
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
