//! One recovery owner per native client. Webviews submit intent, never TDLib
//! proxy mutations. All deadlines and acknowledgements live outside Webview2.
use super::{
    ProxyEndpoint, ProxyMode, ProxyPreferences, ProxySettings, SystemProxy, detect_system_proxy,
    load_preferences, proxy_request, save_preferences,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};

const CONNECT_GRACE: Duration = Duration::from_secs(20);
const SYNC_GRACE: Duration = Duration::from_secs(90);
const DISCOVERY_INTERVAL: Duration = Duration::from_secs(5);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const READY: &str = "connectionStateReady";
const CONNECTING: &str = "connectionStateConnecting";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSnapshot {
    #[serde(rename = "@type")]
    kind: &'static str,
    state: String,
    phase: &'static str,
    error: Option<&'static str>,
    error_code: Option<i64>,
    attempt: u32,
    retry_delay_seconds: u64,
    revision: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Stage {
    Apply,
    Reopen,
    Probe,
    Snapshot,
}

impl Stage {
    fn name(self) -> &'static str {
        match self {
            Self::Apply => "apply",
            Self::Reopen => "reopen",
            Self::Probe => "probe",
            Self::Snapshot => "snapshot",
        }
    }
}

struct Pending {
    extra: String,
    revision: u64,
    stage: Stage,
    deadline: Instant,
}

struct Coordinator {
    preferences: ProxyPreferences,
    revision: u64,
    system: SystemProxy,
    last_system: Option<ProxyEndpoint>,
    runtime_profile: String,
    client_id: Option<i32>,
    initialized: bool,
    applied_revision: Option<u64>,
    pending: Option<Pending>,
    queued: Option<Stage>,
    sequence: u64,
    state: String,
    phase: &'static str,
    error: Option<&'static str>,
    error_code: Option<i64>,
    attempt: u32,
    next_attempt: Instant,
    retry_delay: Duration,
    last_discovery: Instant,
    last_tick: Instant,
    last_signal: Option<Instant>,
    verified: bool,
    last_published: Option<ConnectionSnapshot>,
}

impl Coordinator {
    fn new(preferences: ProxyPreferences, now: Instant) -> Self {
        Self {
            runtime_profile: preferences.active_profile_id.clone(),
            preferences,
            revision: 1,
            system: SystemProxy::Unavailable,
            last_system: None,
            client_id: None,
            initialized: false,
            applied_revision: None,
            pending: None,
            queued: None,
            sequence: 0,
            state: CONNECTING.into(),
            phase: "recovering",
            error: None,
            error_code: None,
            attempt: 0,
            next_attempt: now,
            retry_delay: Duration::ZERO,
            last_discovery: now,
            last_tick: now,
            last_signal: None,
            verified: false,
            last_published: None,
        }
    }

    fn attach(&mut self, client_id: i32, now: Instant) {
        self.client_id = Some(client_id);
        self.initialized = false;
        self.applied_revision = None;
        self.pending = None;
        self.queued = None;
        self.state = CONNECTING.into();
        self.phase = "initializing";
        self.error = None;
        self.error_code = None;
        self.runtime_profile = self.preferences.active_profile_id.clone();
        self.attempt = 0;
        self.next_attempt = now;
        self.last_tick = now;
        self.last_signal = None;
        self.last_published = None;
        self.verified = false;
    }

    fn update_system(&mut self, system: SystemProxy, now: Instant) -> bool {
        self.last_discovery = now;
        if self.system == system {
            return false;
        }
        let previous_endpoint = self.endpoint();
        if let SystemProxy::Resolved { endpoint } = &system {
            self.last_system = Some(endpoint.clone());
        } else if system == SystemProxy::Disabled {
            self.last_system = None;
        }
        self.system = system;
        if self.preferences.mode == ProxyMode::System && self.endpoint() != previous_endpoint {
            self.revision += 1;
            self.invalidate(now);
        }
        true
    }

