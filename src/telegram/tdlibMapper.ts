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

const thumbnailDetails = (value: unknown) => {
  const thumbnail = asTdObject(value);
  const file = asTdObject(thumbnail?.file);
  const local = asTdObject(file?.local);
  return {
    thumbnailPath: localImagePath(file),
    thumbnailFileId: tdNumber(file?.id),
    thumbnailCanDownload: local?.can_be_downloaded === true,
    thumbnailIsDownloading: local?.is_downloading_active === true,
  };
};

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
          caption: formattedText(content.caption) || undefined,
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
      return serviceContent(`收到新类型消息（${type}）`);
    }
  }
};

export const messagePreview = (value: unknown) => {
  const content = mapTdMessageContent(asTdObject(value)?.content ?? value);
  return content.kind === "text" || content.kind === "service" ? content.text : content.fileName;
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
