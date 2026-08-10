import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { FileDownloadQueue } from "./fileDownloadQueue";
import type {
  PreparedPastedAttachment,
  PreparedPastedFile,
} from "./tdRequestBroker";
import {
  asTdObject,
  asTdObjects,
  mapTdMessageProperties,
  serializeTdObject,
  tdId,
  tdLocalFilePath,
  tdNumber,
  tdStickerMimeType,
  type TdObject,
} from "./tdlibMapper";
import {
  formattedTextObject,
  forumTopicObject,
  inputMessageText,
  numericId,
} from "./tdlibRequests";
import {
  attachmentAlbumFamily,
  inspectOutgoingAttachment,
} from "../media/outgoingAttachments";
import type {
  DeleteMessageInput,
  EditMessageInput,
  EmojiPickerAsset,
  EmojiPickerCatalog,
  ForwardMessagesInput,
  ForwardMessagesResult,
  Message,
  MessageDateTimeFormatting,
  MessagePermissions,
  MessageReplyQuote,
  MessageTextEntity,
  PinMessageInput,
  SendEmojiAssetInput,
  SendFileInput,
  SendFilesInput,
  SendMessageInput,
  SetChatDraftInput,
  SetChatMessageAutoDeleteTimeInput,
  SetMessageReactionInput,
  SetPollAnswerInput,
  StickerSet,
  StickerSetSummary,
  StreamFileInput,
} from "./types";

const MAX_PINNED_MESSAGE_PAGES = 100;

const dateTimePartPrecisionObject = (
  precision: MessageDateTimeFormatting["timePrecision"],
) => {
  switch (precision) {
    case "none": return { "@type": "dateTimePartPrecisionNone" };
    case "short": return { "@type": "dateTimePartPrecisionShort" };
    case "long": return { "@type": "dateTimePartPrecisionLong" };
    default: return { "@type": "dateTimePartPrecisionNone" };
  }
};

const dateTimeFormattingObject = (dateTime: MessageDateTimeFormatting) => {
  switch (dateTime.mode) {
    case "relative": return { "@type": "dateTimeFormattingTypeRelative" };
    case "absolute": return {
      "@type": "dateTimeFormattingTypeAbsolute",
      time_precision: dateTimePartPrecisionObject(dateTime.timePrecision),
      date_precision: dateTimePartPrecisionObject(dateTime.datePrecision),
      show_day_of_week: dateTime.showDayOfWeek === true,
    };
    case "original": return null;
  }
};

const inputTextQuoteEntityType = (entity: MessageTextEntity) => {
  switch (entity.kind) {
    case "bold": return { "@type": "textEntityTypeBold" };
    case "italic": return { "@type": "textEntityTypeItalic" };
    case "underline": return { "@type": "textEntityTypeUnderline" };
    case "strikethrough": return { "@type": "textEntityTypeStrikethrough" };
    case "spoiler": return { "@type": "textEntityTypeSpoiler" };
    case "customEmoji": return entity.customEmojiId
      ? { "@type": "textEntityTypeCustomEmoji", custom_emoji_id: entity.customEmojiId }
      : undefined;
    case "dateTime": return entity.dateTime
      ? {
          "@type": "textEntityTypeDateTime",
          unix_time: entity.dateTime.unixTime,
          formatting_type: dateTimeFormattingObject(entity.dateTime),
        }
      : undefined;
    default: return undefined;
  }
};

const inputTextQuoteObject = (replyQuote?: MessageReplyQuote): TdObject | null => {
  if (!replyQuote || replyQuote.text.length === 0 ||
    !Number.isSafeInteger(replyQuote.position) || replyQuote.position < 0) return null;
  const entities = (replyQuote.entities ?? []).flatMap((entity) => {
    const type = inputTextQuoteEntityType(entity);
    return type && entity.offset >= 0 && entity.length > 0 &&
      entity.offset + entity.length <= replyQuote.text.length
      ? [{ offset: entity.offset, length: entity.length, type }]
      : [];
  });
  return {
    "@type": "inputTextQuote",
    text: { "@type": "formattedText", text: replyQuote.text, entities },
    position: replyQuote.position,
  };
};

