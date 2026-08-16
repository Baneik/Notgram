use serde_json::{Value, json};
use std::path::Path;

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedTextMention {
    pub offset: i32,
    pub length: i32,
    pub user_id: i64,
}

const WEBVIEW_TDLIB_REQUESTS: &[&str] = &[
    "addChatToList",
    "addChatMembers",
    "canTransferOwnership",
    "cancelDownloadFile",
    "setChatMemberStatus",
    "setChatMemberTag",
    "addMessageReaction",
    "addProxy",
    "checkAuthenticationCode",
    "checkAuthenticationEmailCode",
    "checkAuthenticationPassword",
    "createChatFolder",
    "createForumTopic",
    "createNewBasicGroupChat",
    "createNewSupergroupChat",
    "createChatInviteLink",
    "createChatSubscriptionInviteLink",
    "createPrivateChat",
    "deleteChatFolder",
    "deleteMessages",
    "disableProxy",
    "downloadFile",
    "editChatFolder",
    "editForumTopic",
    "editMessageText",
    "editChatInviteLink",
    "editChatSubscriptionInviteLink",
    "enableProxy",
    "forwardMessages",
    "getChat",
    "getChatFolder",
    "getChatHistory",
    "getChatMessageByDate",
    "getForumTopic",
    "getForumTopicHistory",
    "getForumTopics",
    "getChatInviteLinks",
    "getChatJoinRequests",
    "getMessageLinkInfo",
    "getChatAdministrators",
    "getBlockedMessageSenders",
    "getActiveSessions",
    "getUserPrivacySettingRules",
    "getInlineQueryResults",
    "getCallbackQueryAnswer",
    "getChatPinnedMessage",
    "getChats",
    "getBasicGroupFullInfo",
    "getBasicGroup",
    "getContacts",
    "getAuthorizationState",
    "getFile",
    "getInstalledStickerSets",
    "getMe",
    "getMessageProperties",
    "getOption",
    "getRecentStickers",
    "getSavedAnimations",
    "getStickerSet",
    "getStickers",
    "getFullRichMessage",
    "getProxies",
    "getRepliedMessage",
    "getSecretChat",
    "getSupergroupFullInfo",
    "getSupergroup",
    "getSupergroupMembers",
    "getUser",
    "getUserFullInfo",
    "leaveChat",
    "loadChats",
    "logOut",
    "parseMarkdown",
    "pinChatMessage",
    "pingProxy",
    "registerUser",
    "requestQrCodeAuthentication",
    "removeMessageReaction",
    "revokeChatInviteLink",
    "resendMessages",
    "searchChatMessages",
    "searchChatMembers",
    "searchChatsOnServer",
    "searchMessages",
    "searchPublicChat",
    "searchPublicChats",
    "sendMessage",
    "sendInlineQueryResultMessage",
    "sendBotStartMessage",
    "setBio",
    "setAuthenticationEmailAddress",
    "setAuthenticationPhoneNumber",
    "setChatDraftMessage",
    "setChatPermissions",
    "setChatSlowModeDelay",
    "processChatJoinRequest",
    "processChatJoinRequests",
    "reportChat",
    "setMessageSenderBlockList",
    "setUserPrivacySettingRules",
    "terminateSession",
    "terminateAllOtherSessions",
    "transferChatOwnership",
    "getChatEventLog",
    "setChatNotificationSettings",
    "setChatMessageAutoDeleteTime",
    "setName",
    "setPinnedChats",
    "setPollAnswer",
    "setSupergroupUsername",
    "setUsername",
    "toggleChatIsMarkedAsUnread",
    "toggleChatIsPinned",
    "toggleSupergroupIsAllHistoryAvailable",
    "toggleForumTopicIsClosed",
    "toggleForumTopicIsPinned",
    "unpinChatMessage",
    "viewMessages",
];

pub(super) fn request_type_from_extra(extra: &str) -> Option<&str> {
    extra.strip_prefix("native:")
}

pub(super) fn validate_webview_extra(extra: &str) -> Result<(), String> {
    let valid = extra.len() == 36
        && extra
            .chars()
            .enumerate()
            .all(|(index, character)| match index {
                8 | 13 | 18 | 23 => character == '-',
                _ => character.is_ascii_hexdigit(),
            });
    if valid {
        Ok(())
    } else {
        Err("Invalid TDLib request correlation identifier".to_string())
    }
}

fn contains_tdlib_type(value: &Value, rejected: &[&str]) -> bool {
    match value {
        Value::Object(object) => {
            object
                .get("@type")
                .and_then(Value::as_str)
                .is_some_and(|kind| rejected.contains(&kind))
                || object
                    .values()
                    .any(|nested| contains_tdlib_type(nested, rejected))
        }
        Value::Array(values) => values
            .iter()
            .any(|nested| contains_tdlib_type(nested, rejected)),
        _ => false,
    }
}

