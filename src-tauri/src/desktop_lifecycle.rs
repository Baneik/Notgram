use tauri::{App, AppHandle, Manager, Window, WindowEvent};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

#[cfg(windows)]
use std::{io::ErrorKind, thread, time::Duration};
#[cfg(windows)]
use winreg::{
    RegKey,
    enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE},
};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_OPEN_ID: &str = "notgram.tray.open";
const TRAY_QUIT_ID: &str = "notgram.tray.quit";

#[cfg(windows)]
const NOTIFY_ICON_SETTINGS_KEY: &str = r"Control Panel\NotifyIconSettings";
#[cfg(windows)]
const TRAY_PROMOTION_RETRIES: usize = 12;

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

#[cfg(windows)]
fn should_promote_tray_icon(
    current_executable: &str,
    registered_executable: &str,
    existing_preference: Option<u32>,
) -> bool {
    existing_preference.is_none() && current_executable.eq_ignore_ascii_case(registered_executable)
}

#[cfg(windows)]
fn promote_current_tray_icon() -> std::io::Result<bool> {
    let executable = std::env::current_exe()?.to_string_lossy().into_owned();
    let settings = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(NOTIFY_ICON_SETTINGS_KEY, KEY_READ | KEY_WRITE)?;

    for key_name in settings.enum_keys().flatten() {
        let Ok(icon) = settings.open_subkey_with_flags(&key_name, KEY_READ | KEY_WRITE) else {
            continue;
        };
        let Ok(registered_executable) = icon.get_value::<String, _>("ExecutablePath") else {
            continue;
        };
        let existing_preference = match icon.get_value::<u32, _>("IsPromoted") {
            Ok(value) => Some(value),
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(_) => continue,
        };
        if should_promote_tray_icon(&executable, &registered_executable, existing_preference) {
            icon.set_value("IsPromoted", &1_u32)?;
            return Ok(true);
        }
        if executable.eq_ignore_ascii_case(&registered_executable) {
            return Ok(true);
        }
    }

    Ok(false)
}

#[cfg(windows)]
fn apply_default_tray_visibility() {
    thread::spawn(|| {
        for _ in 0..TRAY_PROMOTION_RETRIES {
            if promote_current_tray_icon().unwrap_or(false) {
                return;
            }
            thread::sleep(Duration::from_millis(250));
        }
    });
}

#[cfg(not(windows))]
fn apply_default_tray_visibility() {}

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
    apply_default_tray_visibility();
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

    #[cfg(windows)]
    #[test]
    fn promotes_only_the_current_unconfigured_tray_icon() {
        let executable = r"C:\Apps\Notgram\Notgram.exe";
        assert!(should_promote_tray_icon(
            executable,
            r"c:\apps\notgram\notgram.exe",
            None,
        ));
        assert!(!should_promote_tray_icon(
            executable,
            r"C:\Apps\Other\Notgram.exe",
            None,
        ));
        assert!(!should_promote_tray_icon(executable, executable, Some(0)));
        assert!(!should_promote_tray_icon(executable, executable, Some(1)));
    }
}
