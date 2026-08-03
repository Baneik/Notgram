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
  MessageRichBlock,
  MessageRichCaption,
  MessageRichListItem,
  MessageRichMedia,
  MessageRichTableCell,
  MessageRichTextRun,
  MessageTextEntity,
  MessageTextEntityKind,
  User,
} from "./types";
import { messageContentText } from "./messageContent";

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
      case "textEntityTypeCode": kind = "code"; break;
      case "textEntityTypePre": kind = "pre"; break;
      case "textEntityTypePreCode": kind = "pre"; break;
      case "textEntityTypeBlockQuote":
      case "textEntityTypeExpandableBlockQuote": kind = "blockquote"; break;
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
    }];
  });
  return { text, entities };
};

const formattedText = (value: unknown) => formattedTextDetails(value).text;

const formattedCaption = (value: unknown) => {
  const { text, entities } = formattedTextDetails(value);
  return {
    caption: text || undefined,
    captionEntities: text && entities.length > 0 ? entities : undefined,
  };
};

const localImagePath = (value: unknown) => {
  const file = asTdObject(value);
  const local = asTdObject(file?.local);
  return local?.is_downloading_completed === true && typeof local.path === "string" && local.path
    ? local.path
    : undefined;
};

const avatarFile = (value: unknown) => {
  const file = asTdObject(value);
  const local = asTdObject(file?.local);
  return {
    imagePath: localImagePath(file),
    fileId: tdNumber(file?.id),
    canDownload: local?.can_be_downloaded === true,
    isDownloading: local?.is_downloading_active === true,
  };
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

const thumbnailFileDetails = (value: unknown) => {
  const file = asTdObject(value);
  const local = asTdObject(file?.local);
  return {
    thumbnailPath: localImagePath(file),
    thumbnailFileId: tdNumber(file?.id),
    thumbnailCanDownload: local?.can_be_downloaded === true,
    thumbnailIsDownloading: local?.is_downloading_active === true,
  };
};

const thumbnailDetails = (value: unknown) =>
  thumbnailFileDetails(asTdObject(value)?.file);

const stickerMimeType = (value: unknown) => {
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
    thumbnailCanDownload?: boolean;
    thumbnailIsDownloading?: boolean;
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
    captionEntities?: MessageTextEntity[];
    mimeType?: string;
    thumbnailPath?: string;
    thumbnailFileId?: number;
    thumbnailCanDownload?: boolean;
    thumbnailIsDownloading?: boolean;
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

const serviceContent = (text: string): MessageContent => ({ kind: "service", text });

export const serializeTdObject = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

const unsupportedContent = (value: unknown, type: string): MessageContent => ({
  kind: "unsupported",
  type,
  text: `收到新类型消息（${type}）`,
  raw: serializeTdObject(value),
});

type RichTextStyle = Omit<MessageRichTextRun, "text">;

const richDateTime = (richText: TdObject): MessageRichTextRun["dateTime"] => {
  const unixTime = tdNumber(richText.unix_time);
  if (unixTime === undefined) return undefined;
  const formatting = asTdObject(richText.formatting_type);
  if (!formatting) return { unixTime, mode: "original" };
  if (formatting["@type"] === "dateTimeFormattingTypeRelative") {
    return { unixTime, mode: "relative" };
  }
  if (formatting["@type"] !== "dateTimeFormattingTypeAbsolute") {
    return { unixTime, mode: "original" };
  }
  const precision = (value: unknown) => {
    switch (asTdObject(value)?.["@type"]) {
      case "dateTimePartPrecisionNone": return "none" as const;
      case "dateTimePartPrecisionShort": return "short" as const;
      case "dateTimePartPrecisionLong": return "long" as const;
      default: return undefined;
    }
  };
  return {
    unixTime,
    mode: "absolute",
    timePrecision: precision(formatting.time_precision),
    datePrecision: precision(formatting.date_precision),
    showDayOfWeek: formatting.show_day_of_week === true,
  };
};

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
          : "动图",
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
        typeof audio?.file_name === "string" && audio.file_name ? audio.file_name : "音频",
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
        : { thumbnailPath: localImagePath(smallestFile) };
      return richMedia("photo", "图片", largest?.photo, {
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
        typeof video?.file_name === "string" && video.file_name ? video.file_name : "视频",
        video?.video,
        {
          mimeType: typeof video?.mime_type === "string" ? video.mime_type : undefined,
          ...thumbnailDetails(video?.thumbnail),
          previewDataUrl: minithumbnailDataUrl(video?.minithumbnail),
          width: tdNumber(video?.width),
          height: tdNumber(video?.height),
          duration: tdNumber(video?.duration),
          hasSpoiler: block.has_spoiler === true,
          autoplay: block.need_autoplay === true,
          loop: block.is_looped === true,
          caption: richCaption(block.caption),
        },
      );
    }
    case "pageBlockVoiceNote": {
      const voice = asTdObject(block.voice_note);
      return richMedia("voice", "语音消息", voice?.voice, {
        mimeType: typeof voice?.mime_type === "string" ? voice.mime_type : undefined,
        duration: tdNumber(voice?.duration),
        caption: richCaption(block.caption),
      });
    }
    default:
      return richMedia("photo", "媒体", undefined);
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
        return paragraph(caption.length > 0 ? caption : [{ text: "位置" }]);
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
      return block.caption ? [richRunsText(block.caption.text)] : ["位置"];
    case "divider":
      return [];
  }
};

