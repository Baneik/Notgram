//! Observe TDLib-owned sends without issuing a second send request. Network
//! readiness is not delivery progress, especially behind an unchanged proxy.
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    time::{Duration, Instant},
};

const SEND_GRACE: Duration = Duration::from_secs(20);
const UPLOAD_GRACE: Duration = Duration::from_secs(45);
const MAX_MESSAGES: usize = 1024;
const MAX_TERMINAL_IDS: usize = 2048;
type MessageKey = (i64, i64);

#[derive(Clone, Copy, Default)]
struct Upload {
    bytes: u64,
    complete: bool,
}

struct PendingSend {
    progress_at: Instant,
    uploads: HashMap<i64, Upload>,
}

#[derive(Default)]
pub(super) struct OutgoingWatchdog {
    messages: HashMap<MessageKey, PendingSend>,
    terminal: HashSet<MessageKey>,
    terminal_order: VecDeque<MessageKey>,
    next_recovery: Option<Instant>,
    pub(super) attempts: u32,
}

fn id(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str()?.parse().ok())
}

fn uploads(value: &Value, result: &mut HashMap<i64, Upload>, depth: usize) {
    if depth > 8 || result.len() >= 32 {
        return;
    }
    if value["@type"] == "file" {
        if let Some(file_id) = id(&value["id"]) {
            result.insert(
                file_id,
                Upload {
                    bytes: value["remote"]["uploaded_size"].as_u64().unwrap_or(0),
                    complete: value["remote"]["is_uploading_completed"] == true,
                },
            );
        }
    } else if let Some(items) = value.as_array() {
        for item in items.iter().take(32) {
            uploads(item, result, depth + 1);
        }
    } else if let Some(object) = value.as_object() {
        for item in object.values() {
            uploads(item, result, depth + 1);
        }
    }
}

impl OutgoingWatchdog {
    fn finish(&mut self, key: MessageKey, now: Instant) {
        if let Some(finished) = self.messages.remove(&key)
            && !finished.uploads.is_empty()
        {
            // Removing an upload also removes its chat-level progress clock.
            // Give texts behind it time to receive their own confirmation.
            for ((chat_id, _), pending) in &mut self.messages {
                if *chat_id == key.0 && pending.uploads.is_empty() {
                    pending.progress_at = now;
                }
            }
        }
        if self.terminal.insert(key) {
            self.terminal_order.push_back(key);
            if self.terminal_order.len() > MAX_TERMINAL_IDS {
                self.terminal
                    .remove(&self.terminal_order.pop_front().unwrap());
            }
        }
        if self.messages.is_empty() {
            self.attempts = 0;
            self.next_recovery = None;
        }
    }

    fn message(&mut self, message: &Value, now: Instant) {
        let (Some(chat_id), Some(message_id)) = (id(&message["chat_id"]), id(&message["id"]))
        else {
            return;
        };
        let key = (chat_id, message_id);
        if message["sending_state"]["@type"] != "messageSendingStatePending"
            || message["is_scheduled"] == true
        {
            if self.messages.contains_key(&key) {
                self.finish(key, now);
            }
            return;
        }
        if message["is_outgoing"] != true || self.terminal.contains(&key) {
            return;
        }
        if !self.messages.contains_key(&key) && self.messages.len() >= MAX_MESSAGES {
            // Keep the oldest outstanding work; later sends share its recovery.
            return;
        }
        let pending = self.messages.entry(key).or_insert_with(|| PendingSend {
            progress_at: now,
            uploads: HashMap::new(),
        });
        let mut files = HashMap::new();
        if message["content"]["@type"] != "messageText" {
            uploads(&message["content"], &mut files, 0);
        }
        for (file_id, upload) in files {
            if let Some(previous) = pending.uploads.get(&file_id)
                && (upload.bytes > previous.bytes || (upload.complete && !previous.complete))
            {
                pending.progress_at = now;
            }
            pending
                .uploads
                .entry(file_id)
                .and_modify(|previous| {
                    previous.bytes = previous.bytes.max(upload.bytes);
                    previous.complete |= upload.complete;
                })
                .or_insert(upload);
        }
    }

    pub(super) fn observe(&mut self, update: &Value, now: Instant) {
        match update["@type"].as_str().unwrap_or("") {
            "message" => self.message(update, now),
            "updateNewMessage" => self.message(&update["message"], now),
            "messages" | "foundChatMessages" => {
                if let Some(messages) = update["messages"].as_array() {
                    for message in messages {
                        self.message(message, now);
                    }
                }
            }
            "updateMessageSendSucceeded" | "updateMessageSendFailed" => {
                if let (Some(chat_id), Some(old_id)) = (
                    id(&update["message"]["chat_id"]),
                    id(&update["old_message_id"]),
                ) {
                    self.finish((chat_id, old_id), now);
                }
            }
            "updateDeleteMessages" if update["is_permanent"] == true => {
                if let (Some(chat_id), Some(messages)) =
                    (id(&update["chat_id"]), update["message_ids"].as_array())
                {
                    for message_id in messages.iter().filter_map(id) {
                        self.finish((chat_id, message_id), now);
                    }
                }
            }
            "updateFile" => {
                let file = &update["file"];
                if let Some(file_id) = id(&file["id"]) {
                    let bytes = file["remote"]["uploaded_size"].as_u64().unwrap_or(0);
                    let complete = file["remote"]["is_uploading_completed"] == true;
                    for pending in self.messages.values_mut() {
                        if let Some(upload) = pending.uploads.get_mut(&file_id) {
                            if bytes > upload.bytes || (complete && !upload.complete) {
                                pending.progress_at = now;
                            }
                            // Stale snapshots and download-only updates cannot
                            // move upload progress backwards and restart a clock.
                            upload.bytes = upload.bytes.max(bytes);
                            upload.complete |= complete;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    pub(super) fn stalled(&self, now: Instant) -> bool {
        if self.messages.is_empty() || self.next_recovery.is_some_and(|deadline| now < deadline) {
            return false;
        }
        // Telegram preserves send order in a chat. A text behind an active
        // upload must not keep reopening the connection during that upload.
        let mut chat_uploads: HashMap<i64, (Instant, bool)> = HashMap::new();
        for ((chat_id, _), pending) in &self.messages {
            if !pending.uploads.is_empty() {
                let uploading = pending.uploads.values().any(|upload| !upload.complete);
                chat_uploads
                    .entry(*chat_id)
                    .and_modify(|(time, active)| {
                        *time = (*time).max(pending.progress_at);
                        *active |= uploading;
                    })
                    .or_insert((pending.progress_at, uploading));
            }
        }
        self.messages.iter().any(|((chat_id, _), pending)| {
            let (progress_at, grace) = chat_uploads.get(chat_id).map_or(
                (pending.progress_at, SEND_GRACE),
                |(time, active)| {
                    (
                        pending.progress_at.max(*time),
                        if *active { UPLOAD_GRACE } else { SEND_GRACE },
                    )
                },
            );
            now.duration_since(progress_at) >= grace
        })
    }

    pub(super) fn recovering(&mut self, now: Instant) {
        self.attempts = self.attempts.saturating_add(1);
        self.next_recovery =
            Some(now + Duration::from_secs(30_u64 << self.attempts.saturating_sub(1).min(2)));
    }

    pub(super) fn count(&self) -> usize {
        self.messages.len()
    }
}
