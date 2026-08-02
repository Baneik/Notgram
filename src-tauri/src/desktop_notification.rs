use notify_rust::{Notification, NotificationResponse};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const NOTIFICATION_OPEN_EVENT: &str = "notgram://notification-open";
const WINDOWS_MESSAGE_SOUND: &str = "IM";
const MAX_TITLE_CHARS: usize = 200;
const MAX_BODY_CHARS: usize = 1_000;
const MAX_ROUTE_ID_CHARS: usize = 256;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRoute {
    account_id: String,
    chat_id: String,
    message_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationRequest {
    title: String,
    body: String,
    sound: bool,
    route: NotificationRoute,
}

fn validate_text(value: &str, maximum_chars: usize, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if value.chars().count() > maximum_chars {
        return Err(format!("{field} is too long"));
    }
    Ok(())
}

fn validate_request(request: &DesktopNotificationRequest) -> Result<(), String> {
    validate_text(&request.title, MAX_TITLE_CHARS, "notification title")?;
    validate_text(&request.body, MAX_BODY_CHARS, "notification body")?;
    validate_text(
        &request.route.account_id,
        MAX_ROUTE_ID_CHARS,
        "notification account id",
    )?;
    validate_text(
        &request.route.chat_id,
        MAX_ROUTE_ID_CHARS,
        "notification chat id",
    )?;
    validate_text(
        &request.route.message_id,
        MAX_ROUTE_ID_CHARS,
        "notification message id",
    )?;
    Ok(())
}

fn should_set_application_id() -> bool {
    let Ok(executable) = std::env::current_exe() else {
        return false;
    };
    let Some(directory) = executable.parent() else {
        return false;
    };
    let directory = directory.to_string_lossy();
    let separator = std::path::MAIN_SEPARATOR;
    !directory.ends_with(&format!("{separator}target{separator}debug"))
        && !directory.ends_with(&format!("{separator}target{separator}release"))
}

fn open_notification_route(app: &AppHandle, route: NotificationRoute) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let _ = app.emit(NOTIFICATION_OPEN_EVENT, route);
}

#[tauri::command]
pub fn notgram_show_notification(
    app: AppHandle,
    notification: DesktopNotificationRequest,
) -> Result<(), String> {
    validate_request(&notification)?;

    let mut native_notification = Notification::new();
    native_notification
        .summary(&notification.title)
        .body(&notification.body);
    if notification.sound {
        native_notification.sound_name(WINDOWS_MESSAGE_SOUND);
    }
    if should_set_application_id() {
        native_notification.app_id(&app.config().identifier);
    }

    let handle = native_notification
        .show()
        .map_err(|_| "Unable to show the Windows notification".to_string())?;
    let route = notification.route;
    std::thread::Builder::new()
        .name("notgram-notification-action".to_string())
        .spawn(move || {
            let app = app.clone();
            let _ = handle.wait_for_response(move |response: &NotificationResponse| {
                if response.is_default_action() {
                    open_notification_route(&app, route);
                }
            });
        })
        .map_err(|_| "Unable to observe the Windows notification".to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> DesktopNotificationRequest {
        DesktopNotificationRequest {
            title: "Notgram".to_string(),
            body: "New message".to_string(),
            sound: true,
            route: NotificationRoute {
                account_id: "default".to_string(),
                chat_id: "123".to_string(),
                message_id: "456".to_string(),
            },
        }
    }

    #[test]
    fn accepts_bounded_notification_routes() {
        assert_eq!(validate_request(&request()), Ok(()));
    }

    #[test]
    fn rejects_empty_and_oversized_values() {
        let mut empty_route = request();
        empty_route.route.message_id = "  ".to_string();
        assert_eq!(
            validate_request(&empty_route),
            Err("notification message id must not be empty".to_string())
        );

        let mut oversized_body = request();
        oversized_body.body = "x".repeat(MAX_BODY_CHARS + 1);
        assert_eq!(
            validate_request(&oversized_body),
            Err("notification body is too long".to_string())
        );
    }

    #[test]
    fn serializes_routes_with_frontend_field_names() {
        let route = request().route;
        assert_eq!(
            serde_json::to_value(route).expect("route should serialize"),
            serde_json::json!({
                "accountId": "default",
                "chatId": "123",
                "messageId": "456",
            })
        );
    }
}
