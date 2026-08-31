use tauri::{App, AppHandle, Manager};

const MAIN_WINDOW_LABEL: &str = "main";

pub fn setup(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(windows)]
    {
        let window = app
            .get_webview_window(MAIN_WINDOW_LABEL)
            .ok_or("main webview window is unavailable")?;
        window.with_webview(|webview| {
            if let Err(error) = configure_windows_webview(webview, false) {
                eprintln!("failed to apply WebView2 security settings: {error}");
            }
        })?;
    }
    Ok(())
}

#[tauri::command]
pub fn notgram_set_developer_mode(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::sync::{Arc, Mutex};

        let window = app
            .get_webview_window(MAIN_WINDOW_LABEL)
            .ok_or_else(|| "main webview window is unavailable".to_string())?;
        let configuration_error = Arc::new(Mutex::new(None::<String>));
        let error_slot = Arc::clone(&configuration_error);
        window
            .with_webview(move |webview| {
                if let Err(error) = configure_windows_webview(webview, enabled)
                    && let Ok(mut slot) = error_slot.lock()
                {
                    *slot = Some(error.to_string());
                }
            })
            .map_err(|error| error.to_string())?;
        if let Some(error) = configuration_error
            .lock()
            .map_err(|_| "failed to read WebView2 configuration result".to_string())?
            .clone()
        {
            return Err(error);
        }
    }

    #[cfg(not(windows))]
    let _ = (app, enabled);

    Ok(())
}

#[cfg(windows)]
fn configure_windows_webview(
    webview: tauri::webview::PlatformWebview,
    developer_mode: bool,
) -> windows_core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    unsafe {
        let core_webview = webview.controller().CoreWebView2()?;
        let settings = core_webview.Settings()?;
        settings.SetAreDefaultContextMenusEnabled(developer_mode)?;
        settings.SetAreDevToolsEnabled(false)?;

        if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
            settings3.SetAreBrowserAcceleratorKeysEnabled(false)?;
        }
    }

    Ok(())
}
