import { currentLanguage, translate } from "../i18n";
import type { ServiceMessageEvent, ServiceMessageMoney, ServiceMessagePart, ServiceMessagePresentation } from "./serviceMessageTypes";
import type { MessageContent } from "./types";

export const servicePersonIds = (content: MessageContent): string[] => content.kind !== "service" ? []
  : [...new Set([...(content.memberUserIds ?? []), ...(content.event?.memberIds ?? []),
      content.event?.actorId, content.event?.recipientId].filter((id): id is string => Boolean(id)))];

const plain = (text: string): ServiceMessagePart => ({ kind: "text", text });
export const servicePartsText = (parts: ServiceMessagePart[]) => parts.map(part => part.text).join("");

export const formatServiceMoney = ({ currency, amount }: ServiceMessageMoney): string => {
  if (currency === "XTR") return `${new Intl.NumberFormat(currentLanguage(), { maximumFractionDigits: 9 }).format(amount)} Stars`;
  if (currency === "TON") return `${new Intl.NumberFormat(currentLanguage(), { maximumFractionDigits: 9 }).format(amount / 1e9)} TON`;
  try {
    const formatter = new Intl.NumberFormat(currentLanguage(), { style: "currency", currency });
    return formatter.format(amount / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2));
  } catch {
    return `${amount} ${currency}`;
  }
};

