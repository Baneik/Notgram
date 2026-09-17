import { currentLanguage, translate } from "../i18n";
import type {
  Chat,
  ChatDraft,
  ChatFolder,
  ForumTopic,
  Message,
  MessageContent,
  MessageDateTimeFormatting,
  MessageForwardInfo,
  MessageInteraction,
  MessageInlineKeyboard,
  MessageInlineKeyboardButton,
  MessageOrigin,
  MessagePermissions,
  MessageReaction,
  MessageReactionSenderPage,
  MessageReactionType,
  MessageReplyTarget,
  MessageRichBlock,
  MessageRichCaption,
  MessageRichListItem,
  MessageRichMedia,
  MessageRichTableCell,
  MessageRichTextRun,
  MessageTextEntity,
  MessageTextEntityKind,
  ChatSponsoredMessages,
  SponsoredMessage,
  User,
} from "./types";
import { messagePreviewText } from "./messageContent";
import { deriveChatManagementCapabilitiesFromTd } from "./chatManagement";
import { parseTdlibRemoteFileDataCenter } from "./fileDataCenter";
import { sanitizeIdentityText } from "./identityText";
import { savedMessagesAvatar } from "./savedMessages";

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

export const serializeTdObject = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

export const tdId = (value: unknown): string =>
  typeof value === "number" || typeof value === "string" ? String(value) : "";

export const tdStickerSetId = (value: unknown): string | undefined => {
  const id = tdId(value);
  return id && id !== "0" ? id : undefined;
};

export const tdNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

// TDLib encodes group chat identifiers from their entity identifiers. Keeping
// this conversion here lets the migration path work even when the legacy chat
// is no longer returned by getChats after an upgrade.
const SUPERGROUP_CHAT_ID_OFFSET = 1_000_000_000_000;

export const chatIdFromBasicGroupId = (value: unknown): string | undefined => {
  const id = tdNumber(value);
  return id !== undefined && Number.isSafeInteger(id) && id > 0
    ? String(-id)
    : undefined;
};

export const chatIdFromSupergroupId = (value: unknown): string | undefined => {
  const id = tdNumber(value);
  return id !== undefined && Number.isSafeInteger(id) && id >= 0 && id <= Number.MAX_SAFE_INTEGER - SUPERGROUP_CHAT_ID_OFFSET
    ? String(-SUPERGROUP_CHAT_ID_OFFSET - id)
    : undefined;
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

const optionalIdentityText = (value: unknown, maximum: number) => (
  typeof value === "string"
    ? sanitizeIdentityText(value, "", maximum) || undefined
    : undefined
);

const dateTimePartPrecision = (value: unknown) => {
  switch (asTdObject(value)?.["@type"]) {
    case "dateTimePartPrecisionNone": return "none" as const;
    case "dateTimePartPrecisionShort": return "short" as const;
    case "dateTimePartPrecisionLong": return "long" as const;
    default: return undefined;
  }
};

const dateTimeFormatting = (value: TdObject): MessageDateTimeFormatting | undefined => {
  const unixTime = tdNumber(value.unix_time);
  if (unixTime === undefined) return undefined;
  const formatting = asTdObject(value.formatting_type);
  if (!formatting) return { unixTime, mode: "original" };
  if (formatting["@type"] === "dateTimeFormattingTypeRelative") {
    return { unixTime, mode: "relative" };
  }
  if (formatting["@type"] !== "dateTimeFormattingTypeAbsolute") {
    return { unixTime, mode: "original" };
  }
  return {
    unixTime,
    mode: "absolute",
    timePrecision: dateTimePartPrecision(formatting.time_precision),
    datePrecision: dateTimePartPrecision(formatting.date_precision),
    showDayOfWeek: formatting.show_day_of_week === true,
  };
};

const formattedTextDetails = (value: unknown) => {
  const object = asTdObject(value);
  const text = typeof object?.text === "string" ? object.text : "";
  const entities = asTdObjects(object?.entities).flatMap<MessageTextEntity>((entity) => {
    const offset = tdNumber(entity.offset);
    const length = tdNumber(entity.length);
    const type = asTdObject(entity.type);
    if (
      offset === undefined ||
      length === undefined ||
      offset < 0 ||
      length <= 0 ||
      offset + length > text.length
    ) return [];

    let kind: MessageTextEntityKind | undefined;
    switch (type?.["@type"]) {
      case "textEntityTypeBold": kind = "bold"; break;
      case "textEntityTypeItalic": kind = "italic"; break;
      case "textEntityTypeUnderline": kind = "underline"; break;
      case "textEntityTypeStrikethrough": kind = "strikethrough"; break;
      case "textEntityTypeSpoiler": kind = "spoiler"; break;
      case "textEntityTypeCustomEmoji": kind = "customEmoji"; break;
      case "textEntityTypeDateTime": kind = "dateTime"; break;
      case "textEntityTypeCode": kind = "code"; break;
      case "textEntityTypePre": kind = "pre"; break;
      case "textEntityTypePreCode": kind = "pre"; break;
      case "textEntityTypeBlockQuote":
      case "textEntityTypeExpandableBlockQuote": kind = "blockquote"; break;
      case "textEntityTypeHashtag": kind = "hashtag"; break;
      case "textEntityTypeMention": kind = "mention"; break;
      case "textEntityTypeMentionName": kind = "mentionName"; break;
      case "textEntityTypeUrl": kind = "url"; break;
      case "textEntityTypeTextUrl": kind = "textUrl"; break;
      case "textEntityTypeEmailAddress": kind = "email"; break;
      case "textEntityTypePhoneNumber": kind = "phone"; break;
      default: return [];
    }

    return [{
      offset,
      length,
      kind,
      href: kind === "textUrl" && typeof type.url === "string" ? type.url : undefined,
      language: kind === "pre" && typeof type.language === "string"
        ? type.language
        : undefined,
      customEmojiId: kind === "customEmoji"
        ? tdId(type.custom_emoji_id) || undefined
        : undefined,
      userId: kind === "mentionName" ? tdId(type.user_id) || undefined : undefined,
      dateTime: kind === "dateTime" ? dateTimeFormatting(type) : undefined,
    }];
  });
  return { text, entities };
};

export const mapTdFormattedText = (value: unknown) => {
  const { text, entities } = formattedTextDetails(value);
  return {
    text,
    entities: entities.length > 0 ? entities : undefined,
  };
};

const formattedText = (value: unknown) => formattedTextDetails(value).text;

const formattedCaption = (value: unknown) => {
  const { text, entities } = formattedTextDetails(value);
  return {
    caption: text || undefined,
    captionEntities: text && entities.length > 0 ? entities : undefined,
  };
};

const pollRestrictionReason = (value: unknown) => {
  switch (asTdObject(value)?.["@type"]) {
    case "pollVoteRestrictionReasonClosed": return translate("投票已结束");
    case "pollVoteRestrictionReasonYetUnsent": return translate("消息发送完成后才能投票");
    case "pollVoteRestrictionReasonScheduled": return translate("定时消息暂不能投票");
    case "pollVoteRestrictionReasonCountryRestricted": return translate("当前地区不能参与此投票");
    case "pollVoteRestrictionReasonMembershipRequired": return translate("加入群组满一天后才能投票");
    case "pollVoteRestrictionReasonOther": return translate("当前账号不能参与此投票");
    default: return undefined;
  }
};

export const tdLocalFilePath = (value: unknown, includePendingUpload = false) => {
  const file = asTdObject(value);
  const local = asTdObject(file?.local);
  return (local?.is_downloading_completed === true || includePendingUpload) && typeof local?.path === "string" && local.path
    ? local.path
    : undefined;
};

const avatarFile = (value: unknown) => {
  const file = asTdObject(value);
  const local = asTdObject(file?.local);
  return {
    imagePath: tdLocalFilePath(file),
    fileId: tdNumber(file?.id),
    canDownload: local?.can_be_downloaded === true,
    isDownloading: local?.is_downloading_active === true,
  };
};

const readableSize = (bytes: number) => {
  if (bytes <= 0) return translate("文件");
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

export const tdFileIsDownloading = (value: unknown) => {
  const file = asTdObject(value);
  const local = asTdObject(file?.local);
  return local?.is_downloading_completed !== true && (typeof file?.notgram_download_requested === "boolean"
    ? file.notgram_download_requested : local?.is_downloading_active === true);
};

export const fileDetails = (value: unknown, includePendingUpload = false) => {
  const file = asTdObject(value);
  const local = asTdObject(file?.local);
  const remote = asTdObject(file?.remote);
  const exactSize = tdNumber(file?.size) ?? 0;
  const expectedSize = tdNumber(file?.expected_size) ?? 0;
  const downloadCompleted = local?.is_downloading_completed === true;
  const size = exactSize > 0 ? exactSize : expectedSize;
  const downloadedSize = tdNumber(local?.downloaded_size) ?? 0;
  const uploadedSize = tdNumber(remote?.uploaded_size) ?? 0;
  const isUploading = remote?.is_uploading_active === true;
  const transferredSize = isUploading ? uploadedSize : downloadedSize;
  const remoteId = typeof remote?.id === "string" ? remote.id : undefined;
  return {
    fileId: tdNumber(file?.id),
    remoteId: remoteId || undefined,
    remoteUniqueId: typeof remote?.unique_id === "string" ? remote.unique_id || undefined : undefined,
    dataCenterId: remoteId ? parseTdlibRemoteFileDataCenter(remoteId) : undefined,
    size,
    sizeLabel: readableSize(size),
    localPath: tdLocalFilePath(file, includePendingUpload),
    canDownload: local?.can_be_downloaded === true,
    isDownloading: tdFileIsDownloading(file),
    isDownloaded: downloadCompleted || Boolean(tdLocalFilePath(file, includePendingUpload)),
    isUploading,
    downloadedSize,
    uploadedSize,
    progress: size > 0 && transferredSize > 0
      ? Math.min(downloadCompleted || (!local?.is_downloading_active && !isUploading) ? 1 : 0.99, transferredSize / size)
      : undefined,
  };
};

const thumbnailPath = (value: unknown) => {
  const thumbnail = asTdObject(value);
  return tdLocalFilePath(thumbnail?.file);
};

const thumbnailFileDetails = (value: unknown) => {
  const file = asTdObject(value);
  const local = asTdObject(file?.local);
  const remote = asTdObject(file?.remote);
  return {
    thumbnailPath: tdLocalFilePath(file),
    thumbnailFileId: tdNumber(file?.id),
    thumbnailRemoteId: typeof remote?.id === "string" ? remote.id || undefined : undefined,
    thumbnailRemoteUniqueId: typeof remote?.unique_id === "string" ? remote.unique_id || undefined : undefined,
    thumbnailCanDownload: local?.can_be_downloaded === true,
    thumbnailIsDownloading: local?.is_downloading_active === true,
  };
};

const thumbnailDetails = (value: unknown) =>
  thumbnailFileDetails(asTdObject(value)?.file);

const photoPreviewDetails = (value: unknown): {
  thumbnailPath?: string;
  thumbnailFileId?: number;
  thumbnailRemoteId?: string;
  thumbnailRemoteUniqueId?: string;
  thumbnailCanDownload?: boolean;
  thumbnailIsDownloading?: boolean;
  previewDataUrl?: string;
} => {
  const photo = asTdObject(value);
  if (!photo) return {};
  const sizes = asTdObjects(photo?.sizes);
  const smallest = sizes.reduce<TdObject | undefined>((best, candidate) => {
    const area = (tdNumber(candidate.width) ?? 0) * (tdNumber(candidate.height) ?? 0);
    const bestArea = (tdNumber(best?.width) ?? Number.POSITIVE_INFINITY) *
      (tdNumber(best?.height) ?? Number.POSITIVE_INFINITY);
    return area <= bestArea ? candidate : best;
  }, undefined);
  return {
    ...(smallest?.photo ? thumbnailFileDetails(asTdObject(smallest.photo)) : {}),
    previewDataUrl: minithumbnailDataUrl(photo?.minithumbnail),
  };
};

const mediaFileExtension = (mimeType: string | undefined, fallback: string) => {
  switch (mimeType?.split(";", 1)[0].trim().toLocaleLowerCase()) {
    case "video/webm": return "webm";
    case "video/quicktime": return "mov";
    case "video/x-matroska": return "mkv";
    case "video/x-msvideo": return "avi";
    case "video/mp4": return "mp4";
    default: return fallback;
  }
};

const downloadableMediaFileName = (
  value: unknown,
  fallbackLabel: string,
  file: unknown,
  mimeType: string | undefined,
  fallbackExtension: string,
) => {
  if (typeof value === "string" && value.trim()) {
    const fileName = value.trim();
    return /\.[^./\\]+$/.test(fileName)
      ? fileName
      : `${fileName}.${mediaFileExtension(mimeType, fallbackExtension)}`;
  }
  const fileId = tdNumber(asTdObject(file)?.id);
  const suffix = fileId === undefined ? "" : `_${fileId}`;
  return `${fallbackLabel}${suffix}.${mediaFileExtension(mimeType, fallbackExtension)}`;
};

export const tdStickerMimeType = (value: unknown) => {
  switch (asTdObject(value)?.["@type"]) {
    case "stickerFormatWebm":
      return "video/webm";
    case "stickerFormatTgs":
      return "application/x-tgsticker";
    case "stickerFormatWebp":
      return "image/webp";
    default:
      return undefined;
  }
};

const fileContent = (
  fileName: string,
  file: unknown,
  options: {
    caption?: string;
    captionEntities?: MessageTextEntity[];
    mimeType?: string;
    thumbnailPath?: string;
    thumbnailFileId?: number;
    thumbnailRemoteId?: string;
    thumbnailRemoteUniqueId?: string;
    thumbnailCanDownload?: boolean;
    thumbnailIsDownloading?: boolean;
    width?: number;
    height?: number;
    includePendingUpload?: boolean;
  } = {},
): MessageContent => {
  const { includePendingUpload = false, ...contentOptions } = options;
  return {
    kind: "file",
    fileName,
    ...fileDetails(file, includePendingUpload),
    ...contentOptions,
  };
};

const mediaContent = (
  mediaType: "photo" | "video" | "videoNote" | "audio" | "voice" | "animation" | "sticker",
  fileName: string,
  file: unknown,
  options: {
    caption?: string;
    captionEntities?: MessageTextEntity[];
    mimeType?: string;
    thumbnailPath?: string;
    thumbnailFileId?: number;
    thumbnailRemoteId?: string;
    thumbnailRemoteUniqueId?: string;
    thumbnailCanDownload?: boolean;
    thumbnailIsDownloading?: boolean;
    previewDataUrl?: string;
    width?: number;
    height?: number;
    duration?: number;
    supportsStreaming?: boolean;
    hasSpoiler?: boolean;
    showCaptionAboveMedia?: boolean;
    stickerSetId?: string;
    includePendingUpload?: boolean;
  } = {},
): MessageContent => {
  const { includePendingUpload = false, ...contentOptions } = options;
  return {
    kind: "media",
    mediaType,
    fileName,
    ...fileDetails(file, includePendingUpload),
    ...contentOptions,
  };
};

const DISPLAYABLE_IMAGE_DOCUMENT_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const DISPLAYABLE_IMAGE_DOCUMENT_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "jfif",
  "jpeg",
  "jpg",
  "png",
  "webp",
]);

