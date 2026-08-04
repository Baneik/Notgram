use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, webview::PageLoadEvent};

const WINDOW_WIDTH: f64 = 880.0;
const WINDOW_HEIGHT: f64 = 680.0;

#[tauri::command]
pub async fn notgram_open_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("settings") {
        existing.show().map_err(|error| error.to_string())?;
        existing.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let url = WebviewUrl::App("index.html?settingsWindow=1".into());
    let mut builder = WebviewWindowBuilder::new(&app, "settings", url)
        .title("")
        .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
        .min_inner_size(720.0, 540.0)
        .resizable(true)
        .maximizable(true)
        .minimizable(true)
        .decorations(false)
        .always_on_top(false)
        .skip_taskbar(false)
        .focused(true)
        .visible(false)
        .zoom_hotkeys_enabled(false)
        .prevent_overflow()
        .on_page_load(|window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let _ = window.show();
            let _ = window.set_focus();
        });
    builder = if let Some((x, y)) =
        crate::window_placement::centered_on_main_window(&app, WINDOW_WIDTH, WINDOW_HEIGHT)
    {
        builder.position(x, y)
    } else {
        builder.center()
    };
    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}
