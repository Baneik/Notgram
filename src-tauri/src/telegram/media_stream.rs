use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
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
const INITIAL_STREAM_WINDOW_BYTES: u64 = 8 * 1024 * 1024;
const STREAM_RANGE_SAFETY_BYTES: u64 = 2 * 1024 * 1024;
const STREAM_METADATA_TAIL_BYTES: u64 = 2 * 1024 * 1024;
const STREAM_BUFFER_SECONDS: f64 = 10.0;
const RANGE_WAIT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct FileProgress {
    path: PathBuf,
    offset: u64,
    prefix_size: u64,
    downloaded_size: u64,
    active: bool,
    completed: bool,
}

#[derive(Clone)]
struct StreamPlayback {
    current_time: f64,
    duration: f64,
    paused: bool,
    active: bool,
}

impl Default for StreamPlayback {
    fn default() -> Self {
        Self {
            current_time: 0.0,
            duration: 0.0,
            paused: true,
            active: true,
        }
    }
}

#[derive(Clone)]
struct RegisteredMedia {
    size: u64,
    mime_type: String,
    progress: Option<FileProgress>,
    playback: StreamPlayback,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStreamStatus {
    downloaded_bytes: u64,
    active: bool,
    completed: bool,
}

#[derive(Default)]
struct RegistryInner {
    files: HashMap<i32, RegisteredMedia>,
    active_downloads: HashMap<i32, PathBuf>,
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
                media.playback.active = true;
            })
            .or_insert(RegisteredMedia {
                size,
                mime_type,
                progress: None,
                playback: StreamPlayback::default(),
            });
        drop(inner);
        self.changed.notify_all();
        Ok(())
    }

    pub fn update_playback(
        &self,
        file_id: i32,
        current_time: f64,
        duration: f64,
        paused: bool,
    ) -> Result<(), String> {
        if !current_time.is_finite()
            || current_time < 0.0
            || !duration.is_finite()
            || duration < 0.0
        {
            return Err("Invalid Telegram media playback state".to_string());
        }
        let mut inner = self.inner.lock().expect("media stream registry poisoned");
        let media = inner
            .files
            .get_mut(&file_id)
            .ok_or_else(|| "Media stream is not registered".to_string())?;
        media.playback = StreamPlayback {
            current_time,
            duration,
            paused,
            active: true,
        };
        drop(inner);
        self.changed.notify_all();
        Ok(())
    }

    pub fn suspend(&self, file_id: i32) {
        let mut inner = self.inner.lock().expect("media stream registry poisoned");
        if let Some(media) = inner.files.get_mut(&file_id) {
            media.playback.active = false;
        }
        drop(inner);
        self.changed.notify_all();
    }

    pub fn status(&self, file_id: i32) -> Option<MediaStreamStatus> {
        let inner = self.inner.lock().expect("media stream registry poisoned");
        let media = inner.files.get(&file_id)?;
        let progress = media.progress.as_ref();
        let completed = media_is_complete(media);
        Some(MediaStreamStatus {
            downloaded_bytes: progress
                .map_or(0, |value| value.downloaded_size.max(value.prefix_size))
                .min(media.size),
            active: media.playback.active && progress.is_some_and(|value| value.active),
            completed,
        })
    }

    pub fn clear(&self) {
        let mut inner = self.inner.lock().expect("media stream registry poisoned");
        inner.files.clear();
        inner.active_downloads.clear();
        drop(inner);
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
        for (file_id, progress, active) in files {
            if active {
                inner
                    .active_downloads
                    .insert(file_id, progress.path.clone());
            } else {
                inner.active_downloads.remove(&file_id);
            }
            if let Some(media) = inner.files.get_mut(&file_id) {
                media.progress = Some(progress);
                changed = true;
            }
        }
        drop(inner);
        if changed {
            self.changed.notify_all();
        }
    }

    pub fn protected_paths(&self) -> HashSet<PathBuf> {
        let inner = self.inner.lock().expect("media stream registry poisoned");
        inner
            .active_downloads
            .values()
            .chain(
                inner
                    .files
                    .values()
                    .filter(|media| media.playback.active)
                    .filter_map(|media| media.progress.as_ref().map(|progress| &progress.path)),
            )
            .cloned()
            .collect()
    }

    fn size(&self, file_id: i32) -> Option<u64> {
        self.inner
            .lock()
            .expect("media stream registry poisoned")
            .files
            .get(&file_id)
            .map(|media| media.size)
    }

    fn wait_for_permitted_range(
        &self,
        file_id: i32,
        start: u64,
        requested: u64,
    ) -> Result<u64, String> {
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
            if !media.playback.active && !media_is_complete(media) {
                return Err("Telegram media stream is suspended".to_string());
            }
            let wanted = permitted_response_bytes(
                media,
                start,
                requested.min(media.size - start).min(MAX_RESPONSE_BYTES),
            );
            if wanted > 0 {
                return Ok(wanted);
            }
            if Instant::now() >= deadline {
                return Err("Timed out while waiting for the video buffer window".to_string());
            }
            let wait = deadline.saturating_duration_since(Instant::now());
            let (next, _) = self
                .changed
                .wait_timeout(inner, wait)
                .expect("media stream registry poisoned while waiting");
            inner = next;
        }
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
            if !media.playback.active && !media_is_complete(media) {
                return Err("Telegram media stream is suspended".to_string());
            }
            let requested_bytes = requested.min(media.size - start).min(MAX_RESPONSE_BYTES);
            let wanted = permitted_response_bytes(media, start, requested_bytes);
            if wanted == 0 {
                if Instant::now() >= deadline {
                    return Err("Timed out while waiting for the video buffer window".to_string());
                }
                let wait = deadline.saturating_duration_since(Instant::now());
                let (next, _) = self
                    .changed
                    .wait_timeout(inner, wait)
                    .expect("media stream registry poisoned while waiting");
                inner = next;
                continue;
            }
            let available = media.progress.as_ref().map_or(0, |progress| {
                let prefix_end = progress.offset.saturating_add(progress.prefix_size);
                if media_is_complete(media) {
                    media.size.saturating_sub(start)
                } else if start >= progress.offset && start < prefix_end {
                    prefix_end - start
                } else {
                    0
                }
            });
            let timed_out = Instant::now() >= deadline;
            let ready = available >= wanted.min(READY_RESPONSE_BYTES)
                || media_is_complete(media)
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

