use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder,
    webview::PageLoadEvent,
};

const MIN_WIDTH: f64 = 180.0;
const MAX_WIDTH: f64 = 440.0;
const MIN_HEIGHT: f64 = 54.0;
const MAX_HEIGHT: f64 = 480.0;

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

#[tauri::command]
pub async fn notgram_open_context_menu_window(
    app: AppHandle,
    id: String,
    width: f64,
    height: f64,
    x: i32,
    y: i32,
    scale_factor: f64,
) -> Result<(), String> {
    validate_id(&id)?;
    if !scale_factor.is_finite() || !(0.5..=4.0).contains(&scale_factor) {
        return Err("invalid context menu scale factor".to_string());
    }
    let label = format!("context-menu-{id}");
    if let Some(existing) = app.get_webview_window(&label) {
        existing.close().map_err(|error| error.to_string())?;
    }
    let (width, height) = menu_size(width, height)?;
    let url = WebviewUrl::App(format!("context-menu-window.html?id={id}").into());
    let window_x = x;
    let window_y = y;
    let builder = WebviewWindowBuilder::new(&app, label, url)
        .title("Notgram")
        .inner_size(width, height)
        .position(x as f64 / scale_factor, y as f64 / scale_factor)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .focused(true)
        .visible(false)
        .transparent(true)
        .zoom_hotkeys_enabled(false)
        .prevent_overflow()
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let _ = window.set_position(PhysicalPosition::new(window_x, window_y));
            let _ = window.set_size(LogicalSize::new(width, height));
            let _ = window.show();
            let _ = window.set_focus();
        });
    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn notgram_resize_context_menu_window(
    app: AppHandle,
    id: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    validate_id(&id)?;
    let (width, height) = menu_size(width, height)?;
    let window = app
        .get_webview_window(&format!("context-menu-{id}"))
        .ok_or_else(|| "context menu window not found".to_string())?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn notgram_close_context_menu_window(app: AppHandle, id: String) -> Result<(), String> {
    validate_id(&id)?;
    if let Some(window) = app.get_webview_window(&format!("context-menu-{id}")) {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{menu_size, validate_id};

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
}
