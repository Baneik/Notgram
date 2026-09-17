use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{
    AppHandle, Manager, Runtime, UriSchemeResponder,
    http::{Request, Response, StatusCode, header},
};

use super::TelegramRuntime;

const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const READY_RESPONSE_BYTES: u64 = 256 * 1024;
const RANGE_WAIT_TIMEOUT: Duration = Duration::from_secs(20);

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
    paused: bool,
    active: bool,
}

impl Default for StreamPlayback {
    fn default() -> Self {
        Self {
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
    request_lock: Arc<Mutex<()>>,
    lease: u64,
    epoch: u64,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StreamLease {
    pub session: u64,
    pub lease: u64,
}

#[derive(Clone, Copy)]
struct RequestTicket {
    session: u64,
    lease: u64,
    epoch: u64,
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
    focused_chat: Option<i64>,
    observed_files: HashMap<i32, PathBuf>,
    file_chats: HashMap<i32, HashSet<i64>>,
    file_policy: HashMap<i32, (bool, Option<std::time::SystemTime>)>,
    files: HashMap<i32, RegisteredMedia>,
    active_downloads: HashMap<i32, PathBuf>,
    active_ranges: HashSet<i32>,
    full_downloads: HashMap<i32, Value>,
    pending_commands: HashMap<i32, Vec<Value>>,
}

#[derive(Default)]
pub struct MediaStreamRegistry {
    generation: AtomicU64,
    next_lease: AtomicU64,
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
    pub fn annotate_download_intent(&self, value: &mut Value) {
        fn annotate(value: &mut Value, inner: &RegistryInner) {
            match value {
                Value::Object(object) => {
                    if object.get("@type").and_then(Value::as_str) == Some("file")
                        && let Some(file_id) = object.get("id").and_then(Value::as_i64)
                    {
                        let file_id = file_id as i32;
                        let completed = object
                            .get("local")
                            .and_then(|local| local.get("is_downloading_completed"))
                            .and_then(Value::as_bool)
                            == Some(true);
                        // TDLib uses the same active flag for byte ranges and full
                        // downloads. Preserve its raw flag for native bookkeeping.
                        if inner.files.contains_key(&file_id)
                            || inner.full_downloads.contains_key(&file_id)
                        {
                            object.insert(
                                "notgram_download_requested".into(),
                                Value::Bool(
                                    !completed && inner.full_downloads.contains_key(&file_id),
                                ),
                            );
                        }
                        return;
                    }
                    for child in object.values_mut() {
                        annotate(child, inner);
                    }
                }
                Value::Array(values) => {
                    for child in values {
                        annotate(child, inner);
                    }
                }
                _ => {}
            }
        }
        let inner = self.inner.lock().expect("media stream registry poisoned");
        annotate(value, &inner);
    }

    fn ticket(&self, file_id: i32) -> Result<RequestTicket, String> {
        let inner = self.inner.lock().expect("media stream registry poisoned");
        let media = inner
            .files
            .get(&file_id)
            .ok_or("Media stream is not registered")?;
        Ok(RequestTicket {
            session: self.generation(),
            lease: media.lease,
            epoch: media.epoch,
        })
    }

    fn ticket_matches(&self, media: &RegisteredMedia, ticket: RequestTicket) -> bool {
        ticket.session == self.generation()
            && ticket.lease == media.lease
            && ticket.epoch == media.epoch
            && media.playback.active
    }

    pub fn release(&self, file_id: i32, owner: Option<(u64, u64)>, runtime: &TelegramRuntime) {
        let mut inner = self.inner.lock().expect("media stream registry poisoned");
        if let Some((session, lease)) = owner
            && (session != self.generation()
                || inner
                    .files
                    .get(&file_id)
                    .is_none_or(|media| media.lease != lease))
        {
            return;
        }
        if let Some(media) = inner.files.get_mut(&file_id) {
            media.playback.active = false;
            media.epoch += 1;
        }
        // Releasing playback never cancels the user's full download. If a range
        // still owns the cursor, its completion path restores that download.
        if !inner.active_ranges.contains(&file_id) && !inner.full_downloads.contains_key(&file_id) {
            let _ = runtime.send(&serde_json::json!({ "@type": "cancelDownloadFile", "file_id": file_id, "only_if_pending": false }));
        }
        drop(inner);
        self.changed.notify_all();
    }

    pub fn coordinate_download(
        &self,
        request: &Value,
        send: impl Fn(&Value) -> Result<(), String>,
    ) -> Result<(), String> {
        let file_id = request
            .get("file_id")
            .and_then(Value::as_i64)
            .ok_or("Invalid file identifier")? as i32;
        let mut inner = self.inner.lock().expect("media stream registry poisoned");
        if inner
            .pending_commands
            .get(&file_id)
            .is_some_and(|commands| commands.len() >= 32)
        {
            return Err("Media download command queue is full".into());
        }
        let full = request.get("@type").and_then(Value::as_str) == Some("downloadFile")
            && request.get("offset").and_then(Value::as_u64) == Some(0)
            && request.get("limit").and_then(Value::as_u64) == Some(0);
        if full {
            let mut intent = request.clone();
            if let Some(object) = intent.as_object_mut() {
                object.remove("@extra");
            }
            inner.full_downloads.insert(file_id, intent);
        } else if request.get("@type").and_then(Value::as_str) == Some("cancelDownloadFile") {
            inner.full_downloads.remove(&file_id);
        }
        if inner.active_ranges.contains(&file_id) {
            inner
                .pending_commands
                .entry(file_id)
                .or_default()
                .push(request.clone());
            return Ok(());
        }
        let result = send(request);
        if result.is_err() && full {
            inner.full_downloads.remove(&file_id);
        }
        result
    }

    fn begin_range(
        &self,
        file_id: i32,
        start: u64,
        length: u64,
        ticket: RequestTicket,
        runtime: &TelegramRuntime,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().expect("media stream registry poisoned");
        let media = inner
            .files
            .get(&file_id)
            .ok_or("Media stream is not registered")?;
        if !self.ticket_matches(media, ticket) {
            return Err("Media request superseded".into());
        }
        let ready = media_is_complete(media)
            || media.progress.as_ref().is_some_and(|progress| {
                start >= progress.offset
                    && start.saturating_add(length)
                        <= progress.offset.saturating_add(progress.prefix_size)
            });
        if !ready {
            runtime.request_media_range(file_id, start, length)?;
        }
        inner.active_ranges.insert(file_id);
        Ok(())
    }

    fn finish_range(
        &self,
        file_id: i32,
        ticket: RequestTicket,
        send: impl Fn(&Value) -> Result<(), String>,
    ) {
        let mut inner = self.inner.lock().expect("media stream registry poisoned");
        if ticket.session != self.generation() {
            return;
        }
        inner.active_ranges.remove(&file_id);
        if let Some(commands) = inner.pending_commands.remove(&file_id) {
            for command in commands {
                let _ = send(&command);
            }
            // The last deferred command already restores the latest intent.
            return;
        }
        if let Some(download) = inner.full_downloads.get(&file_id) {
            // TDLib has a single offset/limit per file. Restore complete-download
            // intent after each serialized range, never concurrently with it.
            let _ = send(download);
        } else if inner
            .files
            .get(&file_id)
            .is_none_or(|media| !media.playback.active)
        {
            let _ = send(
                &serde_json::json!({ "@type": "cancelDownloadFile", "file_id": file_id, "only_if_pending": false }),
            );
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
    pub fn register(
        &self,
        file_id: i32,
        size: u64,
        mime_type: &str,
        preserve_download: bool,
    ) -> Result<StreamLease, String> {
        if file_id <= 0 || size == 0 {
            return Err("Invalid Telegram media stream descriptor".to_string());
        }
        let mime_type = normalized_media_mime_type(mime_type);
        let lease = self.next_lease.fetch_add(1, Ordering::SeqCst) + 1;
        let mut inner = self.inner.lock().expect("media stream registry poisoned");
        if !preserve_download {
            inner.full_downloads.remove(&file_id);
        }
        inner
            .files
            .entry(file_id)
            .and_modify(|media| {
                media.size = size;
                media.mime_type.clone_from(&mime_type);
                media.playback.active = true;
                media.lease = lease;
                media.epoch += 1;
            })
            .or_insert(RegisteredMedia {
                size,
                mime_type,
                progress: None,
                playback: StreamPlayback::default(),
                request_lock: Arc::new(Mutex::new(())),
                lease,
                epoch: 0,
            });
        let owner = StreamLease {
            session: self.generation(),
            lease,
        };
        drop(inner);
        self.changed.notify_all();
        Ok(owner)
    }

    pub fn update_playback(
        &self,
        file_id: i32,
        current_time: f64,
        duration: f64,
        paused: bool,
        owner: Option<(u64, u64)>,
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
        if let Some((session, lease)) = owner
            && (session != self.generation() || lease != media.lease || !media.playback.active)
        {
            return Err("Media session expired".into());
        }
        // A timeline seek does not invalidate bytes in this source. The demuxer
        // may retain an in-flight range (including an in-buffer seek); revoking
        // it here turns normal playback into an HTTP error. Only source lifetime
        // changes revoke tickets. Byte offsets continue to come from Range.
        media.playback = StreamPlayback {
            paused,
            active: true,
        };
        drop(inner);
        self.changed.notify_all();
        Ok(())
    }

    #[cfg(test)]
    pub fn suspend(&self, file_id: i32) {
        let mut inner = self.inner.lock().expect("media stream registry poisoned");
        if let Some(media) = inner.files.get_mut(&file_id) {
            media.playback.active = false;
            media.epoch += 1;
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
        self.generation.fetch_add(1, Ordering::SeqCst);
        inner.focused_chat = None;
        inner.observed_files.clear();
        inner.file_chats.clear();
        inner.file_policy.clear();
        inner.files.clear();
        inner.active_downloads.clear();
        inner.active_ranges.clear();
        inner.full_downloads.clear();
        inner.pending_commands.clear();
        drop(inner);
        self.changed.notify_all();
    }

    pub fn observe_update(&self, update: &Value) {
        let mut files = Vec::new();
        collect_file_progress(update, &mut files);
        let mut changed = false;
        let mut inner = self.inner.lock().expect("media stream registry poisoned");
        collect_file_chats(update, &mut inner.file_chats);
        collect_file_policies(update, &mut inner.file_policy, None);
        for (file_id, progress, active) in files {
            inner.observed_files.insert(file_id, progress.path.clone());
            if progress.completed {
                inner.full_downloads.remove(&file_id);
            }
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

    pub fn set_focus(&self, chat_id: Option<i64>) {
        self.inner
            .lock()
            .expect("media stream registry poisoned")
            .focused_chat = chat_id;
    }

    pub fn protected_chat_ids(&self) -> HashSet<i64> {
        let inner = self
            .inner
            .lock()
            .expect("Media stream registry unavailable");
        inner
            .active_downloads
            .keys()
            .chain(
                inner
                    .files
                    .iter()
                    .filter(|(_, media)| media.playback.active)
                    .map(|(id, _)| id),
            )
            .filter_map(|id| inner.file_chats.get(id))
            .flat_map(|chats| chats.iter().copied())
            .chain(inner.focused_chat)
            .collect()
    }

    pub fn protected_paths(&self) -> HashSet<PathBuf> {
        let inner = self.inner.lock().expect("media stream registry poisoned");
        inner
            .active_downloads
            .values()
            .chain(
                inner
                    .files
                    .iter()
                    .filter(|(_, media)| media.playback.active)
                    .filter_map(|(id, media)| {
                        media
                            .progress
                            .as_ref()
                            .map(|progress| &progress.path)
                            .or_else(|| inner.observed_files.get(id))
                    }),
            )
            .cloned()
            .collect()
    }

    pub fn check_expiry(&self, path: &std::path::Path) -> Result<(), String> {
        self.check_policy(path, false)
    }

    pub fn check_export(&self, path: &std::path::Path) -> Result<(), String> {
        self.check_policy(path, true)
    }

    fn check_policy(&self, path: &std::path::Path, exporting: bool) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|_| "File policy unavailable")?;
        for (id, observed) in &inner.observed_files {
            if (observed == path || observed.canonicalize().ok().as_deref() == Some(path))
                && let Some((denied, expires)) = inner.file_policy.get(id)
                && ((exporting && *denied)
                    || expires.is_some_and(|time| time <= std::time::SystemTime::now()))
            {
                return Err("This message cannot be saved or has expired".into());
            }
        }
        Ok(())
    }

    pub fn recovery_path(&self, file_id: i32) -> Result<PathBuf, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "Media registry unavailable")?;
        if inner.active_downloads.contains_key(&file_id)
            || inner
                .files
                .get(&file_id)
                .is_some_and(|media| media.playback.active && !media.playback.paused)
        {
            return Err("File is currently downloading or playing".into());
        }
        inner
            .observed_files
            .get(&file_id)
            .cloned()
            .ok_or("File was not observed in this account".into())
    }

    fn stream_descriptor(&self, file_id: i32) -> Option<(u64, Arc<Mutex<()>>)> {
        self.inner
            .lock()
            .expect("media stream registry poisoned")
            .files
            .get(&file_id)
            .map(|media| (media.size, Arc::clone(&media.request_lock)))
    }

    #[cfg(test)]
    fn read_range(&self, file_id: i32, start: u64, requested: u64) -> Result<MediaChunk, String> {
        let ticket = self.ticket(file_id)?;
        self.read_range_owned(file_id, start, requested, ticket)
    }

    fn read_range_owned(
        &self,
        file_id: i32,
        start: u64,
        requested: u64,
        ticket: RequestTicket,
    ) -> Result<MediaChunk, String> {
        let deadline = Instant::now() + RANGE_WAIT_TIMEOUT;
        let mut inner = self.inner.lock().expect("media stream registry poisoned");
        loop {
            let media = inner
                .files
                .get(&file_id)
                .ok_or_else(|| "Media stream is not registered".to_string())?;
            if !self.ticket_matches(media, ticket) {
                return Err("Media request superseded".into());
            }
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

                self.check_expiry(&progress.path)?;
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

fn normalized_media_mime_type(mime_type: &str) -> String {
    let normalized = mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "video/mp4" | "video/webm" | "video/quicktime" | "audio/mpeg" | "audio/mp4"
        | "audio/aac" | "audio/ogg" | "application/ogg" | "audio/opus" | "audio/wav"
        | "audio/wave" | "audio/x-wav" | "audio/vnd.wave" | "audio/flac" | "audio/x-flac"
        | "audio/webm" => normalized,
        _ => "video/mp4".to_string(),
    }
}

fn collect_file_chats(value: &Value, chats: &mut HashMap<i32, HashSet<i64>>) {
    if let Some(object) = value.as_object() {
        if object.get("@type").and_then(Value::as_str) == Some("message")
            && let Some(chat_id) = object.get("chat_id").and_then(Value::as_i64)
        {
            let mut files = Vec::new();
            collect_file_progress(value, &mut files);
            for (id, _, _) in files {
                chats.entry(id).or_default().insert(chat_id);
            }
        }
        for nested in object.values() {
            collect_file_chats(nested, chats);
        }
    } else if let Some(values) = value.as_array() {
        for nested in values {
            collect_file_chats(nested, chats);
        }
    }
}

fn collect_file_policies(
    value: &Value,
    policies: &mut HashMap<i32, (bool, Option<std::time::SystemTime>)>,
    inherited: Option<(bool, Option<std::time::SystemTime>)>,
) {
    match value {
        Value::Object(object) => {
            let policy = if object.get("@type").and_then(Value::as_str) == Some("message") {
                let denied = object.get("can_be_saved").and_then(Value::as_bool) == Some(false)
                    || object
                        .get("self_destruct_type")
                        .is_some_and(|value| !value.is_null());
                let seconds = ["self_destruct_in", "auto_delete_in"]
                    .iter()
                    .filter_map(|key| object.get(*key).and_then(Value::as_f64))
                    .filter(|value| value.is_finite() && *value > 0.0)
                    .min_by(f64::total_cmp);
                Some((
                    denied,
                    seconds.and_then(|seconds| {
                        std::time::SystemTime::now()
                            .checked_add(Duration::from_secs_f64(seconds.min(315_360_000.0)))
                    }),
                ))
            } else {
                inherited
            };
            if let Some(policy) = policy
                && object.contains_key("local")
                && let Some(id) = object
                    .get("id")
                    .and_then(Value::as_i64)
                    .and_then(|id| i32::try_from(id).ok())
            {
                policies
                    .entry(id)
                    .and_modify(|old| {
                        old.0 |= policy.0;
                        old.1 = match (old.1, policy.1) {
                            (Some(a), Some(b)) => Some(a.min(b)),
                            (a, b) => a.or(b),
                        };
                    })
                    .or_insert(policy);
            }
            for nested in object.values() {
                collect_file_policies(nested, policies, policy);
            }
        }
        Value::Array(values) => {
            for nested in values {
                collect_file_policies(nested, policies, inherited);
            }
        }
        _ => {}
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

// The demuxer supplies byte offsets. Time/size ratios are invalid for VBR and
// tail metadata; bound the actual requested bytes instead of predicting them.
fn permitted_response_bytes(media: &RegisteredMedia, start: u64, requested: u64) -> u64 {
    requested
        .min(MAX_RESPONSE_BYTES)
        .min(media.size.saturating_sub(start))
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
        if suffix == 0 {
            return Err("Invalid media suffix range".into());
        }
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

fn parse_stream_owner(query: &str) -> Option<(u64, u64)> {
    let mut session = None;
    let mut lease = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=')?;
        match key {
            "session" if session.is_none() => session = Some(value.parse().ok()?),
            "lease" if lease.is_none() => lease = Some(value.parse().ok()?),
            _ => return None,
        }
    }
    Some((session?, lease?))
}

fn media_response<R: Runtime>(
    app: &AppHandle<R>,
    request: Request<Vec<u8>>,
    ticket: RequestTicket,
) -> Response<Vec<u8>> {
    let file_id = match request.uri().path().trim_matches('/').parse::<i32>() {
        Ok(file_id) => file_id,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "Invalid Telegram media file"),
    };
    let registry = app.state::<MediaStreamRegistry>();
    if ticket.session != registry.generation() {
        return error_response(StatusCode::FORBIDDEN, "Media session expired");
    }
    let Some((size, request_lock)) = registry.stream_descriptor(file_id) else {
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

    let _request_guard = match request_lock.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Media stream request lock is unavailable",
            );
        }
    };
    let runtime = app.state::<TelegramRuntime>();
    if let Err(message) = registry.begin_range(file_id, start, length, ticket, &runtime) {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, &message);
    }
    let result = registry.read_range_owned(file_id, start, length, ticket);
    registry.finish_range(file_id, ticket, |request| runtime.send(request));
    match result {
        Ok(_) if ticket.session != registry.generation() => {
            error_response(StatusCode::FORBIDDEN, "Media session expired")
        }
        Ok(chunk) => Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, chunk.mime_type)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(
                header::CONTENT_RANGE,
                format!("bytes {}-{}/{}", chunk.start, chunk.end, chunk.total),
            )
            .header(header::CONTENT_LENGTH, chunk.bytes.len())
            .header(header::CACHE_CONTROL, "no-store")
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
    let file_id = request
        .uri()
        .path()
        .trim_matches('/')
        .parse::<i32>()
        .unwrap_or(0);
    let owner = request.uri().query().and_then(parse_stream_owner);
    let ticket = app.state::<MediaStreamRegistry>().ticket(file_id);
    let ticket = match ticket {
        Ok(ticket) if owner == Some((ticket.session, ticket.lease)) => ticket,
        _ => {
            responder.respond(error_response(
                StatusCode::FORBIDDEN,
                "Media session expired",
            ));
            return;
        }
    };
    super::stream_scheduler::dispatch((ticket.session, file_id), ticket.epoch, move |cancelled| {
        let response = if cancelled {
            error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "Media request superseded or queue full",
            )
        } else {
            media_response(&app, request, ticket)
        };
        responder.respond(response);
    });
}

#[tauri::command]
pub fn telegram_set_media_focus(
    chat_id: Option<i64>,
    registry: tauri::State<'_, MediaStreamRegistry>,
) {
    registry.set_focus(chat_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env, fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn restrictions_survive_file_updates_and_session_urls_are_revoked() {
        let registry = MediaStreamRegistry::default();
        let original_generation = registry.generation();
        let message = serde_json::json!({"@type":"message", "id":1, "chat_id":20,
            "can_be_saved":false, "auto_delete_in":10,
            "content":{"file":{"id":42,"local":{"path":""}}}});
        registry.observe_update(&message);
        registry.observe_update(&serde_json::json!({"@type":"updateFile", "file":{"id":42,"local":{"path":"media.jpg"}}}));
        assert!(
            registry
                .check_export(std::path::Path::new("media.jpg"))
                .is_err()
        );
        assert!(
            registry
                .check_expiry(std::path::Path::new("media.jpg"))
                .is_ok()
        );
        registry
            .inner
            .lock()
            .unwrap()
            .file_policy
            .get_mut(&42)
            .unwrap()
            .1 = Some(std::time::SystemTime::UNIX_EPOCH);
        assert!(
            registry
                .check_expiry(std::path::Path::new("media.jpg"))
                .is_err()
        );
        registry.clear();
        assert_ne!(original_generation, registry.generation());
        assert!(registry.inner.lock().unwrap().observed_files.is_empty());
    }

    #[test]
    fn parses_bounded_open_and_suffix_ranges() {
        assert_eq!(parse_range(Some("bytes=10-19"), 100).unwrap(), (10, 10));
        assert_eq!(parse_range(Some("bytes=90-"), 100).unwrap(), (90, 10));
        assert_eq!(parse_range(Some("bytes=-8"), 100).unwrap(), (92, 8));
        assert!(parse_range(Some("bytes=100-"), 100).is_err());
        assert!(parse_range(Some("bytes=0-1,3-4"), 100).is_err());
        assert!(parse_range(Some("bytes=40-20"), 100).is_err());
        assert!(parse_range(Some("bytes=-0"), 100).is_err());
    }

    #[test]
    fn preserves_supported_audio_mime_types_without_accepting_arbitrary_headers() {
        assert_eq!(normalized_media_mime_type("audio/flac"), "audio/flac");
        assert_eq!(
            normalized_media_mime_type("Audio/Ogg; codecs=opus"),
            "audio/ogg"
        );
        assert_eq!(normalized_media_mime_type("text/plain"), "video/mp4");
    }

    #[test]
    fn reads_only_observed_ranges_for_registered_files() {
        let registry = MediaStreamRegistry::default();
        registry.register(7, 12, "video/mp4", false).unwrap();
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
    fn serializes_range_requests_for_each_registered_file() {
        let registry = MediaStreamRegistry::default();
        registry.register(7, 12, "video/mp4", false).unwrap();
        registry.register(8, 12, "video/mp4", false).unwrap();

        let (_, first) = registry.stream_descriptor(7).unwrap();
        let (_, same_file) = registry.stream_descriptor(7).unwrap();
        let (_, other_file) = registry.stream_descriptor(8).unwrap();

        assert!(Arc::ptr_eq(&first, &same_file));
        assert!(!Arc::ptr_eq(&first, &other_file));
        let _guard = first.lock().unwrap();
        assert!(same_file.try_lock().is_err());
        assert!(other_file.try_lock().is_ok());
    }

    #[test]
    fn protects_registered_streams_and_active_downloads() {
        let registry = MediaStreamRegistry::default();
        let stream = PathBuf::from("stream.mp4");
        let download = PathBuf::from("download.jpg");
        registry.register(7, 12, "video/mp4", false).unwrap();
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
    fn serves_demuxer_offsets_without_assuming_a_constant_bitrate() {
        let registry = MediaStreamRegistry::default();
        registry
            .register(7, 600 * 1024 * 1024, "video/mp4", false)
            .unwrap();
        let inner = registry.inner.lock().unwrap();
        let media = inner.files.get(&7).unwrap();
        assert_eq!(
            permitted_response_bytes(media, 100 * 1024 * 1024, MAX_RESPONSE_BYTES),
            MAX_RESPONSE_BYTES
        );
        assert_eq!(
            permitted_response_bytes(media, media.size - 1024, MAX_RESPONSE_BYTES),
            1024
        );
        assert_eq!(permitted_response_bytes(media, media.size, 100), 0);
    }

    #[test]
    fn source_leases_and_account_generations_reject_old_owners() {
        let registry = MediaStreamRegistry::default();
        let first = registry.register(7, 1000, "video/mp4", false).unwrap();
        let ticket = registry.ticket(7).unwrap();
        let second = registry.register(7, 1000, "video/mp4", false).unwrap();
        registry.release(
            7,
            Some((first.session, first.lease)),
            &TelegramRuntime::new(),
        );
        assert!(
            registry
                .inner
                .lock()
                .unwrap()
                .files
                .get(&7)
                .unwrap()
                .playback
                .active
        );
        assert_ne!(first.lease, second.lease);
        assert!(registry.read_range_owned(7, 0, 10, ticket).is_err());
        assert!(
            registry
                .update_playback(7, 5.0, 10.0, false, Some((first.session, first.lease)))
                .is_err()
        );
        registry.clear();
        registry.register(7, 1000, "video/mp4", false).unwrap();
        assert!(
            registry
                .update_playback(7, 5.0, 10.0, false, Some((second.session, second.lease)))
                .is_err()
        );
        assert_eq!(parse_stream_owner("session=2&lease=5"), Some((2, 5)));
        assert!(parse_stream_owner("session=2&lease=5&session=3").is_none());
        assert!(parse_stream_owner("session=2").is_none());
    }

    #[test]
    fn seeks_preserve_pending_bytes_but_release_still_wakes_and_revokes_reads() {
        let registry = Arc::new(MediaStreamRegistry::default());
        registry.register(7, 1000, "video/mp4", false).unwrap();
        let ticket = registry.ticket(7).unwrap();
        let other = Arc::clone(&registry);
        let (send, receive) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            send.send(other.read_range_owned(7, 0, 100, ticket).is_err())
                .unwrap();
        });
        registry
            .update_playback(7, 0.5, 100.0, false, None)
            .unwrap();
        registry
            .update_playback(7, 60.0, 100.0, true, None)
            .unwrap();
        registry
            .update_playback(7, 4.0, 100.0, false, None)
            .unwrap();
        assert_eq!(registry.ticket(7).unwrap().epoch, ticket.epoch);
        assert!(receive.recv_timeout(Duration::from_millis(30)).is_err());
        registry.suspend(7);
        assert!(receive.recv_timeout(Duration::from_secs(1)).unwrap());
        reader.join().unwrap();
        assert_ne!(registry.ticket(7).unwrap().epoch, ticket.epoch);
    }

    #[test]
    fn ranges_requested_before_seeking_can_still_read_their_original_bytes() {
        let registry = MediaStreamRegistry::default();
        registry.register(7, 12, "video/mp4", false).unwrap();
        let ticket = registry.ticket(7).unwrap();
        let path = env::temp_dir().join(format!("notgram-seek-{}.mp4", std::process::id()));
        fs::write(&path, b"hello stream").unwrap();
        registry
            .update_playback(7, 80.0, 100.0, false, None)
            .unwrap();
        registry.observe_update(&serde_json::json!({"@type":"file", "id":7, "local":{
            "path":path, "download_offset":0, "downloaded_prefix_size":12,
            "downloaded_size":12, "is_downloading_completed":false
        }}));
        let result = registry.read_range_owned(7, 6, 6, ticket);
        fs::remove_file(path).unwrap();
        assert_eq!(result.unwrap().bytes, b"stream");
    }

    #[test]
    fn exposes_full_download_intent_independently_of_stream_activity() {
        let registry = MediaStreamRegistry::default();
        registry.register(7, 1000, "video/mp4", false).unwrap();
        let file = serde_json::json!({"@type":"file", "id":7,
            "local":{"is_downloading_active":true,"is_downloading_completed":false}});
        let mut message = serde_json::json!({"messages":[{"content":{"video":file.clone()}}]});
        registry.annotate_download_intent(&mut message);
        assert_eq!(
            message["messages"][0]["content"]["video"]["notgram_download_requested"],
            false
        );
        assert_eq!(
            message["messages"][0]["content"]["video"]["local"]["is_downloading_active"],
            true
        );
        registry.inner.lock().unwrap().active_ranges.insert(7);
        registry
            .coordinate_download(
                &serde_json::json!({"@type":"downloadFile","file_id":7,"offset":0,"limit":0}),
                |_| panic!("must defer"),
            )
            .unwrap();
        let mut waiting = file.clone();
        waiting["local"]["is_downloading_active"] = Value::Bool(false);
        registry.annotate_download_intent(&mut waiting);
        assert_eq!(waiting["notgram_download_requested"], true);
        let mut completed = file.clone();
        completed["local"]["is_downloading_completed"] = Value::Bool(true);
        registry.annotate_download_intent(&mut completed);
        assert_eq!(completed["notgram_download_requested"], false);
        registry
            .coordinate_download(
                &serde_json::json!({"@type":"cancelDownloadFile","file_id":7}),
                |_| panic!("must defer"),
            )
            .unwrap();
        let mut cancelled = file.clone();
        registry.annotate_download_intent(&mut cancelled);
        assert_eq!(cancelled["notgram_download_requested"], false);
        registry.suspend(7);
        registry.annotate_download_intent(&mut cancelled);
        assert_eq!(cancelled["notgram_download_requested"], false);
        registry.clear();
        let mut ordinary = file;
        registry.annotate_download_intent(&mut ordinary);
        assert!(ordinary.get("notgram_download_requested").is_none());
    }

    #[test]
    fn defers_full_downloads_and_cancellation_until_the_range_releases_the_cursor() {
        let registry = MediaStreamRegistry::default();
        registry.register(7, 1000, "video/mp4", false).unwrap();
        let ticket = registry.ticket(7).unwrap();
        registry.inner.lock().unwrap().active_ranges.insert(7);
        let sent = Mutex::new(Vec::new());
        let send = |request: &Value| {
            sent.lock().unwrap().push(request.clone());
            Ok(())
        };
        let full = serde_json::json!({"@type":"downloadFile", "file_id":7, "offset":0, "limit":0, "priority":24, "@extra":"full"});
        registry.coordinate_download(&full, send).unwrap();
        assert!(sent.lock().unwrap().is_empty());
        registry.finish_range(7, ticket, send);
        assert_eq!(*sent.lock().unwrap(), vec![full.clone()]);
        // An ensuing playback range restores the saved full-download request.
        registry.inner.lock().unwrap().active_ranges.insert(7);
        registry.finish_range(7, ticket, send);
        assert_eq!(
            sent.lock().unwrap().last().unwrap().get("limit"),
            Some(&Value::from(0))
        );
        assert!(sent.lock().unwrap().last().unwrap().get("@extra").is_none());
        registry.inner.lock().unwrap().active_ranges.insert(7);
        let cancel =
            serde_json::json!({"@type":"cancelDownloadFile", "file_id":7, "only_if_pending":false});
        registry.coordinate_download(&cancel, send).unwrap();
        registry.finish_range(7, ticket, send);
        assert_eq!(sent.lock().unwrap().last(), Some(&cancel));
        assert!(
            !registry
                .inner
                .lock()
                .unwrap()
                .full_downloads
                .contains_key(&7)
        );
    }

    #[test]
    fn account_reset_drops_deferred_downloads_and_old_range_completion() {
        let registry = MediaStreamRegistry::default();
        registry.register(7, 1000, "video/mp4", false).unwrap();
        let ticket = registry.ticket(7).unwrap();
        registry.inner.lock().unwrap().active_ranges.insert(7);
        registry
            .coordinate_download(
                &serde_json::json!({"@type":"downloadFile", "file_id":7, "offset":0, "limit":0}),
                |_| panic!("must defer"),
            )
            .unwrap();
        registry.clear();
        registry.register(7, 1000, "video/mp4", false).unwrap();
        registry.finish_range(7, ticket, |_| panic!("must not send to the new account"));
        assert!(registry.inner.lock().unwrap().pending_commands.is_empty());
    }

    #[test]
    fn local_playback_protects_a_file_observed_before_registration() {
        let registry = MediaStreamRegistry::default();
        registry.observe_update(&serde_json::json!({"@type":"updateFile", "file":{"id":7,
            "local":{"path":"cached.mp4", "is_downloading_active":false, "is_downloading_completed":true}}}));
        let owner = registry.register(7, 1000, "video/mp4", false).unwrap();
        assert!(
            registry
                .protected_paths()
                .contains(&PathBuf::from("cached.mp4"))
        );
        registry.release(
            7,
            Some((owner.session, owner.lease)),
            &TelegramRuntime::new(),
        );
        assert!(
            !registry
                .protected_paths()
                .contains(&PathBuf::from("cached.mp4"))
        );
    }
}
