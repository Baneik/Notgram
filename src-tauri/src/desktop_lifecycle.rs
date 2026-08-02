use tauri::{App, AppHandle, Manager, Window, WindowEvent};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_OPEN_ID: &str = "notgram.tray.open";
const TRAY_QUIT_ID: &str = "notgram.tray.quit";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayMenuAction {
    Open,
    Quit,
}

fn tray_menu_action(id: &str) -> Option<TrayMenuAction> {
    match id {
        TRAY_OPEN_ID => Some(TrayMenuAction::Open),
        TRAY_QUIT_ID => Some(TrayMenuAction::Quit),
        _ => None,
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let menu = MenuBuilder::new(app)
        .text(TRAY_OPEN_ID, "打开 Notgram")
        .separator()
        .text(TRAY_QUIT_ID, "退出")
        .build()?;
    let mut tray = TrayIconBuilder::with_id("notgram-main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Notgram")
        .on_menu_event(|app, event| match tray_menu_action(event.id().as_ref()) {
            Some(TrayMenuAction::Open) => show_main_window(app),
            Some(TrayMenuAction::Quit) => app.exit(0),
            None => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_notgram_tray_commands() {
        assert_eq!(tray_menu_action(TRAY_OPEN_ID), Some(TrayMenuAction::Open));
        assert_eq!(tray_menu_action(TRAY_QUIT_ID), Some(TrayMenuAction::Quit));
        assert_eq!(tray_menu_action("unrelated"), None);
    }
}
