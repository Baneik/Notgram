import { afterEach, describe, expect, it } from "vitest";
import { applyLanguagePreference } from "../i18n";
import { mapTdMessage, mapTdMessageContent } from "./tdlibMapper";
import { mapTdServiceEvent } from "./tdlibServiceMessages";
import { formatServiceMoney, presentServiceEvent, servicePartsText } from "./serviceMessages";

afterEach(() => applyLanguagePreference("zh-CN"));

// A protocol inventory, with an expected user-facing meaning for every supported notice.
// Keep compatibility types here as well so old persisted histories remain readable.
const notices: Array<[string, Record<string, unknown>, string]> = [
  ["messageCall", { is_video: true, duration: 61 }, "视频通话 · 1 分 1 秒"],
  ["messageGroupCall", { is_active: true }, "多人通话进行中"],
  ["messageBasicGroupChatCreate", { title: "讨论" }, "群聊已创建：讨论"],
  ["messageSupergroupChatCreate", { title: "讨论" }, "群聊已创建：讨论"],
  ["messageChatAddMembers", { member_user_ids: [7] }, "Alice 加入了群聊"],
  ["messageChatJoinByLink", {}, "有成员通过邀请链接加入了群聊"],
  ["messageChatJoinByRequest", {}, "入群申请已通过"],
  ["messageChatDeleteMember", { user_id: 7 }, "Alice 已离开群聊"],
  ["messageChatChangeTitle", { title: "计划" }, "名称已更改：计划"],
  ["messageChatChangePhoto", {}, "更新了聊天头像"],
  ["messageChatDeletePhoto", {}, "移除了聊天头像"],
  ["messageChatUpgradeTo", {}, "群聊已升级为超级群组"],
  ["messageChatUpgradeFrom", { title: "原群" }, "群聊已完成升级：原群"],
  ["messagePinMessage", { message_id: 100 }, "置顶了一条消息"],
  ["messageScreenshotTaken", {}, "截取了聊天截图"],
  ["messageChatSetMessageAutoDeleteTime", { message_auto_delete_time: 86400 }, "新消息将在 1 天 后自动删除"],
  ["messageAutoDeleteTime", { time: 3600 }, "新消息将在 1 小时 后自动删除"],
  ["messageChatSetTheme", { theme: { "@type": "chatThemeEmoji", name: "🌙" } }, "聊天主题已更改：🌙"],
  ["messageChatSetBackground", {}, "聊天背景已更改"],
  ["messageChatHasProtectedContentToggled", { new_has_protected_content: true }, "已禁止转发和保存内容"],
  ["messageChatHasProtectedContentDisableRequested", {}, "已请求关闭内容保护"],
  ["messageChatBoost", { boost_count: 2 }, "为群聊助力 2 次"],
  ["messageForumTopicCreated", { name: "设计" }, "话题已创建：设计"],
  ["messageForumTopicEdited", { name: "实现" }, "话题已更新：实现"],
  ["messageForumTopicIsClosedToggled", { is_closed: true }, "话题已关闭"],
  ["messageForumTopicIsHiddenToggled", { is_hidden: true }, "话题已隐藏"],
  ["messageVideoChatScheduled", {}, "视频聊天已安排"],
  ["messageVideoChatStarted", {}, "视频聊天已开始"],
  ["messageVideoChatEnded", { duration: 120 }, "视频聊天已结束 · 2 分钟"],
  ["messageInviteVideoChatParticipants", { user_ids: [7] }, "有成员 邀请 Alice 参加视频聊天"],
  ["messageContactRegistered", {}, "有成员 加入了 Telegram"],
  ["messageCustomServiceAction", { text: "自定义通知" }, "自定义通知"],
  ["messageGameScore", { score: 10, game_message_id: 99 }, "游戏得分：10"],
  ["messagePaymentSuccessful", { currency: "XTR", total_amount: 25 }, "付款成功 · 25 Stars"],
  ["messagePaymentSuccessfulBot", {}, "付款成功"],
  ["messagePaymentRefunded", { currency: "XTR", total_amount: 25 }, "付款已退款 · 25 Stars"],
  ["messageGiftedPremium", { month_count: 3 }, "赠送了 Telegram Premium"],
  ["messagePremiumGiftCode", {}, "发送了 Telegram Premium 礼品码"],
  ["messageGiftedStars", { star_count: 50 }, "赠送了 50 Stars"],
  ["messageGiftedTon", { gram_amount: 1234567890 }, "赠送了 1.23456789 TON"],
  ["messageGift", {}, "发送了一份礼物"],
  ["messageUpgradedGift", { gift: { title: "纪念徽章" } }, "礼物已升级：纪念徽章"],
  ["messageRefundedUpgradedGift", {}, "礼物已退款"],
  ["messageUpgradedGiftPurchaseOffer", {}, "发起了礼物购买报价"],
  ["messageUpgradedGiftPurchaseOfferRejected", {}, "礼物购买报价已拒绝"],
  ["messageGiveaway", { winner_count: 3 }, "抽奖已开始"],
  ["messageGiveawayCreated", {}, "抽奖已开始"],
  ["messageGiveawayCompleted", {}, "抽奖已结束"],
  ["messageGiveawayWinners", {}, "抽奖结果已公布"],
  ["messageGiveawayPrizeStars", { star_count: 10 }, "抽奖奖品已发放 · 10 Stars"],
  ["messageUsersShared", { users: [{ user_id: 7 }] }, "分享了 Alice 的信息"],
  ["messageChatShared", { chat: { title: "朋友" } }, "分享了聊天信息：朋友"],
  ["messageBotWriteAccessAllowed", {}, "已允许机器人发送消息"],
  ["messageWebAppDataSent", {}, "已向小程序发送数据"],
  ["messageWebAppDataReceived", {}, "已从小程序收到数据"],
  ["messagePassportDataSent", {}, "已发送身份验证资料"],
  ["messagePassportDataReceived", {}, "已收到身份验证资料"],
  ["messageProximityAlertTriggered", { traveler_id: { user_id: 7 }, watcher_id: { user_id: 8 }, distance: 100 }, "Alice 已靠近 Bob"],
  ["messageChecklistTasksAdded", { tasks: [{ id: 1 }, { id: 2 }] }, "在清单中添加了 2 项任务"],
  ["messageChecklistTasksDone", { marked_as_done_task_ids: [1] }, "清单任务状态已更新"],
  ["messagePollOptionAdded", { text: { text: "周六" } }, "投票中添加了新选项 · 周六"],
  ["messagePollOptionDeleted", { text: { text: "周日" } }, "投票选项已移除 · 周日"],
  ["messageChatAddedToCommunity", {}, "群聊已加入社区"],
  ["messageChatAddToCommunity", {}, "群聊已加入社区"],
  ["messageChatRemovedFromCommunity", {}, "群聊已从社区移除"],
  ["messageChatOwnerChanged", { new_owner_user_id: 7 }, "Alice 成为了群主"],
  ["messageChatOwnerLeft", { new_owner_user_id: 7 }, "群主已离开，Alice 成为新群主"],
  ["messageManagedBotCreated", { bot_user_id: 7 }, "创建了管理机器人 Alice"],
  ["messageDirectMessagePriceChanged", { is_enabled: false }, "已关闭频道私信"],
  ["messagePaidMessagePriceChanged", { paid_message_star_count: 5 }, "每条消息收费 5 Stars"],
  ["messagePaidMessagesRefunded", { star_count: 10 }, "付费消息费用已退还 · 10 Stars"],
  ["messageSuggestedPostApprovalFailed", {}, "投稿未能通过审核"],
  ["messageSuggestedPostApproved", {}, "投稿已通过"],
  ["messageSuggestedPostDeclined", {}, "投稿已拒绝"],
  ["messageSuggestedPostPaid", {}, "投稿报酬已支付"],
  ["messageSuggestedPostRefunded", {}, "投稿费用已退还"],
  ["messageSuggestBirthdate", {}, "建议添加生日"],
  ["messageSuggestProfilePhoto", {}, "建议更新头像"],
  ["messageExpiredPhoto", {}, "照片已过期"],
  ["messageExpiredVideo", {}, "视频已过期"],
  ["messageExpiredVideoNote", {}, "视频消息已过期"],
  ["messageExpiredVoiceNote", {}, "语音消息已过期"],
  ["messageEmpty", {}, "消息内容为空"],
  ["messageUnsupported", {}, "此消息暂不支持显示，请使用 Telegram 查看"],
  ["messageStakeDice", { value: 6, stake_gram_amount: 1e9, prize_gram_amount: 3e9 }, "骰子点数：6"],
];
const context = { personName: (id: string) => ({ "7": "Alice", "8": "Bob" })[id] ?? `User ${id}` };
const present = (raw: Record<string, unknown>) => presentServiceEvent(mapTdServiceEvent(raw)!, context);
const shown = (raw: Record<string, unknown>) => servicePartsText(present(raw).parts);

