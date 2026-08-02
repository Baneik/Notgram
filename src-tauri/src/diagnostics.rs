use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    error::Error,
    fs,
    io::{self, Read, Seek, SeekFrom, Write},
    panic,
    path::{Path, PathBuf},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use crate::distribution::{DistributionKind, current_kind};

const MAX_EXPORTED_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_EXPORTED_LOG_RECORDS: usize = 20_000;

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsManifest {
    schema_version: u32,
    application: &'static str,
    version: &'static str,
    generated_at_ms: u128,
    operating_system: &'static str,
    architecture: &'static str,
    distribution: DistributionKind,
    crash_reporting_enabled: bool,
    crash_report_included: bool,
    runtime_log_records: usize,
    message_content_included: bool,
    credentials_included: bool,
    local_paths_included: bool,
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

fn safe_detail_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 48
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn sensitive_detail_key(key: &str) -> bool {
    let normalized = key
        .bytes()
        .filter(|byte| byte.is_ascii_alphanumeric())
        .map(|byte| byte.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let normalized = String::from_utf8_lossy(&normalized);
    normalized.len() > 2 && normalized.ends_with("id")
        || [
            "apihash",
            "cachepath",
            "correlation",
            "databaseencryptionkey",
            "downloadpath",
            "email",
            "filesdirectory",
            "librarypath",
            "link",
            "message",
            "password",
            "path",
            "phonenumber",
            "secret",
            "text",
            "token",
            "username",
        ]
        .iter()
        .any(|sensitive| normalized.contains(sensitive))
}

fn sanitize_diagnostic_details(value: Value, depth: usize) -> Value {
    if depth >= 4 {
        return Value::Null;
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value,
        Value::String(_) => Value::String("[REDACTED]".to_string()),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .take(32)
                .map(|value| sanitize_diagnostic_details(value, depth + 1))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .filter(|(key, _)| safe_detail_key(key))
                .take(32)
                .map(|(key, value)| {
                    let value = if sensitive_detail_key(&key) {
                        Value::String("[REDACTED]".to_string())
                    } else {
                        sanitize_diagnostic_details(value, depth + 1)
                    };
                    (key, value)
                })
                .collect(),
        ),
    }
}

fn read_bounded_tail(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let length = file.metadata()?.len();
    if length > MAX_EXPORTED_LOG_BYTES {
        file.seek(SeekFrom::Start(length - MAX_EXPORTED_LOG_BYTES))?;
    }
    let mut bytes = Vec::with_capacity(length.min(MAX_EXPORTED_LOG_BYTES) as usize);
    file.take(MAX_EXPORTED_LOG_BYTES).read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn sanitize_runtime_logs(log_directory: &Path) -> (Vec<u8>, usize) {
    let mut records = Vec::new();
    for file_name in ["notgram.log.1", "notgram.log"] {
        let path = log_directory.join(file_name);
        let Ok(content) = read_bounded_tail(&path) else {
            continue;
        };
        for line in content.lines() {
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let Some(object) = value.as_object() else {
                continue;
            };
            let event = object
                .get("event")
                .and_then(Value::as_str)
                .filter(|event| {
                    !event.is_empty()
                        && event.len() <= 64
                        && event.bytes().all(|byte| {
                            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
                        })
                })
                .unwrap_or("invalid_event");
            let level = object
                .get("level")
                .and_then(Value::as_str)
                .filter(|level| matches!(*level, "debug" | "info" | "warn" | "error"))
                .unwrap_or("unknown");
            records.push(json!({
                "timestampMs": object.get("timestampMs").and_then(Value::as_u64).unwrap_or(0),
                "level": level,
                "event": event,
                "details": sanitize_diagnostic_details(
                    object.get("details").cloned().unwrap_or_else(|| json!({})),
                    0,
                ),
            }));
            if records.len() >= MAX_EXPORTED_LOG_RECORDS {
                break;
            }
        }
        if records.len() >= MAX_EXPORTED_LOG_RECORDS {
            break;
        }
    }
    let mut payload = Vec::new();
    for record in &records {
        if serde_json::to_writer(&mut payload, record).is_ok() {
            payload.push(b'\n');
        }
    }
    (payload, records.len())
}

fn sanitized_crash_report(path: &Path) -> Option<Vec<u8>> {
    let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let timestamp_ms = value.get("timestampMs")?.as_u64()?;
    serde_json::to_vec_pretty(&json!({
        "schemaVersion": 1,
        "event": "application_panic",
        "version": env!("CARGO_PKG_VERSION"),
        "timestampMs": timestamp_ms,
    }))
    .ok()
}

fn add_zip_file(
    archive: &mut ZipWriter<fs::File>,
    name: &str,
    bytes: &[u8],
) -> zip::result::ZipResult<()> {
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o600);
    archive.start_file(name, options)?;
    archive.write_all(bytes)?;
    Ok(())
}

fn export_diagnostics_bundle(
    destination: &Path,
    log_directory: &Path,
    state: &DiagnosticsState,
) -> io::Result<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| io::Error::other("diagnostics destination has no parent"))?;
    let temporary = parent.join(format!(
        ".notgram-diagnostics-{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    ));
    let result = (|| -> io::Result<()> {
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let mut archive = ZipWriter::new(file);
        let (runtime_logs, runtime_log_records) = sanitize_runtime_logs(log_directory);
        let crash_reporting_enabled = state.enabled.load(Ordering::Relaxed);
        let crash_report = crash_reporting_enabled
            .then(|| sanitized_crash_report(&state.crash_report_path))
            .flatten();
        let manifest = DiagnosticsManifest {
            schema_version: 1,
            application: "Notgram",
            version: env!("CARGO_PKG_VERSION"),
            generated_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            operating_system: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            distribution: current_kind(),
            crash_reporting_enabled,
            crash_report_included: crash_report.is_some(),
            runtime_log_records,
            message_content_included: false,
            credentials_included: false,
            local_paths_included: false,
        };
        let manifest = serde_json::to_vec_pretty(&manifest)?;
        add_zip_file(&mut archive, "manifest.json", &manifest)?;
        add_zip_file(&mut archive, "logs/runtime.jsonl", &runtime_logs)?;
        if let Some(crash_report) = crash_report {
            add_zip_file(&mut archive, "crash/latest.json", &crash_report)?;
        }
        archive.finish()?.sync_all()?;
        if destination.exists() {
            fs::remove_file(destination)?;
        }
        fs::rename(&temporary, destination)
    })();
    if result.is_err() && temporary.is_file() {
        let _ = fs::remove_file(temporary);
    }
    result
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

#[tauri::command]
pub fn notgram_export_diagnostics(
    app: AppHandle,
    state: State<'_, DiagnosticsState>,
) -> Result<bool, String> {
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("导出 Notgram 诊断包")
        .add_filter("ZIP 压缩包", &["zip"])
        .set_file_name(format!(
            "Notgram-diagnostics-{}.zip",
            env!("CARGO_PKG_VERSION")
        ))
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let mut destination = selected
        .into_path()
        .map_err(|_| "Unable to resolve the diagnostics destination".to_string())?;
    if !destination.is_absolute() || destination.is_dir() {
        return Err("Diagnostics destination must be an absolute file path".to_string());
    }
    if destination
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("zip"))
    {
        destination.set_extension("zip");
    }
    let program_directory = std::env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(Path::to_path_buf))
        .ok_or_else(|| "Unable to resolve the diagnostics log directory".to_string())?;
    export_diagnostics_bundle(&destination, &program_directory.join("logs"), &state)
        .map_err(|_| "Unable to export the diagnostics bundle".to_string())?;
    Ok(true)
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

    #[test]
    fn exported_logs_redact_all_strings_and_ignore_malformed_records() {
        let directory = test_directory();
        fs::create_dir_all(&directory).expect("test directory should be created");
        fs::write(
            directory.join("notgram.log"),
            concat!(
                "not-json\n",
                "{\"timestampMs\":12,\"level\":\"debug\",\"event\":\"runtime_started\",",
                "\"details\":{\"durationMs\":8,\"path\":\"C:\\\\Users\\\\private\",",
                "\"chatId\":7931534087,\"phoneNumber\":13800000000,",
                "\"nested\":{\"token\":\"secret\",\"ok\":true}}}\n",
            ),
        )
        .expect("runtime log should be written");

        let (payload, count) = sanitize_runtime_logs(&directory);
        let payload = String::from_utf8(payload).expect("sanitized logs should be UTF-8");
        assert_eq!(count, 1);
        assert!(payload.contains("runtime_started"));
        assert!(payload.contains("[REDACTED]"));
        assert!(!payload.contains("private"));
        assert!(!payload.contains("secret"));
        assert!(!payload.contains("7931534087"));
        assert!(!payload.contains("13800000000"));
        fs::remove_dir_all(directory).expect("test directory should be removed");
    }

    #[test]
    fn diagnostics_zip_contains_only_sanitized_entries() {
        let directory = test_directory();
        let log_directory = directory.join("logs");
        fs::create_dir_all(&log_directory).expect("log directory should be created");
        fs::write(
            log_directory.join("notgram.log"),
            "{\"timestampMs\":12,\"level\":\"error\",\"event\":\"test_event\",\"details\":{\"token\":\"private-token\",\"messageId\":991,\"count\":2}}\n",
        )
        .expect("runtime log should be written");
        let settings_path = directory.join("settings.json");
        let crash_report_path = directory.join("crash-report.json");
        write_crash_report(&crash_report_path).expect("crash report should be written");
        let state = DiagnosticsState {
            enabled: Arc::new(AtomicBool::new(true)),
            settings_path: Arc::new(settings_path),
            crash_report_path: Arc::new(crash_report_path),
        };
        let destination = directory.join("diagnostics.zip");
        export_diagnostics_bundle(&destination, &log_directory, &state)
            .expect("diagnostics bundle should be exported");

        let file = fs::File::open(&destination).expect("diagnostics bundle should open");
        let mut archive = zip::ZipArchive::new(file).expect("diagnostics bundle should be a ZIP");
        assert_eq!(archive.len(), 3);
        let mut manifest = String::new();
        archive
            .by_name("manifest.json")
            .expect("manifest should exist")
            .read_to_string(&mut manifest)
            .expect("manifest should be readable");
        assert!(manifest.contains("\"messageContentIncluded\": false"));
        assert!(manifest.contains("\"crashReportIncluded\": true"));
        let mut log_payload = String::new();
        archive
            .by_name("logs/runtime.jsonl")
            .expect("sanitized logs should exist")
            .read_to_string(&mut log_payload)
            .expect("sanitized logs should be readable");
        assert!(log_payload.contains("[REDACTED]"));
        assert!(!log_payload.contains("private-token"));
        assert!(!log_payload.contains("991"));
        drop(archive);

        state.enabled.store(false, Ordering::Relaxed);
        let opted_out_destination = directory.join("diagnostics-opted-out.zip");
        export_diagnostics_bundle(&opted_out_destination, &log_directory, &state)
            .expect("opted-out diagnostics bundle should be exported");
        let file = fs::File::open(&opted_out_destination)
            .expect("opted-out diagnostics bundle should open");
        let mut archive =
            zip::ZipArchive::new(file).expect("opted-out diagnostics bundle should be a ZIP");
        assert_eq!(archive.len(), 2);
        let mut manifest = String::new();
        archive
            .by_name("manifest.json")
            .expect("opted-out manifest should exist")
            .read_to_string(&mut manifest)
            .expect("opted-out manifest should be readable");
        assert!(manifest.contains("\"crashReportIncluded\": false"));
        drop(archive);

        fs::remove_dir_all(directory).expect("test directory should be removed");
    }
}