pub(super) fn validate_webview_tdlib_request(request: &Value) -> Result<(), String> {
    let request_type = request
        .get("@type")
        .and_then(Value::as_str)
        .ok_or_else(|| "TDLib request is missing @type".to_string())?;
    if !WEBVIEW_TDLIB_REQUESTS.contains(&request_type) {
        return Err(format!("TDLib request type is not allowed: {request_type}"));
    }
    let extra = request
        .get("@extra")
        .and_then(Value::as_str)
        .ok_or_else(|| "TDLib request is missing @extra".to_string())?;
    validate_webview_extra(extra)?;
    if contains_tdlib_type(request, &["inputFileLocal", "inputFileGenerated"]) {
        return Err("Local files cannot be sent through the generic TDLib bridge".to_string());
    }
    match request_type {
        "cancelDownloadFile" => {
            validate_nonzero_identifier(request, "file_id")?;
            if request
                .get("only_if_pending")
                .and_then(Value::as_bool)
                .is_none()
            {
                return Err("Download cancellation mode is missing".to_string());
            }
        }
        "getOption" => {
            if request.get("name").and_then(Value::as_str) != Some("dc_id") {
                return Err("Only the data-center option can be read".to_string());
            }
        }
        "setName" => {
            validate_profile_text(request, "first_name", 64, false, true)?;
            validate_profile_text(request, "last_name", 64, false, false)?;
        }
        "setBio" => {
            validate_profile_text(request, "bio", 140, true, false)?;
        }
        "setUsername" => {
            let username = validate_profile_text(request, "username", 32, false, false)?;
            if !username.is_empty()
                && (username.chars().count() < 5
                    || !username
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '_'))
            {
                return Err("Invalid Telegram username".to_string());
            }
        }
        "createNewBasicGroupChat" => {
            validate_profile_text(request, "title", 128, false, true)?;
            validate_user_ids(request, "user_ids", 200)?;
            validate_auto_delete_time(request)?;
        }
        "createNewSupergroupChat" => {
            validate_profile_text(request, "title", 128, false, true)?;
            validate_profile_text(request, "description", 255, true, false)?;
            validate_auto_delete_time(request)?;
            if request.get("is_forum").and_then(Value::as_bool).is_none()
                || request.get("is_channel").and_then(Value::as_bool).is_none()
                || request.get("for_import").and_then(Value::as_bool) != Some(false)
                || !request.get("location").is_some_and(Value::is_null)
            {
                return Err("Invalid supergroup creation options".to_string());
            }
        }
        "addChatMembers" => {
            validate_nonzero_identifier(request, "chat_id")?;
            validate_user_ids(request, "user_ids", 200)?;
        }
        "setChatMemberStatus" => validate_chat_member_status(request)?,
        "setChatMemberTag" => {
            validate_nonzero_identifier(request, "chat_id")?;
            validate_nonzero_identifier(request, "user_id")?;
            validate_profile_text(request, "tag", 16, false, false)?;
        }
        "setChatSlowModeDelay" => {
            validate_nonzero_identifier(request, "chat_id")?;
            let delay = request
                .get("slow_mode_delay")
                .and_then(Value::as_i64)
                .ok_or_else(|| "Slow mode delay is missing".to_string())?;
            if !(0..=86_400).contains(&delay) {
                return Err("Invalid slow mode delay".to_string());
            }
        }
        "transferChatOwnership" => {
            validate_nonzero_identifier(request, "chat_id")?;
            validate_nonzero_identifier(request, "user_id")?;
            validate_profile_text(request, "password", 256, false, true)?;
        }
        "getChatEventLog" => {
            validate_nonzero_identifier(request, "chat_id")?;
            validate_profile_text(request, "query", 128, true, false)?;
            let limit = request
                .get("limit")
                .and_then(Value::as_i64)
                .ok_or_else(|| "Event log limit is missing".to_string())?;
            if !(1..=100).contains(&limit) {
                return Err("Invalid event log limit".to_string());
            }
            if request.get("user_ids").and_then(Value::as_array).is_none() {
                return Err("Event log users are missing".to_string());
            }
        }
        "createChatInviteLink" | "editChatInviteLink" => validate_chat_invite_link(request)?,
        "createChatSubscriptionInviteLink" => {
            validate_nonzero_identifier(request, "chat_id")?;
            validate_profile_text(request, "name", 32, false, false)?;
            let pricing = request
                .get("subscription_pricing")
                .and_then(Value::as_object)
                .ok_or_else(|| "Subscription pricing is missing".to_string())?;
            if pricing.get("@type").and_then(Value::as_str) != Some("starSubscriptionPricing")
                || pricing.get("period").and_then(Value::as_i64) != Some(2_592_000)
                || pricing
                    .get("star_count")
                    .and_then(Value::as_i64)
                    .is_none_or(|stars| !(1..=1_000_000_000).contains(&stars))
            {
                return Err("Invalid subscription pricing".to_string());
            }
        }
        "editChatSubscriptionInviteLink" => {
            validate_nonzero_identifier(request, "chat_id")?;
            validate_invite_link(request)?;
            validate_profile_text(request, "name", 32, false, false)?;
        }
        "revokeChatInviteLink" => {
            validate_nonzero_identifier(request, "chat_id")?;
            validate_invite_link(request)?;
        }
        "getChatInviteLinks" => {
            validate_nonzero_identifier(request, "chat_id")?;
            if request
                .get("creator_user_id")
                .and_then(Value::as_i64)
                .is_none_or(|id| id < 0)
                || request.get("is_revoked").and_then(Value::as_bool).is_none()
                || request
                    .get("offset_date")
                    .and_then(Value::as_i64)
                    .is_none_or(|date| date < 0)
                || request
                    .get("offset_invite_link")
                    .and_then(Value::as_str)
                    .is_none_or(|link| link.len() > 256)
                || request
                    .get("limit")
                    .and_then(Value::as_i64)
                    .is_none_or(|limit| !(1..=100).contains(&limit))
            {
                return Err("Invalid invite link pagination".to_string());
            }
        }
        "getChatJoinRequests" => {
            validate_nonzero_identifier(request, "chat_id")?;
            validate_profile_text(request, "query", 128, true, false)?;
            if request
                .get("invite_link")
                .and_then(Value::as_str)
                .is_none_or(|link| link.len() > 256)
                || request
                    .get("limit")
                    .and_then(Value::as_i64)
                    .is_none_or(|limit| !(1..=100).contains(&limit))
            {
                return Err("Invalid join request pagination".to_string());
            }
        }
        "getForumTopics" => {
            validate_nonzero_identifier(request, "chat_id")?;
            validate_profile_text(request, "query", 128, true, false)?;
            if request
                .get("offset_date")
                .and_then(Value::as_i64)
                .is_none_or(|date| date < 0)
                || request
                    .get("offset_message_id")
                    .and_then(Value::as_i64)
                    .is_none_or(|id| id < 0)
                || request
                    .get("offset_forum_topic_id")
                    .and_then(Value::as_i64)
                    .is_none_or(|id| id < 0)
                || request
                    .get("limit")
                    .and_then(Value::as_i64)
                    .is_none_or(|limit| !(1..=100).contains(&limit))
            {
                return Err("Invalid forum topic pagination".to_string());
            }
        }
        "getForumTopic" | "getForumTopicHistory" => {
            validate_nonzero_identifier(request, "chat_id")?;
            let topic_id = request
                .get("forum_topic_id")
                .and_then(Value::as_i64)
                .ok_or_else(|| "Forum topic identifier is missing".to_string())?;
            if topic_id <= 0 {
                return Err("Invalid forum topic identifier".to_string());
            }
            if request_type == "getForumTopicHistory"
                && (request
                    .get("from_message_id")
                    .and_then(Value::as_i64)
                    .is_none_or(|id| id < 0)
                    || request
                        .get("offset")
                        .and_then(Value::as_i64)
                        .is_none_or(|offset| !(-99..=0).contains(&offset))
                    || request
                        .get("limit")
                        .and_then(Value::as_i64)
                        .is_none_or(|limit| !(1..=100).contains(&limit)))
            {
                return Err("Invalid forum topic history pagination".to_string());
            }
        }
        "createForumTopic" => {
            validate_nonzero_identifier(request, "chat_id")?;
            validate_profile_text(request, "name", 128, false, true)?;
            let icon = request
                .get("icon")
                .and_then(Value::as_object)
                .ok_or_else(|| "Forum topic icon is missing".to_string())?;
            if icon.get("@type").and_then(Value::as_str) != Some("forumTopicIcon")
                || icon
                    .get("color")
                    .and_then(Value::as_i64)
                    .is_none_or(|color| !(0..=0xFF_FF_FF).contains(&color))
                || icon
                    .get("custom_emoji_id")
                    .and_then(Value::as_i64)
                    .is_none_or(|id| id < 0)
            {
                return Err("Invalid forum topic icon".to_string());
            }
        }
        "editForumTopic" => {
            validate_nonzero_identifier(request, "chat_id")?;
            let topic_id = request
                .get("forum_topic_id")
                .and_then(Value::as_i64)
                .ok_or_else(|| "Forum topic identifier is missing".to_string())?;
            if topic_id <= 0 {
                return Err("Invalid forum topic identifier".to_string());
            }
            validate_profile_text(request, "name", 128, false, false)?;
            if request
                .get("edit_icon_custom_emoji")
                .and_then(Value::as_bool)
                .is_none()
                || request
                    .get("icon_custom_emoji_id")
                    .and_then(Value::as_i64)
                    .is_none_or(|id| id < 0)
            {
                return Err("Invalid forum topic edit".to_string());
            }
        }
        "toggleForumTopicIsClosed" | "toggleForumTopicIsPinned" => {
            validate_nonzero_identifier(request, "chat_id")?;
            let topic_id = request
                .get("forum_topic_id")
                .and_then(Value::as_i64)
                .ok_or_else(|| "Forum topic identifier is missing".to_string())?;
            let state_field = if request_type == "toggleForumTopicIsClosed" {
                "is_closed"
            } else {
                "is_pinned"
            };
            if topic_id <= 0 || request.get(state_field).and_then(Value::as_bool).is_none() {
                return Err("Invalid forum topic state".to_string());
            }
        }
        "getInlineQueryResults" => {
            validate_nonzero_identifier(request, "bot_user_id")?;
            validate_nonzero_identifier(request, "chat_id")?;
            validate_profile_text(request, "query", 256, true, false)?;
            validate_profile_text(request, "offset", 64, true, false)?;
        }
        "getCallbackQueryAnswer" => {
            validate_nonzero_identifier(request, "chat_id")?;
            validate_nonzero_identifier(request, "message_id")?;
            let payload = request
                .get("payload")
                .and_then(Value::as_object)
                .ok_or_else(|| "Callback query payload is missing".to_string())?;
            let data = payload
                .get("data")
                .and_then(Value::as_str)
                .ok_or_else(|| "Callback query data is missing".to_string())?;
            if payload.get("@type").and_then(Value::as_str) != Some("callbackQueryPayloadData")
                || data.len() > 128
                || !data.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'-' | b'_')
                })
            {
                return Err("Invalid callback query payload".to_string());
            }
        }
        "sendInlineQueryResultMessage" => {
            validate_nonzero_identifier(request, "chat_id")?;
            validate_nonzero_identifier(request, "query_id")?;
            let result_id = request
                .get("result_id")
                .and_then(Value::as_str)
                .ok_or_else(|| "Inline result identifier is missing".to_string())?;
            if result_id.is_empty()
                || result_id.len() > 256
                || request
                    .get("hide_via_bot")
                    .and_then(Value::as_bool)
                    .is_none()
            {
                return Err("Invalid inline result message".to_string());
            }
        }
        "sendBotStartMessage" => {
            validate_nonzero_identifier(request, "bot_user_id")?;
            validate_nonzero_identifier(request, "chat_id")?;
            validate_profile_text(request, "parameter", 64, true, false)?;
        }
        "processChatJoinRequest" => {
            validate_nonzero_identifier(request, "chat_id")?;
            validate_nonzero_identifier(request, "user_id")?;
            if request.get("approve").and_then(Value::as_bool).is_none() {
                return Err("Join request decision is missing".to_string());
            }
        }
        "processChatJoinRequests" => {
            validate_nonzero_identifier(request, "chat_id")?;
            if request
                .get("invite_link")
                .and_then(Value::as_str)
                .is_none_or(|link| link.len() > 256)
                || request.get("approve").and_then(Value::as_bool).is_none()
            {
                return Err("Invalid bulk join request decision".to_string());
            }
        }
        "getBlockedMessageSenders" => {
            if request
                .get("block_list")
                .and_then(Value::as_object)
                .and_then(|value| value.get("@type"))
                .and_then(Value::as_str)
                != Some("blockListMain")
                || request
                    .get("offset")
                    .and_then(Value::as_i64)
                    .is_none_or(|offset| offset < 0)
                || request
                    .get("limit")
                    .and_then(Value::as_i64)
                    .is_none_or(|limit| !(1..=100).contains(&limit))
            {
                return Err("Invalid blocked sender pagination".to_string());
            }
        }
        "setMessageSenderBlockList" => {
            let sender = request
                .get("sender_id")
                .and_then(Value::as_object)
                .ok_or_else(|| "Blocked sender is missing".to_string())?;
            let sender_type = sender.get("@type").and_then(Value::as_str);
            if !matches!(
                sender_type,
                Some("messageSenderUser") | Some("messageSenderChat")
            ) {
                return Err("Invalid blocked sender".to_string());
            }
            let id_field = if sender_type == Some("messageSenderUser") {
                "user_id"
            } else {
                "chat_id"
            };
            if sender
                .get(id_field)
                .and_then(Value::as_i64)
                .is_none_or(|id| id <= 0)
            {
                return Err("Invalid blocked sender identifier".to_string());
            }
            if let Some(block_list) = request.get("block_list") {
                if !block_list.is_null()
                    && block_list.get("@type").and_then(Value::as_str) != Some("blockListMain")
                {
                    return Err("Invalid block list".to_string());
                }
            } else {
                return Err("Block list is missing".to_string());
            }
        }
        "reportChat" => {
            validate_nonzero_identifier(request, "chat_id")?;
            let option_id = request
                .get("option_id")
                .and_then(Value::as_str)
                .ok_or_else(|| "Report reason is missing".to_string())?;
            if option_id.len() > 256
                || request
                    .get("text")
                    .and_then(Value::as_str)
                    .is_none_or(|text| text.len() > 1_000)
            {
                return Err("Invalid report fields".to_string());
            }
            validate_message_ids(request, "message_ids", 100)?;
        }
        "getActiveSessions" | "terminateAllOtherSessions" => {}
        "terminateSession" => {
            validate_nonzero_identifier(request, "session_id")?;
        }
        "getUserPrivacySettingRules" | "setUserPrivacySettingRules" => {
            validate_privacy_rules(request, request_type == "setUserPrivacySettingRules")?
        }
        "setSupergroupUsername" => {
            validate_nonzero_identifier(request, "supergroup_id")?;
            let username = validate_profile_text(request, "username", 32, false, true)?;
            if username.chars().count() < 5
                || !username
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_alphabetic())
                || !username
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '_')
            {
                return Err("Invalid public chat username".to_string());
            }
        }
        "searchPublicChat" => {
            let username = validate_profile_text(request, "username", 32, true, true)?;
            if username.chars().count() < 5
                || !username
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '_')
            {
                return Err("Invalid public chat username".to_string());
            }
        }
        "getMessageLinkInfo" => {
            let url = request
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| "Message link is missing".to_string())?;
            let lower = url.to_ascii_lowercase();
            if url.len() > 4_096
                || !(lower.starts_with("https://t.me/")
                    || lower.starts_with("https://telegram.me/")
                    || lower.starts_with("https://telegram.dog/")
                    || lower.starts_with("tg:"))
            {
                return Err("Invalid Telegram message link".to_string());
            }
        }
        "toggleSupergroupIsAllHistoryAvailable" => {
            validate_nonzero_identifier(request, "supergroup_id")?;
            if request
                .get("is_all_history_available")
                .and_then(Value::as_bool)
                .is_none()
            {
                return Err("History visibility is missing".to_string());
            }
        }
        "setChatPermissions" => validate_chat_permissions(request)?,
        "setPollAnswer" => {
            let positions = request
                .get("option_ids")
                .and_then(Value::as_array)
                .ok_or_else(|| "Poll option identifiers are missing".to_string())?;
            if positions.len() > 100
                || positions.iter().any(|position| {
                    position
                        .as_i64()
                        .is_none_or(|position| !(0..=99).contains(&position))
                })
            {
                return Err("Invalid poll option identifiers".to_string());
            }
            let mut unique = positions
                .iter()
                .filter_map(Value::as_i64)
                .collect::<Vec<_>>();
            unique.sort_unstable();
            unique.dedup();
            if unique.len() != positions.len() {
                return Err("Poll option identifiers must be unique".to_string());
            }
        }
        "pinChatMessage" => {
            validate_message_target(request)?;
            if request
                .get("disable_notification")
                .and_then(Value::as_bool)
                .is_none()
                || request
                    .get("only_for_self")
                    .and_then(Value::as_bool)
                    .is_none()
            {
                return Err("Pin options are missing".to_string());
            }
        }
        "unpinChatMessage" => validate_message_target(request)?,
        "setChatMessageAutoDeleteTime" => {
            let time = request
                .get("message_auto_delete_time")
                .and_then(Value::as_i64)
                .ok_or_else(|| "Auto-delete time is missing".to_string())?;
            if !(0..=31_536_000).contains(&time) || (time != 0 && time % 86_400 != 0) {
                return Err("Invalid auto-delete settings".to_string());
            }
        }
        "getChatMessageByDate" => {
            validate_nonzero_identifier(request, "chat_id")?;
            if request
                .get("date")
                .and_then(Value::as_i64)
                .is_none_or(|date| date < 0)
            {
                return Err("Invalid message date".to_string());
            }
        }
        "searchChatMessages" => {
            validate_nonzero_identifier(request, "chat_id")?;
            validate_profile_text(request, "query", 1_024, false, false)?;
            for field in ["from_message_id", "min_date", "max_date"] {
                if request.get(field).is_some_and(|value| {
                    !value.is_null() && value.as_i64().is_none_or(|number| number < 0)
                }) {
                    return Err(format!("Invalid chat search field: {field}"));
                }
            }
            if let Some(topic) = request.get("topic_id").filter(|value| !value.is_null())
                && (topic.get("@type").and_then(Value::as_str) != Some("messageTopicForum")
                    || topic
                        .get("forum_topic_id")
                        .and_then(Value::as_i64)
                        .is_none_or(|id| id <= 0))
            {
                return Err("Invalid chat search topic".to_string());
            }
            if request
                .get("limit")
                .and_then(Value::as_i64)
                .is_none_or(|limit| !(1..=100).contains(&limit))
            {
                return Err("Invalid chat search pagination".to_string());
            }
            if let Some(sender) = request.get("sender_id").filter(|value| !value.is_null()) {
                let sender_type = sender.get("@type").and_then(Value::as_str);
                if !matches!(sender_type, Some("messageSenderUser" | "messageSenderChat")) {
                    return Err("Invalid chat search sender".to_string());
                }
                if sender
                    .get("user_id")
                    .or_else(|| sender.get("chat_id"))
                    .and_then(Value::as_i64)
                    .is_none_or(|id| id == 0)
                {
                    return Err("Invalid chat search sender identifier".to_string());
                }
            }
            let filter = request
                .get("filter")
                .and_then(|value| value.get("@type"))
                .and_then(Value::as_str);
            if filter.is_some_and(|filter| {
                !matches!(
                    filter,
                    "searchMessagesFilterAnimation"
                        | "searchMessagesFilterAudio"
                        | "searchMessagesFilterDocument"
                        | "searchMessagesFilterPhoto"
                        | "searchMessagesFilterPoll"
                        | "searchMessagesFilterVideo"
                        | "searchMessagesFilterVoiceNote"
                        | "searchMessagesFilterPhotoAndVideo"
                        | "searchMessagesFilterUrl"
                        | "searchMessagesFilterChatPhoto"
                        | "searchMessagesFilterVideoNote"
                        | "searchMessagesFilterVoiceAndVideoNote"
                        | "searchMessagesFilterMention"
                        | "searchMessagesFilterUnreadMention"
                        | "searchMessagesFilterUnreadReaction"
                        | "searchMessagesFilterUnreadPollVote"
                        | "searchMessagesFilterFailedToSend"
                        | "searchMessagesFilterPinned"
                )
            }) {
                return Err("Unsupported chat search filter".to_string());
            }
        }
        _ => {}
    }
    if request_type == "createPrivateChat"
        && request.get("force").and_then(Value::as_bool) != Some(false)
    {
        return Err("Private chats must be resolved from the Telegram server".to_string());
    }
    if request_type == "editMessageText" {
        let content_type = request
            .get("input_message_content")
            .and_then(|content| content.get("@type"))
            .and_then(Value::as_str);
        if content_type != Some("inputMessageText") {
            return Err("Edited messages are limited to text content".to_string());
        }
    }
    if request_type == "sendMessage" {
        let content = request
            .get("input_message_content")
            .ok_or_else(|| "Message content is missing".to_string())?;
        let content_type = content.get("@type").and_then(Value::as_str);
        match content_type {
            Some("inputMessageText") => {}
            Some("inputMessageSticker") => {
                let file_type = content
                    .pointer("/sticker/sticker/@type")
                    .and_then(Value::as_str);
                if file_type != Some("inputFileId") {
                    return Err("Stickers must reference a Telegram file identifier".to_string());
                }
            }
            Some("inputMessageAnimation") => {
                let file_type = content
                    .pointer("/animation/animation/@type")
                    .and_then(Value::as_str);
                if file_type != Some("inputFileId") {
                    return Err("Animations must reference a Telegram file identifier".to_string());
                }
            }
            _ => return Err("Unsupported generic message content".to_string()),
        }
    }
    Ok(())
}

