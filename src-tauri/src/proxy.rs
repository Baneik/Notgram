use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
#[cfg(not(target_os = "windows"))]
use std::env;
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProxyMode {
    #[default]
    System,
    Direct,
    Custom,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProxyKind {
    #[default]
    Http,
    Socks5,
    Mtproto,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyEndpoint {
    #[serde(rename = "type")]
    pub kind: ProxyKind,
    pub server: String,
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub secret: String,
    #[serde(default)]
    pub http_only: bool,
}

impl Default for ProxyEndpoint {
    fn default() -> Self {
        Self {
            kind: ProxyKind::Http,
            server: "127.0.0.1".to_string(),
            port: 7890,
            username: String::new(),
            password: String::new(),
            secret: String::new(),
            http_only: false,
        }
    }
}

impl ProxyEndpoint {
    fn validate(&self) -> Result<(), String> {
        if self.server.trim().is_empty() {
            return Err("代理服务器不能为空".to_string());
        }
        if self.server.chars().any(char::is_whitespace) {
            return Err("代理服务器不能包含空白字符".to_string());
        }
        if self.port == 0 {
            return Err("代理端口必须在 1 到 65535 之间".to_string());
        }
        if self.kind == ProxyKind::Mtproto && self.secret.trim().is_empty() {
            return Err("MTProto 代理必须填写 secret".to_string());
        }
        Ok(())
    }

    pub fn tdlib_value(&self) -> Value {
        let proxy_type = match self.kind {
            ProxyKind::Http => json!({
                "@type": "proxyTypeHttp",
                "username": self.username,
                "password": self.password,
                "http_only": self.http_only,
            }),
            ProxyKind::Socks5 => json!({
                "@type": "proxyTypeSocks5",
                "username": self.username,
                "password": self.password,
            }),
            ProxyKind::Mtproto => json!({
                "@type": "proxyTypeMtproto",
                "secret": self.secret,
            }),
        };
        json!({
            "@type": "proxy",
            "server": self.server.trim(),
            "port": self.port,
            "type": proxy_type,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyProfile {
    pub id: String,
    pub name: String,
    pub endpoint: ProxyEndpoint,
}

impl ProxyProfile {
    fn validate(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 64
            || !self
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("代理标识无效".to_string());
        }
        let name = self.name.trim();
        if name.is_empty() || name.chars().count() > 40 {
            return Err("代理名称必须为 1 到 40 个字符".to_string());
        }
        self.endpoint.validate()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyPreferences {
    #[serde(default)]
    pub mode: ProxyMode,
    #[serde(default, skip_serializing)]
    custom: Option<ProxyEndpoint>,
    #[serde(default)]
    pub profiles: Vec<ProxyProfile>,
    #[serde(default)]
    pub active_profile_id: String,
    #[serde(default)]
    pub auto_switch: bool,
}

impl Default for ProxyPreferences {
    fn default() -> Self {
        Self {
            mode: ProxyMode::System,
            custom: None,
            profiles: vec![ProxyProfile {
                id: "proxy-1".to_string(),
                name: "代理 1".to_string(),
                endpoint: ProxyEndpoint::default(),
            }],
            active_profile_id: "proxy-1".to_string(),
            auto_switch: false,
        }
    }
}

impl ProxyPreferences {
    fn normalize(mut self) -> Result<Self, String> {
        if self.profiles.is_empty() {
            self.profiles.push(ProxyProfile {
                id: "proxy-1".to_string(),
                name: "代理 1".to_string(),
                endpoint: self.custom.take().unwrap_or_default(),
            });
        }
        if !self
            .profiles
            .iter()
            .any(|profile| profile.id == self.active_profile_id)
        {
            self.active_profile_id = self.profiles[0].id.clone();
        }
        self.custom = None;
        self.validate()?;
        Ok(self)
    }

    fn validate(&self) -> Result<(), String> {
        if self.profiles.len() > 20 {
            return Err("最多可以保存 20 个代理".to_string());
        }
        let mut ids = std::collections::HashSet::new();
        for profile in &self.profiles {
            profile.validate()?;
            if !ids.insert(&profile.id) {
                return Err("代理标识不能重复".to_string());
            }
        }
        if self.mode == ProxyMode::Custom && self.profiles.is_empty() {
            return Err("自定义模式至少需要一个代理".to_string());
        }
        if !self.profiles.is_empty()
            && !self
                .profiles
                .iter()
                .any(|profile| profile.id == self.active_profile_id)
        {
            return Err("当前代理不在代理列表中".to_string());
        }
        Ok(())
    }

    fn active_endpoint(&self) -> Option<&ProxyEndpoint> {
        self.profiles
            .iter()
            .find(|profile| profile.id == self.active_profile_id)
            .or_else(|| self.profiles.first())
            .map(|profile| &profile.endpoint)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    mode: ProxyMode,
    profiles: Vec<ProxyProfile>,
    active_profile_id: String,
    auto_switch: bool,
    system: Option<ProxyEndpoint>,
}

#[tauri::command]
pub fn telegram_proxy_settings(app: AppHandle) -> Result<ProxySettings, String> {
    let preferences = load_preferences(&app)?;
    Ok(ProxySettings {
        mode: preferences.mode,
        profiles: preferences.profiles,
        active_profile_id: preferences.active_profile_id,
        auto_switch: preferences.auto_switch,
        system: detect_system_proxy(),
    })
}

#[tauri::command]
pub fn telegram_save_proxy_settings(
    app: AppHandle,
    preferences: ProxyPreferences,
) -> Result<(), String> {
    let preferences = preferences.normalize()?;
    save_preferences(&app, &preferences)
}

pub fn startup_proxy_request(app: &AppHandle) -> Result<Value, String> {
    let preferences = load_preferences(app)?;
    let endpoint = match preferences.mode {
        ProxyMode::System => detect_system_proxy(),
        ProxyMode::Direct => None,
        ProxyMode::Custom => preferences.active_endpoint().cloned(),
    };

    Ok(match endpoint {
        Some(endpoint) => json!({
            "@type": "addProxy",
            "proxy": endpoint.tdlib_value(),
            "enable": true,
            "comment": "Notgram",
            "@extra": "native:applyProxy",
        }),
        None => json!({
            "@type": "disableProxy",
            "@extra": "native:applyProxy",
        }),
    })
}

fn preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法解析应用配置目录: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建应用配置目录 {}: {error}", directory.display()))?;
    Ok(directory.join("proxy-settings.dat"))
}

fn load_preferences(app: &AppHandle) -> Result<ProxyPreferences, String> {
    let path = preferences_path(app)?;
    if !path.is_file() {
        return Ok(ProxyPreferences::default());
    }
    let protected =
        fs::read(&path).map_err(|error| format!("无法读取代理设置 {}: {error}", path.display()))?;
    let serialized = unprotect(&protected)?;
    let preferences: ProxyPreferences = serde_json::from_slice(&serialized)
        .map_err(|error| format!("无法解析代理设置: {error}"))?;
    preferences.normalize()
}

fn save_preferences(app: &AppHandle, preferences: &ProxyPreferences) -> Result<(), String> {
    let path = preferences_path(app)?;
    let serialized =
        serde_json::to_vec(preferences).map_err(|error| format!("无法序列化代理设置: {error}"))?;
    let protected = protect(&serialized)?;
    fs::write(&path, protected)
        .map_err(|error| format!("无法保存代理设置 {}: {error}", path.display()))
}

#[cfg(target_os = "windows")]
fn detect_system_proxy() -> Option<ProxyEndpoint> {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    let enabled = key.get_value::<u32, _>("ProxyEnable").unwrap_or(0) != 0;
    if !enabled {
        return None;
    }
    let value = key.get_value::<String, _>("ProxyServer").ok()?;
    parse_proxy_server(&value)
}

#[cfg(not(target_os = "windows"))]
fn detect_system_proxy() -> Option<ProxyEndpoint> {
    ["ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY"]
        .into_iter()
        .find_map(|name| {
            env::var(name)
                .ok()
                .and_then(|value| parse_proxy_server(&value))
        })
}

fn parse_proxy_server(value: &str) -> Option<ProxyEndpoint> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }

    let mut selected_kind = ProxyKind::Http;
    let mut address = value;
    if value.contains('=') {
        let entries: Vec<(&str, &str)> = value
            .split(';')
            .filter_map(|entry| entry.split_once('='))
            .map(|(key, address)| (key.trim(), address.trim()))
            .collect();
        if let Some((_, found)) = entries.iter().find(|(key, _)| {
            key.eq_ignore_ascii_case("socks") || key.eq_ignore_ascii_case("socks5")
        }) {
            selected_kind = ProxyKind::Socks5;
            address = found;
        } else if let Some((_, found)) = entries
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("https"))
            .or_else(|| {
                entries
                    .iter()
                    .find(|(key, _)| key.eq_ignore_ascii_case("http"))
            })
        {
            address = found;
        } else {
            return None;
        }
    }

    if let Some((scheme, remainder)) = address.split_once("://") {
        address = remainder;
        if scheme.eq_ignore_ascii_case("socks") || scheme.eq_ignore_ascii_case("socks5") {
            selected_kind = ProxyKind::Socks5;
        }
    }
    let address = address.rsplit('@').next().unwrap_or(address);
    let (server, port) = address.rsplit_once(':')?;
    let server = server.trim().trim_matches(['[', ']']);
    let port = port.trim().parse::<u16>().ok()?;
    if server.is_empty() || port == 0 {
        return None;
    }
    Some(ProxyEndpoint {
        kind: selected_kind,
        server: server.to_string(),
        port,
        ..ProxyEndpoint::default()
    })
}

#[cfg(target_os = "windows")]
pub(crate) fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    use std::{ptr, slice};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData},
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: data
            .len()
            .try_into()
            .map_err(|_| "受保护的本地数据过大".to_string())?,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let success = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 {
        return Err(format!(
            "Windows 无法加密本地数据: {}",
            std::io::Error::last_os_error()
        ));
    }
    let protected =
        unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(protected)
}

#[cfg(target_os = "windows")]
pub(crate) fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    use std::{ptr, slice};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
        },
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: data
            .len()
            .try_into()
            .map_err(|_| "受保护的本地数据过大".to_string())?,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let success = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 {
        return Err(format!(
            "Windows 无法解密本地数据: {}",
            std::io::Error::last_os_error()
        ));
    }
    let unprotected =
        unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(unprotected)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_windows_proxy() {
        let proxy = parse_proxy_server("127.0.0.1:7897").expect("proxy");
        assert_eq!(proxy.kind, ProxyKind::Http);
        assert_eq!(proxy.server, "127.0.0.1");
        assert_eq!(proxy.port, 7897);
    }

    #[test]
    fn prefers_socks_from_protocol_map() {
        let proxy = parse_proxy_server("http=127.0.0.1:8080;socks=localhost:1080").expect("proxy");
        assert_eq!(proxy.kind, ProxyKind::Socks5);
        assert_eq!(proxy.server, "localhost");
        assert_eq!(proxy.port, 1080);
    }

    #[test]
    fn migrates_the_legacy_single_proxy_preferences() {
        let preferences: ProxyPreferences = serde_json::from_value(json!({
            "mode": "custom",
            "custom": {
                "type": "socks5",
                "server": "127.0.0.1",
                "port": 1080,
                "username": "demo",
                "password": "secret",
                "secret": "",
                "httpOnly": false
            }
        }))
        .expect("legacy preferences");

        let migrated = preferences.normalize().expect("normalized preferences");

        assert_eq!(migrated.profiles.len(), 1);
        assert_eq!(migrated.active_profile_id, "proxy-1");
        assert_eq!(migrated.profiles[0].endpoint.kind, ProxyKind::Socks5);
        assert_eq!(migrated.profiles[0].endpoint.password, "secret");
    }

    #[test]
    fn rejects_duplicate_proxy_profile_ids() {
        let profile = ProxyProfile {
            id: "duplicate".to_string(),
            name: "主代理".to_string(),
            endpoint: ProxyEndpoint::default(),
        };
        let preferences = ProxyPreferences {
            mode: ProxyMode::Custom,
            custom: None,
            profiles: vec![profile.clone(), profile],
            active_profile_id: "duplicate".to_string(),
            auto_switch: true,
        };

        assert_eq!(preferences.validate(), Err("代理标识不能重复".to_string()));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn protects_proxy_preferences_for_current_windows_user() {
        let serialized = br#"{"mode":"custom","password":"secret"}"#;
        let protected = protect(serialized).expect("protect");
        assert_ne!(protected, serialized);
        assert_eq!(unprotect(&protected).expect("unprotect"), serialized);
    }
}
