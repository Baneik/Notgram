import { asTdObject, asTdObjects, tdId, tdNumber, type TdObject } from "./tdlibValues";
import type { ServiceMessageEvent, ServiceMessageMoney } from "./serviceMessageTypes";

const text = (value: unknown): string | undefined => {
  const result = typeof value === "string" ? value : asTdObject(value)?.text;
  return typeof result === "string" && result.trim() ? result.trim() : undefined;
};
const id = (value: unknown) => {
  const result = tdId(value);
  return result && result !== "0" ? result : undefined;
};
const ids = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.map(id).filter((value): value is string => Boolean(value)))] : [];
const sender = (value: unknown) => {
  const object = asTdObject(value);
  return object?.["@type"] === "messageSenderChat"
    ? (id(object.chat_id) ? `chat:${id(object.chat_id)}` : undefined) : id(object?.user_id);
};
const money = (currency: unknown, amount: unknown): ServiceMessageMoney | undefined => {
  const number = tdNumber(amount);
  return typeof currency === "string" && currency && number !== undefined
    ? { currency, amount: number } : undefined;
};
const price = (value: unknown) => {
  const raw = asTdObject(value);
  return money("XTR", raw?.star_count) ??
    money("TON", raw?.gram_cent_count === undefined ? undefined : Number(raw.gram_cent_count) * 10_000_000);
};
const target = (messageId: unknown, chatId?: unknown): ServiceMessageEvent["target"] =>
  id(messageId) ? { messageId: id(messageId)!, ...(id(chatId) ? { chatId: id(chatId) } : {}) } : undefined;
const photo = (value: unknown): ServiceMessageEvent["photo"] => {
  const raw = asTdObject(value);
  const sizes = asTdObjects(raw?.sizes).sort((a, b) => (tdNumber(a.width) ?? 0) - (tdNumber(b.width) ?? 0));
  const downloaded = sizes.map(size => asTdObject(asTdObject(size.photo)?.local)).find(file =>
    file?.is_downloading_completed === true && typeof file.path === "string" && file.path);
  const data = asTdObject(raw?.minithumbnail)?.data;
  // Inline/local previews need no new file lease and remain safe in persisted service records.
  return downloaded || typeof data === "string" ? {
    localPath: downloaded?.path as string | undefined,
    previewDataUrl: typeof data === "string" && data.length <= 32768 && /^[A-Za-z0-9+/=]+$/.test(data)
      ? `data:image/jpeg;base64,${data}` : undefined,
  } : undefined;
};