fn validate_message_target(request: &Value) -> Result<(), String> {
    let chat_id = request
        .get("chat_id")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Chat identifier is missing".to_string())?;
    let message_id = request
        .get("message_id")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Message identifier is missing".to_string())?;
    if chat_id == 0 || message_id <= 0 {
        return Err("Invalid message target".to_string());
    }
    Ok(())
}

fn validate_message_ids(request: &Value, field: &str, maximum: usize) -> Result<(), String> {
    let values = request
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Message identifiers are missing: {field}"))?;
    if values.len() > maximum
        || values
            .iter()
            .any(|value| value.as_i64().is_none_or(|id| id <= 0))
    {
        return Err("Invalid message identifiers".to_string());
    }
    Ok(())
}

fn validate_profile_text<'a>(
    request: &'a Value,
    field: &str,
    maximum: usize,
    allow_newline: bool,
    required: bool,
) -> Result<&'a str, String> {
    let value = request
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Profile field is missing: {field}"))?;
    if (required && value.trim().is_empty()) || value.chars().count() > maximum {
        return Err(format!("Invalid profile field: {field}"));
    }
    if value
        .chars()
        .any(|character| character.is_control() && !(allow_newline && character == '\n'))
    {
        return Err(format!("Invalid profile field: {field}"));
    }
    Ok(value)
}

