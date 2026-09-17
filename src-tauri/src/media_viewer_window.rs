use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
    webview::PageLoadEvent,
};

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
pub async fn notgram_open_media_viewer_window(
    app: AppHandle,
    id: String,
    windowed: Option<bool>,
) -> Result<(), String> {
    validate_window_id(&id)?;
    let label = format!("media-viewer-{id}");
    if let Some(existing) = app.get_webview_window(&label) {
        existing.close().map_err(|error| error.to_string())?;
    }

    let url = WebviewUrl::App(format!("windows/media-viewer-window.html?id={id}").into());
    let windowed = windowed.unwrap_or(false);
    let (width, height) = if windowed {
        (640.0, 360.0)
    } else {
        (1280.0, 800.0)
    };
    let mut builder = WebviewWindowBuilder::new(&app, label, url)
        .data_directory(crate::distribution::webview_data_directory(&app)?)
        .title("Notgram 媒体")
        .inner_size(width, height)
        .resizable(true)
        .min_inner_size(320.0, 180.0)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .focused(true)
        .visible(false)
        // Enter fullscreen during construction, before page-load callbacks can
        // show the HWND with its initial non-client caption style.
        .fullscreen(!windowed)
        .zoom_hotkeys_enabled(false)
        .prevent_overflow();
    builder = if let Some((x, y)) =
        crate::window_placement::centered_on_main_monitor(&app, width, height)
    {
        builder.position(x, y)
    } else {
        builder.center()
    };
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    let window = builder
        .on_page_load(|window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let window = window.clone();
            let _ = window.clone().run_on_main_thread(move || {
                remove_native_frame(&window);
                let _ = window.show();
                let _ = window.set_focus();
            });
        })
        .build()
        .map_err(|error| error.to_string())?;
    let app = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let _ = app.emit_to("main", "notgram:media-viewer-closed", &id);
        }
    });
    Ok(())
}

fn remove_native_frame(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GWL_STYLE, GetWindowLongW, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
            SWP_NOZORDER, SetWindowLongW, SetWindowPos, WS_CAPTION, WS_THICKFRAME,
        };
        let Ok(hwnd) = window.hwnd() else { return };
        // Tao keeps WS_CAPTION on some undecorated HWNDs and relies on
        // non-client handling to hide it. Remove it before the first paint.
        unsafe {
            let style = GetWindowLongW(hwnd.0, GWL_STYLE) as u32;
            if style & (WS_CAPTION | WS_THICKFRAME) != 0 {
                SetWindowLongW(
                    hwnd.0,
                    GWL_STYLE,
                    (style & !(WS_CAPTION | WS_THICKFRAME)) as i32,
                );
                SetWindowPos(
                    hwnd.0,
                    std::ptr::null_mut(),
                    0,
                    0,
                    0,
                    0,
                    SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
                );
            }
        }
    }
    #[cfg(not(windows))]
    let _ = window;
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
