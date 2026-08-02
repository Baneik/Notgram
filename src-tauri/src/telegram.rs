mod assets;
pub(crate) mod media_stream;
mod runtime_log;
mod security;

use assets::{allow_tdlib_assets, trusted_asset_roots};
use libloading::Library;
use runtime_log::RuntimeLogger;
use security::{
    prepared_file_request, request_type_from_extra, validate_webview_extra,
    validate_webview_tdlib_request,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    env,
    ffi::{CStr, CString},
    os::raw::{c_char, c_double, c_int},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

type TdCreateClientId = unsafe extern "C" fn() -> c_int;
type TdSend = unsafe extern "C" fn(c_int, *const c_char);
type TdReceive = unsafe extern "C" fn(c_double) -> *const c_char;

struct TdJson {
    _library: Library,
    create_client_id: TdCreateClientId,
    send: TdSend,
    receive: TdReceive,
}

impl TdJson {
    fn load(path: &Path) -> Result<Self, String> {
        let path = path
            .canonicalize()
            .map_err(|error| format!("无法解析 {}: {error}", path.display()))?;
        let library = unsafe { load_library(&path) }
            .map_err(|error| format!("无法加载 {}: {error}", path.display()))?;
        let create_client_id = unsafe {
            *library
                .get::<TdCreateClientId>(b"td_create_client_id\0")
                .map_err(|error| format!("缺少 td_create_client_id: {error}"))?
        };
        let send = unsafe {
            *library
                .get::<TdSend>(b"td_send\0")
                .map_err(|error| format!("缺少 td_send: {error}"))?
        };
        let receive = unsafe {
            *library
                .get::<TdReceive>(b"td_receive\0")
                .map_err(|error| format!("缺少 td_receive: {error}"))?
        };

        Ok(Self {
            _library: library,
            create_client_id,
            send,
            receive,
        })
    }

    fn create_client(&self) -> i32 {
        unsafe { (self.create_client_id)() }
    }

    fn send_value(&self, client_id: i32, request: &Value) -> Result<(), String> {
        let serialized = serde_json::to_string(request)
            .map_err(|error| format!("无法序列化 TDLib 请求: {error}"))?;
        let request =
            CString::new(serialized).map_err(|_| "TDLib 请求包含无效的空字符".to_string())?;
        unsafe { (self.send)(client_id, request.as_ptr()) };
        Ok(())
    }

    fn receive_value(&self, timeout: f64) -> Result<Option<Value>, String> {
        let result = unsafe { (self.receive)(timeout) };
        if result.is_null() {
            return Ok(None);
        }

        let json = unsafe { CStr::from_ptr(result) }
            .to_str()
            .map_err(|error| format!("TDLib 返回了无效 UTF-8: {error}"))?
            .to_owned();
        serde_json::from_str(&json)
            .map(Some)
            .map_err(|error| format!("无法解析 TDLib 更新: {error}"))
    }
}

#[cfg(target_os = "windows")]
unsafe fn load_library(path: &Path) -> Result<Library, libloading::Error> {
    use libloading::os::windows::{
        LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
        Library as WindowsLibrary,
    };

    let flags = LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS;
    let library = unsafe { WindowsLibrary::load_with_flags(path, flags) }?;
    Ok(library.into())
}

#[cfg(not(target_os = "windows"))]
unsafe fn load_library(path: &Path) -> Result<Library, libloading::Error> {
    unsafe { Library::new(path) }
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

pub struct TelegramRuntime {
    inner: Mutex<RuntimeInner>,
    request_types: Arc<Mutex<HashMap<String, String>>>,
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
        let proxy_request = crate::proxy::startup_proxy_request(app)?;

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
        engine.send_value(client_id, &proxy_request)?;
        engine.send_value(client_id, &json!({ "@type": "getAuthorizationState" }))?;
        if let Some(logger) = &logger {
            logger.write("info", "runtime_started", json!({}));
        }

        let app_handle = app.clone();
        self.request_types
            .lock()
            .expect("request type mutex poisoned")
            .clear();
        let request_types = Arc::clone(&self.request_types);
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
                    request_types,
                );
            })
            .map_err(|error| format!("无法启动 TDLib 接收线程: {error}"))?;
        Ok(())
    }

    fn send(&self, request: &Value) -> Result<(), String> {
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
        }
        let result = engine.send_value(running.client_id, request);
        if result.is_err()
            && let Some(correlation) = correlation
        {
            self.request_types
                .lock()
                .expect("request type mutex poisoned")
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
        }
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
            "system_language_code": env::var("NOTGRAM_SYSTEM_LANGUAGE")
                .unwrap_or_else(|_| "zh-CN".to_string()),
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
    request_types: Arc<Mutex<HashMap<String, String>>>,
) {
    let mut stats_started = Instant::now();
    let mut poll_count = 0_u64;
    let mut update_count = 0_u64;
    let mut error_count = 0_u64;
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
        poll_count += 1;
        let poll_started = Instant::now();
        match engine.receive_value(1.0) {
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
                    let mut emit_update = true;
                    let request = update.get("@extra").and_then(Value::as_str);
                    let request_type = request.and_then(|correlation| {
                        request_type_from_extra(correlation)
                            .map(str::to_owned)
                            .or_else(|| {
                                request_types
                                    .lock()
                                    .expect("request type mutex poisoned")
                                    .remove(correlation)
                            })
                    });
                    if update.get("@type").and_then(Value::as_str) == Some("error") {
                        let code = update.get("code").and_then(Value::as_i64);
                        let expected = (code == Some(404)
                            && request_type.as_deref() == Some("loadChats"))
                            || (code == Some(401) && authorization_closing);
                        if let Some(logger) = &logger {
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
                        if request == Some("native:applyProxy") {
                            let message = update
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("TDLib 代理初始化失败");
                            let _ =
                                app.emit("telegram://bridge-error", json!({ "message": message }));
                        }
                    }

                    if update.get("@extra").and_then(Value::as_str) == Some("native:applyProxy")
                        && update.get("@type").and_then(Value::as_str) != Some("error")
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
                            let _ = app.emit("telegram://update", delayed);
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
                        let _ = app.emit("telegram://update", &update);
                    }
                    if closed {
                        stop.store(true, Ordering::Release);
                    }
                }
            }
            Ok(None) => {
                consecutive_errors = 0;
                let elapsed = poll_started.elapsed();
                if elapsed < Duration::from_millis(100) {
                    thread::sleep(Duration::from_millis(100) - elapsed);
                }
            }
            Err(error) => {
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

        if stats_started.elapsed() >= Duration::from_secs(60) {
            let window_seconds = stats_started.elapsed().as_secs_f64().max(1.0);
            if let Some(logger) = &logger {
                logger.write(
                    "info",
                    "receive_stats",
                    json!({
                        "polls": poll_count,
                        "updates": update_count,
                        "errors": error_count,
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
    app.state::<TelegramRuntime>().mark_closed(client_id);
}

fn api_credentials() -> Result<ApiCredentials, String> {
    let api_id = env::var("NOTGRAM_API_ID")
        .ok()
        .or_else(|| option_env!("NOTGRAM_API_ID").map(str::to_string))
        .ok_or_else(|| "缺少 NOTGRAM_API_ID".to_string())?
        .parse::<i32>()
        .map_err(|_| "NOTGRAM_API_ID 必须是有效整数".to_string())?;
    let api_hash = env::var("NOTGRAM_API_HASH")
        .ok()
        .or_else(|| option_env!("NOTGRAM_API_HASH").map(str::to_string))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "缺少 NOTGRAM_API_HASH".to_string())?;
    Ok(ApiCredentials { api_id, api_hash })
}

fn env_flag(name: &str) -> bool {
    env::var(name)
        .is_ok_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
}

fn library_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let file_name = tdjson_file_name();
    let mut candidates = Vec::new();

    if let Ok(configured) = env::var("NOTGRAM_TDLIB_PATH") {
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
pub fn telegram_send(request: Value, runtime: State<'_, TelegramRuntime>) -> Result<(), String> {
    validate_webview_tdlib_request(&request)?;
    runtime.send(&request)
}

#[tauri::command]
pub fn telegram_register_media_stream(
    file_id: i32,
    size: u64,
    mime_type: String,
    registry: State<'_, media_stream::MediaStreamRegistry>,
) -> Result<(), String> {
    registry.register(file_id, size, &mime_type)
}

#[tauri::command]
pub async fn telegram_pick_and_send_file(
    app: AppHandle,
    chat_id: i64,
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
    runtime.send(&prepared_file_request(chat_id, &extra, &file)?)?;
    Ok(true)
}

#[tauri::command]
pub fn telegram_shutdown(runtime: State<'_, TelegramRuntime>) -> Result<(), String> {
    runtime.shutdown()
}