const inputMessageReplyTarget = (
  replyToMessageId?: string,
  replyQuote?: MessageReplyQuote,
) => replyToMessageId
  ? {
      "@type": "inputMessageReplyToMessage",
      message_id: numericId(replyToMessageId),
      quote: inputTextQuoteObject(replyQuote),
      checklist_task_id: 0,
      poll_option_id: "",
    }
  : null;

const emojiPreviewDataUrl = (value: unknown) => {
  const minithumbnail = asTdObject(value);
  return typeof minithumbnail?.data === "string" && minithumbnail.data
    ? `data:image/jpeg;base64,${minithumbnail.data}`
    : undefined;
};

const stickerFileName = (mimeType?: string) => {
  if (mimeType === "video/webm") return "sticker.webm";
  if (mimeType === "application/x-tgsticker") return "sticker.tgs";
  return "sticker.webp";
};

const mapEmojiSticker = (value: unknown): EmojiPickerAsset | undefined => {
  const sticker = asTdObject(value);
  const file = asTdObject(sticker?.sticker);
  const fileId = tdNumber(file?.id);
  if (!sticker || fileId === undefined) return undefined;
  const thumbnail = asTdObject(sticker.thumbnail);
  const thumbnailFile = asTdObject(thumbnail?.file);
  const mimeType = tdStickerMimeType(sticker.format);
  return {
    id: `sticker:${tdId(sticker.id) || fileId}`,
    kind: "sticker",
    fileId,
    previewFileId: tdNumber(thumbnailFile?.id),
    emoji: typeof sticker.emoji === "string" ? sticker.emoji : undefined,
    fileName: stickerFileName(mimeType),
    mimeType,
    previewMimeType: "image/webp",
    localPath: tdLocalFilePath(file),
    previewPath: tdLocalFilePath(thumbnailFile),
    previewDataUrl: emojiPreviewDataUrl(sticker.minithumbnail),
    width: tdNumber(sticker.width),
    height: tdNumber(sticker.height),
  };
};

const mapEmojiAnimation = (value: unknown): EmojiPickerAsset | undefined => {
  const animation = asTdObject(value);
  const file = asTdObject(animation?.animation);
  const fileId = tdNumber(file?.id);
  if (!animation || fileId === undefined) return undefined;
  const thumbnail = asTdObject(animation.thumbnail);
  const thumbnailFile = asTdObject(thumbnail?.file);
  return {
    id: `animation:${fileId}`,
    kind: "animation",
    fileId,
    previewFileId: tdNumber(thumbnailFile?.id),
    fileName: typeof animation.file_name === "string" && animation.file_name
      ? animation.file_name
      : "animation.mp4",
    mimeType: typeof animation.mime_type === "string" ? animation.mime_type : undefined,
    previewMimeType: "image/jpeg",
    localPath: tdLocalFilePath(file),
    previewPath: tdLocalFilePath(thumbnailFile),
    previewDataUrl: emojiPreviewDataUrl(animation.minithumbnail),
    width: tdNumber(animation.width),
    height: tdNumber(animation.height),
    duration: tdNumber(animation.duration),
  };
};

const mapStickerSetSummary = (value: unknown): StickerSetSummary | undefined => {
  const stickerSet = asTdObject(value);
  const id = tdId(stickerSet?.id);
  if (!stickerSet || !id) return undefined;
  return {
    id,
    title: typeof stickerSet.title === "string" ? stickerSet.title : "贴纸包",
    name: typeof stickerSet.name === "string" ? stickerSet.name : "",
    size: tdNumber(stickerSet.size) ?? asTdObjects(stickerSet.stickers).length,
    covers: asTdObjects(stickerSet.covers ?? stickerSet.stickers)
      .map(mapEmojiSticker)
      .filter((asset): asset is EmojiPickerAsset => Boolean(asset)),
  };
};

export interface TauriMessageMediaServiceContext {
  request: (request: TdObject) => Promise<TdObject>;
  rawMessages: Map<string, Map<string, TdObject>>;
  emitMessage: (raw?: TdObject, animateEntrance?: boolean) => void;
  emitMessages: (rawMessages: TdObject[]) => void;
  mapMessage: (raw: TdObject) => Message | undefined;
  ensureReplyContent: (raw: TdObject) => void;
  patchMessage: (chatId: string, messageId: string, patch: TdObject) => void;
  refreshChat: (chatId: string) => Promise<TdObject>;
  fileDownloads: FileDownloadQueue;
  pendingDownloads: Map<number, string>;
  updateFile: (file?: TdObject) => void;
  requestPreparedFile: (chatId: string, topicId?: string) => Promise<boolean>;
  requestPreparedPastedFiles: (
    chatId: string,
    files: PreparedPastedAttachment[],
    caption?: string,
    topicId?: string,
  ) => Promise<boolean>;
}