fn validate_nonzero_identifier(request: &Value, field: &str) -> Result<i64, String> {
    let identifier = request
        .get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("Identifier is missing: {field}"))?;
    if identifier == 0 {
        return Err(format!("Invalid identifier: {field}"));
    }
    Ok(identifier)
}

fn validate_user_ids(request: &Value, field: &str, maximum: usize) -> Result<(), String> {
    let values = request
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("User identifiers are missing: {field}"))?;
    if values.len() > maximum
        || values
            .iter()
            .any(|value| value.as_i64().is_none_or(|id| id == 0))
    {
        return Err("Invalid user identifiers".to_string());
    }
    let mut unique = values.iter().filter_map(Value::as_i64).collect::<Vec<_>>();
    unique.sort_unstable();
    unique.dedup();
    if unique.len() != values.len() {
        return Err("User identifiers must be unique".to_string());
    }
    Ok(())
}

fn validate_auto_delete_time(request: &Value) -> Result<(), String> {
    let value = request
        .get("message_auto_delete_time")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Auto-delete time is missing".to_string())?;
    if !(0..=31_536_000).contains(&value) || (value != 0 && value % 86_400 != 0) {
        return Err("Invalid auto-delete settings".to_string());
    }
    Ok(())
}

fn validate_invite_link(request: &Value) -> Result<(), String> {
    let link = request
        .get("invite_link")
        .and_then(Value::as_str)
        .ok_or_else(|| "Invite link is missing".to_string())?;
    if link.len() > 256
        || !(link.starts_with("https://t.me/+") || link.starts_with("https://telegram.me/+"))
    {
        return Err("Invalid invite link".to_string());
    }
    Ok(())
}

fn validate_chat_invite_link(request: &Value) -> Result<(), String> {
    validate_nonzero_identifier(request, "chat_id")?;
    validate_profile_text(request, "name", 32, false, false)?;
    if request.get("@type").and_then(Value::as_str) == Some("editChatInviteLink") {
        validate_invite_link(request)?;
    }
    let expiration = request
        .get("expiration_date")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Invite expiration is missing".to_string())?;
    let member_limit = request
        .get("member_limit")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Invite member limit is missing".to_string())?;
    if !(0..=2_147_483_647).contains(&expiration)
        || !(0..=99_999).contains(&member_limit)
        || request
            .get("creates_join_request")
            .and_then(Value::as_bool)
            .is_none()
    {
        return Err("Invalid invite link settings".to_string());
    }
    Ok(())
}

fn validate_privacy_rules(request: &Value, has_rules: bool) -> Result<(), String> {
    let setting = request
        .get("setting")
        .and_then(Value::as_object)
        .and_then(|value| value.get("@type"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Privacy setting is missing".to_string())?;
    if !matches!(
        setting,
        "userPrivacySettingShowStatus"
            | "userPrivacySettingShowPhoneNumber"
            | "userPrivacySettingShowProfilePhoto"
            | "userPrivacySettingAllowCalls"
            | "userPrivacySettingAllowChatInvites"
            | "userPrivacySettingAllowSecretChats"
    ) {
        return Err("Unsupported privacy setting".to_string());
    }
    if has_rules {
        let rules = request
            .get("rules")
            .and_then(Value::as_object)
            .filter(|value| {
                value.get("@type").and_then(Value::as_str) == Some("userPrivacySettingRules")
            })
            .and_then(|value| value.get("rules"))
            .and_then(Value::as_array)
            .ok_or_else(|| "Privacy rules are missing".to_string())?;
        if rules.is_empty() || rules.len() > 10 {
            return Err("Invalid privacy rules".to_string());
        }
        for rule in rules {
            let object = rule
                .as_object()
                .ok_or_else(|| "Invalid privacy rule".to_string())?;
            let kind = object
                .get("@type")
                .and_then(Value::as_str)
                .ok_or_else(|| "Privacy rule type is missing".to_string())?;
            if !matches!(
                kind,
                "userPrivacySettingRuleAllowAll"
                    | "userPrivacySettingRuleAllowContacts"
                    | "userPrivacySettingRuleAllowUsers"
                    | "userPrivacySettingRuleRestrictAll"
                    | "userPrivacySettingRuleRestrictContacts"
                    | "userPrivacySettingRuleRestrictUsers"
            ) {
                return Err("Unsupported privacy rule".to_string());
            }
            if matches!(
                kind,
                "userPrivacySettingRuleAllowUsers" | "userPrivacySettingRuleRestrictUsers"
            ) {
                validate_user_ids_value(object.get("user_ids"), 100)?;
            }
        }
    }
    Ok(())
}

fn validate_user_ids_value(value: Option<&Value>, maximum: usize) -> Result<(), String> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| "Privacy user identifiers are missing".to_string())?;
    if values.is_empty()
        || values.len() > maximum
        || values
            .iter()
            .any(|value| value.as_i64().is_none_or(|id| id <= 0))
    {
        return Err("Invalid privacy user identifiers".to_string());
    }
    Ok(())
}

fn validate_chat_permissions(request: &Value) -> Result<(), String> {
    validate_nonzero_identifier(request, "chat_id")?;
    let permissions = request
        .get("permissions")
        .and_then(Value::as_object)
        .ok_or_else(|| "Chat permissions are missing".to_string())?;
    let allowed = [
        "@type",
        "can_send_basic_messages",
        "can_send_audios",
        "can_send_documents",
        "can_send_photos",
        "can_send_videos",
        "can_send_video_notes",
        "can_send_voice_notes",
        "can_send_polls",
        "can_send_other_messages",
        "can_add_link_previews",
        "can_react_to_messages",
        "can_edit_tag",
        "can_change_info",
        "can_invite_users",
        "can_pin_messages",
        "can_create_topics",
    ];
    if permissions.get("@type").and_then(Value::as_str) != Some("chatPermissions")
        || permissions
            .keys()
            .any(|key| !allowed.contains(&key.as_str()))
        || allowed[1..]
            .iter()
            .any(|field| permissions.get(*field).and_then(Value::as_bool).is_none())
    {
        return Err("Invalid chat permission matrix".to_string());
    }
    Ok(())
}

fn validate_chat_member_status(request: &Value) -> Result<(), String> {
    validate_nonzero_identifier(request, "chat_id")?;
    let member = request
        .get("member_id")
        .and_then(Value::as_object)
        .ok_or_else(|| "Member identifier is missing".to_string())?;
    if member.get("@type").and_then(Value::as_str) != Some("messageSenderUser")
        || member
            .get("user_id")
            .and_then(Value::as_i64)
            .is_none_or(|id| id <= 0)
    {
        return Err("Invalid member identifier".to_string());
    }
    let status = request
        .get("status")
        .and_then(Value::as_object)
        .ok_or_else(|| "Member status is missing".to_string())?;
    match status.get("@type").and_then(Value::as_str) {
        Some("chatMemberStatusMember") => {
            if status
                .get("member_until_date")
                .and_then(Value::as_i64)
                .is_none()
            {
                return Err("Member expiry is missing".to_string());
            }
        }
        Some("chatMemberStatusAdministrator") => {
            if status
                .get("can_be_edited")
                .and_then(Value::as_bool)
                .is_none()
                || status.get("rights").and_then(Value::as_object).is_none()
            {
                return Err("Administrator rights are missing".to_string());
            }
        }
        Some("chatMemberStatusRestricted") => {
            if status.get("is_member").and_then(Value::as_bool).is_none()
                || status
                    .get("restricted_until_date")
                    .and_then(Value::as_i64)
                    .is_none()
                || status
                    .get("permissions")
                    .and_then(Value::as_object)
                    .is_none()
            {
                return Err("Restricted member permissions are missing".to_string());
            }
        }
        Some("chatMemberStatusBanned") => {
            if status
                .get("banned_until_date")
                .and_then(Value::as_i64)
                .is_none()
            {
                return Err("Ban expiry is missing".to_string());
            }
        }
        _ => return Err("Unsupported member status".to_string()),
    }
    Ok(())
}

