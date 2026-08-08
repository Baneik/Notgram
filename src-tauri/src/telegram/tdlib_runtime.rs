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
