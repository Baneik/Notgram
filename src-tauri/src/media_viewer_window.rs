use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, webview::PageLoadEvent};

fn validate_window_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("invalid media viewer window identifier".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn notgram_open_media_viewer_window(app: AppHandle, id: String) -> Result<(), String> {
    validate_window_id(&id)?;
    let label = format!("media-viewer-{id}");
    if let Some(existing) = app.get_webview_window(&label) {
        existing.close().map_err(|error| error.to_string())?;
    }

    let url = WebviewUrl::App(format!("index.html?mediaViewerWindow={id}").into());
    WebviewWindowBuilder::new(&app, label, url)
        .title("Notgram 图片")
        .inner_size(1280.0, 800.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .focused(true)
        .visible(false)
        .fullscreen(false)
        .zoom_hotkeys_enabled(false)
        .prevent_overflow()
        .on_page_load(|window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let _ = window.set_fullscreen(true);
            let _ = window.show();
            let _ = window.set_focus();
        })
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn notgram_close_media_viewer_window(app: AppHandle, id: String) -> Result<(), String> {
    validate_window_id(&id)?;
    let label = format!("media-viewer-{id}");
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_window_id;

    #[test]
    fn accepts_ephemeral_alphanumeric_window_ids() {
        assert!(validate_window_id("0198f34c70b74e2f83e183ef861166db").is_ok());
    }

    #[test]
    fn rejects_window_ids_that_can_escape_the_label_or_url() {
        assert!(validate_window_id("../main").is_err());
        assert!(validate_window_id("").is_err());
    }
}
