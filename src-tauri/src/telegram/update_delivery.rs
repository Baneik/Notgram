//! Acknowledged delivery keeps a suspended WebView from accumulating script
//! injections. Ordered overflow is DPAPI-protected on disk, never discarded.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const MEMORY_BYTES: usize = 1024 * 1024;
const MEMORY_RECORDS: usize = 512;
const DELIVERY_RECORDS: usize = 64;
static NEXT_STREAM: AtomicU64 = AtomicU64::new(1);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Serialize, Deserialize)]
struct Packet {
    received_at_ms: u64,
    updates: VecDeque<Value>,
    bytes: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryBatch {
    stream_id: u64,
    sequence: u64,
    updates: Vec<Value>,
    pending_count: usize,
    oldest_age_ms: u64,
}

struct Spill {
    path: PathBuf,
    file: File,
}

impl Spill {
    fn create(path: PathBuf, bytes: &[u8]) -> Result<Self, String> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_ATTRIBUTE_TEMPORARY, FILE_FLAG_DELETE_ON_CLOSE,
            };
            // Windows also deletes this encrypted spool after a process crash.
            options.custom_flags(FILE_FLAG_DELETE_ON_CLOSE | FILE_ATTRIBUTE_TEMPORARY);
        }
        let file = options.open(&path).map_err(|error| error.to_string())?;
        let mut spill = Self { path, file };
        spill
            .file
            .write_all(bytes)
            .map_err(|error| error.to_string())?;
        Ok(spill)
    }

    fn read(&mut self) -> Result<Vec<u8>, String> {
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        self.file
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok(bytes)
    }
}

impl Drop for Spill {
    fn drop(&mut self) {
        // On Windows the open handle has delete-on-close semantics; the path
        // cleanup is also needed for platforms using the test fallback cipher.
        let _ = fs::remove_file(&self.path);
    }
}

struct Stream {
    id: u64,
    memory: VecDeque<Packet>,
    reading: VecDeque<Packet>,
    spills: VecDeque<Spill>,
    memory_bytes: usize,
    memory_records: usize,
    pending_count: usize,
    directory: PathBuf,
    next_file: u64,
    next_sequence: u64,
    acknowledged: u64,
    lease: Option<DeliveryBatch>,
    signalled: bool,
}

impl Stream {
    fn new() -> Self {
        let id = NEXT_STREAM.fetch_add(1, Ordering::Relaxed);
        Self {
            id,
            memory: VecDeque::new(),
            reading: VecDeque::new(),
            spills: VecDeque::new(),
            memory_bytes: 0,
            memory_records: 0,
            pending_count: 0,
            directory: std::env::temp_dir().join(format!(
                "notgram-updates-{}-{}-{id}",
                std::process::id(),
                now_ms()
            )),
            next_file: 0,
            next_sequence: 1,
            acknowledged: 0,
            lease: None,
            signalled: false,
        }
    }

    fn spill_memory(&mut self) -> Result<(), String> {
        if self.memory.is_empty() {
            return Ok(());
        }
        let bytes = serde_json::to_vec(&self.memory).map_err(|error| error.to_string())?;
        let protected = crate::proxy::protect(&bytes)?;
        fs::create_dir_all(&self.directory).map_err(|error| error.to_string())?;
        let path = self.directory.join(format!("{}.dat", self.next_file));
        let spill = Spill::create(path, &protected)?;
        self.next_file += 1;
        self.spills.push_back(spill);
        self.memory.clear();
        self.memory_bytes = 0;
        self.memory_records = 0;
        Ok(())
    }

    fn append(&mut self, updates: &[Value]) -> Result<bool, String> {
        if updates.is_empty() {
            return Ok(false);
        }
        let bytes = serde_json::to_vec(updates)
            .map_err(|error| error.to_string())?
            .len();
        // Spill before accepting the next packet, so an I/O failure can retry
        // that packet without duplicating any messages already in the queue.
        if self.memory_records + updates.len() > MEMORY_RECORDS
            || self.memory_bytes + bytes > MEMORY_BYTES
        {
            self.spill_memory()?;
        }
        self.memory.push_back(Packet {
            received_at_ms: now_ms(),
            updates: updates.iter().cloned().collect(),
            bytes,
        });
        self.memory_bytes += bytes;
        self.memory_records += updates.len();
        self.pending_count += updates.len();
        let signal = !self.signalled;
        self.signalled = true;
        Ok(signal)
    }