fn is_photo_upload(file: &crate::storage::UploadFileInfo) -> bool {
    Path::new(&file.path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png"
            )
        })
        && file.size <= 10 * 1024 * 1024
}

#[derive(Clone, Debug)]
pub(super) struct PreparedUpload {
    pub file: crate::storage::UploadFileInfo,
    pub mime_type: String,
    pub kind: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub duration: Option<i32>,
    pub title: Option<String>,
    pub performer: Option<String>,
    pub thumbnail: Option<crate::storage::UploadFileInfo>,
    pub has_spoiler: bool,
    pub show_caption_above_media: bool,
}

impl PreparedUpload {
    fn automatic(file: &crate::storage::UploadFileInfo) -> Self {
        Self {
            file: file.clone(),
            mime_type: String::new(),
            kind: if is_photo_upload(file) {
                "photo"
            } else {
                "document"
            }
            .to_string(),
            width: None,
            height: None,
            duration: None,
            title: None,
            performer: None,
            thumbnail: None,
            has_spoiler: false,
            show_caption_above_media: false,
        }
    }
}

fn validate_upload_caption(caption: &str) -> Result<(), String> {
    if caption.chars().count() > 1_024 || caption.contains('\0') {
        return Err("Telegram media captions must contain at most 1024 characters".to_string());
    }
    Ok(())
}

fn bounded_metadata(value: Option<i32>, maximum: i32, field: &str) -> Result<i32, String> {
    let value = value.unwrap_or_default();
    if !(0..=maximum).contains(&value) {
        return Err(format!("Invalid upload metadata: {field}"));
    }
    Ok(value)
}

fn validate_optional_media_text(value: Option<&str>, field: &str) -> Result<String, String> {
    let value = value.unwrap_or_default();
    if value.chars().count() > 128 || value.chars().any(char::is_control) {
        return Err(format!("Invalid upload metadata: {field}"));
    }
    Ok(value.to_string())
}

fn input_thumbnail(upload: &PreparedUpload) -> Result<Value, String> {
    let Some(thumbnail) = upload.thumbnail.as_ref() else {
        return Ok(Value::Null);
    };
    let extension = Path::new(&thumbnail.path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "jpg" | "jpeg" | "png") || thumbnail.size > 200 * 1024 {
        return Err("Media thumbnails must be JPEG or PNG files no larger than 200 KB".to_string());
    }
    Ok(json!({
        "@type": "inputThumbnail",
        "thumbnail": { "@type": "inputFileLocal", "path": thumbnail.path },
        "width": bounded_metadata(upload.width, 10_000, "width")?.min(320),
        "height": bounded_metadata(upload.height, 10_000, "height")?.min(320)
    }))
}

fn formatted_caption(
    caption_text: &str,
    mentions: &[PreparedTextMention],
) -> Result<Value, String> {
    if mentions.len() > 100 {
        return Err("Telegram captions support at most 100 member mentions".to_string());
    }
    let utf16_len = caption_text.encode_utf16().count();
    let mut previous_end = 0usize;
    let mut entities = Vec::with_capacity(mentions.len());
    for mention in mentions {
        let offset = usize::try_from(mention.offset)
            .map_err(|_| "Invalid Telegram mention offset".to_string())?;
        let length = usize::try_from(mention.length)
            .map_err(|_| "Invalid Telegram mention length".to_string())?;
        let end = offset
            .checked_add(length)
            .ok_or_else(|| "Invalid Telegram mention range".to_string())?;
        if length == 0 || mention.user_id <= 0 || offset < previous_end || end > utf16_len {
            return Err("Invalid Telegram caption mention".to_string());
        }
        previous_end = end;
        entities.push(json!({
            "offset": mention.offset,
            "length": mention.length,
            "type": {
                "@type": "textEntityTypeMentionName",
                "user_id": mention.user_id
            }
        }));
    }
    Ok(json!({ "@type": "formattedText", "text": caption_text, "entities": entities }))
}