export class TauriMessageMediaService {
  constructor(private readonly context: TauriMessageMediaServiceContext) {}

  async getMessageContext(chatId: string, messageId: string, limit = 31) {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const newerCount = Math.min(49, Math.floor((boundedLimit - 1) / 2));
    const result = await this.context.request({
      "@type": "getChatHistory",
      chat_id: numericId(chatId),
      from_message_id: numericId(messageId),
      offset: -newerCount,
      limit: boundedLimit,
      only_local: false,
    });
    const rawMessages = asTdObjects(result.messages);
    this.context.emitMessages(rawMessages);
    return rawMessages
      .map((raw) => this.context.mapMessage(raw))
      .filter((message): message is Message => Boolean(message));
  }

  async getMessage(chatId: string, messageId: string) {
    const raw = await this.context.request({
      "@type": "getMessage",
      chat_id: numericId(chatId),
      message_id: numericId(messageId),
    });
    const message = this.context.mapMessage(raw);
    if (!message || message.chatId !== chatId || message.id !== messageId) return undefined;
    const chatMessages = this.context.rawMessages.get(chatId) ?? new Map<string, TdObject>();
    chatMessages.set(message.id, raw);
    this.context.rawMessages.set(chatId, chatMessages);
    this.context.ensureReplyContent(raw);
    return message;
  }

  async getRawMessage(chatId: string, messageId: string) {
    let raw = this.context.rawMessages.get(chatId)?.get(messageId);
    if (!raw) {
      const requested = await this.context.request({
        "@type": "getMessage",
        chat_id: numericId(chatId),
        message_id: numericId(messageId),
      });
      if (tdId(requested.chat_id) !== chatId || tdId(requested.id) !== messageId) {
        return undefined;
      }
      const chatMessages = this.context.rawMessages.get(chatId) ?? new Map<string, TdObject>();
      chatMessages.set(messageId, requested);
      this.context.rawMessages.set(chatId, chatMessages);
      raw = requested;
    }
    return serializeTdObject(raw);
  }

  async getMessageProperties(chatId: string, messageId: string): Promise<MessagePermissions> {
    const properties = await this.context.request({
      "@type": "getMessageProperties",
      chat_id: numericId(chatId),
      message_id: numericId(messageId),
    });
    return mapTdMessageProperties(properties);
  }

  async setMessageReaction(input: SetMessageReactionInput) {
    const request = {
      "@type": input.chosen ? "addMessageReaction" : "removeMessageReaction",
      chat_id: numericId(input.chatId),
      message_id: numericId(input.messageId),
      reaction_type: { "@type": "reactionTypeEmoji", emoji: input.emoji },
    } as TdObject;
    if (input.chosen) {
      request.is_big = false;
      request.update_recent_reactions = true;
    }
    await this.context.request(request);
  }

  async setPollAnswer(input: SetPollAnswerInput) {
    const optionPositions = [...new Set(input.optionPositions)].sort((left, right) => left - right);
    if (optionPositions.length > 100 || optionPositions.some(
      (position) => !Number.isSafeInteger(position) || position < 0 || position > 99,
    )) throw new Error("投票选项无效");
    await this.context.request({
      "@type": "setPollAnswer",
      chat_id: numericId(input.chatId),
      message_id: numericId(input.messageId),
      option_ids: optionPositions,
    });
    const refreshed = await this.context.request({
      "@type": "getMessage",
      chat_id: numericId(input.chatId),
      message_id: numericId(input.messageId),
    });
    if (tdId(refreshed.chat_id) === input.chatId && tdId(refreshed.id) === input.messageId) {
      this.context.emitMessage(refreshed);
    }
  }