const isDisplayableImageDocument = (fileName: string, mimeType?: string) => {
  const normalizedMimeType = mimeType?.trim().toLowerCase();
  const extension = fileName.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  if (normalizedMimeType === "image/svg+xml" || extension === "svg") return false;
  return (normalizedMimeType ? DISPLAYABLE_IMAGE_DOCUMENT_MIME_TYPES.has(normalizedMimeType) : false) ||
    (extension ? DISPLAYABLE_IMAGE_DOCUMENT_EXTENSIONS.has(extension) : false);
};

const minithumbnailDataUrl = (value: unknown) => {
  const minithumbnail = asTdObject(value);
  return typeof minithumbnail?.data === "string" && minithumbnail.data
    ? `data:image/jpeg;base64,${minithumbnail.data}`
    : undefined;
};

const serviceContent = (text: string, memberUserIds?: string[]): MessageContent => ({
  kind: "service",
  text,
  ...(memberUserIds ? { memberUserIds } : {}),
});

const unsupportedContent = (_value: unknown, type: string): MessageContent => ({
  kind: "unsupported",
  type,
  text: translate("收到新类型消息（{{value0}}）", { value0: type }),
});

type RichTextStyle = Omit<MessageRichTextRun, "text">;

const richDateTime = (richText: TdObject): MessageRichTextRun["dateTime"] =>
  dateTimeFormatting(richText);

const richTextRuns = (
  value: unknown,
  style: RichTextStyle = {},
  depth = 0,
): MessageRichTextRun[] => {
  if (depth > 24) return [];
  if (typeof value === "string") return value ? [{ text: value, ...style }] : [];
  const richText = asTdObject(value);
  if (!richText) return [];

  const nested = (nextStyle: RichTextStyle = style) =>
    richTextRuns(richText.text, nextStyle, depth + 1);
  const styled = (mark: RichTextStyle) => nested({ ...style, ...mark });

  switch (richText["@type"]) {
    case "richTextPlain":
      return typeof richText.text === "string" && richText.text
        ? [{ text: richText.text, ...style }]
        : [];
    case "richTexts":
      return Array.isArray(richText.texts)
        ? richText.texts.flatMap((item) => richTextRuns(item, style, depth + 1))
        : [];
    case "richTextBold": return styled({ bold: true });
    case "richTextItalic": return styled({ italic: true });
    case "richTextUnderline": return styled({ underline: true });
    case "richTextStrikethrough": return styled({ strikethrough: true });
    case "richTextSpoiler": return styled({ spoiler: true });
    case "richTextFixed": return styled({ code: true });
    case "richTextSubscript": return styled({ subscript: true });
    case "richTextSuperscript": return styled({ superscript: true });
    case "richTextMarked": return styled({ marked: true });
    case "richTextDateTime": return styled({ dateTime: richDateTime(richText) });
    case "richTextUrl":
      return styled(typeof richText.url === "string" ? { href: richText.url } : {});
    case "richTextReferenceLink":
      return styled(typeof richText.reference_name === "string"
        ? { linkTarget: { kind: "reference", name: richText.reference_name } }
        : {});
    case "richTextAnchorLink":
      return styled(typeof richText.anchor_name === "string"
        ? { linkTarget: { kind: "anchor", name: richText.anchor_name } }
        : {});
    case "richTextEmailAddress":
      return styled(typeof richText.email_address === "string"
        ? { href: `mailto:${richText.email_address}` }
        : {});
    case "richTextPhoneNumber":
      return styled(typeof richText.phone_number === "string"
        ? { href: `tel:${richText.phone_number}` }
        : {});
    case "richTextMention":
      return styled(typeof richText.username === "string" && richText.username
        ? { href: `tg://resolve?domain=${encodeURIComponent(richText.username)}` }
        : {});
    case "richTextMentionName": {
      const userId = tdId(richText.user_id);
      return styled(userId ? { href: `tg://user?id=${encodeURIComponent(userId)}` } : {});
    }
    case "richTextCustomEmoji":
      return typeof richText.alternative_text === "string" && richText.alternative_text
        ? [{
            text: richText.alternative_text,
            ...style,
            customEmojiId: tdId(richText.custom_emoji_id) || undefined,
          }]
        : [];
    case "richTextMathematicalExpression":
      return typeof richText.expression === "string" && richText.expression
        ? [{
            text: richText.expression,
            ...style,
            mathematicalExpression: richText.expression,
          }]
        : [];
    case "richTextDiff":
      return richTextRuns(richText.text, style, depth + 1);
    case "richTextReference":
      return styled(typeof richText.name === "string"
        ? { anchor: { kind: "reference", name: richText.name } }
        : {});
    case "richTextHashtag": return styled({ semantic: "hashtag" });
    case "richTextCashtag": return styled({ semantic: "cashtag" });
    case "richTextBankCardNumber": return styled({ semantic: "bankCard" });
    case "richTextBotCommand": return styled({ semantic: "botCommand" });
    case "richTextAnchor":
      return typeof richText.name === "string"
        ? [{ text: "", ...style, anchor: { kind: "anchor", name: richText.name } }]
        : [];
    case "richTextIcon":
      return [];
    default:
      if (richText.text !== undefined) return nested();
      if (typeof richText.alternative_text === "string") {
        return [{ text: richText.alternative_text, ...style }];
      }
      return [];
  }
};

const richRunsText = (runs: MessageRichTextRun[]) => runs.map(({ text }) => text).join("");