const richMessageContent = (value: unknown): MessageContent => {
  const message = asTdObject(asTdObject(value)?.message);
  let blocks = pageBlocks(message?.blocks);
  let text = blocks.flatMap(richBlockText).filter(Boolean).join("\n").trim();
  if (!text) text = "富文本消息";
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
  if (seconds <= 0) return "已关闭消息自动删除";
  if (seconds % 86_400 === 0) return `消息将在 ${seconds / 86_400} 天后自动删除`;
  if (seconds % 3_600 === 0) return `消息将在 ${seconds / 3_600} 小时后自动删除`;
  if (seconds % 60 === 0) return `消息将在 ${seconds / 60} 分钟后自动删除`;
  return `消息将在 ${seconds} 秒后自动删除`;
};

export const mapTdMessageContent = (value: unknown): MessageContent => {
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
          : caption || "文档";
      return fileContent(fileName, document?.document, {
        ...formattedCaption(content.caption),
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
      const largestFileId = tdNumber(asTdObject(largest?.photo)?.id);
      const smallestFile = asTdObject(smallest?.photo);
      const smallestFileId = tdNumber(smallestFile?.id);
      const previewDetails = smallestFileId !== undefined && smallestFileId !== largestFileId
        ? thumbnailFileDetails(smallestFile)
        : { thumbnailPath: localImagePath(smallestFile) };
      return mediaContent("photo", "图片", largest?.photo, {
        ...formattedCaption(content.caption),
        ...previewDetails,
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
          ...formattedCaption(content.caption),
          mimeType: typeof video?.mime_type === "string" ? video.mime_type : undefined,
          ...thumbnailDetails(video?.thumbnail),
          previewDataUrl: minithumbnailDataUrl(video?.minithumbnail),
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
          ...formattedCaption(content.caption),
          mimeType: typeof animation?.mime_type === "string" ? animation.mime_type : undefined,
          ...thumbnailDetails(animation?.thumbnail),
          previewDataUrl: minithumbnailDataUrl(animation?.minithumbnail),
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
          ...formattedCaption(content.caption),
          mimeType: typeof audio?.mime_type === "string" ? audio.mime_type : undefined,
          thumbnailPath: thumbnailPath(audio?.album_cover_thumbnail),
        },
      );
    }
    case "messageVoiceNote": {
      const voice = asTdObject(content.voice_note);
      return mediaContent("voice", "语音消息", voice?.voice, {
        ...formattedCaption(content.caption),
        mimeType: typeof voice?.mime_type === "string" ? voice.mime_type : undefined,
      });
    }
    case "messageVideoNote": {
      const videoNote = asTdObject(content.video_note);
      const length = tdNumber(videoNote?.length);
      return mediaContent("videoNote", "视频消息", videoNote?.video, {
        ...thumbnailDetails(videoNote?.thumbnail),
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
        mimeType: stickerMimeType(sticker?.format),
        width: tdNumber(sticker?.width),
        height: tdNumber(sticker?.height),
      });
    }
    case "messageContact": {
      const contact = asTdObject(content.contact);
      const name = [contact?.first_name, contact?.last_name]
        .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
        .join(" ");
      const phone = typeof contact?.phone_number === "string" ? contact.phone_number : "";
      return { kind: "text", text: ["联系人", name, phone].filter(Boolean).join(" · ") };
    }
    case "messageLocation":
      return { kind: "text", text: "位置" };
    case "messageLiveLocation":
      return { kind: "text", text: "实时位置" };
    case "messageVenue": {
      const venue = asTdObject(content.venue);
      const title = typeof venue?.title === "string" ? venue.title : "";
      const address = typeof venue?.address === "string" ? venue.address : "";
      return { kind: "text", text: ["地点", title, address].filter(Boolean).join(" · ") };
    }
    case "messagePoll": {
      const poll = asTdObject(content.poll);
      return { kind: "text", text: labeledText("投票", poll?.question) };
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
        : typeof content.emoji === "string" ? content.emoji : "动态表情";
      return { kind: "text", text: emoji };
    }
    case "messageGame": {
      const game = asTdObject(content.game);
      return { kind: "text", text: labeledText("游戏", game?.title) };
    }
    case "messageInvoice":
      return { kind: "text", text: labeledText("账单", content.title) };
    case "messageChecklist": {
      const checklist = asTdObject(content.checklist);
      return { kind: "text", text: labeledText("清单", checklist?.title) };
    }
    case "messagePaidMedia": {
      const caption = formattedText(content.caption);
      return { kind: "text", text: caption ? `付费媒体：${caption}` : "付费媒体" };
    }
    case "messageStory":
      return { kind: "text", text: "故事" };
    case "messageCall": {
      const discardReason = asTdObject(content.discard_reason)?.["@type"];
      const videoLabel = content.is_video === true ? "视频通话" : "通话";
      const label = discardReason === "callDiscardReasonMissed"
        ? `未接${videoLabel}`
        : discardReason === "callDiscardReasonDeclined" ? `已拒绝${videoLabel}` : videoLabel;
      const duration = tdNumber(content.duration) ?? 0;
      return serviceContent(duration > 0 ? `${label} · ${duration} 秒` : label);
    }
    case "messageBasicGroupChatCreate":
      return serviceContent(labeledText("群聊已创建", content.title));
    case "messageSupergroupChatCreate":
      return serviceContent(labeledText(content.is_channel === true ? "频道已创建" : "群聊已创建", content.title));
    case "messageChatAddMembers": {
      const count = Array.isArray(content.member_user_ids) ? content.member_user_ids.length : 0;
      return serviceContent(count > 1 ? `${count} 位新成员加入了群聊` : "新成员加入了群聊");
    }
    case "messageChatJoinByLink":
      return serviceContent("有成员通过邀请链接加入了群聊");
    case "messageChatJoinByRequest":
      return serviceContent("入群申请已通过");
    case "messageChatDeleteMember":
      return serviceContent("一位成员离开或被移出了群聊");
    case "messageChatChangeTitle":
      return serviceContent(labeledText("群聊名称已更改", content.title));
    case "messageChatChangePhoto":
      return serviceContent("群聊头像已更新");
    case "messageChatDeletePhoto":
      return serviceContent("群聊头像已移除");
    case "messageChatUpgradeTo":
      return serviceContent("群聊已升级为超级群组");
    case "messageChatUpgradeFrom":
      return serviceContent("群聊已完成升级");
    case "messagePinMessage":
      return serviceContent("置顶了一条消息");
    case "messageScreenshotTaken":
      return serviceContent("截取了聊天截图");
    case "messageChatSetMessageAutoDeleteTime":
    case "messageAutoDeleteTime":
      return serviceContent(durationText(content.message_auto_delete_time ?? content.time));
    case "messageChatSetTheme":
      return serviceContent(content.theme_name ? `聊天主题已更改为 ${String(content.theme_name)}` : "聊天主题已更改");
    case "messageChatSetBackground":
      return serviceContent("聊天背景已更改");
    case "messageChatHasProtectedContentToggled":
      return serviceContent(content.has_protected_content === true ? "已禁止转发和保存内容" : "已允许转发和保存内容");
    case "messageChatHasProtectedContentDisableRequested":
      return serviceContent("已请求关闭内容保护");
    case "messageChatBoost": {
      const count = tdNumber(content.boost_count) ?? 0;
      return serviceContent(count > 1 ? `为群聊助力 ${count} 次` : "为群聊助力");
    }
    case "messageForumTopicCreated": {
      const topic = asTdObject(content.topic_info);
      return serviceContent(labeledText("话题已创建", topic?.name));
    }
    case "messageForumTopicEdited":
      return serviceContent(labeledText("话题已更新", content.name));
    case "messageForumTopicIsClosedToggled":
      return serviceContent(content.is_closed === true ? "话题已关闭" : "话题已重新打开");
    case "messageForumTopicIsHiddenToggled":
      return serviceContent(content.is_hidden === true ? "话题已隐藏" : "话题已显示");
    case "messageVideoChatScheduled":
      return serviceContent("视频聊天已安排");
    case "messageVideoChatStarted":
      return serviceContent("视频聊天已开始");
    case "messageVideoChatEnded": {
      const duration = tdNumber(content.duration) ?? 0;
      return serviceContent(duration > 0 ? `视频聊天已结束 · ${duration} 秒` : "视频聊天已结束");
    }
    case "messageInviteVideoChatParticipants": {
      const count = Array.isArray(content.user_ids) ? content.user_ids.length : 0;
      return serviceContent(count > 0 ? `邀请了 ${count} 位成员参加视频聊天` : "邀请成员参加视频聊天");
    }
    case "messageContactRegistered":
      return serviceContent("该联系人已加入 Telegram");
    case "messageCustomServiceAction":
      return serviceContent(textValue(content.text).trim() || "群聊状态已更新");
    case "messageGameScore":
      return serviceContent(`游戏得分：${tdNumber(content.score) ?? 0}`);
    case "messagePaymentSuccessful":
    case "messagePaymentSuccessfulBot":
      return serviceContent("付款成功");
    case "messagePaymentRefunded":
      return serviceContent("付款已退款");
    case "messageGiftedPremium":
      return serviceContent("赠送了 Telegram Premium");
    case "messagePremiumGiftCode":
      return serviceContent("发送了 Telegram Premium 礼品码");
    case "messageGiftedStars":
      return serviceContent("赠送了 Telegram Stars");
    case "messageGiftedTon":
      return serviceContent("赠送了 TON");
    case "messageGift":
      return serviceContent("发送了一份礼物");
    case "messageUpgradedGift":
      return serviceContent("礼物已升级");
    case "messageRefundedUpgradedGift":
      return serviceContent("升级礼物已退款");
    case "messageUpgradedGiftPurchaseOffer":
      return serviceContent("发起了礼物购买报价");
    case "messageUpgradedGiftPurchaseOfferRejected":
      return serviceContent("礼物购买报价已拒绝");
    case "messageGiveaway":
    case "messageGiveawayCreated":
      return serviceContent("抽奖已开始");
    case "messageGiveawayCompleted":
      return serviceContent("抽奖已结束");
    case "messageGiveawayWinners":
      return serviceContent("抽奖结果已公布");
    case "messageGiveawayPrizeStars":
      return serviceContent("抽奖 Stars 奖品已发放");
    case "messageUsersShared":
      return serviceContent("分享了用户信息");
    case "messageChatShared":
      return serviceContent("分享了聊天信息");
    case "messageBotWriteAccessAllowed":
      return serviceContent("已允许机器人发送消息");
    case "messageWebAppDataSent":
      return serviceContent("已向小程序发送数据");
    case "messageWebAppDataReceived":
      return serviceContent("已从小程序收到数据");
    case "messagePassportDataSent":
      return serviceContent("已发送 Telegram Passport 数据");
    case "messagePassportDataReceived":
      return serviceContent("已收到 Telegram Passport 数据");
    case "messageProximityAlertTriggered":
      return serviceContent("触发了附近提醒");
    case "messageChecklistTasksAdded":
      return serviceContent("清单中添加了新任务");
    case "messageChecklistTasksDone":
      return serviceContent("清单任务状态已更新");
    case "messagePollOptionAdded":
      return serviceContent("投票中添加了新选项");
    case "messagePollOptionDeleted":
      return serviceContent("投票选项已移除");
    case "messageChatAddedToCommunity":
    case "messageChatAddToCommunity":
      return serviceContent("群聊已加入社区");
    case "messageChatRemovedFromCommunity":
      return serviceContent("群聊已从社区移除");
    case "messageChatOwnerChanged":
      return serviceContent("群聊所有者已更改");
    case "messageChatOwnerLeft":
      return serviceContent("群聊所有者已离开");
    case "messageManagedBotCreated":
      return serviceContent("已创建管理机器人");
    case "messageDirectMessagePriceChanged":
    case "messagePaidMessagePriceChanged":
      return serviceContent("付费消息价格已更改");
    case "messagePaidMessagesRefunded":
      return serviceContent("付费消息费用已退还");
    case "messageSuggestedPostApprovalFailed":
      return serviceContent("建议帖子审核失败");
    case "messageSuggestedPostApproved":
      return serviceContent("建议帖子已通过");
    case "messageSuggestedPostDeclined":
      return serviceContent("建议帖子已拒绝");
    case "messageSuggestedPostPaid":
      return serviceContent("建议帖子已付款");
    case "messageSuggestedPostRefunded":
      return serviceContent("建议帖子已退款");
    case "messageSuggestBirthdate":
      return serviceContent("建议添加生日");
    case "messageSuggestProfilePhoto":
      return serviceContent("建议更新头像");
    case "messageExpiredPhoto":
      return serviceContent("照片已过期");
    case "messageExpiredVideo":
      return serviceContent("视频已过期");
    case "messageExpiredVideoNote":
      return serviceContent("视频消息已过期");
    case "messageExpiredVoiceNote":
      return serviceContent("语音消息已过期");
    case "messageEmpty":
      return serviceContent("消息内容为空");
    case "messageUnsupported":
      return serviceContent("此消息类型当前无法显示");
    default: {
      const type = typeof content?.["@type"] === "string" ? content["@type"] : "unknown";
      return unsupportedContent(value, type);
    }
  }
};

