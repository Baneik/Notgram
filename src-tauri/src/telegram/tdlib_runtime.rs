use libloading::Library;
use serde_json::Value;
use std::{
    ffi::{CStr, CString},
    os::raw::{c_char, c_double, c_int},
    path::Path,
};

type TdCreateClientId = unsafe extern "C" fn() -> c_int;
type TdSend = unsafe extern "C" fn(c_int, *const c_char);
type TdReceive = unsafe extern "C" fn(c_double) -> *const c_char;

/// Minimal wrapper around TDLib's dynamically loaded JSON API.
///
/// The library handle is kept alongside the function pointers so the symbols
/// remain valid for the entire lifetime of the runtime engine.
pub(crate) struct TdJson {
    _library: Library,
    create_client_id: TdCreateClientId,
    send: TdSend,
    receive: TdReceive,
}

impl TdJson {
    pub(crate) fn load(path: &Path) -> Result<Self, String> {
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

    pub(crate) fn create_client(&self) -> i32 {
        unsafe { (self.create_client_id)() }
    }

    pub(crate) fn send_value(&self, client_id: i32, request: &Value) -> Result<(), String> {
        let serialized = serde_json::to_string(request)
            .map_err(|error| format!("无法序列化 TDLib 请求: {error}"))?;
        let request =
            CString::new(serialized).map_err(|_| "TDLib 请求包含无效的空字符".to_string())?;
        unsafe { (self.send)(client_id, request.as_ptr()) };
        Ok(())
    }

    pub(crate) fn receive_value(&self, timeout: f64) -> Result<Option<Value>, String> {
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

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{Duration, Instant};

    /// Explicit opt-in smoke test: actual pinned DLL, independent client, no
    /// existing account database. Verifies the native recovery primitive
    /// reaches TDLib instead of being rejected by the Webview allowlist.
    #[test]
    #[ignore = "requires the pinned Windows TDLib runtime and local API configuration"]
    fn native_recovery_requests_reach_tdlib() {
        let dll = Path::new(env!("CARGO_MANIFEST_DIR")).join("tdlib/tdjson.dll");
        let engine = TdJson::load(&dll).expect("pinned TDLib must be available");
        crate::development::load_environment();
        let credentials =
            super::super::api_credentials().expect("local API configuration is required");
        let audit_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.native-smoke");
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = audit_root.join(format!("recovery-{stamp}"));
        std::fs::create_dir_all(&directory).unwrap();
        let client = engine.create_client();
        engine
            .send_value(
                client,
                &json!({ "@type": "setLogStream", "log_stream": { "@type": "logStreamEmpty" } }),
            )
            .unwrap();
        // TDLib defers network/proxy requests until parameters are initialized.
        // Queue a network hold and an unused loopback proxy before parameters:
        // the smoke test cannot contact an account or a Telegram endpoint.
        engine
            .send_value(client, &crate::proxy::recovery::initial_network_request())
            .unwrap();
        engine
            .send_value(
                client,
                &json!({ "@type": "addProxy", "enable": true, "comment": "isolated smoke",
            "proxy": { "@type": "proxy", "server": "127.0.0.1", "port": 1,
                "type": { "@type": "proxyTypeSocks5", "username": "", "password": "" } } }),
            )
            .unwrap();
        engine
            .send_value(
                client,
                &json!({ "@type": "setTdlibParameters",
            "database_directory": directory, "files_directory": directory.join("files"),
            "api_id": credentials.api_id, "api_hash": credentials.api_hash,
            "system_language_code": "en", "device_model": "Native recovery smoke",
            "application_version": "test", "@extra": "native:smoke:parameters" }),
            )
            .unwrap();
        let requests = [
            crate::proxy::recovery::initial_network_request(),
            crate::proxy::recovery::reopen_request(),
            json!({ "@type": "getCurrentState" }),
        ];
        for (index, mut request) in requests.into_iter().enumerate() {
            let extra = format!("native:smoke:{index}");
            request["@extra"] = json!(extra);
            engine.send_value(client, &request).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                assert!(Instant::now() < deadline, "native TDLib request timed out");
                if let Some(response) = engine.receive_value(0.1).unwrap()
                    && response["@client_id"] == client
                    && response["@extra"] == extra
                {
                    let expected = if index == 2 { "updates" } else { "ok" };
                    assert_eq!(response["@type"], expected, "native request was rejected");
                    break;
                }
            }
        }
        engine
            .send_value(client, &json!({ "@type": "close" }))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Some(update) = engine.receive_value(0.1).unwrap()
                && update["@client_id"] == client
                && update["authorization_state"]["@type"] == "authorizationStateClosed"
            {
                let root = audit_root.canonicalize().unwrap();
                let target = directory.canonicalize().unwrap();
                assert!(target.starts_with(&root) && target != root);
                std::fs::remove_dir_all(target).unwrap();
                return;
            }
        }
        panic!("isolated TDLib client did not close");
    }
}
