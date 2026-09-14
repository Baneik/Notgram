mod assets;
pub(crate) mod media_stream;
mod runtime_log;
mod security;
mod tdlib_runtime;
pub(crate) mod update_delivery;

use assets::{allow_tdlib_assets, trusted_asset_roots};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use runtime_log::RuntimeLogger;
use security::{
    PreparedTextMention, PreparedUpload, prepared_chat_photo_request,
    prepared_file_request_with_topic, prepared_profile_photo_request, request_type_from_extra,
    validate_webview_extra, validate_webview_tdlib_request,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tdlib_runtime::TdJson;

const MAX_PERFORMANCE_LOG_BATCH: usize = 50;
const MAX_VISIBLE_PERFORMANCE_LOG_RECORDS: usize = 240;
const MAX_PASTED_UPLOAD_FILES: usize = 10;
const MAX_PASTED_UPLOAD_BYTES: usize = 64 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PastedUploadFile {
    name: String,
    mime_type: String,
    #[serde(default)]
    data_base64: String,
    #[serde(default)]
    blob_token: Option<String>,
    kind: String,
    width: Option<i32>,
    height: Option<i32>,
    duration: Option<i32>,
    title: Option<String>,
    performer: Option<String>,
    thumbnail: Option<PastedUploadThumbnail>,
    #[serde(default)]
    fallback: Option<PastedUploadFallback>,
    #[serde(default)]
    has_spoiler: bool,
    #[serde(default)]
    show_caption_above_media: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PastedUploadFallback {
    name: String,
    mime_type: String,
    #[serde(default)]
    data_base64: String,
    #[serde(default)]
    blob_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PastedUploadThumbnail {
    name: String,
    mime_type: String,
    #[serde(default)]
    data_base64: String,
    #[serde(default)]
    blob_token: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PastedUploadCaption {
    text: String,
    #[serde(default)]
    entities: Vec<PreparedTextMention>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PastedUploadReplyQuote {
    text: String,
    position: i32,
}
const ALLOWED_PERFORMANCE_EVENTS: &[&str] = &[
    "ui_history_data",
    "ui_history_cache_confirmation",
    "ui_history_merge",
    "ui_history_render",
    "ui_conversation_switch",
    "ui_conversation_viewport",
    "ui_conversation_trace",
    "ui_conversation_row",
    "ui_conversation_member",
    "ui_frame_drop",
    "ui_layout_shift",
    "ui_long_frame",
    "ui_long_task",
    "ui_message_projection",
    "ui_performance_log_drop",
    "ui_react_commit",
    "ui_slow_interaction",
    "ui_startup",
    "ui_tdlib_update_batch",
    "ui_visual_jitter",
    "media_playback_started",
    "media_buffering_started",
    "media_buffering_recovered",
    "media_playback_error",
    "video_window_descriptor_received",
    "video_window_initialized",
    "video_window_open_failed",
    "video_window_open_started",
];
const ALLOWED_PERFORMANCE_DETAIL_FIELDS: &[&str] = &[
    "addedCount",
    "afterCount",
    "averageFrameGapMs",
    "anchorShiftPx",
    "asyncWaitDurationMs",
    "asyncWaitCount",
    "asyncWaitFailed",
    "asyncWaitInFlight",
    "attributionCount",
    "baseDurationMs",
    "batchCount",
    "bufferedAheadMs",
    "beforeCount",
    "blockCount",
    "blockingDurationMs",
    "bottleneckDurationMs",
    "bottleneckStage",
    "cached",
    "cancelled",
    "causeDomain",
    "causeKind",
    "chatCount",
    "chatHash",
    "completedStageMask",
    "componentKind",
    "containerKind",
    "dataDurationMs",
    "domContentLoadedMs",
    "domCompleteMs",
    "domInteractiveMs",
    "durationMs",
    "duringConversationSwitch",
    "duringHistoryLoad",
    "droppedCount",
    "evidenceKind",
    "expectedFrames",
    "failed",
    "firstContentfulPaintMs",
    "firstPaintMs",
    "forcedStyleLayoutDurationMs",
    "forumCount",
    "frameBudgetMs",
    "frameGapMs",
    "pageCount",
    "purpose",
    "stopReason",
    "remainingBoundaryCount",
    "frontendWorkDurationMs",
    "fullscreen",
    "hasMore",
    "inputDelayMs",
    "interactionKind",
    "jitterMs",
    "jitterScore",
    "loadEventMs",
    "loadedCount",
    "unreadCountBucket",
    "anchorMessagePresent",
    "localCacheHit",
    "remainingCachedCount",
    "continuationPages",
    "longestMainThreadStallMs",
    "longestScriptDurationMs",
    "mainThreadBlocked",
    "mainThreadBlockedDurationMs",
    "mainThreadStallCount",
    "maxShiftScore",
    "maxFrameGapMs",
    "mediaDurationKnown",
    "mediaErrorCode",
    "mediaKind",
    "mediaNetworkState",
    "mediaReadyState",
    "messageUpdateCount",
    "chatUpdateCount",
    "fileUpdateCount",
    "otherUpdateCount",
    "pendingUpdateCount",
    "oldestUpdateAgeMs",
    "deliveryDurationMs",
    "messageCount",
    "missedFrames",
    "missingStageMask",
    "movedDistancePx",
    "navigationKind",
    "networkOnline",
    "observedAtMs",
    "pageVisible",
    "pauseDurationMs",
    "phaseKind",
    "presentationDelayMs",
    "positionDurationMs",
    "processingDurationMs",
    "projectionDurationMs",
    "reactDurationMs",
    "refreshRateHz",
    "refreshRateSource",
    "regionKind",
    "responseStartMs",
    "renderDurationMs",
    "restoreDurationMs",
    "scriptDurationMs",
    "scriptCount",
    "scriptInvokerKind",
    "scriptSourceKind",
    "scrollHeight",
    "scrollTop",
    "clientHeight",
    "viewportHeight",
    "bottomDistancePx",
    "viewportClipPx",
    "footerPresent",
    "footerGapPx",
    "footerHeight",
    "latestGapPx",
    "measuredRowErrorPx",
    "mountedRowCount",
    "ancestorScrollTop",
    "cssZoom",
    "deviceScale",
    "followLatest",
    "scrollMode",
    "bottomReconcileActive",
    "pointerActive",
    "middleAutoScroll",
    "latestRowPresent",
    "shiftScore",
    "shiftCount",
    "sourceCount",
    "sourceCharPosition",
    "sampleCount",
    "startTimeMs",
    "styleLayoutDurationMs",
    "streaming",
    "targetKind",
    "timedOut",
    "traceId",
    "traceWaitDurationMs",
    "transitionDurationMs",
    "unstableFrameCount",
    "uiStall",
    "viewTransition",
    "virtualListDurationMs",
    "visualResponseDurationMs",
    "titleUpdateDurationMs",
    "messagesVisibleDurationMs",
    "firstScreenMediaDurationMs",
    "firstScreenMediaFailed",
    "windowId",
    "windowFocused",
    "windowKind",
    "impactedAreaPx",
    "selectionDurationMs",
    "traceSession",
    "traceSeq",
    "traceTimeMs",
    "traceOriginMs",
    "traceRun",
    "traceKind",
    "triggerKind",
    "finishKind",
    "recordCount",
    "traceElapsedMs",
    "writerKind",
    "beforeTop",
    "requestedTop",
    "actualTop",
    "targetIndex",
    "alignKind",
    "smooth",
    "messageToken",
    "replyToken",
    "revisionToken",
    "contentKind",
    "mediaKind",
    "hasReply",
    "hasKeyboard",
    "hasAlbum",
    "isRemoving",
    "isLocallyDeleted",
    "textLength",
    "mediaWidth",
    "mediaHeight",
    "live",
    "isBot",
    "remote",
    "permanent",
    "fromCache",
    "immediate",
    "archiveEnabled",
    "deadlineLagMs",
    "snapshotId",
    "rowToken",
    "blockIndex",
    "itemIndex",
    "partitionToken",
    "firstMessageToken",
    "lastMessageToken",
    "knownHeight",
    "rowHeight",
    "rowTop",
    "rowWidth",
    "rowOffsetTop",
    "rowLayoutHeight",
    "transformY",
    "scaleY",
    "removingCount",
    "mappingMismatch",
    "firstItemIndex",
    "selectedRowCount",
    "expectedIndex",
    "memberCount",
    "minimumTop",
    "maximumTop",
    "minimumHeight",
    "maximumHeight",
    "minimumDistance",
    "maximumDistance",
    "reversalCount",
    "trusted",
    "inputKind",
    "direction",
    "button",
    "keyKind",
    "generation",
    "removalActive",
    "removedCount",
    "anchorActive",
    "anchorToken",
    "anchorOffset",
    "reconcileMode",
    "verificationPassCount",
    "userIntentActive",
    "smoothActive",
    "structuralChange",
    "reducedMotion",
    "resizeDelta",
    "measuredSize",
    "heightMeasurement",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PerformanceLogRecord {
    event: String,
    details: Value,
}

fn performance_thresholds(event: &str) -> (f64, f64) {
    match event {
        "ui_startup" => (1_000.0, 2_500.0),
        "ui_history_data" => (500.0, 1_500.0),
        "ui_history_cache_confirmation" => (500.0, 1_500.0),
        "ui_history_merge" => (16.0, 50.0),
        "ui_conversation_switch" => (100.0, 250.0),
        "ui_message_projection" => (8.0, 16.0),
        "ui_visual_jitter" => (6.0, 12.0),
        "ui_react_commit" | "ui_tdlib_update_batch" => (16.0, 50.0),
        "ui_performance_log_drop" => (0.0, 1.0),
        "video_window_descriptor_received"
        | "video_window_initialized"
        | "video_window_open_started" => (250.0, 1_000.0),
        "video_window_open_failed" => (0.0, 1.0),
        "media_playback_started" => (500.0, 1_500.0),
        "media_buffering_started" | "media_buffering_recovered" => (250.0, 1_000.0),
        "media_playback_error" => (0.0, 0.0),
        _ => (50.0, 100.0),
    }
}

pub(crate) fn validate_performance_record(
    event: &str,
    details: &Value,
) -> Result<&'static str, String> {
    if !ALLOWED_PERFORMANCE_EVENTS.contains(&event) {
        return Err("不支持的性能日志事件".to_string());
    }
    let Value::Object(fields) = details else {
        return Err("性能日志详情必须是对象".to_string());
    };
    if fields.len() > 48
        || fields
            .keys()
            .any(|key| !ALLOWED_PERFORMANCE_DETAIL_FIELDS.contains(&key.as_str()))
        || fields
            .values()
            .any(|value| !matches!(value, Value::Number(_) | Value::Bool(_) | Value::Null))
    {
        return Err("性能日志详情格式无效".to_string());
    }

    if event == "ui_conversation_switch"
        && fields.get("causeDomain").and_then(Value::as_f64) == Some(4.0)
    {
        if fields.get("cancelled").and_then(Value::as_bool) == Some(true) {
            return Ok("info");
        }
        if fields.get("timedOut").and_then(Value::as_bool) == Some(true) {
            return Ok("warn");
        }
    }
    if event == "ui_frame_drop" {
        return Ok(match fields.get("missedFrames").and_then(Value::as_f64) {
            Some(value) if value >= 6.0 => "error",
            Some(value) if value >= 2.0 => "warn",
            _ => "info",
        });
    }

    let measurement = if event == "ui_layout_shift" {
        fields.get("shiftScore").and_then(Value::as_f64)
    } else {
        fields.get("durationMs").and_then(Value::as_f64)
    };
    let (warning, critical) = if event == "ui_layout_shift" {
        (0.02, 0.1)
    } else {
        performance_thresholds(event)
    };
    Ok(match measurement {
        Some(value) if value >= critical => "error",
        Some(value) if value >= warning => "warn",
        _ => "info",
    })
}

struct RunningClient {
    client_id: i32,
}

struct RuntimeInner {
    engine: Option<Arc<TdJson>>,
    logger: Option<RuntimeLogger>,
    library_path: Option<PathBuf>,
    running: Option<RunningClient>,
    phase: &'static str,
    last_error: Option<String>,
}

struct RequestTracking {
    types: Arc<Mutex<HashMap<String, String>>>,
    fallbacks: Arc<Mutex<HashMap<String, Value>>>,
}

pub struct TelegramRuntime {
    inner: Mutex<RuntimeInner>,
    request_types: Arc<Mutex<HashMap<String, String>>>,
    fallback_requests: Arc<Mutex<HashMap<String, Value>>>,
}

impl TelegramRuntime {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(RuntimeInner {
                engine: None,
                logger: None,
                library_path: None,
                running: None,
                phase: "unavailable",
                last_error: None,
            }),
            request_types: Arc::new(Mutex::new(HashMap::new())),
            fallback_requests: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn prepare(&self, app: &AppHandle) {
        let mut inner = self.inner.lock().expect("telegram runtime mutex poisoned");
        if inner.logger.is_none() {
            inner.logger = RuntimeLogger::new(app).ok();
        }
        if inner.engine.is_some() {
            return;
        }

        let candidates = library_candidates(app);
        let Some(path) = candidates.into_iter().find(|path| path.is_file()) else {
            inner.phase = "unavailable";
            inner.last_error = None;
            return;
        };

        match TdJson::load(&path) {
            Ok(engine) => {
                if let Some(logger) = &inner.logger {
                    logger.write("info", "tdlib_loaded", json!({}));
                }
                inner.engine = Some(Arc::new(engine));
                inner.library_path = Some(path);
                inner.phase = "ready";
                inner.last_error = None;
            }
            Err(error) => {
                if let Some(logger) = &inner.logger {
                    logger.write("error", "tdlib_load_failed", json!({}));
                }
                inner.phase = "error";
                inner.last_error = Some(error);
            }
        }
    }

    fn start(&self, app: &AppHandle) -> Result<(), String> {
        self.prepare(app);
        let credentials = api_credentials()?;
        let configuration = TdlibConfiguration::new(app, credentials)?;
        let proxy_runtime = app.state::<crate::proxy::recovery::ProxyRuntime>();
        // Load and validate persisted intent before allocating a TDLib client.
        proxy_runtime.settings(app)?;

        let (engine, logger, client_id, stop) = {
            let mut inner = self.inner.lock().expect("telegram runtime mutex poisoned");
            if inner.running.is_some() {
                return Ok(());
            }
            let engine = inner.engine.clone().ok_or_else(|| {
                inner
                    .last_error
                    .clone()
                    .unwrap_or_else(|| "未找到 tdjson 动态库".to_string())
            })?;
            let logger = inner.logger.clone();
            let client_id = engine.create_client();
            let stop = Arc::new(AtomicBool::new(false));
            inner.running = Some(RunningClient { client_id });
            inner.phase = "running";
            (engine, logger, client_id, stop)
        };

        for request in configuration.logging_requests() {
            engine.send_value(client_id, &request)?;
        }
        proxy_runtime.attach(app, client_id)?;
        engine.send_value(
            client_id,
            &crate::proxy::recovery::initial_network_request(),
        )?;
        engine.send_value(client_id, &json!({ "@type": "getAuthorizationState" }))?;
        if let Some(logger) = &logger {
            logger.write("info", "runtime_started", json!({}));
        }

        let app_handle = app.clone();
        self.request_types
            .lock()
            .expect("request type mutex poisoned")
            .clear();
        let request_tracking = RequestTracking {
            types: Arc::clone(&self.request_types),
            fallbacks: Arc::clone(&self.fallback_requests),
        };
        thread::Builder::new()
            .name("tdlib-receive".to_string())
            .spawn(move || {
                receive_loop(
                    app_handle,
                    engine,
                    logger,
                    client_id,
                    stop,
                    configuration,
                    request_tracking,
                );
            })
            .map_err(|error| format!("无法启动 TDLib 接收线程: {error}"))?;
        Ok(())
    }

    fn send(&self, request: &Value) -> Result<(), String> {
        self.send_internal(request, None)
    }

    fn send_with_fallback(&self, request: &Value, fallback: Value) -> Result<(), String> {
        self.send_internal(request, Some(fallback))
    }

    fn send_internal(&self, request: &Value, fallback: Option<Value>) -> Result<(), String> {
        let inner = self.inner.lock().expect("telegram runtime mutex poisoned");
        let running = inner
            .running
            .as_ref()
            .ok_or_else(|| "TDLib runtime 尚未启动".to_string())?;
        let engine = inner
            .engine
            .as_ref()
            .ok_or_else(|| "tdjson 动态库尚未加载".to_string())?;
        if let Some(logger) = &inner.logger {
            logger.write(
                "debug",
                "request_sent",
                json!({ "type": request.get("@type").and_then(Value::as_str) }),
            );
        }
        let correlation = request
            .get("@extra")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let (Some(correlation), Some(request_type)) = (
            correlation.as_ref(),
            request.get("@type").and_then(Value::as_str),
        ) {
            self.request_types
                .lock()
                .expect("request type mutex poisoned")
                .insert(correlation.clone(), request_type.to_string());
            if let Some(fallback) = fallback {
                self.fallback_requests
                    .lock()
                    .expect("telegram fallback request mutex poisoned")
                    .insert(correlation.clone(), fallback);
            }
        }
        let result = engine.send_value(running.client_id, request);
        if result.is_err()
            && let Some(correlation) = correlation
        {
            self.request_types
                .lock()
                .expect("request type mutex poisoned")
                .remove(&correlation);
            self.fallback_requests
                .lock()
                .expect("telegram fallback request mutex poisoned")
                .remove(&correlation);
        }
        result
    }

    pub(crate) fn request_media_range(
        &self,
        file_id: i32,
        offset: u64,
        limit: u64,
    ) -> Result<(), String> {
        self.send(&json!({
            "@type": "downloadFile",
            "file_id": file_id,
            "priority": 32,
            "offset": offset,
            "limit": limit,
            "synchronous": false
        }))
    }

    fn shutdown(&self) -> Result<(), String> {
        {
            let mut inner = self.inner.lock().expect("telegram runtime mutex poisoned");
            let Some(running) = inner.running.as_ref() else {
                return Ok(());
            };
            let engine = inner
                .engine
                .as_ref()
                .ok_or_else(|| "tdjson 动态库尚未加载".to_string())?;
            engine.send_value(running.client_id, &json!({ "@type": "close" }))?;
            if let Some(logger) = &inner.logger {
                logger.write("info", "runtime_closing", json!({}));
            }
            inner.phase = "closing";
        }

        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if self
                .inner
                .lock()
                .expect("telegram runtime mutex poisoned")
                .running
                .is_none()
            {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(50));
        }
        Err("等待 TDLib runtime 关闭超时".to_string())
    }

    fn mark_closed(&self, client_id: i32) {
        let mut inner = self.inner.lock().expect("telegram runtime mutex poisoned");
        if inner
            .running
            .as_ref()
            .is_some_and(|running| running.client_id == client_id)
        {
            inner.running = None;
            inner.phase = "ready";
        }
        self.request_types
            .lock()
            .expect("request type mutex poisoned")
            .clear();
        self.fallback_requests
            .lock()
            .expect("telegram fallback request mutex poisoned")
            .clear();
    }

    fn status(&self, app: &AppHandle) -> TelegramRuntimeStatus {
        self.prepare(app);
        let inner = self.inner.lock().expect("telegram runtime mutex poisoned");
        TelegramRuntimeStatus {
            backend: "tdlib",
            linked: inner.engine.is_some(),
            state: inner.phase,
            credentials_configured: api_credentials().is_ok(),
            library_path: inner
                .library_path
                .as_ref()
                .map(|path| path.display().to_string()),
            searched_paths: library_candidates(app)
                .into_iter()
                .map(|path| path.display().to_string())
                .collect(),
            error: inner.last_error.clone(),
            log_path: inner
                .logger
                .as_ref()
                .map(|logger| logger.path.display().to_string()),
            performance_log_path: inner
                .logger
                .as_ref()
                .map(|logger| logger.performance_path.display().to_string()),
        }
    }

    fn log_performance_batch(&self, records: Vec<PerformanceLogRecord>) -> Result<(), String> {
        if records.is_empty() || records.len() > MAX_PERFORMANCE_LOG_BATCH {
            return Err("性能日志批次大小无效".to_string());
        }
        let records = records
            .into_iter()
            .map(|record| {
                let level = validate_performance_record(&record.event, &record.details)?;
                Ok((level.to_string(), record.event, record.details))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let logger = self
            .inner
            .lock()
            .expect("telegram runtime mutex poisoned")
            .logger
            .clone();
        if let Some(logger) = logger {
            logger.write_performance_batch(records);
        }
        Ok(())
    }

    fn log_performance(&self, event: &str, details: Value) -> Result<(), String> {
        self.log_performance_batch(vec![PerformanceLogRecord {
            event: event.to_string(),
            details,
        }])
    }

    fn read_performance_records(&self) -> Vec<Value> {
        self.inner
            .lock()
            .expect("telegram runtime mutex poisoned")
            .logger
            .clone()
            .map(|logger| logger.read_performance_records(MAX_VISIBLE_PERFORMANCE_LOG_RECORDS))
            .unwrap_or_default()
    }

    fn clear_performance_records(&self) -> Result<(), String> {
        let logger = self
            .inner
            .lock()
            .expect("telegram runtime mutex poisoned")
            .logger
            .clone();
        if let Some(logger) = logger {
            logger.clear_performance_records()?;
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramRuntimeStatus {
    backend: &'static str,
    linked: bool,
    state: &'static str,
    credentials_configured: bool,
    library_path: Option<String>,
    searched_paths: Vec<String>,
    error: Option<String>,
    log_path: Option<String>,
    performance_log_path: Option<String>,
}

#[derive(Clone)]
struct ApiCredentials {
    api_id: i32,
    api_hash: String,
}

struct TdlibConfiguration {
    credentials: ApiCredentials,
    database_directory: PathBuf,
    files_directory: PathBuf,
    database_encryption_key: String,
}

impl TdlibConfiguration {
    fn new(app: &AppHandle, credentials: ApiCredentials) -> Result<Self, String> {
        let database_directory = crate::storage::tdlib_database_directory(app)?;
        std::fs::create_dir_all(&database_directory)
            .map_err(|error| format!("无法创建 TDLib 数据库目录: {error}"))?;
        let files_directory = crate::storage::tdlib_cache_directory(app)?.join("files");
        std::fs::create_dir_all(&files_directory)
            .map_err(|error| format!("无法创建 TDLib 文件目录: {error}"))?;
        Ok(Self {
            credentials,
            database_directory,
            files_directory,
            database_encryption_key: crate::storage::database_encryption_key(app)?,
        })
    }

    fn logging_requests(&self) -> [Value; 2] {
        // Raw TDLib logs can include account and network data. Keep them disabled;
        // Notgram's structured logger above records only redacted operational events.
        [
            json!({
                "@type": "setLogStream",
                "log_stream": { "@type": "logStreamEmpty" },
                "@extra": "native:setLogStream"
            }),
            json!({
                "@type": "setLogVerbosityLevel",
                "new_verbosity_level": 0,
                "@extra": "native:setLogVerbosityLevel"
            }),
        ]
    }

    fn request(&self) -> Value {
        json!({
            "@type": "setTdlibParameters",
            "use_test_dc": env_flag("NOTGRAM_USE_TEST_DC"),
            "database_directory": self.database_directory.display().to_string(),
            "files_directory": self.files_directory.display().to_string(),
            "database_encryption_key": self.database_encryption_key,
            "use_file_database": true,
            "use_chat_info_database": true,
            "use_message_database": true,
            "use_secret_chats": true,
            "api_id": self.credentials.api_id,
            "api_hash": self.credentials.api_hash,
            "system_language_code": crate::development::environment_value("NOTGRAM_SYSTEM_LANGUAGE")
                .unwrap_or_else(|| "zh-CN".to_string()),
            "device_model": "Notgram Desktop",
            "system_version": env::consts::OS,
            "application_version": env!("CARGO_PKG_VERSION"),
            "@extra": "native:setTdlibParameters"
        })
    }
}

fn receive_loop(
    app: AppHandle,
    engine: Arc<TdJson>,
    logger: Option<RuntimeLogger>,
    client_id: i32,
    stop: Arc<AtomicBool>,
    configuration: TdlibConfiguration,
    request_tracking: RequestTracking,
) {
    let mut stats_started = Instant::now();
    let mut poll_count = 0_u64;
    let mut update_count = 0_u64;
    let mut error_count = 0_u64;
    let mut pending_updates = Vec::<Value>::new();
    let mut last_update_emit = Instant::now();
    let mut consecutive_errors = 0_u32;
    let mut next_error_emit = Instant::now();
    let mut proxy_ready = false;
    let mut tdlib_parameters_sent = false;
    let mut authorization_closing = false;
    let mut delayed_authorization_update: Option<Value> = None;
    let trusted_asset_roots = trusted_asset_roots(
        &configuration.database_directory,
        &configuration.files_directory,
    );
    let mut allowed_assets = HashSet::new();

    while !stop.load(Ordering::Acquire) {
        if pending_updates.len() >= 64 && flush_pending_updates(&app, &mut pending_updates).is_err()
        {
            // Preserve delivery on a temporary spool failure. TDLib still owns
            // unread records; never grow a second unbounded native queue.
            thread::sleep(Duration::from_millis(100));
            continue;
        }
        poll_count += 1;
        let poll_started = Instant::now();
        let receive_timeout = if pending_updates.is_empty() {
            1.0
        } else {
            0.008
        };
        match engine.receive_value(receive_timeout) {
            Ok(Some(update)) => {
                update_count += 1;
                consecutive_errors = 0;
                if update.get("@client_id").and_then(Value::as_i64) == Some(client_id as i64) {
                    app.state::<media_stream::MediaStreamRegistry>()
                        .observe_update(&update);
                    allow_tdlib_assets(
                        &app,
                        &update,
                        &trusted_asset_roots,
                        &mut allowed_assets,
                        logger.as_ref(),
                    );
                    let owned_proxy_update = app
                        .state::<crate::proxy::recovery::ProxyRuntime>()
                        .observe(client_id, &update);
                    let mut emit_update = !owned_proxy_update;
                    let request = update.get("@extra").and_then(Value::as_str);
                    let request_type = request.and_then(|correlation| {
                        request_type_from_extra(correlation)
                            .map(str::to_owned)
                            .or_else(|| {
                                request_tracking
                                    .types
                                    .lock()
                                    .expect("request type mutex poisoned")
                                    .remove(correlation)
                            })
                    });
                    let is_error = update.get("@type").and_then(Value::as_str) == Some("error");
                    if !is_error && let Some(correlation) = request {
                        request_tracking
                            .fallbacks
                            .lock()
                            .expect("telegram fallback request mutex poisoned")
                            .remove(correlation);
                    }
                    if is_error {
                        let mut fallback_sent = false;
                        let fallback = request
                            .filter(|_| request_type.as_deref() == Some("sendMessage"))
                            .and_then(|correlation| {
                                request_tracking
                                    .fallbacks
                                    .lock()
                                    .expect("telegram fallback request mutex poisoned")
                                    .remove(correlation)
                            });
                        if let (Some(correlation), Some(mut fallback_request)) = (request, fallback)
                        {
                            fallback_request["@extra"] = json!(correlation);
                            if engine.send_value(client_id, &fallback_request).is_ok() {
                                request_tracking
                                    .types
                                    .lock()
                                    .expect("request type mutex poisoned")
                                    .insert(correlation.to_string(), "sendMessage".to_string());
                                emit_update = false;
                                fallback_sent = true;
                                if let Some(logger) = &logger {
                                    logger.write(
                                        "warn",
                                        "photo_upload_fallback",
                                        json!({ "requestType": "sendMessage" }),
                                    );
                                }
                            }
                        }
                        let code = update.get("code").and_then(Value::as_i64);
                        let expected = (code == Some(404)
                            && request_type.as_deref() == Some("loadChats"))
                            || (code == Some(401) && authorization_closing);
                        if let Some(logger) = &logger
                            && !fallback_sent
                        {
                            logger.write(
                                if expected { "debug" } else { "error" },
                                if expected {
                                    "tdlib_request_ignored"
                                } else {
                                    "tdlib_request_failed"
                                },
                                json!({
                                    "code": code,
                                    "requestType": request_type.as_deref(),
                                }),
                            );
                        }
                        if request == Some("native:setTdlibParameters") {
                            let message = update
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("TDLib 参数初始化失败");
                            let _ =
                                app.emit("telegram://bridge-error", json!({ "message": message }));
                        }
                    }

                    if !proxy_ready
                        && app
                            .state::<crate::proxy::recovery::ProxyRuntime>()
                            .initialized(client_id)
                    {
                        proxy_ready = true;
                        if let Some(logger) = &logger {
                            logger.write(
                                "info",
                                "proxy_applied",
                                json!({
                                    "resultType": update.get("@type").and_then(Value::as_str),
                                }),
                            );
                        }
                        if let Some(delayed) = delayed_authorization_update.take() {
                            pending_updates.push(delayed);
                        }
                    }

                    let authorization_state = update
                        .get("authorization_state")
                        .and_then(|state| state.get("@type"))
                        .and_then(Value::as_str);

                    if matches!(
                        authorization_state,
                        Some(
                            "authorizationStateLoggingOut"
                                | "authorizationStateClosing"
                                | "authorizationStateClosed"
                        )
                    ) {
                        authorization_closing = true;
                    }

                    if let Some(state) = authorization_state
                        && let Some(logger) = &logger
                    {
                        logger.write("info", "authorization_state", json!({ "state": state }));
                    }

                    if authorization_state == Some("authorizationStateWaitTdlibParameters")
                        && !tdlib_parameters_sent
                    {
                        match engine.send_value(client_id, &configuration.request()) {
                            Ok(()) => {
                                tdlib_parameters_sent = true;
                                if let Some(logger) = &logger {
                                    logger.write(
                                        "info",
                                        "tdlib_parameters_sent",
                                        json!({ "proxyRequestQueued": true }),
                                    );
                                }
                            }
                            Err(error) => {
                                if let Some(logger) = &logger {
                                    logger.write("error", "tdlib_parameters_failed", json!({}));
                                }
                                let _ = app
                                    .emit("telegram://bridge-error", json!({ "message": error }));
                            }
                        }
                    } else if authorization_state.is_some() && !proxy_ready {
                        delayed_authorization_update = Some(update.clone());
                        emit_update = false;
                    }

                    let closed = authorization_state == Some("authorizationStateClosed");
                    if emit_update {
                        pending_updates.push(update);
                    }
                    if pending_updates.len() >= 64
                        || last_update_emit.elapsed() >= Duration::from_millis(8)
                    {
                        let _ = flush_pending_updates(&app, &mut pending_updates);
                        last_update_emit = Instant::now();
                    }
                    if closed {
                        stop.store(true, Ordering::Release);
                    }
                }
            }
            Ok(None) => {
                let had_pending_updates = !pending_updates.is_empty();
                let _ = flush_pending_updates(&app, &mut pending_updates);
                last_update_emit = Instant::now();
                consecutive_errors = 0;
                let elapsed = poll_started.elapsed();
                if !had_pending_updates && elapsed < Duration::from_millis(100) {
                    thread::sleep(Duration::from_millis(100) - elapsed);
                }
            }
            Err(error) => {
                let _ = flush_pending_updates(&app, &mut pending_updates);
                last_update_emit = Instant::now();
                error_count += 1;
                consecutive_errors = consecutive_errors.saturating_add(1);
                if let Some(logger) = &logger {
                    logger.write(
                        "error",
                        "receive_failed",
                        json!({ "consecutiveErrors": consecutive_errors }),
                    );
                }
                if Instant::now() >= next_error_emit {
                    let _ = app.emit("telegram://bridge-error", json!({ "message": error }));
                    next_error_emit = Instant::now() + Duration::from_secs(5);
                }
                let exponent = consecutive_errors.saturating_sub(1).min(5);
                let backoff_ms = (50_u64 * (1_u64 << exponent)).min(1_000);
                thread::sleep(Duration::from_millis(backoff_ms));
            }
        }

        if !authorization_closing {
            app.state::<crate::proxy::recovery::ProxyRuntime>().tick(
                &app,
                client_id,
                |request| engine.send_value(client_id, request),
                |level, event, details| {
                    if let Some(logger) = &logger {
                        logger.write(level, event, details);
                    }
                },
            );
        }

        if stats_started.elapsed() >= Duration::from_secs(60) {
            let window_seconds = stats_started.elapsed().as_secs_f64().max(1.0);
            if let Some(logger) = &logger {
                let (pending_ui, leased_ui, acknowledged_ui) = update_delivery::stats(&app);
                logger.write(
                    "info",
                    "receive_stats",
                    json!({
                        "polls": poll_count,
                        "updates": update_count,
                        "errors": error_count,
                        "pendingUiUpdates": pending_ui,
                        "inFlightUiUpdates": leased_ui,
                        "acknowledgedUiBatches": acknowledged_ui,
                        "windowSeconds": window_seconds,
                        "pollsPerSecond": (poll_count as f64 / window_seconds).round(),
                    }),
                );
            }
            stats_started = Instant::now();
            poll_count = 0;
            update_count = 0;
            error_count = 0;
        }
    }

    if let Some(logger) = &logger {
        logger.write("info", "receive_loop_stopped", json!({}));
    }
    app.state::<crate::proxy::recovery::ProxyRuntime>()
        .detach(client_id);
    app.state::<TelegramRuntime>().mark_closed(client_id);
}

fn flush_pending_updates(app: &AppHandle, updates: &mut Vec<Value>) -> Result<(), String> {
    if updates.is_empty() {
        return Ok(());
    }
    update_delivery::publish(app, updates)?;
    updates.clear();
    Ok(())
}

fn api_credentials() -> Result<ApiCredentials, String> {
    let api_id = crate::development::environment_value("NOTGRAM_API_ID")
        .or_else(|| option_env!("NOTGRAM_API_ID").map(str::to_string))
        .ok_or_else(|| "缺少 NOTGRAM_API_ID".to_string())?
        .parse::<i32>()
        .map_err(|_| "NOTGRAM_API_ID 必须是有效整数".to_string())?;
    let api_hash = crate::development::environment_value("NOTGRAM_API_HASH")
        .or_else(|| option_env!("NOTGRAM_API_HASH").map(str::to_string))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "缺少 NOTGRAM_API_HASH".to_string())?;
    Ok(ApiCredentials { api_id, api_hash })
}

fn env_flag(name: &str) -> bool {
    crate::development::environment_value(name)
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
}

fn library_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let file_name = tdjson_file_name();
    let mut candidates = Vec::new();

    if let Some(configured) = crate::development::environment_value("NOTGRAM_TDLIB_PATH") {
        let configured = PathBuf::from(configured);
        candidates.push(if configured.is_dir() {
            configured.join(file_name)
        } else {
            configured
        });
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("tdlib").join(file_name));
    }
    if let Ok(data_dir) = app.path().app_data_dir() {
        candidates.push(data_dir.join("tdlib").join(file_name));
    }
    if let Ok(executable) = env::current_exe()
        && let Some(directory) = executable.parent()
    {
        candidates.push(directory.join(file_name));
    }
    #[cfg(debug_assertions)]
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tdlib")
            .join(file_name),
    );

    candidates.dedup();
    candidates
}

#[cfg(target_os = "windows")]
fn tdjson_file_name() -> &'static str {
    "tdjson.dll"
}

#[cfg(target_os = "macos")]
fn tdjson_file_name() -> &'static str {
    "libtdjson.dylib"
}

#[cfg(all(unix, not(target_os = "macos")))]
fn tdjson_file_name() -> &'static str {
    "libtdjson.so"
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn bundled_tdjson_exports_current_json_api() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tdlib")
            .join("tdjson.dll");
        if !path.is_file() {
            eprintln!("skipping bundled TDLib export check because tdjson.dll is not present");
            return;
        }

        TdJson::load(&path).unwrap_or_else(|error| {
            panic!(
                "failed to load bundled TDLib from {}: {error}",
                path.display()
            )
        });
    }

    #[test]
    fn performance_logs_accept_only_bounded_numeric_diagnostics() {
        let runtime = TelegramRuntime::new();
        assert!(
            runtime
                .log_performance(
                    "ui_history_render",
                    json!({ "durationMs": 12.5, "addedCount": 30, "failed": false }),
                )
                .is_ok()
        );
        assert!(
            runtime
                .log_performance(
                    "ui_conversation_switch",
                    json!({
                        "durationMs": 132.0,
                        "traceId": 4,
                        "cached": true,
                        "reactDurationMs": 28.0,
                        "bottleneckStage": 4,
                        "bottleneckDurationMs": 28.0,
                        "windowKind": 1,
                    }),
                )
                .is_ok()
        );
        assert!(
            runtime
                .log_performance(
                    "media_playback_error",
                    json!({
                        "durationMs": 0,
                        "mediaKind": 1,
                        "streaming": true,
                        "mediaErrorCode": 4,
                        "mediaReadyState": 0,
                        "mediaNetworkState": 3,
                        "mediaDurationKnown": false,
                    }),
                )
                .is_ok()
        );
        assert!(
            runtime
                .log_performance("arbitrary_event", json!({ "durationMs": 1 }))
                .is_err()
        );
        assert!(
            runtime
                .log_performance("ui_history_render", json!({ "text": "message content" }))
                .is_err()
        );
        assert!(
            runtime
                .log_performance("ui_history_render", json!({ "chatId": 991 }))
                .is_err()
        );
        assert!(
            runtime
                .log_performance(
                    "ui_visual_jitter",
                    json!({
                        "durationMs": 8.0,
                        "jitterMs": 8.0,
                        "jitterScore": 0.48,
                        "unstableFrameCount": 8,
                        "sampleCount": 24,
                    }),
                )
                .is_ok()
        );
        assert!(
            runtime
                .log_performance(
                    "media_playback_started",
                    json!({ "durationMs": 720.0, "mediaKind": 1, "streaming": true }),
                )
                .is_ok()
        );
        assert_eq!(
            validate_performance_record(
                "ui_slow_interaction",
                &json!({ "startTimeMs": 50_000, "durationMs": 40 }),
            ),
            Ok("info")
        );
        assert_eq!(
            validate_performance_record(
                "ui_slow_interaction",
                &json!({ "startTimeMs": 50_000, "durationMs": 72 }),
            ),
            Ok("warn")
        );
        assert_eq!(
            validate_performance_record(
                "ui_slow_interaction",
                &json!({ "startTimeMs": 50_000, "durationMs": 120 }),
            ),
            Ok("error")
        );
        assert_eq!(
            validate_performance_record("ui_layout_shift", &json!({ "shiftScore": 0.1 })),
            Ok("error")
        );
        assert_eq!(
            validate_performance_record(
                "ui_frame_drop",
                &json!({ "durationMs": 25, "missedFrames": 2, "refreshRateHz": 120 }),
            ),
            Ok("warn")
        );
        assert_eq!(
            validate_performance_record(
                "ui_visual_jitter",
                &json!({ "durationMs": 8, "jitterScore": 0.48, "sampleCount": 24 }),
            ),
            Ok("warn")
        );
        assert_eq!(
            validate_performance_record(
                "ui_conversation_switch",
                &json!({
                    "durationMs": 8_000,
                    "timedOut": true,
                    "uiStall": false,
                    "causeDomain": 4,
                    "missingStageMask": 32,
                }),
            ),
            Ok("warn")
        );
        assert_eq!(
            validate_performance_record(
                "ui_conversation_switch",
                &json!({
                    "durationMs": 8_000,
                    "timedOut": true,
                    "uiStall": false,
                    "causeDomain": 3,
                    "asyncWaitInFlight": true,
                }),
            ),
            Ok("error")
        );
        assert_eq!(
            validate_performance_record(
                "ui_conversation_switch",
                &json!({
                    "durationMs": 500,
                    "cancelled": true,
                    "uiStall": false,
                    "causeDomain": 4,
                }),
            ),
            Ok("info")
        );
    }

    #[test]
    fn viewport_diagnostics_preserve_signed_geometry_without_message_data() {
        let geometry = json!({
            "scrollTop": 1200.5, "scrollHeight": 1901, "clientHeight": 700,
            "viewportHeight": 700.25, "bottomDistancePx": 0.5, "viewportClipPx": 18,
            "footerPresent": true, "footerGapPx": -18.5, "footerHeight": 12,
            "latestGapPx": -6.5, "measuredRowErrorPx": 0.25, "mountedRowCount": 20,
            "ancestorScrollTop": 0, "cssZoom": 1, "deviceScale": 1.25,
            "followLatest": true, "scrollMode": 0, "bottomReconcileActive": false,
            "pointerActive": false, "middleAutoScroll": false, "latestRowPresent": true
        });
        assert!(super::validate_performance_record("ui_conversation_viewport", &geometry).is_ok());
        assert!(
            super::validate_performance_record("ui_conversation_viewport", &json!({ "chatId": 1 }))
                .is_err()
        );
        assert!(
            super::validate_performance_record(
                "ui_conversation_viewport",
                &json!({ "latestGapPx": "message" })
            )
            .is_err()
        );
    }

    #[test]
    fn conversation_trace_accepts_correlated_numeric_evidence_only() {
        for (event, details) in [
            (
                "ui_conversation_trace",
                json!({
                    "traceSession": 3, "traceRun": 1, "traceSeq": 9,
                    "traceTimeMs": 123.5, "traceOriginMs": 1789095840000_u64,
                    "traceKind": 4, "writerKind": 1, "beforeTop": 20,
                    "requestedTop": 200, "actualTop": 100, "generation": 2
                }),
            ),
            (
                "ui_conversation_row",
                json!({
                    "traceSession": 3, "rowToken": 8, "partitionToken": 5,
                    "knownHeight": 10, "rowHeight": 526.1, "rowTop": -123.5,
                    "blockIndex": 5, "itemIndex": 1000005, "firstItemIndex": 1000000,
                    "mappingMismatch": true, "transformY": -20, "scaleY": 1
                }),
            ),
            (
                "ui_conversation_member",
                json!({
                    "traceSession": 3, "messageToken": 4, "rowToken": 8,
                    "contentKind": 1, "hasReply": true, "hasKeyboard": false,
                    "isRemoving": true, "expectedIndex": 5
                }),
            ),
        ] {
            assert!(super::validate_performance_record(event, &details).is_ok());
            assert!(
                super::validate_performance_record(event, &json!({ "messageId": 123 })).is_err()
            );
            assert!(
                super::validate_performance_record(event, &json!({ "messageToken": "raw-id" }))
                    .is_err()
            );
            assert!(
                super::validate_performance_record(event, &json!({ "rowToken": [1, 2] })).is_err()
            );
        }
    }

    #[test]
    fn pasted_upload_paths_isolate_repeated_file_names() {
        let cache_root = PathBuf::from(r"C:\cache\pasted-uploads");
        let first = pasted_upload_path(&cache_root, "image.png", 0);
        let second = pasted_upload_path(&cache_root, "image.png", 1);

        assert_ne!(first, second);
        assert_eq!(first.file_name(), second.file_name());
        assert_ne!(first.parent(), second.parent());
    }
}

#[tauri::command]
pub fn telegram_runtime_status(
    app: AppHandle,
    runtime: State<'_, TelegramRuntime>,
) -> TelegramRuntimeStatus {
    runtime.status(&app)
}

#[tauri::command]
pub fn telegram_start(app: AppHandle, runtime: State<'_, TelegramRuntime>) -> Result<(), String> {
    app.state::<media_stream::MediaStreamRegistry>().clear();
    runtime.start(&app)
}

#[tauri::command]
pub async fn telegram_send(
    request: Value,
    runtime: State<'_, TelegramRuntime>,
) -> Result<(), String> {
    validate_webview_tdlib_request(&request)?;
    runtime.send(&request)
}

#[tauri::command]
pub fn telegram_recover_file(
    app: AppHandle,
    file_id: i32,
    extra: String,
    runtime: State<'_, TelegramRuntime>,
    registry: State<'_, media_stream::MediaStreamRegistry>,
) -> Result<(), String> {
    validate_webview_extra(&extra)?;
    if file_id <= 0 {
        return Err("Invalid file identifier".into());
    }
    let path = registry.recovery_path(file_id)?;
    if path.exists() {
        // Never delete a real file merely because a WebView image failed to load.
        return runtime.send(&json!({"@type": "getFile", "file_id": file_id, "@extra": extra}));
    }
    let roots = [
        crate::storage::tdlib_cache_directory(&app)?.join("files"),
        crate::storage::tdlib_database_directory(&app)?,
    ];
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
        || !roots.iter().any(|root| path.starts_with(root))
    {
        return Err("Stale file is outside the active account storage".into());
    }
    runtime.send(&json!({"@type": "deleteFile", "file_id": file_id, "@extra": extra}))
}

#[tauri::command]
pub fn telegram_optimize_storage(
    categories: Vec<String>,
    older_than_days: Option<u32>,
    active_chat_id: Option<i64>,
    extra: String,
    runtime: State<'_, TelegramRuntime>,
    registry: State<'_, media_stream::MediaStreamRegistry>,
) -> Result<(), String> {
    validate_webview_extra(&extra)?;
    if categories.is_empty()
        || categories.len() > 5
        || older_than_days.is_some_and(|days| days > 3650)
    {
        return Err("Invalid storage optimization request".into());
    }
    let mut file_types = Vec::new();
    for category in categories {
        let types: &[&str] = match category.as_str() {
            "image" => &["fileTypePhoto", "fileTypeThumbnail", "fileTypeAnimation"],
            "video" => &["fileTypeVideo", "fileTypeVideoNote"],
            "audio" => &["fileTypeAudio", "fileTypeVoiceNote"],
            "document" => &["fileTypeDocument"],
            "other" => &["fileTypeUnknown"],
            _ => return Err("Invalid storage category".into()),
        };
        file_types.extend(types.iter().map(|kind| json!({"@type": kind})));
    }
    let mut excluded = registry.protected_chat_ids();
    if let Some(id) = active_chat_id {
        excluded.insert(id);
    }
    runtime.send(&json!({
        "@type": "optimizeStorage", "size": i64::MAX, "count": i32::MAX,
        "ttl": older_than_days.unwrap_or(0) as u64 * 86400, "immunity_delay": 60,
        "file_types": file_types, "chat_ids": [], "exclude_chat_ids": excluded,
        "return_deleted_file_statistics": true, "chat_limit": 0, "@extra": extra
    }))
}

#[tauri::command]
pub fn telegram_log_performance(
    app: AppHandle,
    event: String,
    details: Value,
    runtime: State<'_, TelegramRuntime>,
) -> Result<(), String> {
    runtime.prepare(&app);
    runtime.log_performance(&event, details)
}

#[tauri::command]
pub fn telegram_log_performance_batch(
    app: AppHandle,
    records: Vec<PerformanceLogRecord>,
    runtime: State<'_, TelegramRuntime>,
) -> Result<(), String> {
    runtime.prepare(&app);
    runtime.log_performance_batch(records)
}

#[tauri::command]
pub fn telegram_read_performance_records(
    app: AppHandle,
    runtime: State<'_, TelegramRuntime>,
) -> Vec<Value> {
    runtime.prepare(&app);
    runtime.read_performance_records()
}

#[tauri::command]
pub fn telegram_clear_performance_records(
    app: AppHandle,
    runtime: State<'_, TelegramRuntime>,
) -> Result<(), String> {
    runtime.prepare(&app);
    runtime.clear_performance_records()
}

#[tauri::command]
pub fn telegram_register_media_stream(
    file_id: i32,
    size: u64,
    mime_type: String,
    registry: State<'_, media_stream::MediaStreamRegistry>,
) -> Result<u64, String> {
    registry.register(file_id, size, &mime_type)?;
    Ok(registry.generation())
}

#[tauri::command]
pub fn telegram_update_media_stream(
    file_id: i32,
    current_time: f64,
    duration: f64,
    paused: bool,
    registry: State<'_, media_stream::MediaStreamRegistry>,
) -> Result<(), String> {
    registry.update_playback(file_id, current_time, duration, paused)
}

#[tauri::command]
pub fn telegram_suspend_media_stream(
    file_id: i32,
    registry: State<'_, media_stream::MediaStreamRegistry>,
) {
    registry.suspend(file_id);
}

#[tauri::command]
pub fn telegram_media_stream_status(
    file_id: i32,
    registry: State<'_, media_stream::MediaStreamRegistry>,
) -> Option<media_stream::MediaStreamStatus> {
    registry.status(file_id)
}

fn write_upload_payload(
    app: &AppHandle,
    path: &std::path::Path,
    token: Option<&str>,
    encoded: String,
    limit: usize,
) -> Result<(), String> {
    if let Some(token) = token {
        if !encoded.is_empty() {
            return Err("Upload must use either a token or inline bytes".into());
        }
        crate::storage::blobs::materialize(app, token, path, limit as u64)
    } else {
        let bytes =
            decode_pasted_upload(encoded, "Pasted file", limit.min(MAX_PASTED_UPLOAD_BYTES))?;
        fs::write(path, bytes).map_err(|e| e.to_string())
    }
}

fn pasted_upload_file_name(name: &str, index: usize) -> String {
    let basename = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let sanitized = basename
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let sanitized = sanitized.trim_matches([' ', '.']);
    if sanitized.is_empty() {
        format!("attachment-{}", index + 1)
    } else {
        sanitized.chars().take(180).collect()
    }
}

fn pasted_upload_path(cache_root: &std::path::Path, name: &str, index: usize) -> PathBuf {
    cache_root
        .join(format!("attachment-{}", index + 1))
        .join(pasted_upload_file_name(name, index))
}

fn decode_pasted_upload(
    data_base64: String,
    label: &str,
    maximum: usize,
) -> Result<Vec<u8>, String> {
    let bytes = BASE64_STANDARD
        .decode(data_base64)
        .map_err(|_| format!("{label} data is not valid base64"))?;
    if bytes.is_empty() || bytes.len() > maximum {
        return Err(format!("{label} has an invalid size"));
    }
    Ok(bytes)
}

struct SentMediaCacheGuard {
    path: PathBuf,
    keep: bool,
}

impl SentMediaCacheGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, keep: false }
    }

    fn keep(&mut self) {
        self.keep = true;
    }
}

