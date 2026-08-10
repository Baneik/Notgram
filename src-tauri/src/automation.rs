use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};
use tauri::{AppHandle, Manager};

const AUTOMATION_PORT_ARGUMENT: &str = "--notgram-automation-port=";
const AUTOMATION_PORT_ENVIRONMENT: &str = "NOTGRAM_AUTOMATION_PORT";
const WEBVIEW2_ARGUMENTS_ENVIRONMENT: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
const AUTOMATION_SETTINGS_FILE: &str = "automation-settings.json";
const MINIMUM_AUTOMATION_PORT: u16 = 1024;
const DEFAULT_AUTOMATION_PORT: u16 = 9333;

static AUTOMATION_PORT: OnceLock<Option<u16>> = OnceLock::new();
static LAUNCH_OVERRIDE: OnceLock<bool> = OnceLock::new();

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationPreferences {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_automation_port")]
    pub port: u16,
}

impl Default for AutomationPreferences {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_AUTOMATION_PORT,
        }
    }
}

impl AutomationPreferences {
    fn validate(self) -> Result<Self, String> {
        if self.port < MINIMUM_AUTOMATION_PORT {
            return Err(
                "Notgram automation port must be an integer from 1024 to 65535".to_string(),
            );
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationSettings {
    enabled: bool,
    port: u16,
    active: bool,
    active_port: Option<u16>,
    restart_required: bool,
    launch_override: bool,
}

const fn default_automation_port() -> u16 {
    DEFAULT_AUTOMATION_PORT
}

fn parse_port(value: &str) -> Result<u16, String> {
    let port = value
        .trim()
        .parse::<u16>()
        .map_err(|_| "Notgram automation port must be an integer from 1024 to 65535".to_string())?;
    AutomationPreferences {
        enabled: true,
        port,
    }
    .validate()
    .map(|preferences| preferences.port)
}

fn requested_port_from<I, S>(arguments: I, environment: Option<&str>) -> Result<Option<u16>, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    if let Some(value) = arguments.into_iter().find_map(|argument| {
        argument
            .as_ref()
            .strip_prefix(AUTOMATION_PORT_ARGUMENT)
            .map(str::to_owned)
    }) {
        return parse_port(&value).map(Some);
    }

    environment
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(parse_port)
        .transpose()
}

fn requested_port() -> Result<Option<u16>, String> {
    requested_port_from(
        env::args(),
        env::var(AUTOMATION_PORT_ENVIRONMENT).ok().as_deref(),
    )
}

fn webview2_arguments(existing: Option<&str>, port: u16) -> Result<String, String> {
    let existing = existing.map(str::trim).filter(|value| !value.is_empty());
    if existing.is_some_and(|value| {
        value.contains("--remote-debugging-port") || value.contains("--remote-debugging-address")
    }) {
        return Err(format!(
            "{WEBVIEW2_ARGUMENTS_ENVIRONMENT} already configures remote debugging; remove that setting and use {AUTOMATION_PORT_ENVIRONMENT} instead"
        ));
    }

    let automation =
        format!("--remote-debugging-address=127.0.0.1 --remote-debugging-port={port} --mute-audio");
    Ok(match existing {
        Some(value) => format!("{value} {automation}"),
        None => automation,
    })
}

fn settings_path_from_root(root: &Path) -> PathBuf {
    root.join(AUTOMATION_SETTINGS_FILE)
}

fn startup_settings_path(identifier: &str) -> Result<PathBuf, String> {
    if identifier.is_empty() || identifier.contains(['/', '\\']) {
        return Err("Notgram application identifier is invalid".to_string());
    }

    #[cfg(target_os = "windows")]
    let root = env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(not(target_os = "windows"))]
    let root = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));

    root.map(|root| settings_path_from_root(&root.join(identifier)))
        .ok_or_else(|| "Notgram application configuration directory is unavailable".to_string())
}

fn load_preferences(path: &Path) -> Result<AutomationPreferences, String> {
    if !path.is_file() {
        return Ok(AutomationPreferences::default());
    }
    let serialized = fs::read(path)
        .map_err(|error| format!("Unable to read Notgram automation settings: {error}"))?;
    serde_json::from_slice::<AutomationPreferences>(&serialized)
        .map_err(|error| format!("Unable to parse Notgram automation settings: {error}"))?
        .validate()
}

fn save_preferences(path: &Path, preferences: AutomationPreferences) -> Result<(), String> {
    let preferences = preferences.validate()?;
    let directory = path
        .parent()
        .ok_or_else(|| "Notgram automation settings directory is unavailable".to_string())?;
    fs::create_dir_all(directory).map_err(|error| {
        format!("Unable to create Notgram automation settings directory: {error}")
    })?;
    let serialized = serde_json::to_vec_pretty(&preferences)
        .map_err(|error| format!("Unable to serialize Notgram automation settings: {error}"))?;
    fs::write(path, serialized)
        .map_err(|error| format!("Unable to save Notgram automation settings: {error}"))
}

