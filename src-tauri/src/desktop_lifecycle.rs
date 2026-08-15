use serde::Serialize;
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
const AUTOSTART_ARGUMENT: &str = "--autostart";

#[cfg(windows)]
const WINDOWS_RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const WINDOWS_RUN_VALUE: &str = "Notgram";

#[cfg(windows)]
const NOTIFY_ICON_SETTINGS_KEY: &str = r"Control Panel\NotifyIconSettings";
#[cfg(windows)]
const TRAY_PROMOTION_RETRIES: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayMenuAction {
    Open,
    Quit,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    launch_on_startup: bool,
    supported: bool,
}

fn launched_from_startup() -> bool {
    arguments_include_startup(std::env::args_os())
}

pub(crate) fn arguments_include_startup<I, S>(arguments: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    arguments
        .into_iter()
        .any(|argument| argument.as_ref() == AUTOSTART_ARGUMENT)
}

#[cfg(windows)]
fn startup_command(executable: &std::path::Path) -> String {
    format!("\"{}\" {AUTOSTART_ARGUMENT}", executable.display())
}

#[cfg(windows)]
fn launch_on_startup_enabled() -> Result<bool, String> {
    let key =
        match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(WINDOWS_RUN_KEY, KEY_READ) {
            Ok(key) => key,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(format!("无法读取 Windows 启动设置：{error}")),
        };
    let registered = match key.get_value::<String, _>(WINDOWS_RUN_VALUE) {
        Ok(value) => value,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("无法读取 Notgram 启动设置：{error}")),
    };
    let executable =
        std::env::current_exe().map_err(|error| format!("无法确定 Notgram 程序路径：{error}"))?;
    Ok(registered.eq_ignore_ascii_case(&startup_command(&executable)))
}

#[cfg(windows)]
fn set_launch_on_startup(enabled: bool) -> Result<(), String> {
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(WINDOWS_RUN_KEY)
        .map_err(|error| format!("无法打开 Windows 启动设置：{error}"))?;
    if enabled {
        let executable = std::env::current_exe()
            .map_err(|error| format!("无法确定 Notgram 程序路径：{error}"))?;
        key.set_value(WINDOWS_RUN_VALUE, &startup_command(&executable))
            .map_err(|error| format!("无法启用开机启动：{error}"))
    } else {
        match key.delete_value(WINDOWS_RUN_VALUE) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("无法关闭开机启动：{error}")),
        }
    }
}

#[cfg(not(windows))]
fn launch_on_startup_enabled() -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(windows))]
fn set_launch_on_startup(_enabled: bool) -> Result<(), String> {
    Err("当前平台暂不支持开机启动".to_string())
}

#[tauri::command]
pub fn notgram_desktop_settings() -> Result<DesktopSettings, String> {
    Ok(DesktopSettings {
        launch_on_startup: launch_on_startup_enabled()?,
        supported: cfg!(windows),
    })
}

#[tauri::command]
pub fn notgram_set_launch_on_startup(enabled: bool) -> Result<DesktopSettings, String> {
    set_launch_on_startup(enabled)?;
    notgram_desktop_settings()
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
            Some(TrayMenuAction::Quit) => {
                crate::window_placement::flush_main_window(app);
                app.exit(0);
            }
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
    if !launched_from_startup() {
        show_main_window(app.handle());
    }
    Ok(())
}

pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }
    crate::window_placement::handle_window_event(window, event);
    if let WindowEvent::CloseRequested { api, .. } = event {
        crate::window_placement::flush_window(window);
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

    #[test]
    fn recognizes_only_the_dedicated_startup_argument() {
        assert!(arguments_include_startup(["Notgram.exe", "--autostart"]));
        assert!(!arguments_include_startup([
            "Notgram.exe",
            "--open-settings"
        ]));
    }

    #[cfg(windows)]
    #[test]
    fn quotes_the_startup_executable_and_marks_the_launch_source() {
        assert_eq!(
            startup_command(std::path::Path::new(
                r"C:\Program Files\Notgram\Notgram.exe"
            )),
            r#""C:\Program Files\Notgram\Notgram.exe" --autostart"#
        );
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
