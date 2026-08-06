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

fn input_message_upload(upload: &PreparedUpload, caption_text: &str) -> Result<Value, String> {
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
    let caption = json!({ "@type": "formattedText", "text": caption_text, "entities": [] });
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

pub(super) fn prepared_file_request(
    chat_id: i64,
    extra: &str,
    file: &crate::storage::UploadFileInfo,
) -> Result<Value, String> {
    prepared_file_request_with_caption(chat_id, extra, file, "")
}

pub(super) fn prepared_file_request_with_caption(
    chat_id: i64,
    extra: &str,
    file: &crate::storage::UploadFileInfo,
    caption: &str,
) -> Result<Value, String> {
    prepared_upload_request_with_caption(chat_id, extra, &PreparedUpload::automatic(file), caption)
}

pub(super) fn prepared_upload_request_with_caption(
    chat_id: i64,
    extra: &str,
    upload: &PreparedUpload,
    caption: &str,
) -> Result<Value, String> {
    if chat_id == 0 {
        return Err("Invalid Telegram chat identifier".to_string());
    }
    validate_webview_extra(extra)?;
    validate_upload_caption(caption)?;
    Ok(json!({
        "@type": "sendMessage",
        "chat_id": chat_id,
        "topic_id": null,
        "reply_to": null,
        "options": null,
        "reply_markup": null,
        "input_message_content": input_message_upload(upload, caption)?,
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

pub(super) fn prepared_upload_album_request_with_caption(
    chat_id: i64,
    extra: &str,
    uploads: &[PreparedUpload],
    caption: &str,
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
        "topic_id": null,
        "reply_to": null,
        "options": null,
        "input_message_contents": uploads.iter().enumerate().map(|(index, upload)| {
            input_message_upload(upload, if index == 0 { caption } else { "" })
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
}
