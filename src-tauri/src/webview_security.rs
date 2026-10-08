use tauri::{App, AppHandle, Manager};

const MAIN_WINDOW_LABEL: &str = "main";

pub fn setup(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(windows)]
    {
        let window = app
            .get_webview_window(MAIN_WINDOW_LABEL)
            .ok_or("main webview window is unavailable")?;
        let clipboard_origin = if tauri::is_dev() {
            app.config().build.dev_url.clone()
        } else {
            None
        }
        .unwrap_or(tauri::Url::parse("http://tauri.localhost/")?);
        window.with_webview(move |webview| {
            if let Err(error) = configure_clipboard_access(&webview, &clipboard_origin) {
                eprintln!("failed to apply WebView2 clipboard settings: {error}");
            }
            if let Err(error) = configure_windows_webview(webview, false) {
                eprintln!("failed to apply WebView2 security settings: {error}");
            }
        })?;
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn allows_clipboard_uri(uri: &str, trusted_origin: &tauri::Url) -> bool {
    tauri::Url::parse(uri).is_ok_and(|url| {
        url.origin() == trusted_origin.origin()
            && url.username().is_empty()
            && url.password().is_none()
    })
}

#[cfg(windows)]
fn configure_clipboard_access(
    webview: &tauri::webview::PlatformWebview,
    trusted_origin: &tauri::Url,
) -> windows_core::Result<()> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
            COREWEBVIEW2_PERMISSION_STATE_DENY, ICoreWebView2PermissionRequestedEventArgs3,
        },
        PermissionRequestedEventHandler, take_pwstr,
    };
    use windows_core::Interface;

    let trusted_origin = trusted_origin.clone();
    unsafe {
        let core_webview = webview.controller().CoreWebView2()?;
        core_webview.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = Default::default();
                args.PermissionKind(&mut kind)?;
                if kind != COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ {
                    return Ok(());
                }
                let mut uri = windows_core::PWSTR::null();
                args.Uri(&mut uri)?;
                // Only the main application's exact origin receives clipboard reads.
                // Leave every other permission under WebView2's existing policy.
                let allowed = allows_clipboard_uri(&take_pwstr(uri), &trusted_origin);
                if let Ok(args3) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                    args3.SetSavesInProfile(false)?;
                }
                args.SetState(if allowed {
                    COREWEBVIEW2_PERMISSION_STATE_ALLOW
                } else {
                    COREWEBVIEW2_PERMISSION_STATE_DENY
                })
            })),
            &mut 0,
        )?;
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

#[cfg(test)]
mod tests {
    use super::allows_clipboard_uri;

    #[test]
    fn clipboard_reads_are_limited_to_the_exact_application_origin() {
        let production = tauri::Url::parse("http://tauri.localhost/").unwrap();
        assert!(allows_clipboard_uri("http://tauri.localhost/", &production));
        for uri in [
            "https://example.com/",
            "http://tauri.localhost.evil.test/",
            "http://tauri.localhost:1420/",
            "https://tauri.localhost/",
            "http://user@tauri.localhost/",
            "file:///index.html",
            "data:text/html,hello",
            "not a URL",
        ] {
            assert!(!allows_clipboard_uri(uri, &production), "{uri}");
        }
        let development = tauri::Url::parse("http://127.0.0.1:1420/").unwrap();
        assert!(allows_clipboard_uri(
            "http://127.0.0.1:1420/?test",
            &development
        ));
        assert!(!allows_clipboard_uri(
            "http://127.0.0.1:1422/",
            &development
        ));
        assert!(!allows_clipboard_uri(
            "http://tauri.localhost/",
            &development
        ));
    }

    #[test]
    fn the_main_window_delivers_html_drag_events() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = config["app"]["windows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|window| window["label"] == "main")
            .unwrap();
        assert_eq!(main["dragDropEnabled"], false);
    }
}