export const messagePreview = (value: unknown) => {
  const content = mapTdMessageContent(asTdObject(value)?.content ?? value);
  return messageContentText(content);
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
  const mediaAlbumId = tdId(raw.media_album_id);

  const senderId = messageSenderId(raw.sender_id) || "unknown";
  const sendingState = asTdObject(raw.sending_state);
  const failed = sendingState?.["@type"] === "messageSendingStateFailed";
  const mappedContent = mapTdMessageContent(raw.content);
  const content = mappedContent.kind === "unsupported"
    ? { ...mappedContent, raw: serializeTdObject(raw) }
    : mappedContent;

  return {
    id,
    chatId,
    mediaAlbumId: mediaAlbumId && mediaAlbumId !== "0" ? mediaAlbumId : undefined,
    senderId,
    outgoing: raw.is_outgoing === true,
    sentAt: unixDate(raw.date),
    delivery: failed ? "failed" : sendingState ? "sending" : "sent",
    canRetry: failed && sendingState.can_retry === true,
    editedAt: optionalUnixDate(raw.edit_date),
    replyTo: mapTdReplyTarget(raw.reply_to),
    forwardInfo: mapTdForwardInfo(raw.forward_info),
    interaction: mapTdInteraction(raw.interaction_info),
    content,
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
  folders.push({
    id: "archive",
    title: "归档",
    iconName: "Archive",
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

  return {
    id,
    kind,
    folderIds: [...folderIds],
    title: kind === "saved" ? "收藏夹" : title,
    avatar: {
      label: kind === "saved" ? "我" : initials(title),
      color: colorFor(id),
      ...avatarFile(asTdObject(raw.photo)?.small),
    },
    peerId,
    preview: lastMessage ? messagePreview(lastMessage) : "暂无消息",
    previewSenderId: lastMessage ? messageSenderId(lastMessage.sender_id) || undefined : undefined,
    updatedAt: unixDate(lastMessage?.date),
    unreadCount: tdNumber(raw.unread_count) ?? 0,
    pinned: pinnedFolderIds.length > 0,
    pinnedFolderIds,
    listOrderByFolder,
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
      ...avatarFile(asTdObject(raw.profile_photo)?.small),
    },
    presence: online ? "online" : "offline",
    lastSeenLabel: lastSeen ? new Date(lastSeen * 1000).toLocaleString("zh-CN") : undefined,
  };
};
