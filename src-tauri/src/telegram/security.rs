use serde_json::{Value, json};
use std::path::Path;

const WEBVIEW_TDLIB_REQUESTS: &[&str] = &[
    "addChatToList",
    "addMessageReaction",
    "addProxy",
    "checkAuthenticationCode",
    "checkAuthenticationEmailCode",
    "checkAuthenticationPassword",
    "createChatFolder",
    "createPrivateChat",
    "deleteChatFolder",
    "deleteMessages",
    "disableProxy",
    "downloadFile",
    "editChatFolder",
    "editMessageText",
    "enableProxy",
    "forwardMessages",
    "getChat",
    "getChatFolder",
    "getChatHistory",
    "getChats",
    "getBasicGroupFullInfo",
    "getContacts",
    "getMe",
    "getMessageProperties",
    "getProxies",
    "getRepliedMessage",
    "getSecretChat",
    "getSupergroupFullInfo",
    "getSupergroupMembers",
    "getUser",
    "getUserFullInfo",
    "leaveChat",
    "loadChats",
    "logOut",
    "parseMarkdown",
    "pingProxy",
    "registerUser",
    "requestQrCodeAuthentication",
    "removeMessageReaction",
    "resendMessages",
    "searchChatMessages",
    "searchChatsOnServer",
    "searchMessages",
    "searchPublicChats",
    "sendMessage",
    "setAuthenticationEmailAddress",
    "setAuthenticationPhoneNumber",
    "setChatDraftMessage",
    "setChatNotificationSettings",
    "setPinnedChats",
    "toggleChatIsMarkedAsUnread",
    "toggleChatIsPinned",
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
    if request_type == "createPrivateChat"
        && request.get("force").and_then(Value::as_bool) != Some(false)
    {
        return Err("Private chats must be resolved from the Telegram server".to_string());
    }
    if matches!(request_type, "sendMessage" | "editMessageText") {
        let content_type = request
            .get("input_message_content")
            .and_then(|content| content.get("@type"))
            .and_then(Value::as_str);
        if content_type != Some("inputMessageText") {
            return Err("Generic message requests are limited to text content".to_string());
        }
    }
    Ok(())
}

fn input_message_upload(file: &crate::storage::UploadFileInfo) -> Value {
    let is_photo = Path::new(&file.path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png"
            )
        })
        && file.size <= 10 * 1024 * 1024;
    let input_file = json!({ "@type": "inputFileLocal", "path": file.path });
    let caption = json!({ "@type": "formattedText", "text": "", "entities": [] });
    if is_photo {
        json!({
            "@type": "inputMessagePhoto",
            "photo": {
                "@type": "inputPhoto",
                "photo": input_file,
                "thumbnail": null,
                "video": null,
                "added_sticker_file_ids": [],
                "width": 0,
                "height": 0
            },
            "caption": caption,
            "show_caption_above_media": false,
            "self_destruct_type": null,
            "has_spoiler": false
        })
    } else {
        json!({
            "@type": "inputMessageDocument",
            "document": {
                "@type": "inputDocument",
                "document": input_file,
                "thumbnail": null,
                "disable_content_type_detection": false
            },
            "caption": caption
        })
    }
}

pub(super) fn prepared_file_request(
    chat_id: i64,
    extra: &str,
    file: &crate::storage::UploadFileInfo,
) -> Result<Value, String> {
    if chat_id == 0 {
        return Err("Invalid Telegram chat identifier".to_string());
    }
    validate_webview_extra(extra)?;
    Ok(json!({
        "@type": "sendMessage",
        "chat_id": chat_id,
        "topic_id": null,
        "reply_to": null,
        "options": null,
        "reply_markup": null,
        "input_message_content": input_message_upload(file),
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
            "getSupergroupFullInfo",
            "getSupergroupMembers",
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
        assert!(validate_webview_tdlib_request(&photo_request).is_err());
    }
}