const captionRuns = (value: unknown) => {
  const caption = richCaption(value);
  if (!caption) return [];
  return caption.credit && caption.credit.length > 0
    ? [
        ...caption.text,
        ...(caption.text.length > 0 ? [{ text: " — " } as MessageRichTextRun] : []),
        ...caption.credit,
      ]
    : caption.text;
};

const richCaption = (value: unknown): MessageRichCaption | undefined => {
  const caption = asTdObject(value);
  if (!caption) return undefined;
  const text = richTextRuns(caption.text);
  const credit = richTextRuns(caption.credit);
  return text.length > 0 || credit.length > 0
    ? { text, credit: credit.length > 0 ? credit : undefined }
    : undefined;
};

const paragraph = (text: MessageRichTextRun[]): MessageRichBlock[] =>
  text.length > 0 ? [{ kind: "paragraph", text }] : [];

const pageBlockText = (block: TdObject, ...keys: string[]) => {
  for (const key of keys) {
    const runs = richTextRuns(block[key]);
    if (runs.length > 0) return runs;
  }
  return [];
};

const richMedia = (
  mediaType: MessageRichMedia["mediaType"],
  fileName: string,
  file: unknown,
  options: Partial<MessageRichMedia> = {},
): MessageRichMedia => ({
  mediaType,
  fileName,
  ...fileDetails(file),
  hasSpoiler: false,
  autoplay: false,
  loop: false,
  ...options,
});

const richPageMedia = (block: TdObject): MessageRichMedia => {
  switch (block["@type"]) {
    case "pageBlockAnimation": {
      const animation = asTdObject(block.animation);
      return richMedia(
        "animation",
        typeof animation?.file_name === "string" && animation.file_name
          ? animation.file_name
          : translate("动图"),
        animation?.animation,
        {
          mimeType: typeof animation?.mime_type === "string" ? animation.mime_type : undefined,
          ...thumbnailDetails(animation?.thumbnail),
          previewDataUrl: minithumbnailDataUrl(animation?.minithumbnail),
          width: tdNumber(animation?.width),
          height: tdNumber(animation?.height),
          duration: tdNumber(animation?.duration),
          hasSpoiler: block.has_spoiler === true,
          autoplay: block.need_autoplay === true,
          loop: true,
          caption: richCaption(block.caption),
        },
      );
    }
    case "pageBlockAudio": {
      const audio = asTdObject(block.audio);
      return richMedia(
        "audio",
        typeof audio?.file_name === "string" && audio.file_name ? audio.file_name : translate("音频"),
        audio?.audio,
        {
          mimeType: typeof audio?.mime_type === "string" ? audio.mime_type : undefined,
          ...thumbnailDetails(audio?.album_cover_thumbnail),
          duration: tdNumber(audio?.duration),
          caption: richCaption(block.caption),
        },
      );
    }
    case "pageBlockPhoto": {
      const photo = asTdObject(block.photo);
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
      const largestFileId = tdNumber(asTdObject(largest?.photo)?.id);
      const smallestFile = asTdObject(smallest?.photo);
      const preview = tdNumber(smallestFile?.id) !== largestFileId
        ? thumbnailFileDetails(smallestFile)
        : { thumbnailPath: tdLocalFilePath(smallestFile) };
      return richMedia("photo", translate("图片"), largest?.photo, {
        ...preview,
        previewDataUrl: minithumbnailDataUrl(photo?.minithumbnail),
        width: tdNumber(largest?.width),
        height: tdNumber(largest?.height),
        hasSpoiler: block.has_spoiler === true,
        caption: richCaption(block.caption),
        url: typeof block.url === "string" && block.url ? block.url : undefined,
      });
    }
    case "pageBlockVideo": {
      const video = asTdObject(block.video);
      return richMedia(
        "video",
        typeof video?.file_name === "string" && video.file_name ? video.file_name : translate("视频"),
        video?.video,
        {
          mimeType: typeof video?.mime_type === "string" ? video.mime_type : undefined,
          ...thumbnailDetails(video?.thumbnail),
          previewDataUrl: minithumbnailDataUrl(video?.minithumbnail),
          width: tdNumber(video?.width),
          height: tdNumber(video?.height),
          duration: tdNumber(video?.duration),
          supportsStreaming: typeof video?.supports_streaming === "boolean" ? video.supports_streaming : undefined,
          hasSpoiler: block.has_spoiler === true,
          autoplay: block.need_autoplay === true,
          loop: block.is_looped === true,
          caption: richCaption(block.caption),
        },
      );
    }
    case "pageBlockVoiceNote": {
      const voice = asTdObject(block.voice_note);
      return richMedia("voice", translate("语音消息"), voice?.voice, {
        mimeType: typeof voice?.mime_type === "string" ? voice.mime_type : undefined,
        duration: tdNumber(voice?.duration),
        caption: richCaption(block.caption),
      });
    }
    default:
      return richMedia("photo", translate("媒体"), undefined);
  }
};

const tableAlignment = (value: unknown): MessageRichTableCell["align"] => {
  switch (asTdObject(value)?.["@type"]) {
    case "pageBlockHorizontalAlignmentCenter": return "center";
    case "pageBlockHorizontalAlignmentRight": return "right";
    default: return "left";
  }
};

const tableVerticalAlignment = (value: unknown): MessageRichTableCell["valign"] => {
  switch (asTdObject(value)?.["@type"]) {
    case "pageBlockVerticalAlignmentMiddle": return "middle";
    case "pageBlockVerticalAlignmentBottom": return "bottom";
    default: return "top";
  }
};

const pageBlocks = (value: unknown, depth = 0): MessageRichBlock[] => {
  if (depth > 24) return [];
  return asTdObjects(value).flatMap((item) => pageBlock(item, depth));
};

const pageBlock = (block: TdObject, depth = 0): MessageRichBlock[] => {
  if (depth > 24) return [];
  const type = block["@type"];
  switch (type) {
    case "pageBlockTitle":
      return [{ kind: "heading", level: 1, text: pageBlockText(block, "title") }];
    case "pageBlockSubtitle":
      return [{ kind: "heading", level: 2, text: pageBlockText(block, "subtitle") }];
    case "pageBlockHeader":
      return [{ kind: "heading", level: 2, text: pageBlockText(block, "header") }];
    case "pageBlockSubheader":
      return [{ kind: "heading", level: 3, text: pageBlockText(block, "subheader") }];
    case "pageBlockSectionHeading": {
      const size = Math.min(6, Math.max(1, tdNumber(block.size) ?? 2));
      return [{
        kind: "heading",
        level: size as 1 | 2 | 3 | 4 | 5 | 6,
        text: pageBlockText(block, "text"),
      }];
    }
    case "pageBlockKicker":
      return [{ kind: "heading", level: 4, text: pageBlockText(block, "kicker") }];
    case "pageBlockParagraph":
      return paragraph(pageBlockText(block, "text"));
    case "pageBlockAuthorDate":
      return paragraph(pageBlockText(block, "author"));
    case "pageBlockFooter":
      return [{ kind: "footer", text: pageBlockText(block, "footer") }];
    case "pageBlockThinking":
      return [{ kind: "thinking", text: pageBlockText(block, "text") }];
    case "pageBlockPreformatted":
      return [{
        kind: "preformatted",
        text: pageBlockText(block, "text"),
        language: typeof block.language === "string" && block.language
          ? block.language
          : undefined,
      }];
    case "pageBlockMathematicalExpression":
      return typeof block.expression === "string" && block.expression
        ? [{ kind: "mathematicalExpression", expression: block.expression }]
        : [];
    case "pageBlockDivider":
      return [{ kind: "divider" }];
    case "pageBlockAnchor":
      return typeof block.name === "string" ? [{ kind: "anchor", name: block.name }] : [];
    case "pageBlockList": {
      const items = asTdObjects(block.items).map((item) => ({
        blocks: pageBlocks(item.blocks, depth + 1),
        label: typeof item.label === "string" && item.label ? item.label : undefined,
        hasCheckbox: item.has_checkbox === true,
        checked: item.is_checked === true,
        value: tdNumber(item.value),
        type: ["a", "A", "i", "I", "1"].includes(String(item.type))
          ? item.type as MessageRichListItem["type"]
          : undefined,
      }));
      const ordered = asTdObjects(block.items).some((item) =>
        typeof item.type === "string" && item.type.length > 0,
      );
      return items.length > 0 ? [{ kind: "list", ordered, items }] : [];
    }
    case "pageBlockBlockQuote":
      return [{
        kind: "quote",
        blocks: pageBlocks(block.blocks, depth + 1),
        credit: richTextRuns(block.credit),
        pull: false,
      }];
    case "pageBlockPullQuote": {
      const text = pageBlockText(block, "text");
      return [{
        kind: "quote",
        blocks: paragraph(text),
        credit: richTextRuns(block.credit),
        pull: true,
      }];
    }
    case "pageBlockDetails":
      return [{
        kind: "details",
        summary: pageBlockText(block, "header"),
        blocks: pageBlocks(block.blocks, depth + 1),
        open: block.is_open === true,
      }];
    case "pageBlockTable": {
      const rows = Array.isArray(block.cells)
        ? block.cells.map((row): MessageRichTableCell[] =>
            asTdObjects(row).map((cell) => ({
              text: richTextRuns(cell.text),
              header: cell.is_header === true,
              colspan: Math.max(1, tdNumber(cell.colspan) ?? 1),
              rowspan: Math.max(1, tdNumber(cell.rowspan) ?? 1),
              visible: asTdObject(cell.text) !== undefined,
              align: tableAlignment(cell.align),
              valign: tableVerticalAlignment(cell.valign),
            })))
        : [];
      return rows.length > 0 ? [{
        kind: "table",
        caption: richTextRuns(block.caption),
        rows,
        bordered: block.is_bordered === true,
        striped: block.is_striped === true,
      }] : [];
    }
    case "pageBlockCover":
      return pageBlock(asTdObject(block.cover) ?? {}, depth + 1);
    case "pageBlockEmbeddedPost":
      return [
        ...paragraph(typeof block.author === "string" ? [{ text: block.author, bold: true }] : []),
        ...pageBlocks(block.blocks, depth + 1),
        ...paragraph(captionRuns(block.caption)),
      ];
    case "pageBlockCollage":
    case "pageBlockSlideshow": {
      const blocks = pageBlocks(block.blocks, depth + 1);
      return blocks.length > 0 ? [{
        kind: "collection",
        layout: type === "pageBlockCollage" ? "collage" : "slideshow",
        blocks,
        caption: richCaption(block.caption),
      }] : paragraph(captionRuns(block.caption));
    }
    case "pageBlockAnimation":
    case "pageBlockAudio":
    case "pageBlockPhoto":
    case "pageBlockVideo":
    case "pageBlockVoiceNote":
      return [{ kind: "media", media: richPageMedia(block) }];
    case "pageBlockChatLink":
      return paragraph(typeof block.title === "string" ? [{ text: block.title }] : []);
    case "pageBlockRelatedArticles": {
      const header = pageBlockText(block, "header");
      const articles = asTdObjects(block.articles).flatMap((article) => {
        const title = typeof article.title === "string" ? article.title : "";
        const description = typeof article.description === "string" ? article.description : "";
        const text = [title, description].filter(Boolean).join(" — ");
        return paragraph(text ? [{ text, href: typeof article.url === "string" ? article.url : undefined }] : []);
      });
      return [...paragraph(header), ...articles];
    }
    case "pageBlockMap": {
      const location = asTdObject(block.location);
      const latitude = tdNumber(location?.latitude);
      const longitude = tdNumber(location?.longitude);
      if (latitude === undefined || longitude === undefined) {
        const caption = captionRuns(block.caption);
        return paragraph(caption.length > 0 ? caption : [{ text: translate("位置") }]);
      }
      return [{
        kind: "map",
        latitude,
        longitude,
        horizontalAccuracy: tdNumber(location?.horizontal_accuracy),
        zoom: tdNumber(block.zoom) ?? 13,
        width: tdNumber(block.width) ?? 0,
        height: tdNumber(block.height) ?? 0,
        caption: richCaption(block.caption),
      }];
    }
    case "pageBlockEmbedded": {
      const caption = captionRuns(block.caption);
      return paragraph(caption.length > 0
        ? caption
        : typeof block.url === "string" && block.url
          ? [{ text: block.url, href: block.url }]
          : []);
    }
    default: {
      const nestedBlocks = pageBlocks(block.blocks, depth + 1);
      if (nestedBlocks.length > 0) return nestedBlocks;
      const text = pageBlockText(
        block,
        "text",
        "title",
        "subtitle",
        "header",
        "subheader",
        "footer",
        "kicker",
      );
      if (text.length > 0) return paragraph(text);
      return paragraph(captionRuns(block.caption));
    }
  }
};