fn collect_file_progress(value: &Value, files: &mut Vec<(i32, FileProgress, bool)>) {
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
                        downloaded_size: local
                            .get("downloaded_size")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                        active: local.get("is_downloading_active").and_then(Value::as_bool)
                            == Some(true),
                        completed: local
                            .get("is_downloading_completed")
                            .and_then(Value::as_bool)
                            == Some(true),
                    },
                    local.get("is_downloading_active").and_then(Value::as_bool) == Some(true),
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

fn media_is_complete(media: &RegisteredMedia) -> bool {
    media
        .progress
        .as_ref()
        .is_some_and(|progress| progress.completed && progress.downloaded_size >= media.size)
}

fn permitted_response_bytes(media: &RegisteredMedia, start: u64, requested: u64) -> u64 {
    if media_is_complete(media) || start >= media.size.saturating_sub(STREAM_METADATA_TAIL_BYTES) {
        return requested;
    }
    let allowed_end = if media.playback.duration > 0.0 {
        let buffered_until =
            (media.playback.current_time + STREAM_BUFFER_SECONDS).min(media.playback.duration);
        let timed_bytes =
            (media.size as f64 * buffered_until / media.playback.duration).ceil() as u64;
        let safety_bytes = if media.playback.paused {
            STREAM_RANGE_SAFETY_BYTES / 2
        } else {
            STREAM_RANGE_SAFETY_BYTES
        };
        timed_bytes.saturating_add(safety_bytes)
    } else {
        INITIAL_STREAM_WINDOW_BYTES
    }
    .min(media.size);
    if start >= allowed_end {
        0
    } else {
        requested.min(allowed_end - start)
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

    let permitted_length = match registry.wait_for_permitted_range(file_id, start, length) {
        Ok(value) => value,
        Err(message) => return error_response(StatusCode::GATEWAY_TIMEOUT, &message),
    };
    if let Err(message) =
        app.state::<TelegramRuntime>()
            .request_media_range(file_id, start, permitted_length)
    {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, &message);
    }
    match registry.read_range(file_id, start, permitted_length) {
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
                "downloaded_size": 12,
                "is_downloading_completed": true
            }
        }));

        let chunk = registry.read_range(7, 6, 6).unwrap();
        assert_eq!(chunk.bytes, b"stream");
        assert!(registry.read_range(8, 0, 1).is_err());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn protects_registered_streams_and_active_downloads() {
        let registry = MediaStreamRegistry::default();
        let stream = PathBuf::from("stream.mp4");
        let download = PathBuf::from("download.jpg");
        registry.register(7, 12, "video/mp4").unwrap();
        registry.observe_update(&serde_json::json!({
            "@type": "updateFile",
            "file": {
                "id": 7,
                "local": {
                    "path": stream,
                    "is_downloading_active": false,
                    "is_downloading_completed": true
                }
            }
        }));
        registry.observe_update(&serde_json::json!({
            "@type": "updateFile",
            "file": {
                "id": 8,
                "local": {
                    "path": download,
                    "is_downloading_active": true,
                    "is_downloading_completed": false
                }
            }
        }));

        let protected = registry.protected_paths();
        assert!(protected.contains(&PathBuf::from("stream.mp4")));
        assert!(protected.contains(&PathBuf::from("download.jpg")));

        registry.suspend(7);
        assert!(
            !registry
                .protected_paths()
                .contains(&PathBuf::from("stream.mp4"))
        );

        registry.observe_update(&serde_json::json!({
            "@type": "updateFile",
            "file": {
                "id": 8,
                "local": {
                    "path": download,
                    "is_downloading_active": false,
                    "is_downloading_completed": false
                }
            }
        }));
        assert!(
            !registry
                .protected_paths()
                .contains(&PathBuf::from("download.jpg"))
        );
    }

    #[test]
    fn limits_ranges_to_the_playhead_buffer_window_but_allows_metadata_tail() {
        let mut media = RegisteredMedia {
            size: 600 * 1024 * 1024,
            mime_type: "video/mp4".to_string(),
            progress: None,
            playback: StreamPlayback {
                current_time: 0.0,
                duration: 3_600.0,
                paused: true,
                active: true,
            },
        };
        assert!(permitted_response_bytes(&media, 0, MAX_RESPONSE_BYTES) > 0);
        assert_eq!(
            permitted_response_bytes(&media, 100 * 1024 * 1024, MAX_RESPONSE_BYTES),
            0
        );
        assert_eq!(
            permitted_response_bytes(&media, 3 * 1024 * 1024, MAX_RESPONSE_BYTES),
            0
        );
        assert_eq!(
            permitted_response_bytes(&media, media.size - 1024, 1024),
            1024,
        );
        media.progress = Some(FileProgress {
            path: PathBuf::from("partial-video.mp4"),
            offset: 0,
            prefix_size: 1024,
            downloaded_size: 1024,
            active: false,
            completed: true,
        });
        assert!(!media_is_complete(&media));
        assert_eq!(
            permitted_response_bytes(&media, 100 * 1024 * 1024, MAX_RESPONSE_BYTES),
            0
        );
    }
}
