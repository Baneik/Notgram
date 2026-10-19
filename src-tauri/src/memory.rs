use tauri::WebviewWindow;

pub fn sync_memory_target(window: &WebviewWindow) {
    #[cfg(windows)]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL, ICoreWebView2_19,
        };
        use windows_core::Interface;

        let owner = window.clone();
        let _ = window.with_webview(move |webview| {
            let (Ok(visible), Ok(minimized)) = (owner.is_visible(), owner.is_minimized()) else {
                return;
            };
            // LOW is best effort and keeps JavaScript/message notifications alive.
            // Older runtimes can lack this interface; leave their defaults intact.
            unsafe {
                if let Ok(core) = webview.controller().CoreWebView2()
                    && let Ok(core) = core.cast::<ICoreWebView2_19>()
                {
                    let level = if visible && !minimized {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                    } else {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                    };
                    let _ = core.SetMemoryUsageTargetLevel(level);
                }
            }
        });
    }
    #[cfg(not(windows))]
    let _ = window;
}

#[tauri::command]
pub fn notgram_sync_memory_target(window: WebviewWindow) {
    sync_memory_target(&window);
}