const richBlockText = (block: MessageRichBlock): string[] => {
  switch (block.kind) {
    case "heading":
    case "paragraph":
    case "preformatted":
    case "footer":
    case "thinking":
      return [richRunsText(block.text)];
    case "mathematicalExpression":
      return [block.expression];
    case "anchor":
      return [];
    case "list":
      return block.items.flatMap((item) => item.blocks.flatMap(richBlockText));
    case "quote":
      return [
        ...block.blocks.flatMap(richBlockText),
        ...(block.credit ? [richRunsText(block.credit)] : []),
      ];
    case "details":
      return [richRunsText(block.summary), ...block.blocks.flatMap(richBlockText)];
    case "table":
      return [
        ...(block.caption ? [richRunsText(block.caption)] : []),
        ...block.rows.flatMap((row) => row.map((cell) => richRunsText(cell.text))),
      ];
    case "media":
      return [
        ...(block.media.caption ? [richRunsText(block.media.caption.text)] : []),
        block.media.fileName,
      ];
    case "collection":
      return [
        ...block.blocks.flatMap(richBlockText),
        ...(block.caption ? [richRunsText(block.caption.text)] : []),
      ];
    case "map":
      return block.caption ? [richRunsText(block.caption.text)] : [translate("位置")];
    case "divider":
      return [];
  }
};

const richMessageContent = (value: unknown): MessageContent => {
  const message = asTdObject(asTdObject(value)?.message);
  let blocks = pageBlocks(message?.blocks);
  let text = blocks.flatMap(richBlockText).filter(Boolean).join("\n").trim();
  if (!text) text = translate("富文本消息");
  if (blocks.length === 0) blocks = paragraph([{ text }]);
  return {
    kind: "rich",
    blocks,
    text,
    isRtl: message?.is_rtl === true,
    isFull: message?.is_full === true,
  };
};

const textValue = (value: unknown) => {
  if (typeof value === "string") return value;
  return formattedText(value);
};

const labeledText = (label: string, detail: unknown) => {
  const text = textValue(detail).trim();
  return text ? `${label}：${text}` : label;
};

const durationText = (secondsValue: unknown) => {
  const seconds = tdNumber(secondsValue) ?? 0;
  if (seconds <= 0) return translate("已关闭消息自动删除");
  if (seconds % 86_400 === 0) return translate("消息将在 {{value0}} 天后自动删除", { value0: seconds / 86_400 });
  if (seconds % 3_600 === 0) return translate("消息将在 {{value0}} 小时后自动删除", { value0: seconds / 3_600 });
  if (seconds % 60 === 0) return translate("消息将在 {{value0}} 分钟后自动删除", { value0: seconds / 60 });
  return translate("消息将在 {{value0}} 秒后自动删除", { value0: seconds });
};

