use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, webview::PageLoadEvent};

const MIN_WINDOW_WIDTH: f64 = 240.0;
const MIN_WINDOW_HEIGHT: f64 = 135.0;
const MAX_WINDOW_WIDTH: f64 = 960.0;
const MAX_WINDOW_HEIGHT: f64 = 720.0;

fn validate_window_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("invalid video window identifier".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn notgram_open_video_window(
    app: AppHandle,
    id: String,
    width: f64,
    height: f64,
    fullscreen: bool,
) -> Result<(), String> {
    validate_window_id(&id)?;
    let label = format!("video-player-{id}");
    if let Some(existing) = app.get_webview_window(&label) {
        existing.close().map_err(|error| error.to_string())?;
    }

    let width = width.clamp(MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH);
    let height = height.clamp(MIN_WINDOW_HEIGHT, MAX_WINDOW_HEIGHT);
    let url = WebviewUrl::App(format!("index.html?videoWindow={id}").into());
    let show_fullscreen = fullscreen;
    let mut builder = WebviewWindowBuilder::new(&app, label, url)
        .title("Notgram 视频")
        .inner_size(width, height)
        .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        .resizable(true)
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
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            if show_fullscreen {
                let _ = window.set_fullscreen(true);
            }
            let _ = window.show();
            let _ = window.set_focus();
        });
    builder = if let Some((x, y)) =
        crate::window_placement::centered_on_main_monitor(&app, width, height)
    {
        builder.position(x, y)
    } else {
        builder.center()
    };
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn notgram_close_video_window(app: AppHandle, id: String) -> Result<(), String> {
    validate_window_id(&id)?;
    let label = format!("video-player-{id}");
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