    fn replace_preferences(&mut self, preferences: ProxyPreferences, now: Instant) {
        self.runtime_profile = preferences.active_profile_id.clone();
        self.preferences = preferences;
        self.revision += 1;
        self.invalidate(now);
    }

    fn invalidate(&mut self, now: Instant) {
        // Keep an outstanding request until acknowledgement/timeout. TDLib sees
        // old and new mutations in order; stale acknowledgements never commit.
        self.queued = None;
        self.phase = "recovering";
        self.error = None;
        self.error_code = None;
        self.attempt = 0;
        self.next_attempt = now;
        self.retry_delay = Duration::ZERO;
        self.verified = false;
    }

    fn endpoint(&self) -> Result<Option<ProxyEndpoint>, &'static str> {
        match self.preferences.mode {
            ProxyMode::Direct => Ok(None),
            ProxyMode::Custom => self
                .preferences
                .profiles
                .iter()
                .find(|profile| profile.id == self.runtime_profile)
                .or_else(|| self.preferences.profiles.first())
                .map(|profile| Some(profile.endpoint.clone()))
                .ok_or("invalidConfiguration"),
            ProxyMode::System => match &self.system {
                SystemProxy::Disabled => Ok(None),
                SystemProxy::Resolved { endpoint } => Ok(Some(endpoint.clone())),
                SystemProxy::Unavailable | SystemProxy::Unsupported => {
                    self.last_system.clone().map(Some).ok_or(
                        if self.system == SystemProxy::Unsupported {
                            "unsupportedSystemProxy"
                        } else {
                            "systemProxyUnavailable"
                        },
                    )
                }
            },
        }
    }

    fn signal(&mut self, force: bool, now: Instant) {
        if !force && self.state == READY && self.phase == "idle" {
            return;
        }
        if self
            .last_signal
            .is_some_and(|last| now.duration_since(last) < Duration::from_secs(10))
        {
            return;
        }
        self.last_signal = Some(now);
        // Coalesce wake/focus/online from all windows into the current attempt.
        if self.pending.is_some() || self.queued.is_some() {
            return;
        }
        self.next_attempt = now;
        self.phase = "recovering";
        self.verified = false;
    }

    fn fail(&mut self, error: &'static str, now: Instant) {
        self.pending = None;
        self.queued = None;
        self.phase = "recovering";
        self.error = Some(error);
        self.error_code = None;
        self.retry_delay =
            Duration::from_secs((15_u64 << self.attempt.saturating_sub(1).min(2)).min(60));
        self.next_attempt = now + self.retry_delay;
    }

    fn connected(&mut self, now: Instant) {
        self.state = READY.into();
        self.phase = "idle";
        self.error = None;
        self.error_code = None;
        self.attempt = 0;
        self.retry_delay = Duration::ZERO;
        self.pending = None;
        self.queued = None;
        self.next_attempt = now + CONNECT_GRACE;
        self.verified = true;
    }

    fn observe(&mut self, update: &Value, now: Instant) -> bool {
        let extra = update.get("@extra").and_then(Value::as_str).unwrap_or("");
        if extra.starts_with("native:proxy:") {
            if !self
                .pending
                .as_ref()
                .is_some_and(|pending| pending.extra == extra)
            {
                return true;
            }
            let pending = self.pending.take().expect("matching pending request");
            if pending.revision != self.revision {
                self.next_attempt = now;
                return true;
            }
            if update["@type"] == "error" {
                self.fail(
                    match pending.stage {
                        Stage::Apply => "proxyApplyFailed",
                        Stage::Reopen => "networkReopenFailed",
                        Stage::Probe => "telegramProbeFailed",
                        Stage::Snapshot => "stateReadFailed",
                    },
                    now,
                );
                self.error_code = update["code"].as_i64();
                if pending.stage == Stage::Apply && self.error_code == Some(400) {
                    self.phase = "configurationError";
                }
                return true;
            }
            match pending.stage {
                Stage::Apply => {
                    self.initialized = true;
                    self.applied_revision = Some(self.revision);
                    self.queued = Some(Stage::Reopen);
                }
                Stage::Reopen => self.queued = Some(Stage::Probe),
                Stage::Probe => self.queued = Some(Stage::Snapshot),
                Stage::Snapshot => {
                    let ready = update["updates"].as_array().is_some_and(|updates| {
                        updates.iter().any(|u| {
                            u["@type"] == "updateConnectionState" && u["state"]["@type"] == READY
                        })
                    });
                    if ready {
                        self.connected(now);
                    } else {
                        self.fail("connectionNotReady", now);
                    }
                }
            }
            return true;
        }
        if update["@type"] != "updateConnectionState" {
            return false;
        }
        let Some(state) = update["state"]["@type"].as_str() else {
            return false;
        };
        let previous = std::mem::replace(&mut self.state, state.to_string());
        // An old READY while applying/reopening is not evidence for the new
        // route. A fresh transition after reopen, or probe + snapshot, is.
        let can_verify = self
            .pending
            .as_ref()
            .is_none_or(|p| matches!(p.stage, Stage::Probe | Stage::Snapshot))
            && self
                .queued
                .is_none_or(|s| matches!(s, Stage::Probe | Stage::Snapshot));
        if state == READY && self.applied_revision == Some(self.revision) && can_verify {
            self.connected(now);
        } else if previous == READY && state != READY && self.phase == "idle" {
            self.verified = false;
            self.next_attempt = now
                + if state == "connectionStateUpdating" {
                    SYNC_GRACE
                } else {
                    CONNECT_GRACE
                };
        }
        false
    }

    fn next_request(&mut self, now: Instant) -> Option<Value> {
        self.client_id?;
        if self.pending.as_ref().is_some_and(|p| now >= p.deadline) {
            if self
                .pending
                .as_ref()
                .is_some_and(|p| p.revision != self.revision)
            {
                self.pending = None;
                self.next_attempt = now;
            } else {
                self.fail("requestTimeout", now);
            }
        }
        if self.pending.is_some() {
            return None;
        }
        let stage = if let Some(stage) = self.queued.take() {
            stage
        } else {
            if (self.state == READY && self.phase == "idle") || now < self.next_attempt {
                return None;
            }
            if let Err(error) = self.endpoint() {
                self.phase = "configurationError";
                self.error = Some(error);
                self.next_attempt = now + DISCOVERY_INTERVAL;
                return None;
            }
            // Rotate only after completed, unsuccessful attempts; wake signals
            // alone never change the selected proxy.
            if self.attempt > 0
                && self.attempt.is_multiple_of(2)
                && self.preferences.mode == ProxyMode::Custom
                && self.preferences.auto_switch
                && self.preferences.profiles.len() > 1
            {
                let index = self
                    .preferences
                    .profiles
                    .iter()
                    .position(|p| p.id == self.runtime_profile)
                    .unwrap_or(0);
                self.runtime_profile = self.preferences.profiles
                    [(index + 1) % self.preferences.profiles.len()]
                .id
                .clone();
                self.applied_revision = None;
            }
            self.attempt = self.attempt.saturating_add(1);
            self.phase = if !self.initialized && self.attempt == 1 {
                "initializing"
            } else {
                "recovering"
            };
            self.error = None;
            self.error_code = None;
            self.retry_delay = Duration::ZERO;
            if self.applied_revision != Some(self.revision) {
                Stage::Apply
            } else {
                Stage::Reopen
            }
        };
        let mut request = match stage {
            Stage::Apply => proxy_request(self.endpoint().ok()?.as_ref()),
            Stage::Reopen => reopen_request(),
            Stage::Probe => {
                json!({ "@type": "pingProxy", "proxy": self.endpoint().ok()?.map(|e| e.tdlib_value()) })
            }
            Stage::Snapshot => json!({ "@type": "getCurrentState" }),
        };
        self.sequence += 1;
        let extra = format!(
            "native:proxy:{}:{}:{}",
            self.revision,
            self.sequence,
            stage.name()
        );
        request["@extra"] = json!(extra);
        self.pending = Some(Pending {
            extra,
            revision: self.revision,
            stage,
            deadline: now
                + if stage == Stage::Probe {
                    PROBE_TIMEOUT
                } else {
                    COMMAND_TIMEOUT
                },
        });
        Some(request)
    }

    fn snapshot(&self) -> ConnectionSnapshot {
        ConnectionSnapshot {
            kind: "updateNotgramConnectionState",
            state: self.state.clone(),
            phase: self.phase,
            error: self.error,
            error_code: self.error_code,
            attempt: self.attempt,
            retry_delay_seconds: self.retry_delay.as_secs(),
            revision: self.revision,
        }
    }
}

