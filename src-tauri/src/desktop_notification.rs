use std::{
    collections::VecDeque,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const NOTIFICATION_OPEN_EVENT: &str = "notgram://notification-open";
const NOTIFICATIONS_CHANGED_EVENT: &str = "notgram://desktop-notifications-changed";
const NOTIFICATION_WINDOW_LABEL: &str = "desktop-notifications";
const NOTIFICATION_WINDOW_WIDTH: f64 = 380.0;
const NOTIFICATION_WINDOW_MIN_HEIGHT: f64 = 88.0;
const NOTIFICATION_WINDOW_MAX_HEIGHT: f64 = 560.0;
const NOTIFICATION_WINDOW_MARGIN: f64 = 16.0;
const MAX_VISIBLE_NOTIFICATIONS: usize = 4;
const MAX_TITLE_CHARS: usize = 200;
const MAX_BODY_CHARS: usize = 1_000;
const MAX_AVATAR_LABEL_CHARS: usize = 8;
const MAX_AVATAR_PATH_CHARS: usize = 4_096;
const MAX_ROUTE_ID_CHARS: usize = 256;
#[cfg(windows)]
const NOTIFICATION_SOUND_RESOURCE: &str = "resources/sounds/notification.mp3";
#[cfg(windows)]
const NOTIFICATION_SOUND_ALIAS: &str = "notgram_notification_sound";

#[cfg(windows)]
static NOTIFICATION_SOUND_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRoute {
    account_id: String,
    chat_id: String,
    message_id: String,
    topic_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationAvatar {
    label: String,
    color: String,
    image_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationRequest {
    title: String,
    body: String,
    avatar: DesktopNotificationAvatar,
    sound: bool,
    theme_id: String,
    reduce_motion: bool,
    route: NotificationRoute,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationItem {
    id: String,
    title: String,
    body: String,
    avatar: DesktopNotificationAvatar,
    theme_id: String,
    reduce_motion: bool,
    updated_at_ms: u64,
    route: NotificationRoute,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationSnapshot {
    revision: u64,
    items: Vec<DesktopNotificationItem>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NotificationWindowLayout {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
}

#[derive(Default)]
pub struct DesktopNotificationWindowState {
    queue: Mutex<NotificationQueue>,
    next_id: AtomicU64,
}

#[derive(Default)]
struct NotificationQueue {
    visible: VecDeque<DesktopNotificationItem>,
    waiting: VecDeque<DesktopNotificationItem>,
    revision: u64,
}

impl DesktopNotificationWindowState {
    fn push(&self, request: DesktopNotificationRequest) -> Result<DesktopNotificationItem, String> {
        let mut queue = self.queue.lock().map_err(|error| error.to_string())?;
        let timestamp = notification_timestamp();
        let visible_index = queue.visible.iter().position(|item| {
            item.route.account_id == request.route.account_id
                && item.route.chat_id == request.route.chat_id
                && item.route.topic_id == request.route.topic_id
        });
        let waiting_index = visible_index
            .is_none()
            .then(|| {
                queue.waiting.iter().position(|item| {
                    item.route.account_id == request.route.account_id
                        && item.route.chat_id == request.route.chat_id
                        && item.route.topic_id == request.route.topic_id
                })
            })
            .flatten();
        let existing = if let Some(index) = visible_index {
            queue.visible.get_mut(index)
        } else if let Some(index) = waiting_index {
            queue.waiting.get_mut(index)
        } else {
            None
        };
        if let Some(item) = existing {
            item.title = request.title;
            item.body = request.body;
            item.avatar = request.avatar;
            item.theme_id = request.theme_id;
            item.reduce_motion = request.reduce_motion;
            item.updated_at_ms = timestamp.max(item.updated_at_ms.saturating_add(1));
            item.route = request.route;
            let item = item.clone();
            queue.revision = queue.revision.saturating_add(1);
            return Ok(item);
        }

        let sequence = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let item = DesktopNotificationItem {
            id: format!("notification-{sequence}"),
            title: request.title,
            body: request.body,
            avatar: request.avatar,
            theme_id: request.theme_id,
            reduce_motion: request.reduce_motion,
            updated_at_ms: timestamp,
            route: request.route,
        };
        if queue.visible.len() < MAX_VISIBLE_NOTIFICATIONS {
            queue.visible.push_back(item.clone());
        } else {
            queue.waiting.push_back(item.clone());
        }
        queue.revision = queue.revision.saturating_add(1);
        Ok(item)
    }

    fn remove(
        &self,
        id: &str,
        expected_updated_at_ms: u64,
    ) -> Result<DesktopNotificationSnapshot, String> {
        let mut queue = self.queue.lock().map_err(|error| error.to_string())?;
        let matching_item = queue
            .visible
            .iter()
            .chain(queue.waiting.iter())
            .find(|item| item.id == id);
        if matching_item.is_none_or(|item| item.updated_at_ms != expected_updated_at_ms) {
            return Ok(snapshot_for(&queue));
        }
        let removed_visible = queue.visible.iter().any(|item| item.id == id);
        queue.visible.retain(|item| item.id != id);
        queue.waiting.retain(|item| item.id != id);
        if removed_visible && let Some(mut promoted) = queue.waiting.pop_front() {
            promoted.updated_at_ms =
                notification_timestamp().max(promoted.updated_at_ms.saturating_add(1));
            queue.visible.push_back(promoted);
        }
        queue.revision = queue.revision.saturating_add(1);
        Ok(snapshot_for(&queue))
    }

    fn snapshot(&self) -> Result<DesktopNotificationSnapshot, String> {
        let queue = self.queue.lock().map_err(|error| error.to_string())?;
        Ok(snapshot_for(&queue))
    }
}

fn snapshot_for(queue: &NotificationQueue) -> DesktopNotificationSnapshot {
    DesktopNotificationSnapshot {
        revision: queue.revision,
        items: queue.visible.iter().cloned().collect(),
    }
}

fn notification_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
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

fn validate_route(route: &NotificationRoute) -> Result<(), String> {
    validate_text(
        &route.account_id,
        MAX_ROUTE_ID_CHARS,
        "notification account id",
    )?;
    validate_text(&route.chat_id, MAX_ROUTE_ID_CHARS, "notification chat id")?;
    validate_text(
        &route.message_id,
        MAX_ROUTE_ID_CHARS,
        "notification message id",
    )?;
    if let Some(topic_id) = &route.topic_id {
        validate_text(topic_id, MAX_ROUTE_ID_CHARS, "notification topic id")?;
    }
    Ok(())
}

fn validate_avatar(avatar: &DesktopNotificationAvatar) -> Result<(), String> {
    validate_text(
        &avatar.label,
        MAX_AVATAR_LABEL_CHARS,
        "notification avatar label",
    )?;
    let valid_color = avatar.color.len() == 7
        && avatar.color.starts_with('#')
        && avatar.color[1..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit());
    if !valid_color {
        return Err("invalid notification avatar color".to_string());
    }
    if let Some(image_path) = &avatar.image_path {
        validate_text(
            image_path,
            MAX_AVATAR_PATH_CHARS,
            "notification avatar image path",
        )?;
    }
    Ok(())
}

fn validate_request(request: &DesktopNotificationRequest) -> Result<(), String> {
    validate_text(&request.title, MAX_TITLE_CHARS, "notification title")?;
    validate_text(&request.body, MAX_BODY_CHARS, "notification body")?;
    validate_avatar(&request.avatar)?;
    if !matches!(request.theme_id.as_str(), "notgram-light" | "notgram-dark") {
        return Err("invalid notification theme".to_string());
    }
    validate_route(&request.route)
}

fn notification_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(NOTIFICATION_WINDOW_LABEL) {
        return Ok(window);
    }
    WebviewWindowBuilder::new(
        app,
        NOTIFICATION_WINDOW_LABEL,
        WebviewUrl::App("notification-window.html".into()),
    )
    .data_directory(crate::distribution::webview_data_directory(app)?)
    .title("Notgram")
    .inner_size(NOTIFICATION_WINDOW_WIDTH, NOTIFICATION_WINDOW_MIN_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .focusable(false)
    .visible(false)
    .transparent(true)
    .zoom_hotkeys_enabled(false)
    .prevent_overflow()
    .build()
    .map_err(|error| error.to_string())
}

fn notification_window_layout(
    work_area_position: PhysicalPosition<i32>,
    work_area_size: PhysicalSize<u32>,
    scale_factor: f64,
    requested_height: f64,
) -> Result<NotificationWindowLayout, String> {
    if !requested_height.is_finite() || requested_height <= 0.0 {
        return Err("invalid notification window height".to_string());
    }
    let scale_factor = scale_factor.max(0.1);
    let margin = (NOTIFICATION_WINDOW_MARGIN * scale_factor).round() as i64;
    let available_width = i64::from(work_area_size.width).saturating_sub(margin * 2);
    let available_height = i64::from(work_area_size.height).saturating_sub(margin * 2);
    let width = (NOTIFICATION_WINDOW_WIDTH * scale_factor).round() as i64;
    let height = (requested_height.clamp(
        NOTIFICATION_WINDOW_MIN_HEIGHT,
        NOTIFICATION_WINDOW_MAX_HEIGHT,
    ) * scale_factor)
        .round() as i64;
    let width = width.min(available_width).max(1);
    let height = height.min(available_height).max(1);
    let right = i64::from(work_area_position.x) + i64::from(work_area_size.width);
    let bottom = i64::from(work_area_position.y) + i64::from(work_area_size.height);
    let x = (right - width - margin)
        .clamp(i64::from(i32::MIN), i64::from(i32::MAX))
        .try_into()
        .unwrap_or(work_area_position.x);
    let y = (bottom - height - margin)
        .clamp(i64::from(i32::MIN), i64::from(i32::MAX))
        .try_into()
        .unwrap_or(work_area_position.y);
    Ok(NotificationWindowLayout {
        position: PhysicalPosition::new(x, y),
        size: PhysicalSize::new(
            width.try_into().unwrap_or(1),
            height.try_into().unwrap_or(1),
        ),
    })
}

fn position_notification_window(
    app: &AppHandle,
    window: &WebviewWindow,
    height: f64,
) -> Result<(), String> {
    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| "No display is available for notifications".to_string())?;
    let work_area = monitor.work_area();
    let layout = notification_window_layout(
        work_area.position,
        work_area.size,
        monitor.scale_factor(),
        height,
    )?;
    window
        .set_position(layout.position)
        .map_err(|error| error.to_string())?;
    window
        .set_size(layout.size)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn emit_snapshot(app: &AppHandle, snapshot: &DesktopNotificationSnapshot) {
    let _ = app.emit_to(
        NOTIFICATION_WINDOW_LABEL,
        NOTIFICATIONS_CHANGED_EVENT,
        snapshot,
    );
}

fn open_notification_route(app: &AppHandle, route: &NotificationRoute) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let _ = app.emit_to("main", NOTIFICATION_OPEN_EVENT, route.clone());
}

#[cfg(windows)]
fn send_mci_command(command: &str) -> u32 {
    use windows::{Win32::Media::Multimedia::mciSendStringW, core::HSTRING};

    let command = HSTRING::from(command);
    unsafe { mciSendStringW(&command, None, None) }
}

#[cfg(windows)]
fn try_play_notification_sound(app: &AppHandle) -> bool {
    let Ok(_guard) = NOTIFICATION_SOUND_LOCK.lock() else {
        return false;
    };
    let Ok(resource_directory) = app.path().resource_dir() else {
        return false;
    };
    let sound_path = resource_directory.join(NOTIFICATION_SOUND_RESOURCE);
    if !sound_path.is_file() {
        return false;
    }

    let _ = send_mci_command(&format!("close {NOTIFICATION_SOUND_ALIAS}"));
    let open_command = format!(
        "open \"{}\" type mpegvideo alias {NOTIFICATION_SOUND_ALIAS}",
        sound_path.display()
    );
    if send_mci_command(&open_command) != 0 {
        return false;
    }
    if send_mci_command(&format!("play {NOTIFICATION_SOUND_ALIAS}")) == 0 {
        return true;
    }

    let _ = send_mci_command(&format!("close {NOTIFICATION_SOUND_ALIAS}"));
    false
}

#[cfg(windows)]
fn play_notification_sound(app: &AppHandle) {
    use windows::Win32::{
        System::Diagnostics::Debug::MessageBeep, UI::WindowsAndMessaging::MB_ICONASTERISK,
    };

    if !try_play_notification_sound(app) {
        let _ = unsafe { MessageBeep(MB_ICONASTERISK) };
    }
}

#[cfg(not(windows))]
fn play_notification_sound(_app: &AppHandle) {}

#[tauri::command]
pub async fn notgram_show_notification(
    app: AppHandle,
    state: State<'_, DesktopNotificationWindowState>,
    notification: DesktopNotificationRequest,
) -> Result<(), String> {
    validate_request(&notification)?;
    let sound = notification.sound;
    let item = state.push(notification)?;
    if let Err(error) = notification_window(&app) {
        let _ = state.remove(&item.id, item.updated_at_ms);
        return Err(error);
    }
    let snapshot = state.snapshot()?;
    emit_snapshot(&app, &snapshot);
    if sound {
        play_notification_sound(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn notgram_desktop_notification_snapshot(
    state: State<'_, DesktopNotificationWindowState>,
) -> Result<DesktopNotificationSnapshot, String> {
    state.snapshot()
}

#[tauri::command]
pub fn notgram_show_notification_window(
    app: AppHandle,
    state: State<'_, DesktopNotificationWindowState>,
    height: f64,
) -> Result<bool, String> {
    if state.snapshot()?.items.is_empty() {
        return Ok(false);
    }
    let window = notification_window(&app)?;
    position_notification_window(&app, &window, height)?;
    window.show().map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn notgram_dismiss_notification(
    app: AppHandle,
    state: State<'_, DesktopNotificationWindowState>,
    id: String,
    expected_updated_at_ms: u64,
) -> Result<DesktopNotificationSnapshot, String> {
    validate_text(&id, 64, "notification id")?;
    let snapshot = state.remove(&id, expected_updated_at_ms)?;
    emit_snapshot(&app, &snapshot);
    if snapshot.items.is_empty()
        && let Some(window) = app.get_webview_window(NOTIFICATION_WINDOW_LABEL)
    {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(snapshot)
}

#[tauri::command]
pub fn notgram_open_notification(app: AppHandle, route: NotificationRoute) -> Result<(), String> {
    validate_route(&route)?;
    open_notification_route(&app, &route);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> DesktopNotificationRequest {
        DesktopNotificationRequest {
            title: "Notgram".to_string(),
            body: "New message".to_string(),
            avatar: DesktopNotificationAvatar {
                label: "N".to_string(),
                color: "#4e86b0".to_string(),
                image_path: Some("C:\\avatars\\chat.jpg".to_string()),
            },
            sound: true,
            theme_id: "notgram-light".to_string(),
            reduce_motion: false,
            route: NotificationRoute {
                account_id: "default".to_string(),
                chat_id: "123".to_string(),
                message_id: "456".to_string(),
                topic_id: None,
            },
        }
    }

    #[test]
    fn accepts_bounded_notification_routes() {
        assert_eq!(validate_request(&request()), Ok(()));
    }

    #[test]
    fn rejects_empty_oversized_and_invalid_theme_values() {
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

        let mut invalid_theme = request();
        invalid_theme.theme_id = "unknown".to_string();
        assert_eq!(
            validate_request(&invalid_theme),
            Err("invalid notification theme".to_string())
        );

        let mut invalid_avatar = request();
        invalid_avatar.avatar.color = "url(bad)".to_string();
        assert_eq!(
            validate_request(&invalid_avatar),
            Err("invalid notification avatar color".to_string())
        );
    }

    #[test]
    fn serializes_routes_and_items_with_frontend_field_names() {
        let state = DesktopNotificationWindowState::default();
        let item = state.push(request()).expect("notification should queue");
        assert_eq!(
            serde_json::to_value(item.route.clone()).expect("route should serialize"),
            serde_json::json!({
                "accountId": "default",
                "chatId": "123",
                "messageId": "456",
                "topicId": null,
            })
        );
        let serialized = serde_json::to_value(item).expect("item should serialize");
        assert_eq!(serialized["themeId"], "notgram-light");
        assert_eq!(serialized["reduceMotion"], false);
        assert_eq!(serialized["avatar"]["label"], "N");
        assert_eq!(serialized["avatar"]["imagePath"], "C:\\avatars\\chat.jpg");
        assert!(serialized["updatedAtMs"].is_number());
    }

    #[test]
    fn reuses_a_notification_for_new_messages_in_the_same_conversation() {
        let state = DesktopNotificationWindowState::default();
        let first = state.push(request()).expect("notification should queue");
        let mut replacement = request();
        replacement.body = "Newest message".to_string();
        replacement.route.message_id = "789".to_string();
        let updated = state.push(replacement).expect("notification should update");

        assert_eq!(updated.id, first.id);
        assert!(updated.updated_at_ms > first.updated_at_ms);
        let snapshot = state.snapshot().expect("snapshot should be available");
        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(snapshot.items[0].body, "Newest message");
        assert_eq!(snapshot.items[0].route.message_id, "789");

        let stale_dismiss = state
            .remove(&first.id, first.updated_at_ms)
            .expect("stale dismiss should be ignored");
        assert_eq!(stale_dismiss.items.len(), 1);
        let dismissed = state
            .remove(&updated.id, updated.updated_at_ms)
            .expect("current notification should dismiss");
        assert!(dismissed.items.is_empty());
    }

    #[test]
    fn keeps_forum_topic_notifications_as_separate_conversations() {
        let state = DesktopNotificationWindowState::default();
        let mut first_topic = request();
        first_topic.route.topic_id = Some("12".to_string());
        let mut second_topic = request();
        second_topic.route.topic_id = Some("18".to_string());

        state.push(first_topic).expect("first topic should queue");
        state.push(second_topic).expect("second topic should queue");

        let snapshot = state.snapshot().expect("snapshot should be available");
        assert_eq!(snapshot.items.len(), 2);
        assert_eq!(snapshot.items[0].route.topic_id.as_deref(), Some("12"));
        assert_eq!(snapshot.items[1].route.topic_id.as_deref(), Some("18"));
    }

    #[test]
    fn queues_conversation_bursts_without_dropping_notifications() {
        let state = DesktopNotificationWindowState::default();
        for index in 0..(MAX_VISIBLE_NOTIFICATIONS + 2) {
            let mut next = request();
            next.route.chat_id = format!("chat-{index}");
            next.route.message_id = index.to_string();
            state.push(next).expect("notification should queue");
        }
        let snapshot = state.snapshot().expect("snapshot should be available");
        assert_eq!(snapshot.revision, (MAX_VISIBLE_NOTIFICATIONS + 2) as u64);
        assert_eq!(snapshot.items.len(), MAX_VISIBLE_NOTIFICATIONS);
        assert_eq!(
            snapshot
                .items
                .first()
                .map(|item| item.route.message_id.as_str()),
            Some("0")
        );
        let first_id = snapshot.items[0].id.clone();
        let first_updated_at_ms = snapshot.items[0].updated_at_ms;
        let snapshot = state
            .remove(&first_id, first_updated_at_ms)
            .expect("visible item should dismiss");
        assert_eq!(snapshot.items.len(), MAX_VISIBLE_NOTIFICATIONS);
        assert_eq!(
            snapshot
                .items
                .last()
                .map(|item| item.route.message_id.as_str()),
            Some("4")
        );
        for _ in 0..MAX_VISIBLE_NOTIFICATIONS + 1 {
            let snapshot = state.snapshot().expect("snapshot should be available");
            let item = &snapshot.items[0];
            state
                .remove(&item.id, item.updated_at_ms)
                .expect("queued item should dismiss");
        }
        assert!(
            state
                .snapshot()
                .expect("snapshot should be available")
                .items
                .is_empty()
        );
    }

    #[test]
    fn positions_notifications_on_scaled_secondary_work_areas() {
        let layout = notification_window_layout(
            PhysicalPosition::new(-1920, 0),
            PhysicalSize::new(1920, 1040),
            1.25,
            300.0,
        )
        .expect("layout should be valid");
        assert_eq!(layout.position, PhysicalPosition::new(-495, 645));
        assert_eq!(layout.size, PhysicalSize::new(475, 375));
    }

    #[test]
    fn rejects_invalid_heights_and_fits_small_work_areas() {
        assert!(
            notification_window_layout(
                PhysicalPosition::new(0, 0),
                PhysicalSize::new(800, 600),
                1.0,
                f64::NAN,
            )
            .is_err()
        );
        let layout = notification_window_layout(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(300, 180),
            1.0,
            560.0,
        )
        .expect("small work areas should still fit");
        assert_eq!(layout.position, PhysicalPosition::new(16, 16));
        assert_eq!(layout.size, PhysicalSize::new(268, 148));
    }
}
