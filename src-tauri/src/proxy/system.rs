use super::{ProxyEndpoint, parse_proxy_server};
use serde::Serialize;

/// Discovery failure is different from an explicit DIRECT configuration.
/// No PAC URLs, credentials, or registry contents are included in the status.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SystemProxy {
    Disabled,
    Resolved { endpoint: ProxyEndpoint },
    Unavailable,
    Unsupported,
}

fn resolve_configuration(proxy: Option<&str>, automatic: bool) -> SystemProxy {
    if let Some(value) = proxy.filter(|value| !value.trim().is_empty()) {
        return parse_proxy_server(value)
            .map(|endpoint| SystemProxy::Resolved { endpoint })
            .unwrap_or(SystemProxy::Unsupported);
    }
    if automatic {
        SystemProxy::Unsupported
    } else {
        SystemProxy::Disabled
    }
}

#[cfg(target_os = "windows")]
pub fn detect_system_proxy() -> SystemProxy {
    use windows_sys::Win32::{
        Foundation::GlobalFree,
        Networking::WinHttp::{
            WINHTTP_CURRENT_USER_IE_PROXY_CONFIG, WinHttpGetIEProxyConfigForCurrentUser,
        },
    };
    // WinHTTP returns the current user's active connection settings, including
    // the distinction between a static proxy, PAC/WPAD, and disabled proxying.
    let mut config: WINHTTP_CURRENT_USER_IE_PROXY_CONFIG = unsafe { std::mem::zeroed() };
    let success = unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut config) };
    let proxy = if config.lpszProxy.is_null() {
        None
    } else {
        let mut len = 0;
        unsafe {
            while *config.lpszProxy.add(len) != 0 {
                len += 1;
            }
            Some(String::from_utf16_lossy(std::slice::from_raw_parts(
                config.lpszProxy,
                len,
            )))
        }
    };
    let automatic = config.fAutoDetect != 0 || !config.lpszAutoConfigUrl.is_null();
    for pointer in [
        config.lpszProxy,
        config.lpszProxyBypass,
        config.lpszAutoConfigUrl,
    ] {
        if !pointer.is_null() {
            unsafe {
                GlobalFree(pointer.cast());
            }
        }
    }
    if success == 0 {
        SystemProxy::Unavailable
    } else {
        resolve_configuration(proxy.as_deref(), automatic)
    }
}

#[cfg(not(target_os = "windows"))]
pub fn detect_system_proxy() -> SystemProxy {
    let value = ["ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY"]
        .into_iter()
        .find_map(|key| {
            std::env::var(key)
                .ok()
                .filter(|value| !value.trim().is_empty())
        });
    resolve_configuration(value.as_deref(), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_disabled_automatic_and_invalid_configuration() {
        assert_eq!(resolve_configuration(None, false), SystemProxy::Disabled);
        assert_eq!(resolve_configuration(None, true), SystemProxy::Unsupported);
        assert_eq!(
            resolve_configuration(Some("bad-value"), false),
            SystemProxy::Unsupported
        );
        assert!(matches!(
            resolve_configuration(Some("127.0.0.1:7890"), true),
            SystemProxy::Resolved { .. }
        ));
    }

    #[test]
    fn rejects_unsupported_schemes_and_credentials_instead_of_silently_dropping_them() {
        for value in [
            "https://localhost:8080",
            "http://user:password@localhost:8080",
            "localhost:0",
            "local host:8080",
        ] {
            assert_eq!(
                resolve_configuration(Some(value), false),
                SystemProxy::Unsupported
            );
        }
        assert!(matches!(
            resolve_configuration(Some("http://[::1]:7890"), false),
            SystemProxy::Resolved { .. }
        ));
    }
}