pub(crate) fn reopen_request() -> Value {
    json!({ "@type": "setNetworkType", "type": { "@type": "networkTypeOther" } })
}

/// Pause initial connections until a proxy or an explicit DIRECT is applied.
pub(crate) fn initial_network_request() -> Value {
    json!({ "@type": "setNetworkType", "type": { "@type": "networkTypeNone" }, "@extra": "native:networkHold" })
}

#[derive(Default)]
pub struct ProxyRuntime(Mutex<Option<Coordinator>>);

impl ProxyRuntime {
    fn initialize<'a>(
        slot: &'a mut Option<Coordinator>,
        app: &AppHandle,
    ) -> Result<&'a mut Coordinator, String> {
        if slot.is_none() {
            let mut state = Coordinator::new(load_preferences(app)?, Instant::now());
            state.update_system(detect_system_proxy(), Instant::now());
            *slot = Some(state);
        }
        Ok(slot.as_mut().expect("initialized proxy coordinator"))
    }

    pub fn settings(&self, app: &AppHandle) -> Result<ProxySettings, String> {
        let mut guard = self.0.lock().expect("proxy runtime mutex poisoned");
        let state = Self::initialize(&mut guard, app)?;
        state.update_system(detect_system_proxy(), Instant::now());
        Ok(ProxySettings {
            mode: state.preferences.mode.clone(),
            profiles: state.preferences.profiles.clone(),
            active_profile_id: state.preferences.active_profile_id.clone(),
            auto_switch: state.preferences.auto_switch,
            system: match &state.system {
                SystemProxy::Resolved { endpoint } => Some(endpoint.clone()),
                _ => state.last_system.clone(),
            },
            system_status: state.system.clone(),
            revision: state.revision,
            runtime_profile_id: (state.preferences.mode == ProxyMode::Custom)
                .then(|| state.runtime_profile.clone()),
        })
    }

    pub fn save(
        &self,
        app: &AppHandle,
        preferences: ProxyPreferences,
        revision: Option<u64>,
    ) -> Result<(), String> {
        let mut guard = self.0.lock().expect("proxy runtime mutex poisoned");
        let state = Self::initialize(&mut guard, app)?;
        if state.preferences == preferences {
            return Ok(());
        }
        if revision.is_some_and(|revision| revision != state.revision) {
            return Err("代理设置已变化，请重新打开设置后再保存".into());
        }
        // Persist intent first. A disk error leaves the active route untouched.
        save_preferences(app, &preferences)?;
        state.replace_preferences(preferences, Instant::now());
        let _ = app.emit(
            "telegram://proxy-settings-changed",
            json!({ "revision": state.revision }),
        );
        Ok(())
    }

    pub(crate) fn attach(&self, app: &AppHandle, client_id: i32) -> Result<(), String> {
        let mut guard = self.0.lock().expect("proxy runtime mutex poisoned");
        Self::initialize(&mut guard, app)?.attach(client_id, Instant::now());
        Ok(())
    }

    pub(crate) fn observe(&self, client_id: i32, update: &Value) -> bool {
        let mut guard = self.0.lock().expect("proxy runtime mutex poisoned");
        let Some(state) = guard.as_mut().filter(|s| s.client_id == Some(client_id)) else {
            return false;
        };
        state.observe(update, Instant::now())
    }

    pub(crate) fn initialized(&self, client_id: i32) -> bool {
        self.0
            .lock()
            .expect("proxy runtime mutex poisoned")
            .as_ref()
            .is_some_and(|s| s.client_id == Some(client_id) && s.initialized)
    }

    pub(crate) fn detach(&self, client_id: i32) {
        let mut guard = self.0.lock().expect("proxy runtime mutex poisoned");
        if let Some(state) = guard.as_mut().filter(|s| s.client_id == Some(client_id)) {
            state.client_id = None;
            state.pending = None;
            state.queued = None;
        }
    }

    pub(crate) fn tick(
        &self,
        app: &AppHandle,
        client_id: i32,
        mut send: impl FnMut(&Value) -> Result<(), String>,
        mut log: impl FnMut(&str, &str, Value),
    ) {
        let now = Instant::now();
        let mut guard = self.0.lock().expect("proxy runtime mutex poisoned");
        let Some(state) = guard.as_mut().filter(|s| s.client_id == Some(client_id)) else {
            return;
        };
        if now.duration_since(state.last_discovery) >= DISCOVERY_INTERVAL
            && state.update_system(detect_system_proxy(), now)
        {
            let _ = app.emit(
                "telegram://proxy-settings-changed",
                json!({ "revision": state.revision }),
            );
        }
        if now.duration_since(state.last_tick) >= Duration::from_secs(25) {
            state.signal(true, now);
        }
        state.last_tick = now;
        if let Some(request) = state.next_request(now) {
            log(
                "info",
                "proxy_recovery_request",
                json!({ "requestType": request["@type"], "revision": state.revision, "attempt": state.attempt }),
            );
            if send(&request).is_err() {
                state.fail("nativeSendFailed", now);
            }
        }
        if state.verified
            && state.preferences.mode == ProxyMode::Custom
            && state.preferences.active_profile_id != state.runtime_profile
        {
            let mut preferences = state.preferences.clone();
            preferences.active_profile_id = state.runtime_profile.clone();
            match save_preferences(app, &preferences) {
                Ok(()) => {
                    state.preferences = preferences;
                    state.revision += 1;
                    state.applied_revision = Some(state.revision);
                    let _ = app.emit(
                        "telegram://proxy-settings-changed",
                        json!({ "revision": state.revision }),
                    );
                }
                Err(_) => log("error", "proxy_preferences_save_failed", json!({})),
            }
            state.verified = false;
        }
        let snapshot = state.snapshot();
        if state.last_published.as_ref() != Some(&snapshot) {
            log(
                if snapshot.error.is_some() {
                    "warn"
                } else {
                    "info"
                },
                "proxy_connection_state",
                json!(snapshot),
            );
            let _ = app.emit("telegram://update", &snapshot);
            state.last_published = Some(snapshot);
        }
    }
}

#[tauri::command]
pub fn telegram_recover_connection(
    runtime: State<'_, ProxyRuntime>,
    force: bool,
) -> Result<(), String> {
    let mut guard = runtime.0.lock().expect("proxy runtime mutex poisoned");
    let state = guard
        .as_mut()
        .filter(|s| s.client_id.is_some())
        .ok_or("TDLib runtime 尚未启动")?;
    state.signal(force, Instant::now());
    Ok(())
}

#[tauri::command]
pub fn telegram_connection_state(
    runtime: State<'_, ProxyRuntime>,
) -> Result<ConnectionSnapshot, String> {
    let guard = runtime.0.lock().expect("proxy runtime mutex poisoned");
    guard
        .as_ref()
        .map(Coordinator::snapshot)
        .ok_or_else(|| "TDLib runtime 尚未启动".into())
}

#[cfg(test)]
mod tests;