export const mapTdMessageContent = (value: unknown, includePendingUpload = false): MessageContent => {
  const content = asTdObject(value);
  switch (content?.["@type"]) {
    case "messageText": {
      const { text, entities } = formattedTextDetails(content.text);
      return { kind: "text", text, entities: entities.length > 0 ? entities : undefined };
    }
    case "messageRichMessage":
      return richMessageContent(content);
    case "messageDocument": {
      const document = asTdObject(content.document);
      const caption = formattedText(content.caption);
      const fileName =
        typeof document?.file_name === "string" && document.file_name
          ? document.file_name
          : caption || translate("文档");
      const mimeType = typeof document?.mime_type === "string" ? document.mime_type : undefined;
      const thumbnail = asTdObject(document?.thumbnail);
      const minithumbnail = asTdObject(document?.minithumbnail);
      const options = {
        ...formattedCaption(content.caption),
        mimeType,
        ...thumbnailDetails(document?.thumbnail),
        includePendingUpload,
      };
      if (isDisplayableImageDocument(fileName, mimeType)) {
        return mediaContent("photo", fileName, document?.document, {
          ...options,
          previewDataUrl: minithumbnailDataUrl(document?.minithumbnail),
          width: tdNumber(thumbnail?.width) ?? tdNumber(minithumbnail?.width),
          height: tdNumber(thumbnail?.height) ?? tdNumber(minithumbnail?.height),
        });
      }
      return fileContent(fileName, document?.document, options);
    }
    case "messagePhoto": {
      const photo = asTdObject(content.photo);
      const minithumbnail = asTdObject(photo?.minithumbnail);
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
      const largestFileId = tdNumber(asTdObject(largest?.photo)?.id);
      const smallestFile = asTdObject(smallest?.photo);
      const smallestFileId = tdNumber(smallestFile?.id);
      const previewDetails = smallestFileId !== undefined && smallestFileId !== largestFileId
        ? thumbnailFileDetails(smallestFile)
        : { thumbnailPath: tdLocalFilePath(smallestFile) };
      return mediaContent("photo", translate("图片"), largest?.photo, {
        ...formattedCaption(content.caption),
        ...previewDetails,
        previewDataUrl: minithumbnailDataUrl(photo?.minithumbnail),
        width: tdNumber(largest?.width) ?? tdNumber(minithumbnail?.width),
        height: tdNumber(largest?.height) ?? tdNumber(minithumbnail?.height),
        hasSpoiler: content.has_spoiler === true,
        showCaptionAboveMedia: content.show_caption_above_media === true,
        includePendingUpload,
      });
    }
    case "messageVideo": {
      const video = asTdObject(content.video);
      const cover = photoPreviewDetails(content.cover);
      const thumbnail = thumbnailDetails(video?.thumbnail);
      const mimeType = typeof video?.mime_type === "string" ? video.mime_type : undefined;
      return mediaContent(
        "video",
        downloadableMediaFileName(video?.file_name, translate("视频"), video?.video, mimeType, "mp4"),
        video?.video,
        {
          ...formattedCaption(content.caption),
          mimeType,
          thumbnailPath: cover.thumbnailPath ?? thumbnail.thumbnailPath,
          thumbnailFileId: cover.thumbnailFileId ?? thumbnail.thumbnailFileId,
          thumbnailRemoteId: cover.thumbnailFileId !== undefined ? cover.thumbnailRemoteId : thumbnail.thumbnailRemoteId,
          thumbnailRemoteUniqueId: cover.thumbnailFileId !== undefined ? cover.thumbnailRemoteUniqueId : thumbnail.thumbnailRemoteUniqueId,
          thumbnailCanDownload: cover.thumbnailCanDownload ?? thumbnail.thumbnailCanDownload,
          thumbnailIsDownloading: cover.thumbnailIsDownloading ?? thumbnail.thumbnailIsDownloading,
          previewDataUrl: cover.previewDataUrl ?? minithumbnailDataUrl(video?.minithumbnail),
          width: tdNumber(video?.width),
          height: tdNumber(video?.height),
          duration: tdNumber(video?.duration),
          supportsStreaming: typeof video?.supports_streaming === "boolean" ? video.supports_streaming : undefined,
          hasSpoiler: content.has_spoiler === true,
          showCaptionAboveMedia: content.show_caption_above_media === true,
          includePendingUpload,
        },
      );
    }
    case "messageAnimation": {
      const animation = asTdObject(content.animation);
      return mediaContent(
        "animation",
        typeof animation?.file_name === "string" && animation.file_name ? animation.file_name : translate("动图"),
        animation?.animation,
        {
          ...formattedCaption(content.caption),
          mimeType: typeof animation?.mime_type === "string" ? animation.mime_type : undefined,
          ...thumbnailDetails(animation?.thumbnail),
          previewDataUrl: minithumbnailDataUrl(animation?.minithumbnail),
          width: tdNumber(animation?.width),
          height: tdNumber(animation?.height),
          hasSpoiler: content.has_spoiler === true,
          showCaptionAboveMedia: content.show_caption_above_media === true,
          includePendingUpload,
        },
      );
    }
    case "messageAudio": {
      const audio = asTdObject(content.audio);
      return mediaContent(
        "audio",
        typeof audio?.file_name === "string" && audio.file_name ? audio.file_name : translate("音频"),
        audio?.audio,
        {
          ...formattedCaption(content.caption),
          mimeType: typeof audio?.mime_type === "string" ? audio.mime_type : undefined,
          thumbnailPath: thumbnailPath(audio?.album_cover_thumbnail),
          duration: tdNumber(audio?.duration),
          includePendingUpload,
        },
      );
    }
    case "messageVoiceNote": {
      const voice = asTdObject(content.voice_note);
      return mediaContent("voice", translate("语音消息"), voice?.voice, {
        ...formattedCaption(content.caption),
        mimeType: typeof voice?.mime_type === "string" ? voice.mime_type : undefined,
        duration: tdNumber(voice?.duration),
        includePendingUpload,
      });
    }
    case "messageVideoNote": {
      const videoNote = asTdObject(content.video_note);
      const length = tdNumber(videoNote?.length);
      return mediaContent("videoNote", downloadableMediaFileName(
        undefined,
        translate("视频消息"),
        videoNote?.video,
        "video/mp4",
        "mp4",
      ), videoNote?.video, {
        ...thumbnailDetails(videoNote?.thumbnail),
        previewDataUrl: minithumbnailDataUrl(videoNote?.minithumbnail),
        width: length,
        height: length,
        duration: tdNumber(videoNote?.duration),
        mimeType: "video/mp4",
        includePendingUpload,
      });
    }
    case "messageSticker": {
      const sticker = asTdObject(content.sticker);
      const emoji = typeof sticker?.emoji === "string" ? sticker.emoji : "";
      return mediaContent("sticker", emoji || translate("贴纸"), sticker?.sticker, {
        ...thumbnailDetails(sticker?.thumbnail),
        previewDataUrl: minithumbnailDataUrl(sticker?.minithumbnail),
        mimeType: tdStickerMimeType(sticker?.format),
        stickerSetId: tdStickerSetId(sticker?.set_id),
        width: tdNumber(sticker?.width),
        height: tdNumber(sticker?.height),
        includePendingUpload,
      });
    }
    case "messageContact": {
      const contact = asTdObject(content.contact);
      const name = [contact?.first_name, contact?.last_name]
        .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
        .join(" ");
      const phone = typeof contact?.phone_number === "string" ? contact.phone_number : "";
      return { kind: "text", text: [translate("联系人"), name, phone].filter(Boolean).join(" · ") };
    }
    case "messageLocation":
      return { kind: "text", text: translate("位置") };
    case "messageLiveLocation":
      return { kind: "text", text: translate("实时位置") };
    case "messageVenue": {
      const venue = asTdObject(content.venue);
      const title = typeof venue?.title === "string" ? venue.title : "";
      const address = typeof venue?.address === "string" ? venue.address : "";
      return { kind: "text", text: [translate("地点"), title, address].filter(Boolean).join(" · ") };
    }
    case "messagePoll": {
      const poll = asTdObject(content.poll);
      const question = formattedTextDetails(poll?.question);
      const pollType = asTdObject(poll?.type);
      const correctPositions = new Set(
        (Array.isArray(pollType?.correct_option_ids) ? pollType.correct_option_ids : [])
          .map((value) => tdNumber(value)).filter(
          (value): value is number => value !== undefined,
        ),
      );
      const explanation = formattedTextDetails(pollType?.explanation);
      return {
        kind: "poll",
        pollId: tdId(poll?.id),
        question: question.text || translate("投票"),
        questionEntities: question.entities.length > 0 ? question.entities : undefined,
        options: asTdObjects(poll?.options).map((option, position) => {
          const text = formattedTextDetails(option.text);
          return {
            id: typeof option.id === "string" && option.id ? option.id : `option-${position}`,
            position,
            text: text.text || translate("选项 {{value0}}", { value0: position + 1 }),
            entities: text.entities.length > 0 ? text.entities : undefined,
            voterCount: tdNumber(option.voter_count) ?? 0,
            votePercentage: Math.min(100, Math.max(0, tdNumber(option.vote_percentage) ?? 0)),
            chosen: option.is_chosen === true,
            beingChosen: option.is_being_chosen === true,
            correct: correctPositions.has(position),
          };
        }),
        totalVoterCount: tdNumber(poll?.total_voter_count) ?? 0,
        type: pollType?.["@type"] === "pollTypeQuiz" ? "quiz" : "regular",
        allowsMultipleAnswers: poll?.allows_multiple_answers === true,
        allowsRevoting: poll?.allows_revoting === true,
        isAnonymous: poll?.is_anonymous === true,
        isClosed: poll?.is_closed === true,
        canSeeResults: poll?.can_see_results === true,
        restrictionReason: pollRestrictionReason(poll?.vote_restriction_reason),
        explanation: explanation.text || undefined,
        explanationEntities: explanation.entities.length > 0 ? explanation.entities : undefined,
      };
    }
    case "messageDice": {
      const emoji = typeof content.emoji === "string" && content.emoji ? content.emoji : "🎲";
      const value = tdNumber(content.value);
      return { kind: "text", text: value === undefined ? emoji : `${emoji} ${value}` };
    }
    case "messageAnimatedEmoji": {
      const animatedEmoji = asTdObject(content.animated_emoji);
      const emoji = typeof animatedEmoji?.emoji === "string"
        ? animatedEmoji.emoji
        : typeof content.emoji === "string" ? content.emoji : translate("动态表情");
      const sticker = asTdObject(animatedEmoji?.sticker);
      if (!sticker?.sticker) return { kind: "text", text: emoji };
      const format = sticker?.format;
      // TDLib includes the full animated sticker here. Keep it as media so
      // the normal TGS/WebM download and renderer can play the large emoji.
      return mediaContent("sticker", emoji, sticker?.sticker, {
        mimeType: tdStickerMimeType(format),
        ...thumbnailDetails(sticker?.thumbnail),
        previewDataUrl: minithumbnailDataUrl(sticker?.minithumbnail),
        width: tdNumber(sticker?.width),
        height: tdNumber(sticker?.height),
        includePendingUpload,
      });
    }
    case "messageGame": {
      const game = asTdObject(content.game);
      return { kind: "text", text: labeledText(translate("游戏"), game?.title) };
    }
    case "messageInvoice":
      return { kind: "text", text: labeledText(translate("账单"), content.title) };
    case "messageChecklist": {
      const checklist = asTdObject(content.checklist);
      return { kind: "text", text: labeledText(translate("清单"), checklist?.title) };
    }
    case "messagePaidMedia": {
      const caption = formattedText(content.caption);
      return { kind: "text", text: caption ? translate("付费媒体：{{value0}}", { value0: caption }) : translate("付费媒体") };
    }
    case "messageStory":
      return { kind: "text", text: translate("故事") };
    case "messageCall": {
      const discardReason = asTdObject(content.discard_reason)?.["@type"];
      const videoLabel = content.is_video === true ? translate("视频通话") : translate("通话");
      const label = discardReason === "callDiscardReasonMissed"
        ? translate("未接{{value0}}", { value0: videoLabel })
        : discardReason === "callDiscardReasonDeclined" ? translate("已拒绝{{value0}}", { value0: videoLabel }) : videoLabel;
      const duration = tdNumber(content.duration) ?? 0;
      return serviceContent(duration > 0 ? translate("{{value0}} · {{value1}} 秒", { value0: label, value1: duration }) : label);
    }
    case "messageBasicGroupChatCreate":
      return serviceContent(labeledText(translate("群聊已创建"), content.title));
    case "messageSupergroupChatCreate":
      return serviceContent(labeledText(content.is_channel === true ? translate("频道已创建") : translate("群聊已创建"), content.title));
    case "messageChatAddMembers": {
      const memberUserIds = Array.isArray(content.member_user_ids)
        ? content.member_user_ids.map(tdId).filter(Boolean)
        : [];
      return serviceContent(
        memberUserIds.length > 1 ? translate("{{value0}} 位新成员加入了群聊", { value0: memberUserIds.length }) : translate("新成员加入了群聊"),
        memberUserIds,
      );
    }
    case "messageChatJoinByLink":
      return serviceContent(translate("有成员通过邀请链接加入了群聊"), []);
    case "messageChatJoinByRequest":
      return serviceContent(translate("入群申请已通过"), []);
    case "messageChatDeleteMember":
      return serviceContent(translate("一位成员离开或被移出了群聊"));
    case "messageChatChangeTitle":
      return serviceContent(labeledText(translate("群聊名称已更改"), content.title));
    case "messageChatChangePhoto":
      return serviceContent(translate("群聊头像已更新"));
    case "messageChatDeletePhoto":
      return serviceContent(translate("群聊头像已移除"));
    case "messageChatUpgradeTo":
      return serviceContent(translate("群聊已升级为超级群组"));
    case "messageChatUpgradeFrom":
      return serviceContent(translate("群聊已完成升级"));
    case "messagePinMessage":
      return serviceContent(translate("置顶了一条消息"));
    case "messageScreenshotTaken":
      return serviceContent(translate("截取了聊天截图"));
    case "messageChatSetMessageAutoDeleteTime":
    case "messageAutoDeleteTime":
      return serviceContent(durationText(content.message_auto_delete_time ?? content.time));
    case "messageChatSetTheme":
      return serviceContent(content.theme_name ? translate("聊天主题已更改为 {{value0}}", { value0: String(content.theme_name) }) : translate("聊天主题已更改"));
    case "messageChatSetBackground":
      return serviceContent(translate("聊天背景已更改"));
    case "messageChatHasProtectedContentToggled":
      return serviceContent(content.has_protected_content === true ? translate("已禁止转发和保存内容") : translate("已允许转发和保存内容"));
    case "messageChatHasProtectedContentDisableRequested":
      return serviceContent(translate("已请求关闭内容保护"));
    case "messageChatBoost": {
      const count = tdNumber(content.boost_count) ?? 0;
      return serviceContent(count > 1 ? translate("为群聊助力 {{value0}} 次", { value0: count }) : translate("为群聊助力"));
    }
    case "messageForumTopicCreated": {
      const topic = asTdObject(content.topic_info);
      return serviceContent(labeledText(translate("话题已创建"), topic?.name));
    }
    case "messageForumTopicEdited":
      return serviceContent(labeledText(translate("话题已更新"), content.name));
    case "messageForumTopicIsClosedToggled":
      return serviceContent(content.is_closed === true ? translate("话题已关闭") : translate("话题已重新打开"));
    case "messageForumTopicIsHiddenToggled":
      return serviceContent(content.is_hidden === true ? translate("话题已隐藏") : translate("话题已显示"));
    case "messageVideoChatScheduled":
      return serviceContent(translate("视频聊天已安排"));
    case "messageVideoChatStarted":
      return serviceContent(translate("视频聊天已开始"));
    case "messageVideoChatEnded": {
      const duration = tdNumber(content.duration) ?? 0;
      return serviceContent(duration > 0 ? translate("视频聊天已结束 · {{value0}} 秒", { value0: duration }) : translate("视频聊天已结束"));
    }
    case "messageInviteVideoChatParticipants": {
      const count = Array.isArray(content.user_ids) ? content.user_ids.length : 0;
      return serviceContent(count > 0 ? translate("邀请了 {{value0}} 位成员参加视频聊天", { value0: count }) : translate("邀请成员参加视频聊天"));
    }
    case "messageContactRegistered":
      return serviceContent(translate("该联系人已加入 Telegram"));
    case "messageCustomServiceAction":
      return serviceContent(textValue(content.text).trim() || translate("群聊状态已更新"));
    case "messageGameScore":
      return serviceContent(translate("游戏得分：{{value0}}", { value0: tdNumber(content.score) ?? 0 }));
    case "messagePaymentSuccessful":
    case "messagePaymentSuccessfulBot":
      return serviceContent(translate("付款成功"));
    case "messagePaymentRefunded":
      return serviceContent(translate("付款已退款"));
    case "messageGiftedPremium":
      return serviceContent(translate("赠送了 Telegram Premium"));
    case "messagePremiumGiftCode":
      return serviceContent(translate("发送了 Telegram Premium 礼品码"));
    case "messageGiftedStars":
      return serviceContent(translate("赠送了 Telegram Stars"));
    case "messageGiftedTon":
      return serviceContent(translate("赠送了 TON"));
    case "messageGift":
      return serviceContent(translate("发送了一份礼物"));
    case "messageUpgradedGift":
      return serviceContent(translate("礼物已升级"));
    case "messageRefundedUpgradedGift":
      return serviceContent(translate("升级礼物已退款"));
    case "messageUpgradedGiftPurchaseOffer":
      return serviceContent(translate("发起了礼物购买报价"));
    case "messageUpgradedGiftPurchaseOfferRejected":
      return serviceContent(translate("礼物购买报价已拒绝"));
    case "messageGiveaway":
    case "messageGiveawayCreated":
      return serviceContent(translate("抽奖已开始"));
    case "messageGiveawayCompleted":
      return serviceContent(translate("抽奖已结束"));
    case "messageGiveawayWinners":
      return serviceContent(translate("抽奖结果已公布"));
    case "messageGiveawayPrizeStars":
      return serviceContent(translate("抽奖 Stars 奖品已发放"));
    case "messageUsersShared":
      return serviceContent(translate("分享了用户信息"));
    case "messageChatShared":
      return serviceContent(translate("分享了聊天信息"));
    case "messageBotWriteAccessAllowed":
      return serviceContent(translate("已允许机器人发送消息"));
    case "messageWebAppDataSent":
      return serviceContent(translate("已向小程序发送数据"));
    case "messageWebAppDataReceived":
      return serviceContent(translate("已从小程序收到数据"));
    case "messagePassportDataSent":
      return serviceContent(translate("已发送 Telegram Passport 数据"));
    case "messagePassportDataReceived":
      return serviceContent(translate("已收到 Telegram Passport 数据"));
    case "messageProximityAlertTriggered":
      return serviceContent(translate("触发了附近提醒"));
    case "messageChecklistTasksAdded":
      return serviceContent(translate("清单中添加了新任务"));
    case "messageChecklistTasksDone":
      return serviceContent(translate("清单任务状态已更新"));
    case "messagePollOptionAdded":
      return serviceContent(translate("投票中添加了新选项"));
    case "messagePollOptionDeleted":
      return serviceContent(translate("投票选项已移除"));
    case "messageChatAddedToCommunity":
    case "messageChatAddToCommunity":
      return serviceContent(translate("群聊已加入社区"));
    case "messageChatRemovedFromCommunity":
      return serviceContent(translate("群聊已从社区移除"));
    case "messageChatOwnerChanged":
      return serviceContent(translate("群聊所有者已更改"));
    case "messageChatOwnerLeft":
      return serviceContent(translate("群聊所有者已离开"));
    case "messageManagedBotCreated":
      return serviceContent(translate("已创建管理机器人"));
    case "messageDirectMessagePriceChanged":
    case "messagePaidMessagePriceChanged":
      return serviceContent(translate("付费消息价格已更改"));
    case "messagePaidMessagesRefunded":
      return serviceContent(translate("付费消息费用已退还"));
    case "messageSuggestedPostApprovalFailed":
      return serviceContent(translate("建议帖子审核失败"));
    case "messageSuggestedPostApproved":
      return serviceContent(translate("建议帖子已通过"));
    case "messageSuggestedPostDeclined":
      return serviceContent(translate("建议帖子已拒绝"));
    case "messageSuggestedPostPaid":
      return serviceContent(translate("建议帖子已付款"));
    case "messageSuggestedPostRefunded":
      return serviceContent(translate("建议帖子已退款"));
    case "messageSuggestBirthdate":
      return serviceContent(translate("建议添加生日"));
    case "messageSuggestProfilePhoto":
      return serviceContent(translate("建议更新头像"));
    case "messageExpiredPhoto":
      return serviceContent(translate("照片已过期"));
    case "messageExpiredVideo":
      return serviceContent(translate("视频已过期"));
    case "messageExpiredVideoNote":
      return serviceContent(translate("视频消息已过期"));
    case "messageExpiredVoiceNote":
      return serviceContent(translate("语音消息已过期"));
    case "messageEmpty":
      return serviceContent(translate("消息内容为空"));
    case "messageUnsupported":
      return serviceContent(translate("此消息类型当前无法显示"));
    default: {
      const type = typeof content?.["@type"] === "string" ? content["@type"] : "unknown";
      return unsupportedContent(value, type);
    }
  }
};

