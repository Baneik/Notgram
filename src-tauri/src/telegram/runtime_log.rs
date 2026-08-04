use serde_json::{Value, json};
use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, SyncSender, TrySendError},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

type LogRecord = (String, String, Value);

enum LogCommand {
    Runtime(Vec<LogRecord>),
    Performance(Vec<LogRecord>),
    #[cfg(test)]
    Flush(mpsc::Sender<()>),
}

#[derive(Clone)]
pub(super) struct RuntimeLogger {
    pub(super) path: Arc<PathBuf>,
    pub(super) performance_path: Arc<PathBuf>,
    sender: SyncSender<LogCommand>,
    dropped_runtime_records: Arc<AtomicU64>,
    dropped_performance_records: Arc<AtomicU64>,
}

impl RuntimeLogger {
    const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;

    pub(super) fn new(_app: &AppHandle) -> Result<Self, String> {
        let directory = program_directory()?.join("logs");
        fs::create_dir_all(&directory)
            .map_err(|error| format!("无法创建日志目录 {}: {error}", directory.display()))?;
        let logger = Self::with_paths(
            directory.join("notgram.log"),
            directory.join("notgram-performance.log"),
        )?;
        logger.write(
            "info",
            "logger_ready",
            json!({ "version": env!("CARGO_PKG_VERSION") }),
        );
        Ok(logger)
    }

    pub(super) fn write(&self, level: &str, event: &str, details: Value) {
        self.enqueue(LogCommand::Runtime(vec![(
            level.to_string(),
            event.to_string(),
            details,
        )]));
    }

    pub(super) fn write_performance_batch(&self, records: Vec<LogRecord>) {
        if !records.is_empty() {
            self.enqueue(LogCommand::Performance(records));
        }
    }

