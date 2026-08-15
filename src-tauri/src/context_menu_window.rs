use std::sync::Mutex;

use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const CONTEXT_MENU_WINDOW_LABEL: &str = "context-menu-shared";
const MIN_WIDTH: f64 = 180.0;
const MAX_WIDTH: f64 = 440.0;
const MIN_HEIGHT: f64 = 54.0;
const MAX_HEIGHT: f64 = 480.0;

#[derive(Default)]
struct ContextMenuSession {
    active_id: Option<String>,
}

impl ContextMenuSession {
    fn activate(&mut self, id: String) {
        self.active_id = Some(id);
    }

    fn is_active(&self, id: &str) -> bool {
        self.active_id.as_deref() == Some(id)
    }

    fn finish(&mut self, id: &str) -> bool {
        if !self.is_active(id) {
            return false;
        }
        self.active_id = None;
        true
    }
}

#[derive(Default)]
pub struct ContextMenuWindowState {
    session: Mutex<ContextMenuSession>,
}

fn menu_size(width: f64, height: f64) -> Result<(f64, f64), String> {
    if !width.is_finite() || !height.is_finite() {
        return Err("invalid context menu window size".to_string());
    }
    Ok((
        width.clamp(MIN_WIDTH, MAX_WIDTH),
        height.clamp(MIN_HEIGHT, MAX_HEIGHT),
    ))
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("invalid context menu window identifier".to_string());
    }
    Ok(())
}

fn context_menu_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(CONTEXT_MENU_WINDOW_LABEL) {
        return Ok(window);
    }
    WebviewWindowBuilder::new(
        app,
        CONTEXT_MENU_WINDOW_LABEL,
        WebviewUrl::App("context-menu-window.html".into()),
    )
    .title("Notgram")
    .inner_size(MIN_WIDTH, MIN_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .visible(false)
    .transparent(true)
    .zoom_hotkeys_enabled(false)
    .prevent_overflow()
    .build()
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn notgram_prepare_context_menu_window(
    app: AppHandle,
    state: State<'_, ContextMenuWindowState>,
) -> Result<(), String> {
    let _session = state.session.lock().map_err(|error| error.to_string())?;
    context_menu_window(&app).map(|_| ())
}

#[tauri::command]
pub async fn notgram_open_context_menu_window(
    app: AppHandle,
    state: State<'_, ContextMenuWindowState>,
    id: String,
    width: f64,
    height: f64,
    x: i32,
    y: i32,
) -> Result<(), String> {
    validate_id(&id)?;
    let (width, height) = menu_size(width, height)?;
    let mut session = state.session.lock().map_err(|error| error.to_string())?;
    let window = context_menu_window(&app)?;
    window.hide().map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    session.activate(id);
    Ok(())
}

#[tauri::command]
pub async fn notgram_show_context_menu_window(
    app: AppHandle,
    state: State<'_, ContextMenuWindowState>,
    id: String,
    width: f64,
    height: f64,
) -> Result<bool, String> {
    validate_id(&id)?;
    let (width, height) = menu_size(width, height)?;
    let session = state.session.lock().map_err(|error| error.to_string())?;
    if !session.is_active(&id) {
        return Ok(false);
    }
    let window = app
        .get_webview_window(CONTEXT_MENU_WINDOW_LABEL)
        .ok_or_else(|| "context menu window not found".to_string())?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn notgram_resize_context_menu_window(
    app: AppHandle,
    state: State<'_, ContextMenuWindowState>,
    id: String,
    width: f64,
    height: f64,
) -> Result<bool, String> {
    validate_id(&id)?;
    let (width, height) = menu_size(width, height)?;
    let session = state.session.lock().map_err(|error| error.to_string())?;
    if !session.is_active(&id) {
        return Ok(false);
    }
    let window = app
        .get_webview_window(CONTEXT_MENU_WINDOW_LABEL)
        .ok_or_else(|| "context menu window not found".to_string())?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn notgram_close_context_menu_window(
    app: AppHandle,
    state: State<'_, ContextMenuWindowState>,
    id: String,
) -> Result<bool, String> {
    validate_id(&id)?;
    let mut session = state.session.lock().map_err(|error| error.to_string())?;
    if !session.is_active(&id) {
        return Ok(false);
    }
    if let Some(window) = app.get_webview_window(CONTEXT_MENU_WINDOW_LABEL) {
        window.hide().map_err(|error| error.to_string())?;
    }
    session.finish(&id);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{ContextMenuSession, menu_size, validate_id};

    #[test]
    fn accepts_only_ephemeral_alphanumeric_menu_ids() {
        assert!(validate_id("0198f34c70b74e2f83e183ef861166db").is_ok());
        assert!(validate_id("../main").is_err());
        assert!(validate_id("").is_err());
    }

    #[test]
    fn constrains_context_menu_window_sizes() {
        assert_eq!(menu_size(438.0, 362.0).unwrap(), (438.0, 362.0));
        assert_eq!(menu_size(900.0, 900.0).unwrap(), (440.0, 480.0));
        assert!(menu_size(f64::NAN, 200.0).is_err());
    }

    #[test]
    fn stale_sessions_cannot_finish_the_active_menu() {
        let mut session = ContextMenuSession::default();
        session.activate("first".to_string());
        session.activate("second".to_string());

        assert!(!session.finish("first"));
        assert!(session.is_active("second"));
        assert!(session.finish("second"));
        assert!(!session.is_active("second"));
    }
}