export const messagePreview = (value: unknown) => {
  const content = mapTdMessageContent(asTdObject(value)?.content ?? value);
  return messagePreviewText(content);
};

export const messageSenderId = (value: unknown) => {
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
    case "messageOriginHiddenUser": {
      const senderName = optionalIdentityText(origin.sender_name, 64);
      return senderName ? { kind: "hiddenUser", senderName } : undefined;
    }
    case "messageOriginChat": {
      const chatId = tdId(origin.sender_chat_id);
      return chatId
        ? {
            kind: "chat",
            chatId,
            authorSignature: optionalIdentityText(origin.author_signature, 64),
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
            authorSignature: optionalIdentityText(origin.author_signature, 64),
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
    senderId: messageSenderId(reply.sender_id) || undefined,
    quote: quote || undefined,
    origin: mapTdMessageOrigin(reply.origin),
    sentAt: optionalUnixDate(reply.origin_send_date),
    content: content ? mapTdMessageContent(content) : undefined,
    ...(typeof reply.is_outgoing === "boolean" ? { outgoing: reply.is_outgoing } : {}),
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
          senderName: optionalIdentityText(source.sender_name, 64),
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
  const rawReactions = asTdObject(interaction.reactions);
  const reactions = asTdObjects(rawReactions?.reactions)
    .map(mapTdReaction)
    .filter((reaction): reaction is MessageReaction => Boolean(reaction));
  return {
    viewCount: Math.max(0, tdNumber(interaction.view_count) ?? 0),
    forwardCount: Math.max(0, tdNumber(interaction.forward_count) ?? 0),
    replyCount: Math.max(0, tdNumber(replyInfo?.reply_count) ?? 0),
    reactions,
    canGetAddedReactions: rawReactions?.can_get_added_reactions === true,
    ...(replyInfo ? { hasDiscussion: true } : {}),
  };
};

export const mapTdMessageReactionSenders = (value: unknown): MessageReactionSenderPage => {
  const page = asTdObject(value);
  if (!page || page["@type"] !== "addedReactions") {
    return { totalCount: 0, senders: [] };
  }
  return {
    totalCount: Math.max(0, tdNumber(page.total_count) ?? 0),
    senders: asTdObjects(page.reactions).flatMap((entry) => {
      const type = mapTdReactionType(entry.type);
      const senderId = messageSenderId(entry.sender_id);
      if (!type || !senderId) return [];
      return [{
        senderId,
        type,
        outgoing: entry.is_outgoing === true,
        addedAt: optionalUnixDate(entry.date),
      }];
    }),
    nextOffset: typeof page.next_offset === "string" && page.next_offset
      ? page.next_offset
      : undefined,
  };
};

const mapTdButtonStyle = (value: unknown): MessageInlineKeyboardButton["style"] => {
  switch (asTdObject(value)?.["@type"]) {
    case "buttonStylePrimary":
      return "primary";
    case "buttonStyleDanger":
      return "danger";
    case "buttonStyleSuccess":
      return "success";
    default:
      return "default";
  }
};

const mapTdInlineKeyboardButton = (
  value: unknown,
): MessageInlineKeyboardButton | undefined => {
  const button = asTdObject(value);
  const type = asTdObject(button?.type);
  const text = typeof button?.text === "string" ? button.text : "";
  if (!button || !type || !text) return undefined;
  const base = { text, style: mapTdButtonStyle(button.style) } as const;
  switch (type["@type"]) {
    case "inlineKeyboardButtonTypeCallback":
      return typeof type.data === "string" ? { ...base, kind: "callback", data: type.data } : undefined;
    case "inlineKeyboardButtonTypeUrl":
    case "inlineKeyboardButtonTypeLoginUrl":
      return typeof type.url === "string" ? { ...base, kind: "url", url: type.url } : undefined;
    case "inlineKeyboardButtonTypeWebApp":
      return typeof type.url === "string" ? { ...base, kind: "webApp", url: type.url } : undefined;
    case "inlineKeyboardButtonTypeUser": {
      const userId = tdId(type.user_id);
      return userId ? { ...base, kind: "user", userId } : undefined;
    }
    case "inlineKeyboardButtonTypeCopyText":
      return typeof type.text === "string"
        ? { ...base, kind: "copyText", copyText: type.text }
        : undefined;
    default:
      return { ...base, kind: "unsupported" };
  }
};

const mapTdReplyMarkup = (value: unknown): MessageInlineKeyboard | undefined => {
  const markup = asTdObject(value);
  if (markup?.["@type"] !== "replyMarkupInlineKeyboard" || !Array.isArray(markup.rows)) {
    return undefined;
  }
  const rows = markup.rows.flatMap((row) => {
    if (!Array.isArray(row)) return [];
    const buttons = row
      .map(mapTdInlineKeyboardButton)
      .filter((button): button is MessageInlineKeyboardButton => Boolean(button));
    return buttons.length > 0 ? [buttons] : [];
  });
  return rows.length > 0 ? { kind: "inlineKeyboard", rows } : undefined;
};

export const mapTdMessageProperties = (raw: TdObject): MessagePermissions => {
  const includesPinPermissions = "can_be_pinned" in raw;
  return {
    ...(typeof raw.can_be_saved === "boolean" ? { canSave: raw.can_be_saved } : {}),
    ...(typeof raw.can_report_chat === "boolean" ? { canReport: raw.can_report_chat } : {}),
    canReply: raw.can_be_replied === true,
    canEdit: raw.can_be_edited === true,
    canDeleteOnlyForSelf: raw.can_be_deleted_only_for_self === true,
    canDeleteForAllUsers: raw.can_be_deleted_for_all_users === true,
    canForward: raw.can_be_forwarded === true,
    ...(includesPinPermissions ? {
      canPin: raw.can_be_pinned === true,
    } : {}),
  };
};

const mapTdUnreadReactions = (value: unknown) => asTdObjects(value).flatMap((entry) => {
  const type = mapTdReactionType(entry.type);
  if (!type) return [];
  const senderId = tdId(entry.sender_id) || messageSenderId(entry.sender_id) || undefined;
  return [{ type, ...(senderId ? { senderId } : {}) }];
});

export const mapTdMessage = (raw: TdObject, options: { isChannel?: boolean } = {}): Message | undefined => {
  const id = tdId(raw.id);
  const chatId = tdId(raw.chat_id);
  if (!id || !chatId) return undefined;
  const mediaAlbumId = tdId(raw.media_album_id);
  const topic = asTdObject(raw.topic_id);
  const topicId = topic?.["@type"] === "messageTopicForum"
    ? tdId(topic.forum_topic_id)
    : "";
  const messageThreadId = topic?.["@type"] === "messageTopicThread"
    ? tdId(topic.message_thread_id) : "";

  const remaining = [raw.self_destruct_in, raw.auto_delete_in].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  if (remaining.length && typeof raw._notgramExpiresAt !== "string") {
    raw._notgramExpiresAt = new Date(Date.now() + Math.min(...remaining) * 1000).toISOString();
  }
  const senderId = messageSenderId(raw.sender_id) || "unknown";
  const sendingState = asTdObject(raw.sending_state);
  const failed = sendingState?.["@type"] === "messageSendingStateFailed";
  const sendError = failed ? asTdObject(sendingState.error) : undefined;
  const needAnotherReplyQuote = failed && sendingState.need_another_reply_quote === true;
  const needDropReply = failed && sendingState.need_drop_reply === true;
  const needAnotherSender = failed && sendingState.need_another_sender === true;
  const unreadReactions = mapTdUnreadReactions(raw.unread_reactions);
  let content = mapTdMessageContent(raw.content, raw.is_outgoing === true);
  const rawContent = asTdObject(raw.content);
  if (
    options.isChannel === true &&
    (rawContent?.["@type"] === "messageBasicGroupChatCreate" ||
      rawContent?.["@type"] === "messageSupergroupChatCreate")
  ) {
    content = serviceContent(labeledText(translate("频道已创建"), rawContent.title));
  }
  if (
    content.kind === "service" && content.memberUserIds?.length === 0 &&
    senderId !== "unknown" && !senderId.startsWith("chat:")
  ) {
    content = { ...content, memberUserIds: [senderId] };
  }

  return {
    id,
    chatId,
    topicId: topicId || undefined,
    ...(messageThreadId ? { messageThreadId } : {}),
    ...(typeof raw.can_be_saved === "boolean" ? { canSave: raw.can_be_saved } : {}),
    ...(asTdObject(raw.self_destruct_type) ? { selfDestruct: true } : {}),
    ...(typeof raw._notgramExpiresAt === "string" ? { expiresAt: raw._notgramExpiresAt } : {}),
    mediaAlbumId: mediaAlbumId && mediaAlbumId !== "0" ? mediaAlbumId : undefined,
    senderId,
    senderTag: optionalIdentityText(raw.sender_tag, 16),
    authorSignature: optionalIdentityText(raw.author_signature, 64),
    isChannelPost: raw.is_channel_post === true,
    outgoing: raw.is_outgoing === true,
    sentAt: unixDate(raw.date),
    delivery: failed ? "failed" : sendingState ? "sending" : "sent",
    canRetry: failed && sendingState.can_retry === true &&
      !needAnotherReplyQuote && !needDropReply && !needAnotherSender,
    sendFailure: failed
      ? {
          code: tdNumber(sendError?.code),
          message: typeof sendError?.message === "string" && sendError.message.trim()
            ? sendError.message.trim()
            : undefined,
          needAnotherReplyQuote,
          needDropReply,
          needAnotherSender,
          requiredPaidMessageStarCount: tdId(sendingState.required_paid_message_star_count) || undefined,
          retryAfter: tdNumber(sendingState.retry_after),
        }
      : undefined,
    editedAt: optionalUnixDate(raw.edit_date),
    replyTo: mapTdReplyTarget(raw.reply_to),
    forwardInfo: mapTdForwardInfo(raw.forward_info),
    interaction: mapTdInteraction(raw.interaction_info),
    ...(typeof raw.is_pinned === "boolean" ? { isPinned: raw.is_pinned } : {}),
    replyMarkup: mapTdReplyMarkup(raw.reply_markup),
    isPending: raw.is_pending === true,
    containsUnreadMention: raw.contains_unread_mention === true,
    containsUnreadReaction: Array.isArray(raw.unread_reactions) && raw.unread_reactions.length > 0,
    ...(unreadReactions.length > 0 ? { unreadReactions } : {}),
    content,
  };
};

const advertisementSponsorAvatar = (
  value: unknown,
  title: string,
  identity: string,
) => {
  const photo = asTdObject(value);
  const sizes = asTdObjects(photo?.sizes);
  const smallest = sizes.reduce<TdObject | undefined>((best, candidate) => {
    const area = (tdNumber(candidate.width) ?? 0) * (tdNumber(candidate.height) ?? 0);
    const bestArea = (tdNumber(best?.width) ?? Number.POSITIVE_INFINITY) *
      (tdNumber(best?.height) ?? Number.POSITIVE_INFINITY);
    return area <= bestArea ? candidate : best;
  }, undefined);
  return {
    label: initials(title),
    color: colorFor(`sponsor:${identity}`),
    ...(smallest?.photo ? avatarFile(smallest.photo) : {}),
  };
};

export const mapTdSponsoredMessages = (
  value: unknown,
  chatIdValue: unknown,
): ChatSponsoredMessages => {
  const result = asTdObject(value);
  const chatId = tdId(chatIdValue);
  const messages = asTdObjects(result?.messages).flatMap((raw): SponsoredMessage[] => {
    const id = tdId(raw.message_id);
    const sponsor = asTdObject(raw.sponsor);
    if (!chatId || !id || !sponsor) return [];
    const title = sanitizeIdentityText(
      typeof raw.title === "string" ? raw.title : "",
      translate("赞助消息"),
      128,
    );
    const backgroundCustomEmojiId = tdId(raw.background_custom_emoji_id);
    return [{
      id,
      chatId,
      isRecommended: raw.is_recommended === true,
      canBeReported: raw.can_be_reported === true,
      sponsor: {
        url: typeof sponsor.url === "string" ? sponsor.url : "",
        info: typeof sponsor.info === "string" && sponsor.info.trim()
          ? sponsor.info.trim()
          : undefined,
        avatar: advertisementSponsorAvatar(sponsor.photo, title, id),
      },
      title,
      buttonText: typeof raw.button_text === "string" && raw.button_text.trim()
        ? raw.button_text.trim()
        : translate("打开"),
      accentColorId: tdNumber(raw.accent_color_id) ?? 0,
      backgroundCustomEmojiId: backgroundCustomEmojiId && backgroundCustomEmojiId !== "0"
        ? backgroundCustomEmojiId
        : undefined,
      additionalInfo: typeof raw.additional_info === "string" && raw.additional_info.trim()
        ? raw.additional_info.trim()
        : undefined,
      content: mapTdMessageContent(raw.content),
    }];
  });
  return {
    messages,
    messagesBetween: Math.max(0, Math.floor(tdNumber(result?.messages_between) ?? 0)),
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
      title: sanitizeIdentityText(folderName(value.name), translate("聊天文件夹"), 12),
      iconName: typeof icon?.name === "string" ? icon.name : "Custom",
    }];
  });
  const folders: ChatFolder[] = [...custom];
  folders.splice(Math.min(Math.max(mainChatListPosition, 0), folders.length), 0, {
    id: "main",
    title: translate("全部聊天"),
    iconName: "All",
  });
  folders.push({
    id: "archive",
    title: translate("归档"),
    iconName: "Archive",
  });
  return folders;
};