const duration = (seconds: number) => {
  if (seconds <= 0) return "";
  if (seconds % 86400 === 0) return translate("{{count}} 天", { count: seconds / 86400 });
  if (seconds % 3600 === 0) return translate("{{count}} 小时", { count: seconds / 3600 });
  if (seconds % 60 === 0) return translate("{{count}} 分钟", { count: seconds / 60 });
  if (seconds < 60) return translate("{{count}} 秒", { count: seconds });
  return translate("{{minutes}} 分 {{seconds}} 秒", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
};
const dateTime = (seconds?: number) => seconds && seconds > 0
  ? new Intl.DateTimeFormat(currentLanguage(), { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(seconds * 1000)) : "";

export interface ServicePresentationContext {
  personName?: (id: string) => string;
  targetSummary?: string;
}

export const presentServiceEvent = (event: ServiceMessageEvent, context: ServicePresentationContext = {}): ServiceMessagePresentation => {
  const details: ServiceMessagePart[][] = [];
  const person = (id?: string): ServiceMessagePart => id
    ? { kind: "person", id, text: context.personName?.(id) ?? translate("Telegram 用户") }
    : plain(translate("有成员"));
  const members = event.memberIds ?? [];
  const people = (ids: string[]) => ids.flatMap((id, index) => index ? [plain(currentLanguage() === "en" ? ", " : "、"), person(id)] : [person(id)]);
  const memberParts = people(members.slice(0, 3));
  if (members.length > 3) {
    memberParts.push(plain(translate(" 等 {{count}} 人", { count: members.length })));
    details.push(people(members));
  }
  if (!memberParts.length) memberParts.push(plain(translate("成员")));
  const bindings: Record<string, ServiceMessagePart[]> = {
    actor: [person(event.actorId)], members: memberParts, recipient: [person(event.recipientId)],
  };
  // Resolve only our template slots before inserting user-controlled names/text.
  // This preserves translated word order without interpreting names as markup.
  const slots = { actor: "\uFFF0actor\uFFF1", members: "\uFFF0members\uFFF1", recipient: "\uFFF0recipient\uFFF1" };
  const sentence = (text: string): ServiceMessagePart[] => text.split(/(\uFFF0(?:actor|members|recipient)\uFFF1)/g)
    .filter(Boolean).flatMap(part => bindings[part.slice(1, -1)] && part.startsWith("\uFFF0")
      ? bindings[part.slice(1, -1)] : [plain(part)]);
  const actorAction = (text: string) => event.actorId ? [person(event.actorId), plain(` · ${text}`)] : [plain(text)];
  const detail = (text?: string) => { if (text) details.push([plain(text)]); };
  const append = (label: string, value?: string) => value ? `${label} · ${value}` : label;
  const named = (label: string) => event.title ? `${label}：${event.title}` : label;
  const amount = event.money ? formatServiceMoney(event.money) : undefined;
  const link = (label: string): ServiceMessagePart => event.target
    ? { kind: "message", ...event.target, text: context.targetSummary ? `${label}：${context.targetSummary}` : label }
    : plain(label);
  let parts: ServiceMessagePart[];
  switch (event.type) {
    case "messageChatAddMembers":
      parts = event.actorId && !(members.length === 1 && members[0] === event.actorId)
        ? sentence(translate("{{actor}} 邀请 {{members}} 加入群聊", slots))
        : members.length ? sentence(translate("{{members}} 加入了群聊", slots)) : [plain(translate("新成员加入了群聊"))];
      break;
    case "messageChatJoinByLink": parts = event.actorId ? sentence(translate("{{actor}} 通过邀请链接加入了群聊", slots))
      : [plain(translate("有成员通过邀请链接加入了群聊"))]; break;
    case "messageChatJoinByRequest": parts = event.actorId ? sentence(translate("{{actor}} 的入群申请已通过", slots))
      : [plain(translate("入群申请已通过"))]; break;
    case "messageChatDeleteMember":
      parts = !members.length ? [plain(translate("一位成员离开或被移出了群聊"))]
        : event.actorId === members[0] ? sentence(translate("{{members}} 离开了群聊", slots))
          : event.actorId ? sentence(translate("{{actor}} 将 {{members}} 移出了群聊", slots))
            : sentence(translate("{{members}} 已离开群聊", slots)); break;
    case "messageContactRegistered": parts = sentence(translate("{{actor}} 加入了 Telegram", slots)); break;
    case "messageChatOwnerChanged":
      parts = event.recipientId ? sentence(translate("{{recipient}} 成为了群主", slots)) : [plain(translate("群聊所有者已更改"))]; break;
    case "messageChatOwnerLeft":
      parts = event.recipientId ? sentence(translate("群主已离开，{{recipient}} 成为新群主", slots)) : [plain(translate("群聊所有者已离开"))]; break;
    case "messageBasicGroupChatCreate":
    case "messageSupergroupChatCreate": parts = actorAction(named(event.isChannel ? translate("频道已创建") : translate("群聊已创建"))); break;
    case "messageChatChangeTitle": parts = actorAction(named(translate("名称已更改"))); break;
    case "messageChatChangePhoto": parts = actorAction(translate("更新了聊天头像")); break;
    case "messageChatDeletePhoto": parts = actorAction(translate("移除了聊天头像")); break;
    case "messageChatUpgradeTo": parts = [plain(translate("群聊已升级为超级群组"))]; break;
    case "messageChatUpgradeFrom": parts = [plain(named(translate("群聊已完成升级")))]; break;
    case "messageChatAddedToCommunity":
    case "messageChatAddToCommunity": parts = actorAction(translate("群聊已加入社区")); break;
    case "messageChatRemovedFromCommunity": parts = actorAction(translate("群聊已从社区移除")); break;
    case "messagePinMessage": parts = [...(event.actorId ? [person(event.actorId), plain(" · ")] : []), link(translate("置顶了一条消息"))]; break;
    case "messageScreenshotTaken": parts = actorAction(translate("截取了聊天截图")); break;
    case "messageChatSetMessageAutoDeleteTime":
    case "messageAutoDeleteTime": parts = actorAction((event.duration ?? 0) <= 0 ? translate("已关闭消息自动删除")
      : translate("新消息将在 {{duration}} 后自动删除", { duration: duration(event.duration!) })); break;
    case "messageChatSetTheme": parts = actorAction(named(translate("聊天主题已更改"))); break;
    case "messageChatSetBackground": parts = actorAction(event.enabled ? translate("更改了自己的聊天背景") : translate("聊天背景已更改")); break;
    case "messageChatHasProtectedContentToggled": parts = actorAction(event.enabled ? translate("已禁止转发和保存内容") : translate("已允许转发和保存内容")); break;
    case "messageChatHasProtectedContentDisableRequested": parts = actorAction(event.isExpired ? translate("关闭内容保护的申请已过期") : translate("已请求关闭内容保护")); break;
    case "messageChatBoost": parts = actorAction((event.count ?? 0) > 1 ? translate("为群聊助力 {{value0}} 次", { value0: event.count }) : translate("为群聊助力")); break;
    case "messageForumTopicCreated": parts = actorAction(named(translate("话题已创建"))); break;
    case "messageForumTopicEdited": parts = actorAction(named(translate("话题已更新"))); break;
    case "messageForumTopicIsClosedToggled": parts = actorAction(event.enabled ? translate("话题已关闭") : translate("话题已重新打开")); break;
    case "messageForumTopicIsHiddenToggled": parts = actorAction(event.enabled ? translate("话题已隐藏") : translate("话题已显示")); break;
    case "messageCall":
    case "messageGroupCall": {
      const label = event.type === "messageGroupCall" ? (event.isVideo ? translate("多人视频通话") : translate("多人通话")) : (event.isVideo ? translate("视频通话") : translate("通话"));
      const state = event.isMissed ? translate("未接{{value0}}", { value0: label }) : event.isDeclined ? translate("已拒绝{{value0}}", { value0: label })
        : event.isActive ? translate("{{call}}进行中", { call: label }) : event.type === "messageGroupCall" && !event.duration ? translate("{{call}}邀请", { call: label }) : label;
      parts = [plain(append(state, duration(event.duration ?? 0)))];
      if (members.length) details.push(people(members));
      break;
    }
    case "messageVideoChatScheduled": parts = actorAction(append(translate("视频聊天已安排"), dateTime(event.startsAt))); break;
    case "messageVideoChatStarted": parts = actorAction(translate("视频聊天已开始")); break;
    case "messageVideoChatEnded": parts = [plain(append(translate("视频聊天已结束"), duration(event.duration ?? 0)))]; break;
    case "messageInviteVideoChatParticipants": parts = sentence(translate("{{actor}} 邀请 {{members}} 参加视频聊天", slots)); break;
    case "messagePaymentSuccessful":
    case "messagePaymentSuccessfulBot": parts = [plain(append(named(translate("付款成功")), amount))]; break;
    case "messagePaymentRefunded": parts = [plain(append(translate("付款已退款"), amount))]; break;
    case "messagePaidMessagePriceChanged":
    case "messageDirectMessagePriceChanged": parts = actorAction(event.enabled === false ? translate("已关闭频道私信")
      : event.money?.amount === 0 ? translate("发消息已无需付费")
        : amount ? translate("每条消息收费 {{amount}}", { amount }) : translate("付费消息价格已更改")); break;
    case "messagePaidMessagesRefunded": parts = [plain(append(translate("付费消息费用已退还"), amount))];
      if (event.count) detail(translate("共 {{count}} 条消息", { count: event.count })); break;
    case "messageGiftedPremium":
    case "messagePremiumGiftCode":
    case "messageGiftedStars":
    case "messageGiftedTon":
    case "messageGift":
    case "messageUpgradedGift":
    case "messageRefundedUpgradedGift":
    case "messageUpgradedGiftPurchaseOffer":
    case "messageUpgradedGiftPurchaseOfferRejected": {
      const label = event.type === "messageGiftedPremium" ? translate("赠送了 Telegram Premium")
        : event.type === "messagePremiumGiftCode" ? translate("发送了 Telegram Premium 礼品码")
          : event.type === "messageGiftedStars" || event.type === "messageGiftedTon" ? translate("赠送了 {{gift}}", { gift: amount ?? (event.type === "messageGiftedStars" ? "Stars" : "TON") })
            : event.type === "messageUpgradedGift" ? named(translate("礼物已升级"))
              : event.type === "messageRefundedUpgradedGift" || event.isRefunded ? named(translate("礼物已退款"))
                : event.type === "messageUpgradedGiftPurchaseOffer" ? named(translate("发起了礼物购买报价"))
                  : event.type === "messageUpgradedGiftPurchaseOfferRejected" ? (event.isExpired ? translate("礼物购买报价已过期") : translate("礼物购买报价已拒绝"))
                    : named(translate("发送了一份礼物"));
      parts = actorAction(label);
      if (event.recipientId) details.push(sentence(translate("接收人：{{recipient}}", slots)));
      if (event.days) detail(translate("{{count}} 天 Premium", { count: event.days }));
      else if (event.months) detail(translate("{{count}} 个月 Premium", { count: event.months }));
      if (amount && !["messageGiftedStars", "messageGiftedTon"].includes(event.type)) detail(amount);
      if (event.expiresAt) detail(translate("有效期至 {{date}}", { date: dateTime(event.expiresAt) }));
      break;
    }
    case "messageGiveaway":
    case "messageGiveawayCreated":
    case "messageGiveawayCompleted":
    case "messageGiveawayWinners":
    case "messageGiveawayPrizeStars":
      parts = [plain(event.isRefunded ? translate("抽奖已取消并退款")
        : event.type === "messageGiveawayCompleted" ? translate("抽奖已结束")
          : event.type === "messageGiveawayWinners" ? translate("抽奖结果已公布")
            : event.type === "messageGiveawayPrizeStars" ? append(translate("抽奖奖品已发放"), amount) : translate("抽奖已开始"))];
      if (event.count !== undefined) detail(translate("{{count}} 位获奖者", { count: event.count }));
      if (amount && event.type !== "messageGiveawayPrizeStars") detail(translate("奖品：{{prize}}", { prize: amount }));
      if (event.months) detail(translate("奖品：{{count}} 个月 Premium", { count: event.months }));
      if (event.startsAt) detail(translate("开奖时间：{{date}}", { date: dateTime(event.startsAt) }));
      detail(event.text);
      if (members.length) details.push(people(members));
      break;
    case "messageUsersShared": parts = sentence(translate("分享了 {{members}} 的信息", slots)); break;
    case "messageChatShared": parts = actorAction(named(translate("分享了聊天信息"))); break;
    case "messageManagedBotCreated": parts = sentence(translate("创建了管理机器人 {{members}}", slots)); break;
    case "messageBotWriteAccessAllowed": parts = [plain(translate("已允许机器人发送消息"))]; break;
    case "messageWebAppDataSent": parts = [plain(named(translate("已向小程序发送数据")))]; break;
    case "messageWebAppDataReceived": parts = [plain(named(translate("已从小程序收到数据")))]; break;
    case "messagePassportDataSent": parts = [plain(translate("已发送身份验证资料"))]; break;
    case "messagePassportDataReceived": parts = [plain(translate("已收到身份验证资料"))]; break;
    case "messageChecklistTasksAdded": parts = actorAction(event.count ? translate("在清单中添加了 {{count}} 项任务", { count: event.count }) : translate("清单中添加了新任务")); break;
    case "messageChecklistTasksDone":
      parts = actorAction(translate("清单任务状态已更新"));
      if (event.completedCount) detail(translate("完成了 {{count}} 项任务", { count: event.completedCount }));
      if (event.reopenedCount) detail(translate("将 {{count}} 项任务改为未完成", { count: event.reopenedCount })); break;
    case "messagePollOptionAdded": parts = actorAction(append(translate("投票中添加了新选项"), event.text)); break;
    case "messagePollOptionDeleted": parts = actorAction(append(translate("投票选项已移除"), event.text)); break;
    case "messageSuggestedPostApprovalFailed": parts = [plain(translate("投稿未能通过审核"))]; break;
    case "messageSuggestedPostApproved": parts = actorAction(translate("投稿已通过")); break;
    case "messageSuggestedPostDeclined": parts = actorAction(translate("投稿已拒绝")); break;
    case "messageSuggestedPostPaid": parts = [plain(translate("投稿报酬已支付"))]; break;
    case "messageSuggestedPostRefunded": parts = [plain(translate("投稿费用已退还"))]; break;
    case "messageSuggestBirthdate": parts = actorAction(translate("建议添加生日")); break;
    case "messageSuggestProfilePhoto": parts = actorAction(translate("建议更新头像")); break;
    case "messageProximityAlertTriggered":
      parts = sentence(translate("{{actor}} 已靠近 {{recipient}}", slots));
      if (event.count !== undefined) detail(translate("距离 {{count}} 米", { count: event.count })); break;
    case "messageGameScore": parts = actorAction(translate("游戏得分：{{value0}}", { value0: event.count ?? 0 })); break;
    case "messageStakeDice":
      parts = [plain(event.count ? translate("骰子点数：{{count}}", { count: event.count }) : translate("骰子结果待公布"))];
      if (amount) detail(translate("投入：{{amount}}", { amount }));
      if (event.prize) detail(translate("奖励：{{amount}}", { amount: formatServiceMoney(event.prize) })); break;
    case "messageExpiredPhoto": parts = [plain(translate("照片已过期"))]; break;
    case "messageExpiredVideo": parts = [plain(translate("视频已过期"))]; break;
    case "messageExpiredVideoNote": parts = [plain(translate("视频消息已过期"))]; break;
    case "messageExpiredVoiceNote": parts = [plain(translate("语音消息已过期"))]; break;
    case "messageEmpty": parts = [plain(translate("消息内容为空"))]; break;
    case "messageCustomServiceAction": parts = [plain(event.text || translate("聊天状态已更新"))]; break;
    default: parts = [plain(translate("此消息暂不支持显示，请使用 Telegram 查看"))];
  }
  if (event.type.startsWith("messageSuggestedPost")) {
    detail(amount);
    if (event.startsAt) detail(translate("发布时间：{{date}}", { date: dateTime(event.startsAt) }));
    detail(event.text);
    if (event.title === "suggestedPostRefundReasonPostDeleted") detail(translate("投稿已被删除"));
    if (event.title === "suggestedPostRefundReasonPaymentRefunded") detail(translate("付款已撤回"));
  }
  if (event.target && event.type !== "messagePinMessage") details.push([link(translate("查看相关消息"))]);
  return { parts, details };
};
