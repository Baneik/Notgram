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
        let _guard = self.lock.lock().expect("runtime logger mutex poisoned");
        if fs::metadata(self.path.as_ref())
            .is_ok_and(|metadata| metadata.len() >= Self::MAX_FILE_SIZE)
        {
            let backup = self.path.with_file_name("notgram.log.1");
            if backup.is_file() {
                let _ = fs::remove_file(&backup);
            }
            let _ = fs::rename(self.path.as_ref(), backup);
        }

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
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.path.as_ref())
        {
            let _ = serde_json::to_writer(&mut file, &record);
            let _ = writeln!(file);
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
}
