use serde_json::{Value, json};
use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

#[derive(Clone)]
pub(super) struct RuntimeLogger {
    pub(super) path: Arc<PathBuf>,
    pub(super) performance_path: Arc<PathBuf>,
    lock: Arc<Mutex<()>>,
}

impl RuntimeLogger {
    const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;

    pub(super) fn new(_app: &AppHandle) -> Result<Self, String> {
        let directory = program_directory()?.join("logs");
        fs::create_dir_all(&directory)
            .map_err(|error| format!("无法创建日志目录 {}: {error}", directory.display()))?;
        let logger = Self {
            path: Arc::new(directory.join("notgram.log")),
            performance_path: Arc::new(directory.join("notgram-performance.log")),
            lock: Arc::new(Mutex::new(())),
        };
        logger.write(
            "info",
            "logger_ready",
            json!({ "version": env!("CARGO_PKG_VERSION") }),
        );
        Ok(logger)
    }

    pub(super) fn write(&self, level: &str, event: &str, details: Value) {
        self.write_records(
            self.path.as_ref(),
            "notgram.log.1",
            vec![(level.to_string(), event.to_string(), details)],
        );
    }

    pub(super) fn write_performance_batch(&self, records: Vec<(String, String, Value)>) {
        self.write_records(
            self.performance_path.as_ref(),
            "notgram-performance.log.1",
            records,
        );
    }

    fn write_records(&self, path: &Path, backup_name: &str, records: Vec<(String, String, Value)>) {
        if records.is_empty() {
            return;
        }
        let _guard = self.lock.lock().expect("runtime logger mutex poisoned");
        if fs::metadata(path).is_ok_and(|metadata| metadata.len() >= Self::MAX_FILE_SIZE) {
            let backup = path.with_file_name(backup_name);
            if backup.is_file() {
                let _ = fs::remove_file(&backup);
            }
            let _ = fs::rename(path, backup);
        }

        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            for (level, event, details) in records {
                let timestamp_ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis();
                let record = json!({
                    "timestampMs": timestamp_ms,
                    "level": level,
                    "event": event,
                    "details": sanitize_log_value(details),
                });
                let _ = serde_json::to_writer(&mut file, &record);
                let _ = writeln!(file);
            }
        }
    }
}

fn program_directory() -> Result<PathBuf, String> {
    env::current_exe()
        .map_err(|error| format!("无法解析程序路径: {error}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "程序路径没有父目录".to_string())
}

fn sanitize_log_value(value: Value) -> Value {
    const SENSITIVE_KEYS: &[&str] = &[
        "api_id",
        "apiId",
        "api_hash",
        "apiHash",
        "cache_path",
        "cachePath",
        "database_encryption_key",
        "databaseEncryptionKey",
        "download_path",
        "downloadPath",
        "email",
        "email_address",
        "emailAddress",
        "library_path",
        "libraryPath",
        "files_directory",
        "filesDirectory",
        "link",
        "message",
        "password",
        "path",
        "phone_number",
        "phoneNumber",
        "secret",
        "text",
        "token",
        "username",
        "userName",
    ];

    match value {
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| {
                    let value = if SENSITIVE_KEYS
                        .iter()
                        .any(|sensitive| key.eq_ignore_ascii_case(sensitive))
                    {
                        Value::String("[REDACTED]".to_string())
                    } else {
                        sanitize_log_value(value)
                    };
                    (key, value)
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(sanitize_log_value).collect()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_log_fields_are_redacted_recursively() {
        let value = sanitize_log_value(json!({
            "phone_number": "+8613800000000",
            "nested": {
                "password": "secret",
                "count": 2,
            },
            "items": [{ "text": "private message" }],
        }));

        assert_eq!(value["phone_number"], "[REDACTED]");
        assert_eq!(value["nested"]["password"], "[REDACTED]");
        assert_eq!(value["nested"]["count"], 2);
        assert_eq!(value["items"][0]["text"], "[REDACTED]");
    }

    #[test]
    fn runtime_and_performance_records_use_separate_files() {
        let directory = std::env::temp_dir().join(format!(
            "notgram-log-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
        ));
        fs::create_dir_all(&directory).expect("test directory should be created");
        let logger = RuntimeLogger {
            path: Arc::new(directory.join("notgram.log")),
            performance_path: Arc::new(directory.join("notgram-performance.log")),
            lock: Arc::new(Mutex::new(())),
        };

        logger.write("info", "runtime_started", json!({}));
        logger.write_performance_batch(vec![
            (
                "warn".to_string(),
                "ui_long_frame".to_string(),
                json!({ "durationMs": 80 }),
            ),
            (
                "error".to_string(),
                "ui_slow_interaction".to_string(),
                json!({ "durationMs": 120 }),
            ),
        ]);

        let runtime = fs::read_to_string(logger.path.as_ref()).expect("runtime log should exist");
        let performance = fs::read_to_string(logger.performance_path.as_ref())
            .expect("performance log should exist");
        assert!(runtime.contains("runtime_started"));
        assert!(!runtime.contains("ui_long_frame"));
        assert!(performance.contains("ui_long_frame"));
        assert!(performance.contains("ui_slow_interaction"));
        assert_eq!(performance.lines().count(), 2);
        assert!(!performance.contains("runtime_started"));
        fs::remove_dir_all(directory).expect("test directory should be removed");
    }
}
