use serde_json::Value;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{
    AppHandle, Manager, Runtime, UriSchemeResponder,
    http::{Request, Response, StatusCode, header},
};

use super::TelegramRuntime;

const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const READY_RESPONSE_BYTES: u64 = 256 * 1024;
const RANGE_WAIT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct FileProgress {
    path: PathBuf,
    offset: u64,
    prefix_size: u64,
    completed: bool,
}

#[derive(Clone)]
struct RegisteredMedia {
    size: u64,
    mime_type: String,
    progress: Option<FileProgress>,
}

#[derive(Default)]
struct RegistryInner {
    files: HashMap<i32, RegisteredMedia>,
}

#[derive(Default)]
pub struct MediaStreamRegistry {
    inner: Mutex<RegistryInner>,
    changed: Condvar,
}

struct MediaChunk {
    start: u64,
    end: u64,
    total: u64,
    mime_type: String,
    bytes: Vec<u8>,
}

impl MediaStreamRegistry {
    pub fn register(&self, file_id: i32, size: u64, mime_type: &str) -> Result<(), String> {
        if file_id <= 0 || size == 0 {
            return Err("Invalid Telegram media stream descriptor".to_string());
        }
        let mime_type = match mime_type.to_ascii_lowercase().as_str() {
            "video/mp4" | "video/webm" | "video/quicktime" => mime_type.to_ascii_lowercase(),
            _ => "video/mp4".to_string(),
        };
        let mut inner = self.inner.lock().expect("media stream registry poisoned");
        inner
            .files
            .entry(file_id)
            .and_modify(|media| {
                media.size = size;
                media.mime_type.clone_from(&mime_type);
            })
            .or_insert(RegisteredMedia {
                size,
                mime_type,
                progress: None,
            });
        Ok(())
    }

    pub fn clear(&self) {
        self.inner
            .lock()
            .expect("media stream registry poisoned")
            .files
            .clear();
        self.changed.notify_all();
    }

    pub fn observe_update(&self, update: &Value) {
        let mut files = Vec::new();
        collect_file_progress(update, &mut files);
        if files.is_empty() {
            return;
        }

        let mut changed = false;
        let mut inner = self.inner.lock().expect("media stream registry poisoned");
        for (file_id, progress) in files {
            let Some(media) = inner.files.get_mut(&file_id) else {
                continue;
            };
            media.progress = Some(progress);
            changed = true;
        }
        drop(inner);
        if changed {
            self.changed.notify_all();
        }
    }

    fn size(&self, file_id: i32) -> Option<u64> {
        self.inner
            .lock()
            .expect("media stream registry poisoned")
            .files
            .get(&file_id)
            .map(|media| media.size)
    }

    fn read_range(&self, file_id: i32, start: u64, requested: u64) -> Result<MediaChunk, String> {
        let deadline = Instant::now() + RANGE_WAIT_TIMEOUT;
        let mut inner = self.inner.lock().expect("media stream registry poisoned");
        loop {
            let media = inner
                .files
                .get(&file_id)
                .ok_or_else(|| "Media stream is not registered".to_string())?;
            if start >= media.size {
                return Err("Requested media range is outside the file".to_string());
            }
            let wanted = requested.min(media.size - start).min(MAX_RESPONSE_BYTES);
            let available = media.progress.as_ref().map_or(0, |progress| {
                let prefix_end = progress.offset.saturating_add(progress.prefix_size);
                if progress.completed {
                    media.size.saturating_sub(start)
                } else if start >= progress.offset && start < prefix_end {
                    prefix_end - start
                } else {
                    0
                }
            });
            let timed_out = Instant::now() >= deadline;
            let ready = available >= wanted.min(READY_RESPONSE_BYTES)
                || media
                    .progress
                    .as_ref()
                    .is_some_and(|progress| progress.completed)
                || (timed_out && available > 0);
            if ready {
                let progress = media.progress.clone().expect("ready media has progress");
                let bytes_to_read = available.min(wanted);
                let total = media.size;
                let mime_type = media.mime_type.clone();
                drop(inner);

                let mut file = File::open(&progress.path)
                    .map_err(|error| format!("Unable to open streamed media: {error}"))?;
                file.seek(SeekFrom::Start(start))
                    .map_err(|error| format!("Unable to seek streamed media: {error}"))?;
                let mut bytes = Vec::with_capacity(bytes_to_read as usize);
                file.take(bytes_to_read)
                    .read_to_end(&mut bytes)
                    .map_err(|error| format!("Unable to read streamed media: {error}"))?;
                if bytes.is_empty() {
                    return Err("Streamed media range is not available yet".to_string());
                }
                return Ok(MediaChunk {
                    start,
                    end: start + bytes.len() as u64 - 1,
                    total,
                    mime_type,
                    bytes,
                });
            }
            if timed_out {
                return Err("Timed out while buffering Telegram video".to_string());
            }
            let wait = deadline.saturating_duration_since(Instant::now());
            let (next, _) = self
                .changed
                .wait_timeout(inner, wait)
                .expect("media stream registry poisoned while waiting");
            inner = next;
        }
    }
}