export const mapTdChat = (
  raw: TdObject,
  currentUserId?: string,
  supergroupValue?: unknown,
  basicGroupValue?: unknown,
  scopeNotificationSettings?: unknown,
): Chat | undefined => {
  const id = tdId(raw.id);
  if (!id) return undefined;

  const type = asTdObject(raw.type);
  const supergroup = asTdObject(supergroupValue);
  const basicGroup = asTdObject(basicGroupValue);
  const memberCount = tdNumber(supergroup?.member_count) ?? tdNumber(basicGroup?.member_count) ?? tdNumber(raw.member_count);
  const activeUserCount = tdNumber(raw.active_user_count);
  const peerId = type?.["@type"] === "chatTypePrivate" ? tdId(type.user_id) : undefined;
  const kind =
    peerId && peerId === currentUserId
      ? "saved"
      : type?.["@type"] === "chatTypePrivate" || type?.["@type"] === "chatTypeSecret"
        ? "direct"
        : type?.["@type"] === "chatTypeSupergroup" && type.is_channel === true
          ? "channel"
          : "group";
  const title = sanitizeIdentityText(
    typeof raw.title === "string" ? raw.title : "",
    translate("未命名会话"),
    128,
  );
  const positions = asTdObjects(raw.positions);
  const folderIds = new Set<string>();
  for (const position of positions) {
    if ((tdNumber(position.order) ?? 0) !== 0) {
      const folderId = tdChatListId(position.list);
      if (folderId) folderIds.add(folderId);
    }
  }
  // chat_lists describes membership even before a list has loaded a visible
  // position. Positions still control ordering and visibility in that list.
  for (const list of asTdObjects(raw.chat_lists)) {
    const folderId = tdChatListId(list);
    if (folderId) folderIds.add(folderId);
  }
  const lastMessage = asTdObject(raw.last_message);
  const lastLifecycle = lastMessage ? mapTdMessage(lastMessage) : undefined;
  const notifications = asTdObject(raw.notification_settings);
  const listOrderByFolder = Object.fromEntries(positions.flatMap((position) => {
    const order = tdId(position.order);
    const folderId = tdChatListId(position.list);
    return order && order !== "0" && folderId ? [[folderId, order]] : [];
  }));
  const pinnedFolderIds = positions.flatMap((position) => {
    if (position.is_pinned !== true || (tdNumber(position.order) ?? 0) === 0) return [];
    const folderId = tdChatListId(position.list);
    return folderId ? [folderId] : [];
  });
  const managedChatType = type?.["@type"] === "chatTypeBasicGroup"
    ? "basicGroup" as const
    : type?.["@type"] === "chatTypeSupergroup"
      ? type.is_channel === true ? "channel" as const : "supergroup" as const
      : undefined;
  const groupStatus = managedChatType === "basicGroup" ? basicGroup?.status : supergroup?.status;
  const management = managedChatType && groupStatus
    ? deriveChatManagementCapabilitiesFromTd(managedChatType, groupStatus)
    : undefined;
  const status = asTdObject(groupStatus);
  const statusType = status?.["@type"];

  const sendingPermissions = asTdObject(statusType === "chatMemberStatusRestricted" ? status?.permissions : raw.permissions);
  const allowsAnyMessage = sendingPermissions
    ? Object.entries(sendingPermissions).some(([key, allowed]) => key.startsWith("can_send_") && allowed === true)
    : statusType !== "chatMemberStatusRestricted";

  return {
    id,
    kind,
    isForum: supergroup?.is_forum === true,
    ...(typeof asTdObject(raw.permissions)?.can_pin_messages === "boolean"
      ? { canPinMessages: asTdObject(raw.permissions)?.can_pin_messages === true }
      : {}),
    canCreateTopics: management?.canManageTopics === true || asTdObject(raw.permissions)?.can_create_topics === true,
    management,
    canDeleteForSelf: raw.can_be_deleted_only_for_self === true,
    isBlocked: asTdObject(raw.block_list)?.["@type"] === "blockListMain",
    ...(kind === "group" || kind === "channel" ? {
      isBanned: statusType === "chatMemberStatusBanned",
      joinByRequest: supergroup?.join_by_request === true,
    } : {}),
    ...(kind === "group" && status ? { canSendMessages:
      statusType === "chatMemberStatusCreator" || statusType === "chatMemberStatusAdministrator" ||
      (statusType === "chatMemberStatusMember" && allowsAnyMessage) ||
      (statusType === "chatMemberStatusRestricted" && status.is_member === true && allowsAnyMessage) } : {}),
    ...(status ? { isMember: statusType === "chatMemberStatusMember" ||
      statusType === "chatMemberStatusAdministrator" ||
      ((statusType === "chatMemberStatusCreator" || statusType === "chatMemberStatusRestricted") && status.is_member === true) } : {}),
    folderIds: [...folderIds],
    title: kind === "saved" ? translate("收藏夹") : title,
    avatar: kind === "saved" ? savedMessagesAvatar() : {
      label: initials(title),
      color: colorFor(id),
      ...avatarFile(asTdObject(raw.photo)?.small),
    },
    peerId,
    ...(memberCount !== undefined ? { memberCount } : {}),
    ...(activeUserCount !== undefined ? { activeUserCount } : {}),
    preview: lastMessage ? messagePreview(lastMessage) : translate("暂无消息"),
    previewCacheable: lastLifecycle ? !lastLifecycle.selfDestruct && !lastLifecycle.expiresAt && lastLifecycle.canSave !== false : true,
    previewExpiresAt: lastLifecycle?.expiresAt,
    previewSenderId: lastMessage ? messageSenderId(lastMessage.sender_id) || undefined : undefined,
    updatedAt: unixDate(lastMessage?.date),
    unreadCount: tdNumber(raw.unread_count) ?? 0,
    unreadMentionCount: Math.max(0, tdNumber(raw.unread_mention_count) ?? 0),
    unreadReactionCount: Math.max(0, tdNumber(raw.unread_reaction_count) ?? 0),
    lastReadInboxMessageId: tdId(raw.last_read_inbox_message_id) || undefined,
    pinned: pinnedFolderIds.length > 0,
    pinnedFolderIds,
    listOrderByFolder,
    muted: (tdNumber(notifications?.use_default_mute_for === true
      ? asTdObject(scopeNotificationSettings)?.mute_for : notifications?.mute_for) ?? 0) > 0,
    ...(tdNumber(raw.message_auto_delete_time) !== undefined
      ? { messageAutoDeleteTime: Math.max(0, tdNumber(raw.message_auto_delete_time) ?? 0) }
      : {}),
  };
};