    fn take(&mut self, acknowledged: u64) -> Result<DeliveryBatch, String> {
        if let Some(lease) = &self.lease {
            if acknowledged == lease.sequence {
                self.acknowledged = acknowledged;
                self.lease = None;
            } else if acknowledged == self.acknowledged {
                return Ok(lease.clone());
            } else {
                return Err("Invalid update acknowledgement".into());
            }
        } else if acknowledged != self.acknowledged {
            return Err("Invalid update acknowledgement".into());
        }

        if self.reading.is_empty() {
            if let Some(spill) = self.spills.front_mut() {
                let protected = spill.read()?;
                let bytes = crate::proxy::unprotect(&protected)?;
                let packets = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
                self.reading = packets;
                self.spills.pop_front();
            } else if let Some(packet) = self.memory.pop_front() {
                self.memory_bytes -= packet.bytes;
                self.memory_records -= packet.updates.len();
                self.reading.push_back(packet);
            }
        }
        let received_at = self
            .reading
            .front()
            .map(|packet| packet.received_at_ms)
            .unwrap_or_else(now_ms);
        let mut updates = Vec::new();
        while updates.len() < DELIVERY_RECORDS {
            let Some(packet) = self.reading.front_mut() else {
                break;
            };
            if let Some(update) = packet.updates.pop_front() {
                updates.push(update);
                self.pending_count -= 1;
            }
            if packet.updates.is_empty() {
                self.reading.pop_front();
            }
        }
        let sequence = if updates.is_empty() {
            self.acknowledged
        } else {
            self.next_sequence
        };
        let batch = DeliveryBatch {
            stream_id: self.id,
            sequence,
            updates,
            pending_count: self.pending_count,
            oldest_age_ms: now_ms().saturating_sub(received_at),
        };
        if !batch.updates.is_empty() {
            self.next_sequence += 1;
            self.lease = Some(batch.clone());
        } else {
            // Re-arm only after an empty, acknowledged read. A producer racing
            // this read will either be in its result or send the next wakeup.
            self.signalled = false;
        }
        Ok(batch)
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.spills.clear();
        let _ = fs::remove_dir(&self.directory);
    }
}

#[derive(Default)]
pub struct UpdateDelivery(Mutex<HashMap<String, Stream>>);

pub(crate) fn close_window(app: &AppHandle, label: &str) {
    if let Ok(mut streams) = app.state::<UpdateDelivery>().0.lock() {
        streams.remove(label);
    }
}

pub(crate) fn stats(app: &AppHandle) -> (usize, usize, u64) {
    app.state::<UpdateDelivery>()
        .0
        .lock()
        .map(|streams| {
            streams
                .values()
                .fold((0, 0, 0), |(pending, leased, acknowledged), stream| {
                    (
                        pending + stream.pending_count,
                        leased + stream.lease.as_ref().map_or(0, |batch| batch.updates.len()),
                        acknowledged + stream.acknowledged,
                    )
                })
        })
        .unwrap_or_default()
}

