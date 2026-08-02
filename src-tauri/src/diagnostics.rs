use serde::{Deserialize, Serialize};
use std::{
    error::Error,
    fs,
    io::{self, Write},
    panic,
    path::{Path, PathBuf},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSettings {
    #[serde(default)]
    pub crash_reporting_enabled: bool,
}

#[derive(Clone)]
pub struct DiagnosticsState {
    enabled: Arc<AtomicBool>,
    settings_path: Arc<PathBuf>,
    crash_report_path: Arc<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CrashReport {
    schema_version: u32,
    event: &'static str,
    version: &'static str,
    timestamp_ms: u128,
}

#[derive(Clone)]
struct CrashHookState {
    enabled: Arc<AtomicBool>,
    report_path: Arc<PathBuf>,
}

static CRASH_HOOK_STATE: OnceLock<CrashHookState> = OnceLock::new();

fn read_settings(path: &Path) -> DiagnosticsSettings {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_settings(path: &Path, settings: DiagnosticsSettings) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("diagnostics settings path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("tmp");
    let payload = serde_json::to_vec(&settings)?;
    let mut file = fs::File::create(&temporary)?;
    file.write_all(&payload)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temporary, path)
}

fn write_crash_report(path: &Path) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("crash report path has no parent"))?;
    fs::create_dir_all(parent)?;
    let report = CrashReport {
        schema_version: 1,
        event: "application_panic",
        version: env!("CARGO_PKG_VERSION"),
        timestamp_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    };
    let payload = serde_json::to_vec(&report)?;
    let mut file = fs::File::create(path)?;
    file.write_all(&payload)?;
    file.write_all(b"\n")?;
    file.sync_all()
}

fn install_crash_hook(state: CrashHookState) {
    if CRASH_HOOK_STATE.set(state).is_err() {
        return;
    }
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |information| {
        if let Some(state) = CRASH_HOOK_STATE.get()
            && state.enabled.load(Ordering::Relaxed)
        {
            let _ = write_crash_report(&state.report_path);
        }
        previous(information);
    }));
}

pub fn setup(app: &AppHandle) -> Result<DiagnosticsState, Box<dyn Error>> {
    let config_directory = app.path().app_config_dir()?.join("diagnostics");
    let data_directory = app.path().app_data_dir()?.join("diagnostics");
    let settings_path = config_directory.join("settings.json");
    let crash_report_path = data_directory.join("crash-report.json");
    let settings = read_settings(&settings_path);
    if !settings.crash_reporting_enabled && crash_report_path.is_file() {
        let _ = fs::remove_file(&crash_report_path);
    }
    let state = DiagnosticsState {
        enabled: Arc::new(AtomicBool::new(settings.crash_reporting_enabled)),
        settings_path: Arc::new(settings_path),
        crash_report_path: Arc::new(crash_report_path),
    };
    install_crash_hook(CrashHookState {
        enabled: state.enabled.clone(),
        report_path: state.crash_report_path.clone(),
    });
    Ok(state)
}

#[tauri::command]
pub fn notgram_diagnostics_settings(state: State<'_, DiagnosticsState>) -> DiagnosticsSettings {
    DiagnosticsSettings {
        crash_reporting_enabled: state.enabled.load(Ordering::Relaxed),
    }
}

#[tauri::command]
pub fn notgram_set_crash_reporting_enabled(
    state: State<'_, DiagnosticsState>,
    enabled: bool,
) -> Result<DiagnosticsSettings, String> {
    let settings = DiagnosticsSettings {
        crash_reporting_enabled: enabled,
    };
    write_settings(&state.settings_path, settings)
        .map_err(|_| "Unable to save diagnostics settings".to_string())?;
    state.enabled.store(enabled, Ordering::Relaxed);
    if !enabled && state.crash_report_path.is_file() {
        fs::remove_file(state.crash_report_path.as_ref())
            .map_err(|_| "Unable to remove the local crash report".to_string())?;
    }
    Ok(settings)
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
        std::env::temp_dir().join(format!("notgram-diagnostics-{suffix}"))
    }

    #[test]
    fn diagnostics_are_opt_in_and_corrupt_settings_fail_closed() {
        let directory = test_directory();
        fs::create_dir_all(&directory).expect("test directory should be created");
        let settings_path = directory.join("settings.json");
        assert_eq!(
            read_settings(&settings_path),
            DiagnosticsSettings::default()
        );

        fs::write(&settings_path, b"not-json").expect("corrupt settings should be written");
        assert_eq!(
            read_settings(&settings_path),
            DiagnosticsSettings::default()
        );

        let enabled = DiagnosticsSettings {
            crash_reporting_enabled: true,
        };
        write_settings(&settings_path, enabled).expect("settings should be saved");
        assert_eq!(read_settings(&settings_path), enabled);
        fs::remove_dir_all(directory).expect("test directory should be removed");
    }

    #[test]
    fn crash_report_contains_only_bounded_operational_metadata() {
        let directory = test_directory();
        let path = directory.join("crash-report.json");
        write_crash_report(&path).expect("crash report should be written");
        let payload = fs::read_to_string(&path).expect("crash report should be readable");
        let report: serde_json::Value =
            serde_json::from_str(&payload).expect("crash report should be valid JSON");

        assert_eq!(report["schemaVersion"], 1);
        assert_eq!(report["event"], "application_panic");
        assert_eq!(report["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(
            report
                .as_object()
                .expect("report should be an object")
                .len(),
            4
        );
        assert!(!payload.contains(directory.to_string_lossy().as_ref()));
        fs::remove_dir_all(directory).expect("test directory should be removed");
    }
}