fn input_message_upload(
    upload: &PreparedUpload,
    caption_text: &str,
    caption_mentions: &[PreparedTextMention],
) -> Result<Value, String> {
    let extension = Path::new(&upload.file.path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = upload.mime_type.to_ascii_lowercase();
    let kind_matches = match upload.kind.as_str() {
        "photo" => is_photo_upload(&upload.file),
        "video" => {
            mime.starts_with("video/")
                || matches!(extension.as_str(), "mp4" | "m4v" | "mov" | "webm" | "mkv")
        }
        "animation" => {
            mime == "image/gif"
                || mime.starts_with("video/")
                || matches!(extension.as_str(), "gif" | "mp4" | "webm")
        }
        "audio" => {
            mime.starts_with("audio/")
                || matches!(
                    extension.as_str(),
                    "mp3" | "m4a" | "aac" | "ogg" | "oga" | "opus" | "flac" | "wav"
                )
        }
        "document" => true,
        _ => false,
    };
    if !kind_matches {
        return Err(format!(
            "Attachment metadata does not match file type: {}",
            upload.kind
        ));
    }
    let input_file = json!({ "@type": "inputFileLocal", "path": upload.file.path });
    let caption = formatted_caption(caption_text, caption_mentions)?;
    let width = bounded_metadata(upload.width, 10_000, "width")?;
    let height = bounded_metadata(upload.height, 10_000, "height")?;
    let duration = bounded_metadata(upload.duration, 86_400, "duration")?;
    let thumbnail = input_thumbnail(upload)?;
    let result = match upload.kind.as_str() {
        "photo" => {
            if !is_photo_upload(&upload.file) {
                return Err(
                    "Telegram photos must be JPEG or PNG files no larger than 10 MB".to_string(),
                );
            }
            json!({
                "@type": "inputMessagePhoto",
                "photo": {
                    "@type": "inputPhoto",
                    "photo": input_file,
                    "thumbnail": thumbnail,
                    "video": null,
                    "added_sticker_file_ids": [],
                    "width": width,
                    "height": height
                },
                "caption": caption,
                "show_caption_above_media": upload.show_caption_above_media,
                "self_destruct_type": null,
                "has_spoiler": upload.has_spoiler
            })
        }
        "video" => json!({
            "@type": "inputMessageVideo",
            "video": {
                "@type": "inputVideo",
                "video": input_file,
                "thumbnail": thumbnail,
                "cover": upload.thumbnail.as_ref().map(|cover| {
                    json!({ "@type": "inputFileLocal", "path": cover.path })
                }),
                "start_timestamp": 0,
                "added_sticker_file_ids": [],
                "duration": duration,
                "width": width,
                "height": height,
                "supports_streaming": true
            },
            "caption": caption,
            "show_caption_above_media": upload.show_caption_above_media,
            "self_destruct_type": null,
            "has_spoiler": upload.has_spoiler
        }),
        "animation" => json!({
            "@type": "inputMessageAnimation",
            "animation": {
                "@type": "inputAnimation",
                "animation": input_file,
                "thumbnail": thumbnail,
                "added_sticker_file_ids": [],
                "duration": duration,
                "width": width,
                "height": height
            },
            "caption": caption,
            "show_caption_above_media": upload.show_caption_above_media,
            "has_spoiler": upload.has_spoiler
        }),
        "audio" => json!({
            "@type": "inputMessageAudio",
            "audio": {
                "@type": "inputAudio",
                "audio": input_file,
                "album_cover_thumbnail": thumbnail,
                "duration": duration,
                "title": validate_optional_media_text(upload.title.as_deref(), "title")?,
                "performer": validate_optional_media_text(upload.performer.as_deref(), "performer")?
            },
            "caption": caption
        }),
        "document" => json!({
            "@type": "inputMessageDocument",
            "document": {
                "@type": "inputDocument",
                "document": input_file,
                "thumbnail": thumbnail,
                "disable_content_type_detection": false
            },
            "caption": caption
        }),
        _ => return Err("Unsupported outgoing attachment kind".to_string()),
    };
    Ok(result)
}

#[allow(dead_code)]
pub(super) fn prepared_file_request(
    chat_id: i64,
    extra: &str,
    file: &crate::storage::UploadFileInfo,
) -> Result<Value, String> {
    prepared_file_request_with_caption(chat_id, extra, file, "")
}

#[allow(dead_code)]
pub(super) fn prepared_file_request_with_caption(
    chat_id: i64,
    extra: &str,
    file: &crate::storage::UploadFileInfo,
    caption: &str,
) -> Result<Value, String> {
    prepared_upload_request_with_caption(chat_id, extra, &PreparedUpload::automatic(file), caption)
}

pub(super) fn prepared_file_request_with_topic(
    chat_id: i64,
    extra: &str,
    file: &crate::storage::UploadFileInfo,
    topic_id: Option<i64>,
) -> Result<Value, String> {
    prepared_upload_request_with_caption_and_topic(
        chat_id,
        extra,
        &PreparedUpload::automatic(file),
        "",
        &[],
        topic_id,
    )
}

#[allow(dead_code)]
pub(super) fn prepared_upload_request_with_caption(
    chat_id: i64,
    extra: &str,
    upload: &PreparedUpload,
    caption: &str,
) -> Result<Value, String> {
    prepared_upload_request_with_caption_and_topic(chat_id, extra, upload, caption, &[], None)
}

pub(super) fn prepared_upload_request_with_caption_and_topic(
    chat_id: i64,
    extra: &str,
    upload: &PreparedUpload,
    caption: &str,
    caption_mentions: &[PreparedTextMention],
    topic_id: Option<i64>,
) -> Result<Value, String> {
    if chat_id == 0 {
        return Err("Invalid Telegram chat identifier".to_string());
    }
    validate_webview_extra(extra)?;
    validate_upload_caption(caption)?;
    Ok(json!({
        "@type": "sendMessage",
        "chat_id": chat_id,
        "topic_id": topic_id.map(|id| json!({ "@type": "messageTopicForum", "forum_topic_id": id })).unwrap_or(Value::Null),
        "reply_to": null,
        "options": null,
        "reply_markup": null,
        "input_message_content": input_message_upload(upload, caption, caption_mentions)?,
        "@extra": extra
    }))
}

#[cfg(test)]
fn prepared_file_album_request_with_caption(
    chat_id: i64,
    extra: &str,
    files: &[crate::storage::UploadFileInfo],
    caption: &str,
) -> Result<Value, String> {
    let uploads = files
        .iter()
        .map(PreparedUpload::automatic)
        .collect::<Vec<_>>();
    prepared_upload_album_request_with_caption(chat_id, extra, &uploads, caption)
}

#[allow(dead_code)]
pub(super) fn prepared_upload_album_request_with_caption(
    chat_id: i64,
    extra: &str,
    uploads: &[PreparedUpload],
    caption: &str,
) -> Result<Value, String> {
    prepared_upload_album_request_with_caption_and_topic(
        chat_id,
        extra,
        uploads,
        caption,
        &[],
        None,
    )
}

pub(super) fn prepared_upload_album_request_with_caption_and_topic(
    chat_id: i64,
    extra: &str,
    uploads: &[PreparedUpload],
    caption: &str,
    caption_mentions: &[PreparedTextMention],
    topic_id: Option<i64>,
) -> Result<Value, String> {
    if chat_id == 0 {
        return Err("Invalid Telegram chat identifier".to_string());
    }
    validate_webview_extra(extra)?;
    validate_upload_caption(caption)?;
    if !(2..=10).contains(&uploads.len()) {
        return Err("Telegram albums require between 2 and 10 files".to_string());
    }
    let album_family = |kind: &str| match kind {
        "photo" | "video" => "visual",
        "audio" => "audio",
        "document" => "document",
        _ => "unsupported",
    };
    let first_family = album_family(&uploads[0].kind);
    if first_family == "unsupported"
        || uploads
            .iter()
            .any(|upload| album_family(&upload.kind) != first_family)
    {
        return Err("Telegram albums must contain compatible media types".to_string());
    }
    if uploads
        .iter()
        .any(|upload| upload.show_caption_above_media != uploads[0].show_caption_above_media)
    {
        return Err("Telegram album caption placement must be consistent".to_string());
    }
    Ok(json!({
        "@type": "sendMessageAlbum",
        "chat_id": chat_id,
        "topic_id": topic_id.map(|id| json!({ "@type": "messageTopicForum", "forum_topic_id": id })).unwrap_or(Value::Null),
        "reply_to": null,
        "options": null,
        "input_message_contents": uploads.iter().enumerate().map(|(index, upload)| {
            input_message_upload(
                upload,
                if index == 0 { caption } else { "" },
                if index == 0 { caption_mentions } else { &[] },
            )
        }).collect::<Result<Vec<_>, _>>()?,
        "@extra": extra
    }))
}

pub(super) fn prepared_profile_photo_request(
    extra: &str,
    file: &crate::storage::UploadFileInfo,
) -> Result<Value, String> {
    validate_webview_extra(extra)?;
    let extension = Path::new(&file.path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "jpg" | "jpeg") || file.size > 10 * 1024 * 1024 {
        return Err("Profile photos must be JPEG files no larger than 10 MB".to_string());
    }
    Ok(json!({
        "@type": "setProfilePhoto",
        "photo": {
            "@type": "inputChatPhotoStatic",
            "photo": { "@type": "inputFileLocal", "path": file.path }
        },
        "is_public": false,
        "@extra": extra
    }))
}

pub(super) fn prepared_chat_photo_request(
    chat_id: i64,
    extra: &str,
    file: &crate::storage::UploadFileInfo,
) -> Result<Value, String> {
    validate_webview_extra(extra)?;
    if chat_id == 0 {
        return Err("Invalid chat photo target".to_string());
    }
    let extension = Path::new(&file.path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "jpg" | "jpeg") || file.size > 10 * 1024 * 1024 {
        return Err("Chat photos must be JPEG files no larger than 10 MB".to_string());
    }
    Ok(json!({
        "@type": "setChatPhoto",
        "chat_id": chat_id,
        "photo": {
            "@type": "inputChatPhotoStatic",
            "photo": { "@type": "inputFileLocal", "path": file.path }
        },
        "@extra": extra
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXTRA: &str = "00000000-0000-4000-8000-000000000000";

    #[test]
    fn preserves_uuid_webview_correlations_and_extracts_native_request_types() {
        let correlation = "550e8400-e29b-41d4-a716-446655440000";
        assert!(validate_webview_extra(correlation).is_ok());
        assert_eq!(request_type_from_extra(correlation), None);
        assert!(validate_webview_extra(&format!("web:getMe:{correlation}")).is_err());
        assert_eq!(
            request_type_from_extra("native:setTdlibParameters"),
            Some("setTdlibParameters")
        );
        assert_eq!(request_type_from_extra("unexpected"), None);
    }

    #[test]
    fn allows_bounded_file_download_cancellation() {
        let cancel = json!({
            "@type": "cancelDownloadFile",
            "file_id": 77,
            "only_if_pending": false,
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&cancel).is_ok());

        let mut invalid_id = cancel.clone();
        invalid_id["file_id"] = json!(0);
        assert!(validate_webview_tdlib_request(&invalid_id).is_err());

        let mut missing_mode = cancel;
        missing_mode
            .as_object_mut()
            .unwrap()
            .remove("only_if_pending");
        assert!(validate_webview_tdlib_request(&missing_mode).is_err());
    }

    #[test]
    fn generic_bridge_allows_text_but_rejects_privileged_requests_and_local_files() {
        let text = json!({
            "@type": "sendMessage",
            "chat_id": 7,
            "input_message_content": {
                "@type": "inputMessageText",
                "text": { "@type": "formattedText", "text": "hello", "entities": [] }
            },
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&text).is_ok());

        let sticker = json!({
            "@type": "sendMessage",
            "chat_id": 7,
            "input_message_content": {
                "@type": "inputMessageSticker",
                "sticker": {
                    "@type": "inputSticker",
                    "sticker": { "@type": "inputFileId", "id": 42 }
                }
            },
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&sticker).is_ok());

        let animation = json!({
            "@type": "sendMessage",
            "chat_id": 7,
            "input_message_content": {
                "@type": "inputMessageAnimation",
                "animation": {
                    "@type": "inputAnimation",
                    "animation": { "@type": "inputFileId", "id": 43 }
                }
            },
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&animation).is_ok());

        let remote_sticker = json!({
            "@type": "sendMessage",
            "chat_id": 7,
            "input_message_content": {
                "@type": "inputMessageSticker",
                "sticker": {
                    "@type": "inputSticker",
                    "sticker": { "@type": "inputFileRemote", "id": "remote" }
                }
            },
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&remote_sticker).is_err());

        let replied_message = json!({
            "@type": "getRepliedMessage",
            "chat_id": 7,
            "message_id": 12,
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&replied_message).is_ok());

        let markdown = json!({
            "@type": "parseMarkdown",
            "text": { "@type": "formattedText", "text": "**hello**", "entities": [] },
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&markdown).is_ok());

        let pinned_chats = json!({
            "@type": "setPinnedChats",
            "chat_list": { "@type": "chatListMain" },
            "chat_ids": [8, 7],
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&pinned_chats).is_ok());

        let pin_chat = json!({
            "@type": "toggleChatIsPinned",
            "chat_list": { "@type": "chatListMain" },
            "chat_id": 7,
            "is_pinned": true,
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&pin_chat).is_ok());

        let mute_chat = json!({
            "@type": "setChatNotificationSettings",
            "chat_id": 7,
            "notification_settings": {
                "@type": "chatNotificationSettings",
                "use_default_mute_for": false,
                "mute_for": 2_147_483_647
            },
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&mute_chat).is_ok());

        let archive_chat = json!({
            "@type": "addChatToList",
            "chat_id": 7,
            "chat_list": { "@type": "chatListArchive" },
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&archive_chat).is_ok());

        let leave_chat = json!({
            "@type": "leaveChat",
            "chat_id": 7,
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&leave_chat).is_ok());

        let mark_chat_read = json!({
            "@type": "toggleChatIsMarkedAsUnread",
            "chat_id": 7,
            "is_marked_as_unread": false,
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&mark_chat_read).is_ok());

        for bulk_read in [
            json!({ "@type": "readAllChatMentions", "chat_id": 7, "@extra": EXTRA }),
            json!({
                "@type": "readAllForumTopicMentions",
                "chat_id": 7,
                "forum_topic_id": 12,
                "@extra": EXTRA
            }),
        ] {
            assert!(validate_webview_tdlib_request(&bulk_read).is_err());
        }

        for request in [
            json!({ "@type": "getChatFolder", "chat_folder_id": 12, "@extra": EXTRA }),
            json!({
                "@type": "createChatFolder",
                "folder": { "@type": "chatFolder" },
                "@extra": EXTRA
            }),
            json!({
                "@type": "editChatFolder",
                "chat_folder_id": 12,
                "folder": { "@type": "chatFolder" },
                "@extra": EXTRA
            }),
            json!({
                "@type": "deleteChatFolder",
                "chat_folder_id": 12,
                "leave_chat_ids": [],
                "@extra": EXTRA
            }),
        ] {
            assert!(validate_webview_tdlib_request(&request).is_ok());
        }

        let global_search = json!({
            "@type": "searchMessages",
            "chat_list": null,
            "query": "layout",
            "offset": "opaque-next",
            "limit": 30,
            "filter": { "@type": "searchMessagesFilterDocument" },
            "chat_type_filter": null,
            "min_date": 0,
            "max_date": 0,
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&global_search).is_ok());

        for request_type in [
            "getUser",
            "getUserFullInfo",
            "getBasicGroupFullInfo",
            "getChatAdministrators",
            "getSupergroupFullInfo",
            "getSupergroupMembers",
            "searchChatMembers",
            "getContacts",
            "getSecretChat",
        ] {
            let request = json!({ "@type": request_type, "@extra": EXTRA });
            assert!(validate_webview_tdlib_request(&request).is_ok());
        }

        let private_chat = json!({
            "@type": "createPrivateChat",
            "user_id": 7,
            "force": false,
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&private_chat).is_ok());
        let mut forced_private_chat = private_chat.clone();
        forced_private_chat["force"] = json!(true);
        assert!(validate_webview_tdlib_request(&forced_private_chat).is_err());

        let poll_answer = json!({
            "@type": "setPollAnswer",
            "chat_id": 7,
            "message_id": 31,
            "option_ids": [0, 2],
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&poll_answer).is_ok());
        let duplicate_poll_answer = json!({
            "@type": "setPollAnswer",
            "chat_id": 7,
            "message_id": 31,
            "option_ids": [1, 1],
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&duplicate_poll_answer).is_err());

        let callback_answer = json!({
            "@type": "getCallbackQueryAnswer",
            "chat_id": 7,
            "message_id": 31,
            "payload": {
                "@type": "callbackQueryPayloadData",
                "data": "cGFnZT0y"
            },
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&callback_answer).is_ok());
        let mut password_callback = callback_answer.clone();
        password_callback["payload"]["@type"] = json!("callbackQueryPayloadDataWithPassword");
        assert!(validate_webview_tdlib_request(&password_callback).is_err());

        let privileged = json!({
            "@type": "setTdlibParameters",
            "database_directory": "C:\\private",
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&privileged).is_err());

        let local_file = json!({
            "@type": "sendMessage",
            "chat_id": 7,
            "input_message_content": {
                "@type": "inputMessageDocument",
                "document": {
                    "@type": "inputDocument",
                    "document": { "@type": "inputFileLocal", "path": "C:\\private.txt" }
                }
            },
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&local_file).is_err());
    }

    #[test]
    fn validates_message_pin_and_auto_delete_requests() {
        let pin = json!({
            "@type": "pinChatMessage",
            "chat_id": 7,
            "message_id": 31,
            "disable_notification": true,
            "only_for_self": false,
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&pin).is_ok());
        let mut invalid_pin = pin.clone();
        invalid_pin["message_id"] = json!(0);
        assert!(validate_webview_tdlib_request(&invalid_pin).is_err());

        let unpin = json!({
            "@type": "unpinChatMessage",
            "chat_id": 7,
            "message_id": 31,
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&unpin).is_ok());

        let auto_delete = json!({
            "@type": "setChatMessageAutoDeleteTime",
            "chat_id": 7,
            "message_auto_delete_time": 604800,
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&auto_delete).is_ok());
        let mut invalid_auto_delete = auto_delete.clone();
        invalid_auto_delete["message_auto_delete_time"] = json!(31_536_001);
        assert!(validate_webview_tdlib_request(&invalid_auto_delete).is_err());

        let media_search = json!({
            "@type": "searchChatMessages",
            "chat_id": 7,
            "query": "",
            "limit": 40,
            "filter": { "@type": "searchMessagesFilterPhotoAndVideo" },
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&media_search).is_ok());
        let mut topic_search = media_search.clone();
        topic_search["topic_id"] = json!({
            "@type": "messageTopicForum",
            "forum_topic_id": 12
        });
        assert!(validate_webview_tdlib_request(&topic_search).is_ok());
        let mut unread_search = media_search.clone();
        unread_search["filter"] = json!({ "@type": "searchMessagesFilterUnreadMention" });
        assert!(validate_webview_tdlib_request(&unread_search).is_ok());
        let mut unsupported_search = media_search.clone();
        unsupported_search["filter"] = json!({ "@type": "searchMessagesFilterCall" });
        assert!(validate_webview_tdlib_request(&unsupported_search).is_err());
        let mut invalid_sender = media_search.clone();
        invalid_sender["sender_id"] = json!({ "@type": "messageSenderUser", "user_id": 0 });
        assert!(validate_webview_tdlib_request(&invalid_sender).is_err());

        let message_by_date = json!({
            "@type": "getChatMessageByDate",
            "chat_id": 7,
            "date": 1_786_319_999,
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&message_by_date).is_ok());
    }

    #[test]
    fn backend_upload_builder_keeps_local_paths_out_of_the_generic_bridge() {
        let photo = crate::storage::UploadFileInfo {
            path: "C:\\selected\\photo.jpg".to_string(),
            size: 2_000_000,
        };
        let large_photo = crate::storage::UploadFileInfo {
            path: "C:\\selected\\large.jpg".to_string(),
            size: 10 * 1024 * 1024 + 1,
        };

        let photo_request = prepared_file_request(7, EXTRA, &photo).unwrap();
        let document_request = prepared_file_request(7, EXTRA, &large_photo).unwrap();
        assert_eq!(
            photo_request["input_message_content"]["@type"],
            "inputMessagePhoto"
        );
        assert_eq!(
            document_request["input_message_content"]["@type"],
            "inputMessageDocument"
        );
        let album_request = prepared_file_album_request_with_caption(
            7,
            EXTRA,
            &[
                photo.clone(),
                crate::storage::UploadFileInfo {
                    path: "C:\\selected\\photo-2.png".to_string(),
                    size: 1_000_000,
                },
            ],
            "相册说明",
        )
        .unwrap();
        assert_eq!(album_request["@type"], "sendMessageAlbum");
        assert_eq!(
            album_request["input_message_contents"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            album_request["input_message_contents"][0]["caption"]["text"],
            "相册说明"
        );
        assert_eq!(
            album_request["input_message_contents"][1]["caption"]["text"],
            ""
        );
        assert!(
            prepared_file_album_request_with_caption(7, EXTRA, std::slice::from_ref(&photo), "")
                .is_err()
        );
        assert!(
            prepared_file_album_request_with_caption(7, EXTRA, &[photo, large_photo], "").is_err()
        );
        assert!(validate_webview_tdlib_request(&photo_request).is_err());

        let cover = crate::storage::UploadFileInfo {
            path: "C:\\selected\\video-cover.jpg".to_string(),
            size: 24_000,
        };
        let video = PreparedUpload {
            file: crate::storage::UploadFileInfo {
                path: "C:\\selected\\clip.mp4".to_string(),
                size: 5_000_000,
            },
            mime_type: "video/mp4".to_string(),
            kind: "video".to_string(),
            width: Some(1280),
            height: Some(720),
            duration: Some(42),
            title: None,
            performer: None,
            thumbnail: Some(cover.clone()),
            has_spoiler: true,
            show_caption_above_media: true,
        };
        let video_request =
            prepared_upload_request_with_caption(7, EXTRA, &video, "视频说明").unwrap();
        let video_content = &video_request["input_message_content"];
        assert_eq!(video_content["@type"], "inputMessageVideo");
        assert_eq!(video_content["video"]["duration"], 42);
        assert_eq!(video_content["video"]["width"], 1280);
        assert_eq!(video_content["video"]["thumbnail"]["width"], 320);
        assert_eq!(video_content["video"]["cover"]["path"], cover.path);
        assert_eq!(video_content["show_caption_above_media"], true);
        assert_eq!(video_content["has_spoiler"], true);

        let mention_request = prepared_upload_request_with_caption_and_topic(
            7,
            EXTRA,
            &video,
            "@Mia 视频说明",
            &[PreparedTextMention {
                offset: 0,
                length: 4,
                user_id: 11,
            }],
            None,
        )
        .unwrap();
        assert_eq!(
            mention_request["input_message_content"]["caption"]["entities"][0]["type"]["@type"],
            "textEntityTypeMentionName"
        );
        assert_eq!(
            mention_request["input_message_content"]["caption"]["entities"][0]["type"]["user_id"],
            11
        );
        assert!(
            prepared_upload_request_with_caption_and_topic(
                7,
                EXTRA,
                &video,
                "short",
                &[PreparedTextMention {
                    offset: 4,
                    length: 10,
                    user_id: 11,
                }],
                None,
            )
            .is_err()
        );

        let audio = PreparedUpload {
            file: crate::storage::UploadFileInfo {
                path: "C:\\selected\\song.flac".to_string(),
                size: 3_000_000,
            },
            mime_type: "audio/flac".to_string(),
            kind: "audio".to_string(),
            width: None,
            height: None,
            duration: Some(180),
            title: Some("Song".to_string()),
            performer: Some("Artist".to_string()),
            thumbnail: None,
            has_spoiler: false,
            show_caption_above_media: false,
        };
        let audio_request = prepared_upload_request_with_caption(7, EXTRA, &audio, "").unwrap();
        assert_eq!(
            audio_request["input_message_content"]["@type"],
            "inputMessageAudio"
        );
        assert_eq!(
            audio_request["input_message_content"]["audio"]["title"],
            "Song"
        );
        assert!(
            prepared_upload_album_request_with_caption(7, EXTRA, &[video, audio], "",).is_err()
        );
    }

    #[test]
    fn profile_updates_are_bounded_and_profile_photos_remain_native_only() {
        for request in [
            json!({ "@type": "setName", "first_name": "Lin", "last_name": "Ran", "@extra": EXTRA }),
            json!({ "@type": "setBio", "bio": "Desktop client", "@extra": EXTRA }),
            json!({ "@type": "setUsername", "username": "linran", "@extra": EXTRA }),
            json!({ "@type": "getOption", "name": "dc_id", "@extra": EXTRA }),
        ] {
            assert!(validate_webview_tdlib_request(&request).is_ok());
        }
        assert!(
            validate_webview_tdlib_request(&json!({
                "@type": "setUsername",
                "username": "bad-name",
                "@extra": EXTRA
            }))
            .is_err()
        );
        assert!(
            validate_webview_tdlib_request(&json!({
                "@type": "getOption",
                "name": "database_directory",
                "@extra": EXTRA
            }))
            .is_err()
        );

        let photo = crate::storage::UploadFileInfo {
            path: "C:\\selected\\avatar.jpg".to_string(),
            size: 2_000_000,
        };
        let request = prepared_profile_photo_request(EXTRA, &photo).unwrap();
        assert_eq!(request["photo"]["@type"], "inputChatPhotoStatic");
        assert!(validate_webview_tdlib_request(&request).is_err());
    }

    #[test]
    fn validates_chat_creation_and_keeps_chat_photos_native_only() {
        let supergroup = json!({
            "@type": "createNewSupergroupChat",
            "title": "Notgram Team",
            "is_forum": false,
            "is_channel": false,
            "description": "Desktop collaboration",
            "location": null,
            "message_auto_delete_time": 0,
            "for_import": false,
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&supergroup).is_ok());

        let mut oversized = supergroup.clone();
        oversized["title"] = json!("x".repeat(129));
        assert!(validate_webview_tdlib_request(&oversized).is_err());

        let members = json!({
            "@type": "addChatMembers",
            "chat_id": 72,
            "user_ids": [11, 12],
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&members).is_ok());
        let mut duplicated = members.clone();
        duplicated["user_ids"] = json!([11, 11]);
        assert!(validate_webview_tdlib_request(&duplicated).is_err());

        let permissions = json!({
            "@type": "setChatPermissions",
            "chat_id": 72,
            "permissions": {
                "@type": "chatPermissions",
                "can_send_basic_messages": true,
                "can_send_audios": false,
                "can_send_documents": false,
                "can_send_photos": false,
                "can_send_videos": false,
                "can_send_video_notes": false,
                "can_send_voice_notes": false,
                "can_send_polls": false,
                "can_send_other_messages": false,
                "can_add_link_previews": false,
                "can_react_to_messages": false,
                "can_edit_tag": false,
                "can_change_info": false,
                "can_invite_users": false,
                "can_pin_messages": false,
                "can_create_topics": false
            },
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&permissions).is_ok());
        let mut incomplete = permissions.clone();
        incomplete["permissions"]
            .as_object_mut()
            .unwrap()
            .remove("can_send_polls");
        assert!(validate_webview_tdlib_request(&incomplete).is_err());

        let status = json!({
            "@type": "setChatMemberStatus",
            "chat_id": 72,
            "member_id": { "@type": "messageSenderUser", "user_id": 11 },
            "status": {
                "@type": "chatMemberStatusRestricted",
                "is_member": true,
                "restricted_until_date": 0,
                "permissions": permissions["permissions"].clone()
            },
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&status).is_ok());
        let mut invalid_status = status.clone();
        invalid_status["member_id"]["user_id"] = json!(0);
        assert!(validate_webview_tdlib_request(&invalid_status).is_err());

        let member_tag = json!({
            "@type": "setChatMemberTag",
            "chat_id": 72,
            "user_id": 11,
            "tag": "值班",
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&member_tag).is_ok());
        let mut oversized_tag = member_tag.clone();
        oversized_tag["tag"] = json!("x".repeat(17));
        assert!(validate_webview_tdlib_request(&oversized_tag).is_err());
        let mut multiline_tag = member_tag.clone();
        multiline_tag["tag"] = json!("值班\n成员");
        assert!(validate_webview_tdlib_request(&multiline_tag).is_err());

        let slow_mode = json!({
            "@type": "setChatSlowModeDelay",
            "chat_id": 72,
            "slow_mode_delay": 30,
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&slow_mode).is_ok());
        let mut invalid_slow_mode = slow_mode.clone();
        invalid_slow_mode["slow_mode_delay"] = json!(86_401);
        assert!(validate_webview_tdlib_request(&invalid_slow_mode).is_err());

        let ownership = json!({
            "@type": "transferChatOwnership",
            "chat_id": 72,
            "user_id": 11,
            "password": "two-step-password",
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&ownership).is_ok());

        let event_log = json!({
            "@type": "getChatEventLog",
            "chat_id": 72,
            "query": "",
            "from_event_id": 0,
            "limit": 30,
            "filters": null,
            "user_ids": [],
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&event_log).is_ok());

        let inline = json!({
            "@type": "getInlineQueryResults",
            "bot_user_id": 901,
            "chat_id": 72,
            "user_location": null,
            "query": "release",
            "offset": "",
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&inline).is_ok());
        let send_inline = json!({
            "@type": "sendInlineQueryResultMessage",
            "chat_id": 72,
            "topic_id": null,
            "reply_to": null,
            "options": null,
            "query_id": 1234,
            "result_id": "result-1",
            "hide_via_bot": false,
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&send_inline).is_ok());
        let start_bot = json!({
            "@type": "sendBotStartMessage",
            "bot_user_id": 901,
            "chat_id": 72,
            "parameter": "campaign",
            "@extra": EXTRA
        });
        assert!(validate_webview_tdlib_request(&start_bot).is_ok());

        let photo = crate::storage::UploadFileInfo {
            path: "C:\\selected\\group.jpg".to_string(),
            size: 2_000_000,
        };
        let request = prepared_chat_photo_request(72, EXTRA, &photo).unwrap();
        assert_eq!(request["@type"], "setChatPhoto");
        assert_eq!(request["chat_id"], 72);
        assert!(validate_webview_tdlib_request(&request).is_err());
    }
}