impl Drop for SentMediaCacheGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn telegram_send_pasted_files(
    app: AppHandle,
    account_id: Option<String>,
    chat_id: i64,
    topic_id: Option<i64>,
    extra: String,
    files: Vec<PastedUploadFile>,
    caption: Option<PastedUploadCaption>,
    reply_to_message_id: Option<i64>,
    reply_quote: Option<PastedUploadReplyQuote>,
    disable_notification: bool,
    runtime: State<'_, TelegramRuntime>,
) -> Result<bool, String> {
    validate_webview_extra(&extra)?;
    let active_account = crate::storage::account::active_account_id(&app)?;
    if account_id
        .as_ref()
        .is_some_and(|account| account != &active_account)
    {
        return Err("Upload account changed".into());
    }
    let media_generation = app
        .state::<media_stream::MediaStreamRegistry>()
        .generation();
    let caption = caption.unwrap_or_default();
    if chat_id == 0
        || topic_id.is_some_and(|id| id <= 0)
        || reply_to_message_id.is_some_and(|id| id <= 0)
        || files.is_empty()
        || files.len() > MAX_PASTED_UPLOAD_FILES
    {
        return Err("Pasted uploads must contain between 1 and 10 files".to_string());
    }
    let reply_to = match (reply_to_message_id, reply_quote) {
        (Some(message_id), quote) => {
            let quote = quote
                .map(|quote| {
                    if quote.text.is_empty()
                        || quote.text.chars().count() > 1024
                        || quote.position < 0
                    {
                        return Err("Invalid reply quote".to_string());
                    }
                    Ok(json!({
                        "@type": "inputTextQuote",
                        "text": {
                            "@type": "formattedText",
                            "text": quote.text,
                            "entities": []
                        },
                        "position": quote.position,
                    }))
                })
                .transpose()?;
            Some(json!({
                "@type": "inputMessageReplyToMessage",
                "message_id": message_id,
                "quote": quote,
                "checklist_task_id": 0,
                "poll_option_id": "",
            }))
        }
        (None, Some(_)) => return Err("Reply quote requires a message target".to_string()),
        (None, None) => None,
    };
    let cache_root = crate::storage::sent_media_directory(&app)?.join(format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    fs::create_dir_all(&cache_root)
        .map_err(|error| format!("Unable to create upload cache: {error}"))?;
    let mut cache_guard = SentMediaCacheGuard::new(cache_root.clone());

    let mut prepared = Vec::with_capacity(files.len());
    let mut fallback_files = Vec::with_capacity(files.len());
    for (index, file) in files.into_iter().enumerate() {
        if file.mime_type.len() > 255 || file.mime_type.chars().any(char::is_control) {
            return Err("Invalid pasted file MIME type".to_string());
        }
        let path = pasted_upload_path(&cache_root, &file.name, index);
        fs::create_dir_all(
            path.parent()
                .ok_or_else(|| "Unable to resolve pasted upload cache directory".to_string())?,
        )
        .map_err(|error| format!("Unable to create pasted upload cache: {error}"))?;
        write_upload_payload(
            &app,
            &path,
            file.blob_token.as_deref(),
            file.data_base64.clone(),
            crate::storage::blobs::MAX_FILE_BYTES as usize,
        )?;
        let fallback_file = if let Some(fallback) = file.fallback.as_ref() {
            if fallback.mime_type.len() > 255 || fallback.mime_type.chars().any(char::is_control) {
                return Err("Invalid fallback file MIME type".to_string());
            }
            let fallback_path = cache_root
                .join(format!("fallback-{}", index + 1))
                .join(pasted_upload_file_name(&fallback.name, index));
            fs::create_dir_all(
                fallback_path.parent().ok_or_else(|| {
                    "Unable to resolve fallback upload cache directory".to_string()
                })?,
            )
            .map_err(|error| format!("Unable to create fallback upload cache: {error}"))?;
            write_upload_payload(
                &app,
                &fallback_path,
                fallback.blob_token.as_deref(),
                fallback.data_base64.clone(),
                crate::storage::blobs::MAX_FILE_BYTES as usize,
            )?;
            Some(crate::storage::prepare_upload_file(&fallback_path)?)
        } else {
            None
        };
        let thumbnail = if let Some(thumbnail) = file.thumbnail {
            if thumbnail.mime_type != "image/jpeg" && thumbnail.mime_type != "image/png" {
                return Err("Invalid media thumbnail MIME type".to_string());
            }

            let thumbnail_name = format!(
                "thumbnail-{index}-{}",
                pasted_upload_file_name(&thumbnail.name, index),
            );
            let thumbnail_path = cache_root.join(thumbnail_name);
            write_upload_payload(
                &app,
                &thumbnail_path,
                thumbnail.blob_token.as_deref(),
                thumbnail.data_base64,
                200 * 1024,
            )?;
            Some(crate::storage::prepare_upload_file(&thumbnail_path)?)
        } else {
            None
        };
        prepared.push(PreparedUpload {
            file: crate::storage::prepare_upload_file(&path)?,
            mime_type: file.mime_type,
            kind: file.kind,
            width: file.width,
            height: file.height,
            duration: file.duration,
            title: file.title,
            performer: file.performer,
            thumbnail,
            has_spoiler: file.has_spoiler,
            show_caption_above_media: file.show_caption_above_media,
        });
        fallback_files.push(fallback_file);
    }

    let mut request = if prepared.len() == 1 {
        security::prepared_upload_request_with_caption_and_topic_and_reply(
            chat_id,
            &extra,
            &prepared[0],
            &caption.text,
            &caption.entities,
            topic_id,
            reply_to.clone().unwrap_or(Value::Null),
        )?
    } else {
        security::prepared_upload_album_request_with_caption_and_topic_and_reply(
            chat_id,
            &extra,
            &prepared,
            &caption.text,
            &caption.entities,
            topic_id,
            reply_to.clone().unwrap_or(Value::Null),
        )?
    };
    let send_options = json!({
        "@type": "messageSendOptions",
        "disable_notification": disable_notification,
        "from_background": false,
        "protect_content": false,
        "update_order_of_installed_sticker_sets": false,
        "scheduling_state": null,
        "paid_message_star_count": 0
    });
    if disable_notification {
        request["options"] = send_options.clone();
    }
    let fallback_request = if fallback_files.iter().any(Option::is_some) {
        let fallback_uploads = prepared
            .iter()
            .zip(fallback_files.iter())
            .map(|(upload, fallback_file)| {
                let mut fallback_upload = upload.clone();
                if let Some(fallback_file) = fallback_file {
                    fallback_upload.file = fallback_file.clone();
                }
                fallback_upload
            })
            .collect::<Vec<_>>();
        if fallback_uploads.len() == 1 {
            Some(
                security::prepared_upload_request_with_caption_and_topic_and_reply(
                    chat_id,
                    &extra,
                    &fallback_uploads[0],
                    &caption.text,
                    &caption.entities,
                    topic_id,
                    reply_to.clone().unwrap_or(Value::Null),
                )?,
            )
        } else {
            Some(
                security::prepared_upload_album_request_with_caption_and_topic_and_reply(
                    chat_id,
                    &extra,
                    &fallback_uploads,
                    &caption.text,
                    &caption.entities,
                    topic_id,
                    reply_to.clone().unwrap_or(Value::Null),
                )?,
            )
        }
    } else {
        None
    };
    let fallback_request = fallback_request.map(|mut fallback| {
        if disable_notification {
            fallback["options"] = send_options;
        }
        fallback
    });
    if crate::storage::account::active_account_id(&app)? != active_account
        || app
            .state::<media_stream::MediaStreamRegistry>()
            .generation()
            != media_generation
    {
        return Err("Upload session changed".into());
    }
    if let Some(fallback_request) = fallback_request {
        runtime.send_with_fallback(&request, fallback_request)?;
    } else {
        runtime.send(&request)?;
    }
    cache_guard.keep();
    Ok(true)
}

#[tauri::command]
pub async fn telegram_pick_and_send_file(
    app: AppHandle,
    chat_id: i64,
    topic_id: Option<i64>,
    extra: String,
    runtime: State<'_, TelegramRuntime>,
) -> Result<bool, String> {
    validate_webview_extra(&extra)?;
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("选择要发送的文件")
        .blocking_pick_file()
    else {
        return Ok(false);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("Unable to resolve selected upload file: {error}"))?;
    let file = crate::storage::prepare_upload_file(&path)?;
    if topic_id.is_some_and(|id| id <= 0) {
        return Err("Invalid forum topic identifier".to_string());
    }
    runtime.send(&prepared_file_request_with_topic(
        chat_id, &extra, &file, topic_id,
    )?)?;
    Ok(true)
}

#[tauri::command]
pub async fn telegram_pick_profile_photo(
    app: AppHandle,
    extra: String,
    runtime: State<'_, TelegramRuntime>,
) -> Result<bool, String> {
    validate_webview_extra(&extra)?;
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("选择头像")
        .add_filter("JPEG 图像", &["jpg", "jpeg"])
        .blocking_pick_file()
    else {
        return Ok(false);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("Unable to resolve selected profile photo: {error}"))?;
    let file = crate::storage::prepare_upload_file(&path)?;
    runtime.send(&prepared_profile_photo_request(&extra, &file)?)?;
    Ok(true)
}

#[tauri::command]
pub async fn telegram_pick_chat_photo(
    app: AppHandle,
    chat_id: i64,
    extra: String,
    runtime: State<'_, TelegramRuntime>,
) -> Result<bool, String> {
    validate_webview_extra(&extra)?;
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("选择群组或频道头像")
        .add_filter("JPEG 图像", &["jpg", "jpeg"])
        .blocking_pick_file()
    else {
        return Ok(false);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("Unable to resolve selected chat photo: {error}"))?;
    let file = crate::storage::prepare_upload_file(&path)?;
    runtime.send(&prepared_chat_photo_request(chat_id, &extra, &file)?)?;
    Ok(true)
}

#[tauri::command]
pub fn telegram_shutdown(runtime: State<'_, TelegramRuntime>) -> Result<(), String> {
    runtime.shutdown()
}
