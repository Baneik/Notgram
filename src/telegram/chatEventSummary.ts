import { translate } from "../i18n";
import type { TdObject } from "./tdlibMapper";

export function chatEventSummary(action: TdObject | undefined): string {
  switch (action?.["@type"]) {
    case "chatEventTitleChanged": return translate("名称改为 {{name}}", { name: action.new_title });
    case "chatEventDescriptionChanged": return translate("更新简介");
    case "chatEventPhotoChanged": return translate("更新聊天头像");
    case "chatEventUsernameChanged": return translate("更新公开用户名");
    case "chatEventPermissionsChanged": return translate("更新默认成员权限");
    case "chatEventSlowModeDelayChanged": return translate("更新慢速模式");
    case "chatEventMessageAutoDeleteTimeChanged": return translate("更新消息自动删除时间");
    case "chatEventLinkedChatChanged": return translate("更改关联讨论群组");
    case "chatEventMemberJoined":
    case "chatEventMemberJoinedByInviteLink": return translate("成员加入聊天");
    case "chatEventMemberJoinedByRequest": return translate("批准成员加入");
    case "chatEventMemberLeft": return translate("成员离开聊天");
    case "chatEventMemberInvited": return translate("邀请成员");
    case "chatEventMemberPromoted": return translate("更改管理员权限");
    case "chatEventMemberRestricted": return translate("更改成员限制");
    case "chatEventMemberTagChanged": return translate("更改成员标签");
    case "chatEventInviteLinkEdited":
    case "chatEventInviteLinkRevoked":
    case "chatEventInviteLinkDeleted": return translate("更改邀请链接");
    case "chatEventMessageEdited": return translate("编辑消息");
    case "chatEventMessageDeleted": return translate("删除消息");
    case "chatEventMessagePinned": return translate("置顶消息");
    case "chatEventMessageUnpinned": return translate("取消置顶消息");
    case "chatEventIsForumToggled": return translate("更改话题模式");
    case "chatEventForumTopicCreated": return translate("创建话题");
    case "chatEventForumTopicEdited": return translate("编辑话题");
    case "chatEventForumTopicDeleted": return translate("删除话题");
    case "chatEventForumTopicPinned": return translate("更改话题置顶");
    case "chatEventForumTopicToggleIsClosed": return translate("更改话题状态");
    case "chatEventForumTopicToggleIsHidden": return translate("更改默认话题显示");
    case "chatEventHasProtectedContentToggled": return translate("更改内容保护");
    case "chatEventHasHiddenMembersToggled": return translate("更改成员列表显示");
    case "chatEventHasAggressiveAntiSpamEnabledToggled": return translate("更改反垃圾设置");
    case "chatEventSignMessagesToggled":
    case "chatEventShowMessageSenderToggled": return translate("更改频道签名");
    case "chatEventJoinByRequestToggled": return translate("更改加入审批");
    default: return translate("群组设置更新");
  }
}