export const mapTdChatDraft = (
  chatIdValue: unknown,
  value: unknown,
  topicIdValue?: unknown,
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
  const quote = reply?.["@type"] === "inputMessageReplyToMessage"
    ? asTdObject(reply.quote)
    : undefined;
  const quoteDetails = quote ? formattedTextDetails(quote.text) : undefined;
  const contentDetails = formattedTextDetails(content.text);
  const quoteText = quoteDetails?.text ?? "";
  const quotePosition = quote ? tdNumber(quote.position) : undefined;
  return {
    chatId,
    topicId: tdId(topicIdValue) || undefined,
    text: contentDetails.text,
    ...(contentDetails.entities.length > 0 ? { entities: contentDetails.entities } : {}),
    replyToMessageId: replyToMessageId || undefined,
    replyQuote: replyToMessageId && quoteText && quotePosition !== undefined && quotePosition >= 0
      ? {
          text: quoteText,
          position: quotePosition,
          ...(quoteDetails && quoteDetails.entities.length > 0
            ? { entities: quoteDetails.entities }
            : {}),
        }
      : undefined,
    updatedAt: unixDate(draft.date),
  };
};

export const mapTdForumTopic = (value: unknown): ForumTopic | undefined => {
  const raw = asTdObject(value);
  const info = asTdObject(raw?.info ?? value);
  const chatId = tdId(info?.chat_id);
  const id = tdId(info?.forum_topic_id);
  if (!raw || !info || !chatId || !id) return undefined;
  const icon = asTdObject(info.icon);
  const notificationSettings = asTdObject(raw.notification_settings);
  const lastMessageRaw = asTdObject(raw.last_message);
  const lastMessage = lastMessageRaw ? mapTdMessage(lastMessageRaw) : undefined;
  const draft = mapTdChatDraft(chatId, raw.draft_message, id);
  const customEmojiId = tdId(icon?.custom_emoji_id);
  const useDefaultMuteFor = notificationSettings?.use_default_mute_for !== false;
  return {
    id,
    chatId,
    name: sanitizeIdentityText(
      typeof info.name === "string" ? info.name : "",
      translate("未命名话题"),
      128,
    ),
    iconColor: tdNumber(icon?.color) ?? 0x6fb9f0,
    iconCustomEmojiId: customEmojiId && customEmojiId !== "0" ? customEmojiId : undefined,
    createdAt: unixDate(info.creation_date),
    isGeneral: info.is_general === true,
    isOutgoing: info.is_outgoing === true,
    isClosed: info.is_closed === true,
    isHidden: info.is_hidden === true,
    isPinned: raw.is_pinned === true,
    unreadCount: Math.max(0, tdNumber(raw.unread_count) ?? 0),
    unreadMentionCount: Math.max(0, tdNumber(raw.unread_mention_count) ?? 0),
    unreadReactionCount: Math.max(0, tdNumber(raw.unread_reaction_count) ?? 0),
    lastReadInboxMessageId: tdId(raw.last_read_inbox_message_id) || undefined,
    lastReadOutboxMessageId: tdId(raw.last_read_outbox_message_id) || undefined,
    lastMessage,
    order: tdId(raw.order) || "0",
    muted: !useDefaultMuteFor && (tdNumber(notificationSettings?.mute_for) ?? 0) > 0,
    useDefaultMuteFor,
    draft,
  };
};

export const mapTdUser = (raw: TdObject): User | undefined => {
  const id = tdId(raw.id);
  if (!id) return undefined;
  const firstName = sanitizeIdentityText(
    typeof raw.first_name === "string" ? raw.first_name : "",
    "",
    64,
  );
  const lastName = sanitizeIdentityText(
    typeof raw.last_name === "string" ? raw.last_name : "",
    "",
    64,
  );
  const displayName = sanitizeIdentityText(
    `${firstName} ${lastName}`,
    translate("Telegram 用户"),
    128,
  );
  const status = asTdObject(raw.status);
  const online = status?.["@type"] === "userStatusOnline";
  const lastSeen = status?.["@type"] === "userStatusOffline" ? tdNumber(status.was_online) : undefined;
  const usernames = asTdObject(raw.usernames);
  const editableUsername = typeof usernames?.editable_username === "string"
    ? usernames.editable_username
    : undefined;
  const activeUsername = Array.isArray(usernames?.active_usernames)
    ? usernames.active_usernames.find((value): value is string => typeof value === "string")
    : undefined;
  const type = asTdObject(raw.type);

  return {
    id,
    displayName,
    firstName,
    lastName,
    username: editableUsername || activeUsername || undefined,
    phoneNumber: typeof raw.phone_number === "string" && raw.phone_number
      ? raw.phone_number
      : undefined,
    ...(type?.["@type"] === "userTypeBot" ? { isBot: true } : {}),
    avatar: {
      label: initials(displayName),
      color: colorFor(id),
      ...avatarFile(asTdObject(raw.profile_photo)?.small),
    },
    presence: online ? "online" : "offline",
    lastSeenLabel: lastSeen ? new Date(lastSeen * 1000).toLocaleString(currentLanguage()) : undefined,
  };
};