describe("service message protocol coverage", () => {
  it.each(notices)("renders %s", (type, payload, expected) => {
    const raw = { "@type": type, ...payload };
    expect(mapTdMessageContent(raw).kind).toBe("service");
    expect(shown(raw)).toBe(expected);
    expect(shown(raw)).not.toMatch(/undefined|NaN|\{\{|\uFFF0/);
  });

  it("distinguishes self joins, invitations, approvals, exits, and removals", () => {
    const render = (type: string, fields: Record<string, unknown>, actor = 7) => {
      const content = mapTdMessage({ id: 1, chat_id: 2, sender_id: { "@type": "messageSenderUser", user_id: actor }, date: 1,
        content: { "@type": type, ...fields } })!.content;
      if (content.kind !== "service" || !content.event) throw Error("Missing event");
      return servicePartsText(presentServiceEvent(content.event, context).parts);
    };
    expect(render("messageChatAddMembers", { member_user_ids: [7] })).toBe("Alice 加入了群聊");
    expect(render("messageChatAddMembers", { member_user_ids: [8] })).toBe("Alice 邀请 Bob 加入群聊");
    expect(render("messageChatJoinByLink", {})).toBe("Alice 通过邀请链接加入了群聊");
    expect(render("messageChatJoinByRequest", {})).toBe("Alice 的入群申请已通过");
    expect(render("messageChatDeleteMember", { user_id: 7 })).toBe("Alice 离开了群聊");
    expect(render("messageChatDeleteMember", { user_id: 8 })).toBe("Alice 将 Bob 移出了群聊");
  });

  it("uses current TDLib fields before legacy fields", () => {
    expect(shown({ "@type": "messageChatHasProtectedContentToggled", new_has_protected_content: false, has_protected_content: true })).toBe("已允许转发和保存内容");
    expect(shown({ "@type": "messageForumTopicCreated", name: "Current", topic_info: { name: "Old" } })).toBe("话题已创建：Current");
    expect(shown({ "@type": "messageChatSetTheme", theme: { "@type": "chatThemeGift", gift_theme: { gift: { title: "Gift theme" } } }, theme_name: "Old" })).toBe("聊天主题已更改：Gift theme");
  });

  it("preserves message targets and presents details without flattening person identities", () => {
    const pin = presentServiceEvent(mapTdServiceEvent({ "@type": "messagePinMessage", message_id: 18 })!, { targetSummary: "A plan" });
    expect(pin.parts[0]).toEqual({ kind: "message", messageId: "18", text: "置顶了一条消息：A plan" });
    const result = present({ "@type": "messageGiftedPremium", gifter_user_id: 7, receiver_user_id: 8, month_count: 3 });
    expect(result.parts[0]).toMatchObject({ kind: "person", id: "7", text: "Alice" });
    expect(result.details.flat()).toContainEqual({ kind: "person", id: "8", text: "Bob" });
    expect(result.details.map(servicePartsText)).toContain("3 个月 Premium");
    expect(present({ "@type": "messagePaymentSuccessful", invoice_chat_id: 9, invoice_message_id: 18 }).details.flat())
      .toContainEqual({ kind: "message", chatId: "9", messageId: "18", text: "查看相关消息" });
  });

  it("shows dates, counts, refund and toggle variants", () => {
    expect(shown({ "@type": "messageVideoChatScheduled", start_date: 1_800_000_000 })).toMatch(/2027/);
    expect(shown({ "@type": "messageForumTopicIsClosedToggled", is_closed: false })).toBe("话题已重新打开");
    expect(shown({ "@type": "messageForumTopicIsHiddenToggled", is_hidden: false })).toBe("话题已显示");
    expect(shown({ "@type": "messageChatSetMessageAutoDeleteTime", message_auto_delete_time: 0 })).toBe("已关闭消息自动删除");
    expect(shown({ "@type": "messageGiveawayWinners", was_refunded: true })).toBe("抽奖已取消并退款");
    expect(shown({ "@type": "messageGroupCall", was_missed: true, is_video: true })).toBe("未接多人视频通话");
    expect(present({ "@type": "messageChecklistTasksDone", marked_as_done_task_ids: [1, 2], marked_as_not_done_task_ids: [3] }).details.map(servicePartsText))
      .toEqual(["完成了 2 项任务", "将 1 项任务改为未完成"]);
    expect(present({ "@type": "messageGiveaway", winner_count: 10, prize: { star_count: 100 } }).details.map(servicePartsText))
      .toEqual(["10 位获奖者", "奖品：100 Stars"]);
  });

  it("formats currency-specific units including zero-decimal, three-decimal, Stars and TON", () => {
    applyLanguagePreference("en");
    expect(formatServiceMoney({ currency: "USD", amount: 1234 })).toBe("$12.34");
    expect(formatServiceMoney({ currency: "JPY", amount: 1234 })).toContain("1,234");
    expect(formatServiceMoney({ currency: "KWD", amount: 1234 })).toContain("1.234");
    expect(formatServiceMoney({ currency: "XTR", amount: 1.25 })).toBe("1.25 Stars");
    expect(formatServiceMoney({ currency: "TON", amount: 1 })).toBe("0.000000001 TON");
  });

  it("updates cached events with the UI language and treats names as literal text", () => {
    const event = { type: "messageChatAddMembers", actorId: "7", memberIds: ["8"] };
    const maliciousName = "<b>name</b>{{actor}}\uFFF0members\uFFF1";
    const first = presentServiceEvent(event, { personName: () => maliciousName });
    expect(first.parts.filter(part => part.kind === "person").map(part => part.text)).toEqual([maliciousName, maliciousName]);
    applyLanguagePreference("en");
    expect(servicePartsText(presentServiceEvent(event, context).parts)).toBe("Alice invited Bob to the group");
    applyLanguagePreference("ja");
    expect(servicePartsText(presentServiceEvent(event, context).parts)).toBe("Alice が Bob をグループに招待しました");
  });

  it("keeps large member lists compact while retaining all detail identities", () => {
    const result = present({ "@type": "messageChatAddMembers", member_user_ids: [7, 8, 9, 10, 11] });
    expect(servicePartsText(result.parts)).toContain("等 5 人");
    expect(result.details[0].filter(part => part.kind === "person")).toHaveLength(5);
  });

  it("never retains sensitive service payloads or executable image URLs", () => {
    for (const type of ["messagePaymentSuccessfulBot", "messagePassportDataReceived", "messagePremiumGiftCode", "messageWebAppDataReceived"]) {
      const mapped = mapTdServiceEvent({ "@type": type, invoice_payload: "SECRET", order_info: { name: "SECRET" },
        credentials: "SECRET", elements: ["SECRET"], code: "SECRET", data: "SECRET" });
      expect(JSON.stringify(mapped)).not.toContain("SECRET");
    }
    const photo = mapTdServiceEvent({ "@type": "messageChatChangePhoto", photo: { minithumbnail: { data: "javascript:alert(1)" } } });
    expect(photo?.photo?.previewDataUrl).toBeUndefined();
  });
});
