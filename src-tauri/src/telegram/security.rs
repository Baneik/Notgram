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
    "setBio",
    "setAuthenticationEmailAddress",
    "setAuthenticationPhoneNumber",
    "setChatDraftMessage",
    "setChatNotificationSettings",
    "setName",
    "setPinnedChats",
    "setUsername",
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
    match request_type {
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

fn input_message_upload(file: &crate::storage::UploadFileInfo) -> Value {
    let is_photo = is_photo_upload(file);
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

pub(super) fn prepared_file_album_request(
    chat_id: i64,
    extra: &str,
    files: &[crate::storage::UploadFileInfo],
) -> Result<Value, String> {
    if chat_id == 0 {
        return Err("Invalid Telegram chat identifier".to_string());
    }
    validate_webview_extra(extra)?;
    if !(2..=10).contains(&files.len()) {
        return Err("Telegram albums require between 2 and 10 files".to_string());
    }
    let first_is_photo = is_photo_upload(&files[0]);
    if files
        .iter()
        .any(|file| is_photo_upload(file) != first_is_photo)
    {
        return Err("Telegram albums cannot mix photos and documents".to_string());
    }
    Ok(json!({
        "@type": "sendMessageAlbum",
        "chat_id": chat_id,
        "topic_id": null,
        "reply_to": null,
        "options": null,
        "input_message_contents": files.iter().map(input_message_upload).collect::<Vec<_>>(),
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
        let album_request = prepared_file_album_request(
            7,
            EXTRA,
            &[
                photo.clone(),
                crate::storage::UploadFileInfo {
                    path: "C:\\selected\\photo-2.png".to_string(),
                    size: 1_000_000,
                },
            ],
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
        assert!(prepared_file_album_request(7, EXTRA, &[photo.clone()]).is_err());
        assert!(prepared_file_album_request(7, EXTRA, &[photo, large_photo]).is_err());
        assert!(validate_webview_tdlib_request(&photo_request).is_err());
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
}