export const mapTdServiceEvent = (content: TdObject): ServiceMessageEvent | undefined => {
  const type = text(content["@type"]);
  if (!type) return undefined;
  const event: ServiceMessageEvent = { type };
  switch (type) {
    case "messageChatAddMembers":
    case "messageInviteVideoChatParticipants":
      return { ...event, memberIds: ids(content.member_user_ids ?? content.user_ids) };
    case "messageChatDeleteMember":
      return { ...event, memberIds: ids([content.user_id]) };
    case "messageChatOwnerChanged":
    case "messageChatOwnerLeft":
      return { ...event, recipientId: id(content.new_owner_user_id) };
    case "messageManagedBotCreated":
      return { ...event, memberIds: ids([content.bot_user_id]) };
    case "messageUsersShared":
      return { ...event, memberIds: ids(asTdObjects(content.users).map(user => user.user_id)) };
    case "messageBasicGroupChatCreate":
    case "messageSupergroupChatCreate":
    case "messageChatChangeTitle":
    case "messageChatUpgradeFrom":
      return { ...event, title: text(content.title), isChannel: content.is_channel === true };
    case "messageChatChangePhoto":
    case "messageSuggestProfilePhoto":
      return { ...event, photo: photo(content.photo) };
    case "messageChatSetTheme": {
      const theme = asTdObject(content.theme);
      return { ...event, title: text(theme?.name) ?? text(asTdObject(asTdObject(theme?.gift_theme)?.gift)?.title) ?? text(content.theme_name) };
    }
    case "messageChatHasProtectedContentToggled":
      return { ...event, enabled: typeof content.new_has_protected_content === "boolean"
        ? content.new_has_protected_content : content.has_protected_content === true };
    case "messageChatHasProtectedContentDisableRequested":
      return { ...event, isExpired: content.is_expired === true };
    case "messageChatSetBackground":
      return { ...event, enabled: content.only_for_self === true };
    case "messageChatSetMessageAutoDeleteTime":
    case "messageAutoDeleteTime":
      return { ...event, duration: tdNumber(content.message_auto_delete_time ?? content.time) ?? 0 };
    case "messageChatBoost":
      return { ...event, count: tdNumber(content.boost_count) };
    case "messagePinMessage":
      return { ...event, target: target(content.message_id) };
    case "messageForumTopicCreated":
      return { ...event, title: text(content.name) ?? text(asTdObject(content.topic_info)?.name) };
    case "messageForumTopicEdited":
      return { ...event, title: text(content.name) };
    case "messageForumTopicIsClosedToggled":
      return { ...event, enabled: content.is_closed === true };
    case "messageForumTopicIsHiddenToggled":
      return { ...event, enabled: content.is_hidden === true };
    case "messageCall":
    case "messageGroupCall":
      return { ...event, duration: tdNumber(content.duration), isVideo: content.is_video === true,
        isMissed: content.was_missed === true || asTdObject(content.discard_reason)?.["@type"] === "callDiscardReasonMissed",
        isDeclined: asTdObject(content.discard_reason)?.["@type"] === "callDiscardReasonDeclined",
        isActive: content.is_active === true,
        memberIds: asTdObjects(content.other_participant_ids).map(sender).filter((value): value is string => Boolean(value)) };
    case "messageVideoChatScheduled":
      return { ...event, startsAt: tdNumber(content.start_date) };
    case "messageVideoChatEnded":
      return { ...event, duration: tdNumber(content.duration) };
    case "messagePaymentSuccessful":
    case "messagePaymentSuccessfulBot":
    case "messagePaymentRefunded":
      return { ...event, money: money(content.currency, content.total_amount), title: text(content.invoice_name),
        target: target(content.invoice_message_id, content.invoice_chat_id) };
    case "messagePaidMessagePriceChanged":
    case "messageDirectMessagePriceChanged":
      return { ...event, money: money("XTR", content.paid_message_star_count), enabled: content.is_enabled !== false };
    case "messagePaidMessagesRefunded":
      return { ...event, money: money("XTR", content.star_count), count: tdNumber(content.message_count) };
    case "messageGiftedPremium":
    case "messagePremiumGiftCode":
    case "messageGiftedStars":
    case "messageGiftedTon":
      return { ...event, actorId: id(content.gifter_user_id) ?? sender(content.creator_id), recipientId: id(content.receiver_user_id),
        months: tdNumber(content.month_count), days: tdNumber(content.day_count),
        money: type === "messageGiftedStars" ? money("XTR", content.star_count)
          : type === "messageGiftedTon" ? money("TON", content.gram_amount) : money(content.currency, content.amount) };
    case "messageGift":
    case "messageUpgradedGift":
    case "messageRefundedUpgradedGift":
    case "messageUpgradedGiftPurchaseOffer":
    case "messageUpgradedGiftPurchaseOfferRejected": {
      const gift = asTdObject(content.gift);
      return { ...event, actorId: sender(content.sender_id), recipientId: sender(content.receiver_id),
        title: text(gift?.title), money: price(content.price), isRefunded: content.was_refunded === true,
        isExpired: content.was_expired === true, expiresAt: tdNumber(content.expiration_date), target: target(content.offer_message_id) };
    }
    case "messageGiveaway":
    case "messageGiveawayCreated":
    case "messageGiveawayCompleted":
    case "messageGiveawayWinners":
    case "messageGiveawayPrizeStars": {
      const prize = asTdObject(content.prize);
      return { ...event, count: tdNumber(content.winner_count), months: tdNumber(prize?.month_count),
        money: money("XTR", content.star_count ?? prize?.star_count), memberIds: ids(content.winner_user_ids),
        startsAt: tdNumber(content.actual_winners_selection_date ?? asTdObject(content.parameters)?.winners_selection_date),
        text: text(content.prize_description), isRefunded: content.was_refunded === true,
        target: target(content.giveaway_message_id, content.boosted_chat_id) };
    }
    case "messageChecklistTasksAdded":
      return { ...event, count: Array.isArray(content.tasks) ? content.tasks.length : undefined, target: target(content.checklist_message_id) };
    case "messageChecklistTasksDone":
      return { ...event, completedCount: ids(content.marked_as_done_task_ids).length,
        reopenedCount: ids(content.marked_as_not_done_task_ids).length, target: target(content.checklist_message_id) };
    case "messagePollOptionAdded":
    case "messagePollOptionDeleted":
      return { ...event, text: text(content.text), target: target(content.poll_message_id) };
    case "messageSuggestedPostApprovalFailed":
    case "messageSuggestedPostApproved":
    case "messageSuggestedPostDeclined":
    case "messageSuggestedPostPaid":
    case "messageSuggestedPostRefunded": {
      const stars = asTdObject(content.star_amount);
      const amount = tdNumber(stars?.star_count);
      return { ...event, target: target(content.suggested_post_message_id), startsAt: tdNumber(content.send_date),
        text: text(content.comment), title: text(asTdObject(content.reason)?.["@type"]),
        money: price(content.price) ?? (amount !== undefined
          ? money("XTR", amount + (tdNumber(stars?.nanostar_count) ?? 0) / 1e9) : money("TON", content.gram_amount)) };
    }
    case "messageGameScore":
      return { ...event, count: tdNumber(content.score), target: target(content.game_message_id) };
    case "messageStakeDice":
      return { ...event, count: tdNumber(content.value), money: money("TON", content.stake_gram_amount), prize: money("TON", content.prize_gram_amount) };
    case "messageProximityAlertTriggered":
      return { ...event, actorId: sender(content.traveler_id), recipientId: sender(content.watcher_id), count: tdNumber(content.distance) };
    case "messageChatShared":
      return { ...event, title: text(asTdObject(content.chat)?.title) };
    case "messageCustomServiceAction":
      return { ...event, text: text(content.text) };
    case "messageWebAppDataSent":
    case "messageWebAppDataReceived":
      return { ...event, title: text(content.button_text) };
    case "messageChatJoinByLink":
    case "messageChatJoinByRequest":
    case "messageChatDeletePhoto":
    case "messageChatUpgradeTo":
    case "messageScreenshotTaken":
    case "messageVideoChatStarted":
    case "messageContactRegistered":
    case "messageBotWriteAccessAllowed":
    case "messagePassportDataSent":
    case "messagePassportDataReceived":
    case "messageChatAddedToCommunity":
    case "messageChatAddToCommunity":
    case "messageChatRemovedFromCommunity":
    case "messageSuggestBirthdate":
    case "messageExpiredPhoto":
    case "messageExpiredVideo":
    case "messageExpiredVideoNote":
    case "messageExpiredVoiceNote":
    case "messageEmpty":
    case "messageUnsupported":
      return event;
    default: return undefined;
  }
};
