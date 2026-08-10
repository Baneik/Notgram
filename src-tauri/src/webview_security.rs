use crate::automation;
use tauri::{App, Manager};

const MAIN_WINDOW_LABEL: &str = "main";

pub fn setup(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(windows)]
    {
        let window = app
            .get_webview_window(MAIN_WINDOW_LABEL)
            .ok_or("main webview window is unavailable")?;
        window.with_webview(|webview| {
            if let Err(error) = configure_windows_webview(webview) {
                eprintln!("failed to apply WebView2 security settings: {error}");
            }
        })?;
    }
    Ok(())
}

#[cfg(windows)]
fn configure_windows_webview(webview: tauri::webview::PlatformWebview) -> windows_core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    unsafe {
        let core_webview = webview.controller().CoreWebView2()?;
        let settings = core_webview.Settings()?;
        settings.SetAreDefaultContextMenusEnabled(false)?;
        settings.SetAreDevToolsEnabled(automation::enabled())?;

        if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
            settings3.SetAreBrowserAcceleratorKeysEnabled(false)?;
        }
    }

    Ok(())
}
