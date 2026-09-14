use serde::Serialize;
use std::{collections::VecDeque, sync::Mutex};
use tauri::{Emitter, Manager};

const LINK_EVENT: &str = "notgram:pending-telegram-links";
const MAX_LINKS: usize = 16;

#[derive(Default)]
pub struct PendingTelegramLinks(Mutex<VecDeque<String>>);

fn valid_link(value: &str) -> bool {
    if value.len() > 4096 || value.chars().any(|c| c.is_control() || c == '"') {
        return false;
    }
    tauri::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "tg"
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.host_str().is_some()
    })
}

impl PendingTelegramLinks {
    fn enqueue(&self, arguments: impl IntoIterator<Item = String>) {
        let Ok(mut pending) = self.0.lock() else {
            return;
        };
        for argument in arguments.into_iter().skip(1).filter(|arg| valid_link(arg)) {
            if pending.contains(&argument) {
                continue;
            }
            if pending.len() == MAX_LINKS {
                pending.pop_front();
            }
            pending.push_back(argument);
        }
    }

    fn take(&self) -> Vec<String> {
        self.0
            .lock()
            .map(|mut pending| pending.drain(..).collect())
            .unwrap_or_default()
    }
}

pub fn receive_arguments(app: &tauri::AppHandle, arguments: Vec<String>) {
    if let Some(pending) = app.try_state::<PendingTelegramLinks>() {
        pending.enqueue(arguments);
        // Only a wake-up crosses the event bridge. Links remain queued until
        // the main window has an authenticated, operational Telegram session.
        let _ = app.emit_to("main", LINK_EVENT, ());
    }
}

pub fn startup_queue() -> PendingTelegramLinks {
    let queue = PendingTelegramLinks::default();
    queue.enqueue(std::env::args());
    queue
}

#[tauri::command]
pub fn notgram_take_telegram_links(
    window: tauri::WebviewWindow,
    pending: tauri::State<PendingTelegramLinks>,
) -> Result<Vec<String>, String> {
    if window.label() != "main" {
        return Err("Telegram links belong to the main window".into());
    }
    Ok(pending.take())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramProtocolSettings {
    supported: bool,
    registered: bool,
    is_default: bool,
}

fn require_settings_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if matches!(window.label(), "main" | "settings") {
        Ok(())
    } else {
        Err("Protocol settings are unavailable in this window".into())
    }
}

#[tauri::command]
pub fn notgram_telegram_protocol_settings(
    window: tauri::WebviewWindow,
) -> Result<TelegramProtocolSettings, String> {
    require_settings_window(&window)?;
    protocol_settings()
}

#[tauri::command]
pub fn notgram_register_telegram_protocol(
    window: tauri::WebviewWindow,
) -> Result<TelegramProtocolSettings, String> {
    require_settings_window(&window)?;
    register_protocol()?;
    protocol_settings()
}

#[tauri::command]
pub fn notgram_open_default_apps(window: tauri::WebviewWindow) -> Result<(), String> {
    require_settings_window(&window)?;
    // A fixed system destination; never accept an arbitrary shell command/URL.
    crate::external_links::open_external_url("ms-settings:defaultapps?registeredAppUser=Notgram")
}

#[cfg(windows)]
const PROG_ID: &str = "Notgram.Telegram";
#[cfg(windows)]
const CAPABILITIES: &str = r"Software\Notgram\Capabilities";

fn protocol_command(executable: &std::path::Path) -> String {
    format!("\"{}\" \"%1\"", executable.display())
}

#[cfg(windows)]
fn protocol_settings() -> Result<TelegramProtocolSettings, String> {
    use winreg::{
        RegKey,
        enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER},
    };
    let user = RegKey::predef(HKEY_CURRENT_USER);
    let classes = RegKey::predef(HKEY_CLASSES_ROOT);
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let command = protocol_command(&executable);
    let registered = user
        .open_subkey(format!(r"Software\Classes\{PROG_ID}\shell\open\command"))
        .and_then(|key| key.get_value::<String, _>(""))
        .is_ok_and(|value| value.eq_ignore_ascii_case(&command));
    // Windows UserChoice takes precedence over Classes\tg. Do not write or
    // delete its protected hash; the user chooses through Default Apps.
    let choice = user
        .open_subkey(r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\tg\UserChoice")
        .and_then(|key| key.get_value::<String, _>("ProgId"))
        .unwrap_or_else(|_| "tg".into());
    let is_default = classes
        .open_subkey(format!(r"{choice}\shell\open\command"))
        .and_then(|key| key.get_value::<String, _>(""))
        .is_ok_and(|value| value.eq_ignore_ascii_case(&command));
    Ok(TelegramProtocolSettings {
        supported: true,
        registered,
        is_default,
    })
}