pub(crate) fn publish(app: &AppHandle, updates: &[Value]) -> Result<(), String> {
    let state = app.state::<UpdateDelivery>();
    let mut streams = state.0.lock().map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec(updates)
        .map_err(|error| error.to_string())?
        .len();
    // Reserve every subscriber before accepting the packet into any of them.
    // The receive loop can then retry a failed spill without partial delivery.
    for stream in streams.values_mut() {
        if stream.memory_records + updates.len() > MEMORY_RECORDS
            || stream.memory_bytes + bytes > MEMORY_BYTES
        {
            stream.spill_memory()?;
        }
    }
    for (label, stream) in streams.iter_mut() {
        if stream.append(updates)?
            && app
                .emit_to(label.as_str(), "telegram://updates-available", stream.id)
                .is_err()
        {
            stream.signalled = false;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn telegram_open_update_stream(window: WebviewWindow, app: AppHandle) -> Result<u64, String> {
    if !matches!(window.label(), "main" | "settings") {
        return Err("Update stream is unavailable in this window".into());
    }
    let stream = Stream::new();
    let id = stream.id;
    app.state::<UpdateDelivery>()
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .insert(window.label().into(), stream);
    Ok(id)
}

#[tauri::command]
pub async fn telegram_take_updates(
    window: WebviewWindow,
    app: AppHandle,
    stream_id: u64,
    acknowledged: u64,
) -> Result<DeliveryBatch, String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<UpdateDelivery>();
        let mut streams = state.0.lock().map_err(|error| error.to_string())?;
        let stream = streams
            .get_mut(&label)
            .filter(|stream| stream.id == stream_id)
            .ok_or_else(|| "Update stream superseded".to_string())?;
        stream.take(acknowledged)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn telegram_close_update_stream(
    window: WebviewWindow,
    app: AppHandle,
    stream_id: u64,
) -> Result<(), String> {
    let state = app.state::<UpdateDelivery>();
    let mut streams = state.0.lock().map_err(|error| error.to_string())?;
    if streams
        .get(window.label())
        .is_some_and(|stream| stream.id == stream_id)
    {
        streams.remove(window.label());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replays_unacknowledged_batches_and_rejects_wrong_acknowledgements() {
        let mut stream = Stream::new();
        assert!(stream.append(&[json!({"id": 1})]).unwrap());
        let batch = stream.take(0).unwrap();
        assert!(!stream.append(&[json!({"id": 2})]).unwrap());
        assert_eq!(stream.take(0).unwrap().updates, batch.updates);
        assert!(stream.take(77).is_err());
        let next = stream.take(batch.sequence).unwrap();
        assert_eq!(next.updates, vec![json!({"id": 2})]);
        assert!(stream.take(next.sequence).unwrap().updates.is_empty());
        assert!(stream.append(&[json!({"id": 3})]).unwrap());
    }

    #[test]
    fn spill_failure_retains_the_original_records_and_does_not_accept_a_partial_packet() {
        let mut stream = Stream::new();
        let packet = vec![json!({"id": 1}); MEMORY_RECORDS];
        stream.append(&packet).unwrap();
        fs::write(&stream.directory, b"simulate unavailable spool directory").unwrap();
        assert!(stream.append(&[json!({"id": 2})]).is_err());
        assert_eq!(stream.pending_count, MEMORY_RECORDS);
        assert_eq!(stream.memory_records, MEMORY_RECORDS);
        fs::remove_file(&stream.directory).unwrap();
        stream.append(&[json!({"id": 2})]).unwrap();
        assert_eq!(stream.pending_count, MEMORY_RECORDS + 1);
    }

    #[test]
    fn suspended_consumer_spills_encrypted_records_and_preserves_every_event_in_order() {
        let mut stream = Stream::new();
        let expected: Vec<_> = (0..12_800).map(|index| json!({"@type": (["updateNewMessage", "updateMessageContent", "updateDeleteMessages"][index % 3]), "id": index, "text": "private-test-content"})).collect();
        for packet in expected.chunks(64) {
            stream.append(packet).unwrap();
            assert!(stream.memory_records <= MEMORY_RECORDS);
        }
        assert!(!stream.spills.is_empty());
        let disk = stream.spills.front_mut().unwrap().read().unwrap();
        #[cfg(windows)]
        assert!(!String::from_utf8_lossy(&disk).contains("private-test-content"));
        let mut received = Vec::new();
        let mut ack = 0;
        loop {
            let batch = stream.take(ack).unwrap();
            ack = batch.sequence;
            if batch.updates.is_empty() {
                break;
            }
            received.extend(batch.updates);
        }
        assert_eq!(received, expected);
        assert!(stream.spills.is_empty());
        let directory = stream.directory.clone();
        drop(stream);
        assert!(!directory.exists());
    }
}