fn collect_file_progress(value: &Value, files: &mut Vec<(i32, FileProgress)>) {
    match value {
        Value::Object(object) => {
            if let (Some(file_id), Some(local)) = (
                object.get("id").and_then(Value::as_i64),
                object.get("local").and_then(Value::as_object),
            ) && let Some(path) = local.get("path").and_then(Value::as_str)
                && !path.is_empty()
                && let Ok(file_id) = i32::try_from(file_id)
            {
                files.push((
                    file_id,
                    FileProgress {
                        path: PathBuf::from(path),
                        offset: local
                            .get("download_offset")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                        prefix_size: local
                            .get("downloaded_prefix_size")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                        completed: local
                            .get("is_downloading_completed")
                            .and_then(Value::as_bool)
                            == Some(true),
                    },
                ));
            }
            for nested in object.values() {
                collect_file_progress(nested, files);
            }
        }
        Value::Array(values) => {
            for nested in values {
                collect_file_progress(nested, files);
            }
        }
        _ => {}
    }
}

fn parse_range(value: Option<&str>, size: u64) -> Result<(u64, u64), String> {
    let Some(value) = value else {
        return Ok((0, size.min(MAX_RESPONSE_BYTES)));
    };
    let range = value
        .strip_prefix("bytes=")
        .ok_or_else(|| "Unsupported media range".to_string())?;
    if range.contains(',') {
        return Err("Multiple media ranges are not supported".to_string());
    }
    let (start, end) = range
        .split_once('-')
        .ok_or_else(|| "Invalid media range".to_string())?;
    if start.is_empty() {
        let suffix = end
            .parse::<u64>()
            .map_err(|_| "Invalid media suffix range".to_string())?
            .min(size);
        return Ok((size - suffix, suffix.min(MAX_RESPONSE_BYTES)));
    }
    let start = start
        .parse::<u64>()
        .map_err(|_| "Invalid media range start".to_string())?;
    if start >= size {
        return Err("Requested media range is outside the file".to_string());
    }
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>()
            .map_err(|_| "Invalid media range end".to_string())?
            .min(size - 1)
    };
    if end < start {
        return Err("Invalid media range bounds".to_string());
    }
    Ok((start, (end - start + 1).min(MAX_RESPONSE_BYTES)))
}

fn error_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(message.as_bytes().to_vec())
        .expect("valid media error response")
}

fn media_response<R: Runtime>(app: &AppHandle<R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let file_id = match request.uri().path().trim_matches('/').parse::<i32>() {
        Ok(file_id) => file_id,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "Invalid Telegram media file"),
    };
    let registry = app.state::<MediaStreamRegistry>();
    let Some(size) = registry.size(file_id) else {
        return error_response(
            StatusCode::NOT_FOUND,
            "Telegram media stream is not registered",
        );
    };
    let range_header = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let (start, length) = match parse_range(range_header, size) {
        Ok(range) => range,
        Err(message) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(message.into_bytes())
                .expect("valid media range error response");
        }
    };

    if let Err(message) = app
        .state::<TelegramRuntime>()
        .request_media_range(file_id, start, length)
    {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, &message);
    }
    match registry.read_range(file_id, start, length) {
        Ok(chunk) => Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, chunk.mime_type)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(
                header::CONTENT_RANGE,
                format!("bytes {}-{}/{}", chunk.start, chunk.end, chunk.total),
            )
            .header(header::CONTENT_LENGTH, chunk.bytes.len())
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(chunk.bytes)
            .expect("valid media stream response"),
        Err(message) => error_response(StatusCode::GATEWAY_TIMEOUT, &message),
    }
}

pub fn respond<R: Runtime>(
    app: AppHandle<R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    thread::spawn(move || responder.respond(media_response(&app, request)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env, fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn parses_bounded_open_and_suffix_ranges() {
        assert_eq!(parse_range(Some("bytes=10-19"), 100).unwrap(), (10, 10));
        assert_eq!(parse_range(Some("bytes=90-"), 100).unwrap(), (90, 10));
        assert_eq!(parse_range(Some("bytes=-8"), 100).unwrap(), (92, 8));
        assert!(parse_range(Some("bytes=100-"), 100).is_err());
    }

    #[test]
    fn reads_only_observed_ranges_for_registered_files() {
        let registry = MediaStreamRegistry::default();
        registry.register(7, 12, "video/mp4").unwrap();
        let path = env::temp_dir().join(format!(
            "notgram-media-{}-{}.mp4",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, b"hello stream").unwrap();
        registry.observe_update(&serde_json::json!({
            "@type": "file",
            "id": 7,
            "local": {
                "path": path.display().to_string(),
                "download_offset": 0,
                "downloaded_prefix_size": 12,
                "is_downloading_completed": true
            }
        }));

        let chunk = registry.read_range(7, 6, 6).unwrap();
        assert_eq!(chunk.bytes, b"stream");
        assert!(registry.read_range(8, 0, 1).is_err());
        fs::remove_file(path).unwrap();
    }
}