#[cfg(windows)]
fn register_protocol() -> Result<(), String> {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};
    let user = RegKey::predef(HKEY_CURRENT_USER);
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let command = protocol_command(&executable);
    let register = || -> std::io::Result<()> {
        for name in [PROG_ID, "tg"] {
            let (key, _) = user.create_subkey(format!(r"Software\Classes\{name}"))?;
            key.set_value("", &"URL:Telegram Link")?;
            key.set_value("URL Protocol", &"")?;
            let (icon, _) = key.create_subkey("DefaultIcon")?;
            icon.set_value("", &format!("\"{}\",0", executable.display()))?;
            let (open, _) = key.create_subkey(r"shell\open\command")?;
            open.set_value("", &command)?;
        }
        let (capabilities, _) = user.create_subkey(CAPABILITIES)?;
        capabilities.set_value("ApplicationName", &"Notgram")?;
        capabilities.set_value("ApplicationDescription", &"Open Telegram links in Notgram")?;
        let (urls, _) = capabilities.create_subkey("URLAssociations")?;
        urls.set_value("tg", &PROG_ID)?;
        let (applications, _) = user.create_subkey(r"Software\RegisteredApplications")?;
        applications.set_value("Notgram", &CAPABILITIES)?;
        Ok(())
    };
    register().map_err(|error| error.to_string())?;
    unsafe {
        windows_sys::Win32::UI::Shell::SHChangeNotify(
            windows_sys::Win32::UI::Shell::SHCNE_ASSOCCHANGED as i32,
            windows_sys::Win32::UI::Shell::SHCNF_IDLIST,
            std::ptr::null(),
            std::ptr::null(),
        );
    }
    Ok(())
}

#[cfg(not(windows))]
fn protocol_settings() -> Result<TelegramProtocolSettings, String> {
    Ok(TelegramProtocolSettings {
        supported: false,
        registered: false,
        is_default: false,
    })
}

#[cfg(not(windows))]
fn register_protocol() -> Result<(), String> {
    Err("Protocol registration requires Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_telegram_arguments_without_accepting_commands_or_files() {
        assert!(valid_link("tg://resolve?domain=telegram&post=42"));
        assert!(valid_link("tg://join?invite=abc_DEF-1"));
        for value in [
            "--autostart",
            "https://t.me/telegram",
            "file:///private",
            "tg://user@resolve?domain=a",
            "tg://resolve?domain=a\n",
            "tg://resolve?domain=\" --flag",
            "tg:invalid",
        ] {
            assert!(!valid_link(value), "{value:?}");
        }
        assert!(!valid_link(&format!(
            "tg://resolve?domain={}",
            "a".repeat(4096)
        )));
    }

    #[test]
    fn retains_cold_and_warm_links_once_until_the_frontend_is_ready() {
        let queue = PendingTelegramLinks::default();
        queue.enqueue(
            ["Notgram.exe", "tg://resolve?domain=telegram", "--autostart"].map(String::from),
        );
        queue.enqueue(
            [
                "Notgram.exe",
                "tg://resolve?domain=telegram",
                "tg://join?invite=abc",
            ]
            .map(String::from),
        );
        assert_eq!(
            queue.take(),
            ["tg://resolve?domain=telegram", "tg://join?invite=abc"]
        );
        assert!(queue.take().is_empty());
    }

    #[test]
    fn bounds_the_queue_and_quotes_both_shell_arguments() {
        let queue = PendingTelegramLinks::default();
        queue.enqueue(
            std::iter::once("Notgram.exe".into())
                .chain((0..40).map(|i| format!("tg://resolve?domain=chat{i}"))),
        );
        let pending = queue.take();
        assert_eq!(pending.len(), MAX_LINKS);
        assert_eq!(pending.last().unwrap(), "tg://resolve?domain=chat39");
        assert_eq!(
            protocol_command(std::path::Path::new(r"C:\Notgram App\Notgram.exe")),
            r#""C:\Notgram App\Notgram.exe" "%1""#
        );
    }
}