fn current_settings(preferences: AutomationPreferences) -> AutomationSettings {
    let active_port = AUTOMATION_PORT.get().copied().flatten();
    let active = active_port.is_some();
    AutomationSettings {
        enabled: preferences.enabled,
        port: preferences.port,
        active,
        active_port,
        restart_required: preferences.enabled != active
            || (preferences.enabled && active_port != Some(preferences.port)),
        launch_override: LAUNCH_OVERRIDE.get().copied().unwrap_or(false),
    }
}

pub fn configure(identifier: &str) -> Result<(), String> {
    let explicit_port = requested_port()?;
    let launch_override = explicit_port.is_some();
    let port = match explicit_port {
        Some(port) => Some(port),
        None => match load_preferences(&startup_settings_path(identifier)?) {
            Ok(preferences) if preferences.enabled => Some(preferences.port),
            Ok(_) => None,
            Err(error) => {
                eprintln!("Ignoring invalid Notgram automation settings: {error}");
                None
            }
        },
    };

    AUTOMATION_PORT
        .set(port)
        .map_err(|_| "Notgram automation was configured more than once".to_string())?;
    LAUNCH_OVERRIDE.set(launch_override).map_err(|_| {
        "Notgram automation launch source was configured more than once".to_string()
    })?;
    let Some(port) = port else {
        return Ok(());
    };

    let arguments = webview2_arguments(
        env::var(WEBVIEW2_ARGUMENTS_ENVIRONMENT).ok().as_deref(),
        port,
    )?;

    // This runs before Tauri creates the WebView2 environment or starts worker threads.
    // Rust 2024 marks process-environment mutation unsafe because doing it later could race.
    unsafe {
        env::set_var(WEBVIEW2_ARGUMENTS_ENVIRONMENT, arguments);
    }
    eprintln!("Notgram automation endpoint enabled at http://127.0.0.1:{port}");
    Ok(())
}

pub fn enabled() -> bool {
    AUTOMATION_PORT.get().copied().flatten().is_some()
}

#[tauri::command]
pub fn notgram_automation_settings(app: AppHandle) -> Result<AutomationSettings, String> {
    let path =
        settings_path_from_root(&app.path().app_config_dir().map_err(|error| {
            format!("Unable to resolve Notgram configuration directory: {error}")
        })?);
    load_preferences(&path).map(current_settings)
}

#[tauri::command]
pub fn notgram_save_automation_settings(
    app: AppHandle,
    preferences: AutomationPreferences,
) -> Result<AutomationSettings, String> {
    let path =
        settings_path_from_root(&app.path().app_config_dir().map_err(|error| {
            format!("Unable to resolve Notgram configuration directory: {error}")
        })?);
    save_preferences(&path, preferences)?;
    load_preferences(&path).map(current_settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        env::temp_dir().join(format!("notgram-automation-{suffix}"))
    }

    #[test]
    fn automation_is_disabled_without_an_explicit_port() {
        assert_eq!(
            requested_port_from(Vec::<String>::new(), None).unwrap(),
            None
        );
        assert_eq!(
            requested_port_from(Vec::<String>::new(), Some("  ")).unwrap(),
            None
        );
    }

    #[test]
    fn command_line_port_takes_priority_over_the_environment() {
        let arguments = ["Notgram.exe", "--notgram-automation-port=9333"];
        assert_eq!(
            requested_port_from(arguments, Some("9444")).unwrap(),
            Some(9333)
        );
    }

    #[test]
    fn automation_rejects_invalid_or_privileged_ports() {
        assert!(requested_port_from(Vec::<String>::new(), Some("not-a-port")).is_err());
        assert!(requested_port_from(Vec::<String>::new(), Some("1023")).is_err());
    }

    #[test]
    fn webview2_automation_is_loopback_only_and_muted() {
        let arguments = webview2_arguments(Some("--disable-features=Example"), 9333).unwrap();
        assert!(arguments.contains("--disable-features=Example"));
        assert!(arguments.contains("--remote-debugging-address=127.0.0.1"));
        assert!(arguments.contains("--remote-debugging-port=9333"));
        assert!(arguments.contains("--mute-audio"));
    }

    #[test]
    fn existing_remote_debugging_arguments_are_rejected() {
        assert!(webview2_arguments(Some("--remote-debugging-port=9222"), 9333).is_err());
        assert!(webview2_arguments(Some("--remote-debugging-address=0.0.0.0"), 9333).is_err());
    }

    #[test]
    fn saved_automation_preferences_default_off_and_round_trip() {
        let directory = test_directory();
        let path = settings_path_from_root(&directory);
        assert_eq!(
            load_preferences(&path).unwrap(),
            AutomationPreferences::default()
        );

        let preferences = AutomationPreferences {
            enabled: true,
            port: 9444,
        };
        save_preferences(&path, preferences).unwrap();
        assert_eq!(load_preferences(&path).unwrap(), preferences);

        fs::remove_dir_all(directory).expect("test directory should be removed");
    }
}