  async getPinnedMessages(chatId: string) {
    const known = [...(this.context.rawMessages.get(chatId)?.values() ?? [])]
      .filter((raw) => raw.is_pinned === true)
      .map((raw) => this.context.mapMessage(raw))
      .filter((message): message is Message => Boolean(message));
    const pinnedById = new Map(known.map((message) => [message.id, message]));
    try {
      let fromMessageId = 0;
      const seenCursors = new Set<number>();
      for (let page = 0; page < MAX_PINNED_MESSAGE_PAGES; page += 1) {
        const result = await this.context.request({
          "@type": "searchChatMessages",
          chat_id: numericId(chatId),
          topic_id: null,
          query: "",
          sender_id: null,
          from_message_id: fromMessageId,
          offset: 0,
          limit: 100,
          filter: { "@type": "searchMessagesFilterPinned" },
        });
        for (const raw of asTdObjects(result.messages)) {
          const pinnedRaw = { ...raw, is_pinned: true };
          const message = this.context.mapMessage(pinnedRaw);
          if (!message || message.chatId !== chatId) continue;
          pinnedById.set(message.id, message);
        }
        const nextFromMessageId = tdNumber(result.next_from_message_id) ?? 0;
        if (nextFromMessageId === 0 || seenCursors.has(nextFromMessageId)) break;
        seenCursors.add(nextFromMessageId);
        fromMessageId = nextFromMessageId;
      }
    } catch {
      // Fall back to the latest pinned message on older TDLib deployments.
    }
    if (pinnedById.size === 0) try {
      const raw = await this.context.request({
        "@type": "getChatPinnedMessage",
        chat_id: numericId(chatId),
      });
      const pinned = this.context.mapMessage(raw);
      if (pinned && pinned.chatId === chatId) {
        pinnedById.set(pinned.id, { ...pinned, isPinned: true });
      }
    } catch {
      // Chats without a pinned message return an ordinary TDLib error.
    }
    return [...pinnedById.values()]
      .sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt));
  }

  async pinMessage(input: PinMessageInput) {
    await this.context.request({
      "@type": "pinChatMessage",
      chat_id: numericId(input.chatId),
      message_id: numericId(input.messageId),
      disable_notification: input.disableNotification,
      only_for_self: input.onlyForSelf,
    });
    this.context.patchMessage(input.chatId, input.messageId, { is_pinned: true });
  }

  async unpinMessage(chatId: string, messageId: string) {
    await this.context.request({
      "@type": "unpinChatMessage",
      chat_id: numericId(chatId),
      message_id: numericId(messageId),
    });
    this.context.patchMessage(chatId, messageId, { is_pinned: false });
  }

  async setChatMessageAutoDeleteTime(input: SetChatMessageAutoDeleteTimeInput) {
    if (!Number.isSafeInteger(input.messageAutoDeleteTime) ||
      input.messageAutoDeleteTime < 0 || input.messageAutoDeleteTime > 31_536_000 ||
      (input.messageAutoDeleteTime !== 0 && input.messageAutoDeleteTime % 86_400 !== 0)) {
      throw new Error("自动删除时间无效");
    }
    await this.context.request({
      "@type": "setChatMessageAutoDeleteTime",
      chat_id: numericId(input.chatId),
      message_auto_delete_time: input.messageAutoDeleteTime,
    });
    await this.context.refreshChat(input.chatId);
  }

  async getEmojiPickerCatalog(): Promise<EmojiPickerCatalog> {
    const stickerType = { "@type": "stickerTypeRegular" };
    const [recent, installed, saved] = await Promise.all([
      this.context.request({ "@type": "getRecentStickers", is_attached: false }),
      this.context.request({ "@type": "getInstalledStickerSets", sticker_type: stickerType }),
      this.context.request({ "@type": "getSavedAnimations" }),
    ]);
    return {
      recentStickers: asTdObjects(recent.stickers)
        .map(mapEmojiSticker)
        .filter((asset): asset is EmojiPickerAsset => Boolean(asset)),
      stickerSets: asTdObjects(installed.sets)
        .map(mapStickerSetSummary)
        .filter((stickerSet): stickerSet is StickerSetSummary => Boolean(stickerSet)),
      savedAnimations: asTdObjects(saved.animations)
        .map(mapEmojiAnimation)
        .filter((asset): asset is EmojiPickerAsset => Boolean(asset)),
    };
  }

  async getStickerSet(stickerSetId: string): Promise<StickerSet> {
    if (!/^[1-9]\d*$/.test(stickerSetId)) throw new Error("无效的贴纸包标识符");
    const response = await this.context.request({ "@type": "getStickerSet", set_id: stickerSetId });
    const summary = mapStickerSetSummary(response);
    if (!summary) throw new Error("找不到贴纸包");
    return {
      ...summary,
      stickers: asTdObjects(response.stickers)
        .map(mapEmojiSticker)
        .filter((asset): asset is EmojiPickerAsset => Boolean(asset)),
    };
  }

  async searchStickers(query: string, chatId: string): Promise<EmojiPickerAsset[]> {
    const response = await this.context.request({
      "@type": "getStickers",
      sticker_type: { "@type": "stickerTypeRegular" },
      query,
      limit: 100,
      chat_id: numericId(chatId),
    });
    return asTdObjects(response.stickers)
      .map(mapEmojiSticker)
      .filter((asset): asset is EmojiPickerAsset => Boolean(asset));
  }

  async loadEmojiAsset(asset: EmojiPickerAsset) {
    if (asset.localPath) return asset.localPath;
    await this.context.fileDownloads.cache(asset.fileId, 28);
    const file = await this.context.request({ "@type": "getFile", file_id: asset.fileId });
    return tdLocalFilePath(file);
  }

  async sendSticker(input: SendEmojiAssetInput) {
    const response = await this.context.request({
      "@type": "sendMessage",
      chat_id: numericId(input.chatId),
      topic_id: forumTopicObject(input.topicId),
      reply_to: this.emojiReplyTarget(input.replyToMessageId),
      options: null,
      reply_markup: null,
      input_message_content: {
        "@type": "inputMessageSticker",
        sticker: {
          "@type": "inputSticker",
          sticker: { "@type": "inputFileId", id: input.asset.fileId },
          thumbnail: null,
          width: input.asset.width ?? 0,
          height: input.asset.height ?? 0,
        },
        emoji: input.asset.emoji ?? "",
      },
    });
    if (response["@type"] === "message") this.context.emitMessage(response, true);
  }

  async sendAnimation(input: SendEmojiAssetInput) {
    const response = await this.context.request({
      "@type": "sendMessage",
      chat_id: numericId(input.chatId),
      topic_id: forumTopicObject(input.topicId),
      reply_to: this.emojiReplyTarget(input.replyToMessageId),
      options: null,
      reply_markup: null,
      input_message_content: {
        "@type": "inputMessageAnimation",
        animation: {
          "@type": "inputAnimation",
          animation: { "@type": "inputFileId", id: input.asset.fileId },
          thumbnail: null,
          added_sticker_file_ids: [],
          duration: input.asset.duration ?? 0,
          width: input.asset.width ?? 0,
          height: input.asset.height ?? 0,
        },
        caption: formattedTextObject(""),
        show_caption_above_media: false,
        has_spoiler: false,
      },
    });
    if (response["@type"] === "message") this.context.emitMessage(response, true);
  }

  async sendMessage(input: SendMessageInput) {
    const text = await this.formattedTextInput(input.text);
    const response = await this.context.request({
      "@type": "sendMessage",
      chat_id: numericId(input.chatId),
      topic_id: forumTopicObject(input.topicId),
      reply_to: inputMessageReplyTarget(input.replyToMessageId, input.replyQuote),
      options: null,
      reply_markup: null,
      input_message_content: inputMessageText(text, input.clearDraft !== false),
    });
    if (response["@type"] === "message") this.context.emitMessage(response, true);
  }

  async editMessage(input: EditMessageInput) {
    const text = await this.formattedTextInput(input.text);
    const response = await this.context.request({
      "@type": "editMessageText",
      chat_id: numericId(input.chatId),
      message_id: numericId(input.messageId),
      reply_markup: null,
      input_message_content: inputMessageText(text, false),
    });
    if (response["@type"] === "message") this.context.emitMessage(response);
  }

  async deleteMessage(input: DeleteMessageInput) {
    await this.context.request({
      "@type": "deleteMessages",
      chat_id: numericId(input.chatId),
      message_ids: [numericId(input.messageId)],
      revoke: input.revoke,
    });
  }

  async forwardMessages(input: ForwardMessagesInput): Promise<ForwardMessagesResult> {
    const messageIds = [...new Set(input.messageIds.map(numericId))]
      .sort((left, right) => left - right);
    if (messageIds.length === 0) throw new Error("请选择要转发的消息");
    if (messageIds.length > 100) throw new Error("单次最多转发 100 条消息");
    const response = await this.context.request({
      "@type": "forwardMessages",
      chat_id: numericId(input.toChatId),
      topic_id: forumTopicObject(input.toTopicId),
      from_chat_id: numericId(input.fromChatId),
      message_ids: messageIds,
      options: null,
      send_copy: false,
      remove_caption: false,
    });
    const forwarded = Array.isArray(response.messages) ? response.messages : [];
    const failedMessageIds: string[] = [];
    let forwardedCount = 0;
    for (const [index, messageId] of messageIds.entries()) {
      const message = asTdObject(forwarded[index]);
      if (message?.["@type"] === "message") {
        this.context.emitMessage(message);
        forwardedCount += 1;
      } else {
        failedMessageIds.push(String(messageId));
      }
    }
    return { forwardedCount, failedMessageIds };
  }

  async setChatDraft(input: SetChatDraftInput) {
    const hasDraft = input.text.length > 0 || Boolean(input.replyToMessageId);
    await this.context.request({
      "@type": "setChatDraftMessage",
      chat_id: numericId(input.chatId),
      topic_id: forumTopicObject(input.topicId),
      draft_message: hasDraft
        ? {
            "@type": "draftMessage",
            reply_to: inputMessageReplyTarget(input.replyToMessageId, input.replyQuote),
            date: Math.floor(Date.now() / 1000),
            content: {
              "@type": "draftMessageContentText",
              text: { "@type": "formattedText", text: input.text, entities: [] },
              link_preview_options: null,
            },
            effect_id: 0,
            suggested_post_info: null,
          }
        : null,
    });
  }

  async setChatTyping(chatId: string, typing: boolean, topicId?: string) {
    await this.context.request({
      "@type": "sendChatAction",
      chat_id: numericId(chatId),
      topic_id: forumTopicObject(topicId),
      business_connection_id: "",
      action: { "@type": typing ? "chatActionTyping" : "chatActionCancel" },
    });
  }

  async downloadFile(fileId: number, fileName: string) {
    this.context.pendingDownloads.set(fileId, fileName);
    try {
      const cachedDownload = this.context.fileDownloads.get(fileId);
      if (cachedDownload) {
        this.context.fileDownloads.promote(fileId);
        await cachedDownload;
        return;
      }
      const file = await this.context.request({
        "@type": "downloadFile",
        file_id: fileId,
        priority: 24,
        offset: 0,
        limit: 0,
        synchronous: false,
      });
      this.context.updateFile(file);
    } catch (error) {
      const cancelled = !this.context.pendingDownloads.has(fileId);
      this.context.pendingDownloads.delete(fileId);
      if (cancelled) return;
      throw error;
    }
  }

  async cancelFileDownload(fileId: number) {
    this.context.pendingDownloads.delete(fileId);
    this.context.fileDownloads.cancel(fileId);
    await this.context.request({
      "@type": "cancelDownloadFile",
      file_id: fileId,
      only_if_pending: false,
    });
  }

  async openFile(sourcePath: string) {
    await invoke("telegram_open_cached_file", { sourcePath });
  }

  async saveFileAs(sourcePath: string, fileName: string) {
    return invoke<boolean>("telegram_save_cached_file_as", { sourcePath, fileName });
  }

  async openDownloadDirectory() {
    await invoke("telegram_open_download_directory");
  }

  cacheFile(fileId: number, priority = 16) {
    return this.context.fileDownloads.cache(fileId, priority);
  }

  async recoverFile(fileId: number, priority = 32) {
    this.context.fileDownloads.cancel(fileId);
    await this.context.request({
      "@type": "deleteFile",
      file_id: fileId,
    });
    await this.context.fileDownloads.cache(fileId, priority);
  }

  async streamFile({ fileId, size, mimeType }: StreamFileInput) {
    await invoke("telegram_register_media_stream", {
      fileId,
      size,
      mimeType: mimeType ?? "video/mp4",
    });
    return convertFileSrc(String(fileId), "notgram-media");
  }

  async suspendFileStream(fileId: number) {
    if (this.context.pendingDownloads.has(fileId)) return;
    await invoke("telegram_suspend_media_stream", { fileId }).catch(() => undefined);
    await this.context.request({
      "@type": "cancelDownloadFile",
      file_id: fileId,
      only_if_pending: false,
    });
  }

  async retryMessage(chatId: string, messageId: string) {
    const response = await this.context.request({
      "@type": "resendMessages",
      chat_id: numericId(chatId),
      message_ids: [numericId(messageId)],
      quote: null,
      paid_message_star_count: 0,
    });
    for (const message of asTdObjects(response.messages)) this.context.emitMessage(message);
  }

  async sendFile(input: SendFileInput) {
    return input.file
      ? this.sendFiles({
          chatId: input.chatId,
          topicId: input.topicId,
          attachments: [await inspectOutgoingAttachment(input.file)],
        })
      : this.context.requestPreparedFile(input.chatId, input.topicId);
  }

  async sendFiles(input: SendFilesInput) {
    if (input.attachments.length === 0) return false;
    const groups = input.attachments.reduce<typeof input.attachments[]>((result, attachment) => {
      const family = attachmentAlbumFamily(attachment.kind);
      const existing = family === "animation"
        ? undefined
        : result.find((candidate) =>
          candidate.length < 10 && attachmentAlbumFamily(candidate[0].kind) === family);
      if (existing) {
        existing.push(attachment);
      } else {
        result.push([attachment]);
      }
      return result;
    }, []);
    let captionPending = input.caption;
    for (const group of groups) {
      const files = await Promise.all(group.map(this.preparePastedAttachment));
      const sent = await this.context.requestPreparedPastedFiles(
        input.chatId,
        files,
        captionPending,
        input.topicId,
      );
      if (!sent) return false;
      captionPending = undefined;
    }
    return true;
  }

  async cancelFileUpload(chatId: string, messageId: string) {
    await this.context.request({
      "@type": "deleteMessages",
      chat_id: numericId(chatId),
      message_ids: [numericId(messageId)],
      revoke: true,
    });
  }

  private emojiReplyTarget(replyToMessageId?: string) {
    return replyToMessageId
      ? {
          "@type": "inputMessageReplyToMessage",
          message_id: numericId(replyToMessageId),
          quote: null,
          checklist_task_id: 0,
        }
      : null;
  }

  private async formattedTextInput(text: string) {
    const fallback = formattedTextObject(text);
    const hasMarkdown = /(?:\*\*[^*]+\*\*|\*[^*\n]+\*|__[^_]+__|_[^_\n]+_|~~[^~]+~~|\|\|[^|]+\|\||`[^`]+`|^\s{0,3}(?:#{1,6}\s|>|[-+*]\s|\d+\.\s)|\[[^\]]+\]\([^)]+\)|\|[^\n]+\|)/m.test(text);
    if (!hasMarkdown) return fallback;
    try {
      const parsed = await this.context.request({
        "@type": "parseMarkdown",
        text: fallback,
      });
      return parsed["@type"] === "formattedText" && typeof parsed.text === "string"
        ? {
            "@type": "formattedText",
            text: parsed.text,
            entities: Array.isArray(parsed.entities) ? parsed.entities : [],
          }
        : fallback;
    } catch {
      return fallback;
    }
  }

  private preparePastedFile = async (file: File): Promise<PreparedPastedFile> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    }
    return {
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      dataBase64: btoa(chunks.join("")),
    };
  };

  private preparePastedAttachment = async (
    attachment: SendFilesInput["attachments"][number],
  ): Promise<PreparedPastedAttachment> => ({
    ...await this.preparePastedFile(attachment.file),
    kind: attachment.kind,
    width: attachment.width,
    height: attachment.height,
    duration: attachment.duration,
    title: attachment.title,
    performer: attachment.performer,
    thumbnail: attachment.thumbnail
      ? await this.preparePastedFile(attachment.thumbnail)
      : undefined,
    hasSpoiler: attachment.hasSpoiler,
    showCaptionAboveMedia: attachment.showCaptionAboveMedia,
  });
}