    fn with_paths(path: PathBuf, performance_path: PathBuf) -> Result<Self, String> {
        let path = Arc::new(path);
        let performance_path = Arc::new(performance_path);
        let (sender, receiver) = mpsc::sync_channel(256);
        let writer_path = Arc::clone(&path);
        let writer_performance_path = Arc::clone(&performance_path);
        let dropped_runtime_records = Arc::new(AtomicU64::new(0));
        let dropped_performance_records = Arc::new(AtomicU64::new(0));
        let writer_dropped_runtime_records = Arc::clone(&dropped_runtime_records);
        let writer_dropped_performance_records = Arc::clone(&dropped_performance_records);
        thread::Builder::new()
            .name("notgram-log-writer".to_string())
            .spawn(move || {
                while let Ok(first) = receiver.recv() {
                    let mut runtime_records = Vec::new();
                    let mut performance_records = Vec::new();
                    let mut flushes = Vec::new();
                    if let Some(flush) =
                        collect_command(first, &mut runtime_records, &mut performance_records)
                    {
                        flushes.push(flush);
                    }
                    let deadline = Instant::now() + Duration::from_millis(10);
                    while runtime_records.len() + performance_records.len() < 256 {
                        let remaining = deadline.saturating_duration_since(Instant::now());
                        if remaining.is_zero() {
                            break;
                        }
                        match receiver.recv_timeout(remaining) {
                            Ok(command) => {
                                if let Some(flush) = collect_command(
                                    command,
                                    &mut runtime_records,
                                    &mut performance_records,
                                ) {
                                    flushes.push(flush);
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    let dropped_runtime = writer_dropped_runtime_records.swap(0, Ordering::AcqRel);
                    if dropped_runtime > 0 {
                        runtime_records.push((
                            "warn".to_string(),
                            "runtime_log_drop".to_string(),
                            json!({ "droppedCount": dropped_runtime }),
                        ));
                    }
                    let dropped_performance =
                        writer_dropped_performance_records.swap(0, Ordering::AcqRel);
                    if dropped_performance > 0 {
                        performance_records.push((
                            "error".to_string(),
                            "ui_performance_log_drop".to_string(),
                            json!({ "droppedCount": dropped_performance }),
                        ));
                    }
                    write_records(writer_path.as_ref(), "notgram.log.1", runtime_records);
                    write_records(
                        writer_performance_path.as_ref(),
                        "notgram-performance.log.1",
                        performance_records,
                    );
                    for flush in flushes {
                        let _ = flush.send(());
                    }
                }
            })
            .map_err(|error| format!("无法启动日志写入线程: {error}"))?;
        Ok(Self {
            path,
            performance_path,
            sender,
            dropped_runtime_records,
            dropped_performance_records,
        })
    }

    fn enqueue(&self, command: LogCommand) {
        match self.sender.try_send(command) {
            Ok(()) => {}
            Err(TrySendError::Full(command)) => match command {
                LogCommand::Runtime(records) => {
                    self.dropped_runtime_records
                        .fetch_add(records.len() as u64, Ordering::Relaxed);
                }
                LogCommand::Performance(records) => {
                    self.dropped_performance_records
                        .fetch_add(records.len() as u64, Ordering::Relaxed);
                }
                #[cfg(test)]
                LogCommand::Flush(_) => {}
            },
            Err(TrySendError::Disconnected(_)) => {}
        }
    }

    #[cfg(test)]
    fn flush(&self) {
        let (sender, receiver) = mpsc::channel();
        if self.sender.send(LogCommand::Flush(sender)).is_ok() {
            let _ = receiver.recv_timeout(Duration::from_secs(2));
        }
    }
}

#[allow(unused_variables)]
fn collect_command(
    command: LogCommand,
    runtime_records: &mut Vec<LogRecord>,
    performance_records: &mut Vec<LogRecord>,
) -> Option<mpsc::Sender<()>> {
    match command {
        LogCommand::Runtime(records) => {
            runtime_records.extend(records);
            None
        }
        LogCommand::Performance(records) => {
            performance_records.extend(records);
            None
        }
        #[cfg(test)]
        LogCommand::Flush(sender) => Some(sender),
    }
}

fn write_records(path: &Path, backup_name: &str, records: Vec<LogRecord>) {
    if records.is_empty() {
        return;
    }
    if fs::metadata(path).is_ok_and(|metadata| metadata.len() >= RuntimeLogger::MAX_FILE_SIZE) {
        let backup = path.with_file_name(backup_name);
        if backup.is_file() {
            let _ = fs::remove_file(&backup);
        }
        let _ = fs::rename(path, backup);
    }

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        for (level, event, details) in records {
            let timestamp_ms = details
                .get("observedAtMs")
                .and_then(Value::as_u64)
                .unwrap_or_else(|| {
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64
                });
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
        let logger = RuntimeLogger::with_paths(
            directory.join("notgram.log"),
            directory.join("notgram-performance.log"),
        )
        .expect("logger writer should start");

        logger.write("info", "runtime_started", json!({}));
        logger.write_performance_batch(vec![
            (
                "warn".to_string(),
                "ui_long_frame".to_string(),
                json!({ "durationMs": 80, "observedAtMs": 1_700_000_000_123_u64 }),
            ),
            (
                "error".to_string(),
                "ui_slow_interaction".to_string(),
                json!({ "durationMs": 120 }),
            ),
        ]);
        logger.flush();

        let runtime = fs::read_to_string(logger.path.as_ref()).expect("runtime log should exist");
        let performance = fs::read_to_string(logger.performance_path.as_ref())
            .expect("performance log should exist");
        assert!(runtime.contains("runtime_started"));
        assert!(!runtime.contains("ui_long_frame"));
        assert!(performance.contains("ui_long_frame"));
        assert!(performance.contains("ui_slow_interaction"));
        assert_eq!(performance.lines().count(), 2);
        assert!(!performance.contains("runtime_started"));
        let first_performance: Value = serde_json::from_str(
            performance
                .lines()
                .next()
                .expect("performance record should exist"),
        )
        .expect("performance record should be valid JSON");
        assert_eq!(first_performance["timestampMs"], 1_700_000_000_123_u64);
        fs::remove_dir_all(directory).expect("test directory should be removed");
    }
}
