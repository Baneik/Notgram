use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{Client, StatusCode, header, redirect::Policy};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, time::Duration};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const MAX_BYTES: usize = 1_400_000;

#[derive(Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfig {
    enabled: bool,
    url: String,
    username: String,
    password: String,
}

#[derive(Default, Deserialize, Serialize)]
struct StoredConfig {
    #[serde(flatten)]
    config: WebDavConfig,
    generation: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSummary {
    enabled: bool,
    url: String,
    has_username: bool,
    has_password: bool,
    generation: String,
}

impl StoredConfig {
    fn summary(&self) -> WebDavSummary {
        WebDavSummary {
            enabled: self.config.enabled,
            url: self.config.url.clone(),
            has_username: !self.config.username.is_empty(),
            has_password: !self.config.password.is_empty(),
            generation: self.generation.clone(),
        }
    }
}

fn allowed_window(window: &WebviewWindow) -> Result<(), String> {
    if matches!(window.label(), "main" | "settings") {
        Ok(())
    } else {
        Err("unavailable".into())
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    crate::distribution::app_config_directory(app)
        .map(|root| root.join("settings-webdav.dat"))
        .map_err(|_| "storage".into())
}

fn read_config(app: &AppHandle) -> Result<StoredConfig, String> {
    crate::storage::persistence::read_json(&config_path(app)?, true)
        .map(|value| value.unwrap_or_default())
        .map_err(|_| "storage".into())
}

fn backup_url(value: &str) -> Result<tauri::Url, String> {
    let mut url = tauri::Url::parse(value).map_err(|_| "invalid-url")?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("invalid-url".into());
    }
    url.path_segments_mut()
        .map_err(|_| "invalid-url")?
        .pop_if_empty()
        .push("notgram-settings.txt");
    Ok(url)
}

fn validate_config(config: &WebDavConfig) -> Result<(), String> {
    if config.url.len() > 4096
        || config.username.len() > 1024
        || config.password.len() > 4096
        || config.username.contains([':', '\r', '\n', '\0'])
        || config.password.contains(['\r', '\n', '\0'])
    {
        return Err("invalid-config".into());
    }
    if config.enabled || !config.url.is_empty() {
        backup_url(&config.url)?;
    }
    Ok(())
}

#[tauri::command]
pub fn notgram_webdav_settings(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<WebDavSummary, String> {
    allowed_window(&window)?;
    Ok(read_config(&app)?.summary())
}

#[tauri::command]
pub fn notgram_webdav_edit_settings(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<WebDavConfig, String> {
    allowed_window(&window)?;
    Ok(read_config(&app)?.config)
}

#[tauri::command]
pub fn notgram_webdav_save_settings(
    app: AppHandle,
    window: WebviewWindow,
    config: WebDavConfig,
) -> Result<WebDavSummary, String> {
    allowed_window(&window)?;
    write_config(&app, config)
}

#[tauri::command]
pub fn notgram_webdav_set_enabled(
    app: AppHandle,
    window: WebviewWindow,
    enabled: bool,
) -> Result<WebDavSummary, String> {
    allowed_window(&window)?;
    let mut config = read_config(&app)?.config;
    config.enabled = enabled;
    write_config(&app, config)
}

fn write_config(app: &AppHandle, mut config: WebDavConfig) -> Result<WebDavSummary, String> {
    config.url = config.url.trim().to_string();
    validate_config(&config)?;
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "storage")?;
    let stored = StoredConfig {
        config,
        generation: STANDARD.encode(random),
    };
    crate::storage::persistence::write_json(&config_path(app)?, &stored, true)
        .map_err(|_| "storage")?;
    Ok(stored.summary())
}

#[derive(Serialize)]
pub struct WebDavResponse {
    status: u16,
    body: String,
    etag: Option<String>,
}

fn validate_backup(body: &str) -> Result<(), String> {
    if body.len() > MAX_BYTES {
        return Err("invalid-backup".into());
    }
    let bytes = STANDARD.decode(body.trim()).map_err(|_| "invalid-backup")?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "invalid-backup")?;
    if value["format"] != "notgram-settings"
        || value["version"] != 1
        || !value["preferences"].is_object()
    {
        return Err("invalid-backup".into());
    }
    Ok(())
}

async fn request(
    config: WebDavConfig,
    method: &str,
    body: Option<String>,
    etag: Option<String>,
    create: bool,
    timeout: Duration,
) -> Result<WebDavResponse, String> {
    validate_config(&config)?;
    let url = backup_url(&config.url)?;
    // Reuse the same TLS provider as the desktop updater, without pulling a second backend.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    // No redirects: authentication must never be forwarded to a different endpoint.
    let client = Client::builder()
        .timeout(timeout)
        .connect_timeout(timeout.min(Duration::from_secs(4)))
        .redirect(Policy::none());
    // Other native tests change proxy environment variables in parallel. Loopback
    // fixtures must reach their own listener independently of that process state.
    #[cfg(test)]
    let client = client.no_proxy();
    let client = client.build().map_err(|_| "network")?;
    let mut builder = match method {
        "GET" => client.get(url),
        "PUT" => {
            let body = body.ok_or("invalid-backup")?;
            validate_backup(&body)?;
            let builder = client
                .put(url)
                .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
                .body(body);
            if create {
                builder.header(header::IF_NONE_MATCH, "*")
            } else {
                let etag = etag.ok_or("missing-etag")?;
                if !etag.starts_with('"') || !etag.ends_with('"') || etag.len() > 1024 {
                    return Err("missing-etag".into());
                }
                builder.header(
                    header::IF_MATCH,
                    header::HeaderValue::from_str(&etag).map_err(|_| "missing-etag")?,
                )
            }
        }
        _ => return Err("invalid-method".into()),
    };
    if !config.username.is_empty() || !config.password.is_empty() {
        builder = builder.basic_auth(config.username, Some(config.password));
    }
    let mut response = builder.send().await.map_err(|_| "network")?;
    let status = response.status();
    let etag = response
        .headers()
        .get(header::ETAG)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 1024)
        .map(str::to_owned);
    let mut bytes = Vec::new();
    if method == "GET" && status == StatusCode::OK {
        if response
            .content_length()
            .is_some_and(|length| length > MAX_BYTES as u64)
        {
            return Err("invalid-backup".into());
        }
        while let Some(chunk) = response.chunk().await.map_err(|_| "network")? {
            if bytes.len() + chunk.len() > MAX_BYTES {
                return Err("invalid-backup".into());
            }
            bytes.extend_from_slice(&chunk);
        }
    }
    Ok(WebDavResponse {
        status: status.as_u16(),
        body: String::from_utf8(bytes).map_err(|_| "invalid-backup")?,
        etag,
    })
}

#[tauri::command]
pub async fn notgram_webdav_request(
    app: AppHandle,
    window: WebviewWindow,
    method: String,
    generation: String,
    body: Option<String>,
    etag: Option<String>,
    create: bool,
) -> Result<WebDavResponse, String> {
    allowed_window(&window)?;
    if window.label() != "main" {
        return Err("unavailable".into());
    }
    let stored = read_config(&app)?;
    if !stored.config.enabled || stored.generation != generation {
        return Err("config-changed".into());
    }
    request(
        stored.config,
        &method,
        body,
        etag,
        create,
        Duration::from_secs(10),
    )
    .await
}

#[tauri::command]
pub async fn notgram_export_settings_backup(
    app: AppHandle,
    window: WebviewWindow,
    body: String,
) -> Result<bool, String> {
    allowed_window(&window)?;
    validate_backup(&body)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(destination) = app
            .dialog()
            .file()
            .add_filter("Notgram settings", &["txt"])
            .set_file_name("notgram-settings.txt")
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = destination.into_path().map_err(|_| "storage")?;
        fs::write(path, body).map_err(|_| "storage")?;
        Ok(true)
    })
    .await
    .map_err(|_| "storage".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    #[test]
    fn resolves_only_plain_http_directories_and_preserves_escaped_paths() {
        assert_eq!(
            backup_url("https://example.com/dav/my%20folder")
                .unwrap()
                .as_str(),
            "https://example.com/dav/my%20folder/notgram-settings.txt"
        );
        assert_eq!(
            backup_url("https://example.com/dav/").unwrap().as_str(),
            "https://example.com/dav/notgram-settings.txt"
        );
        for value in [
            "file:///a",
            "https://user:pass@example.com/",
            "https://example.com/?token=a",
            "https://example.com/#a",
        ] {
            assert!(backup_url(value).is_err());
        }
    }

    fn serve(response: &'static str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/dav/", listener.local_addr().unwrap());
        let worker = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = vec![0u8; 8192];
            let size = socket.read(&mut bytes).unwrap();
            socket.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&bytes[..size]).to_string()
        });
        (url, worker)
    }

    #[test]
    fn native_webdav_get_reads_etag_and_uses_basic_auth() {
        let (url, worker) = serve(
            "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nETag: \"v1\"\r\nConnection: close\r\n\r\ndGVz",
        );
        let config = WebDavConfig {
            enabled: true,
            url,
            username: "user".into(),
            password: "secret".into(),
        };
        let result = tauri::async_runtime::block_on(request(
            config,
            "GET",
            None,
            None,
            false,
            Duration::from_secs(2),
        ))
        .unwrap();
        assert_eq!(result.status, 200);
        assert_eq!(result.body, "dGVz");
        assert_eq!(result.etag.as_deref(), Some("\"v1\""));
        let incoming = worker.join().unwrap().to_lowercase();
        assert!(incoming.starts_with("get /dav/notgram-settings.txt "));
        assert!(incoming.contains("authorization: basic dxnlcjpzzwnyzxq="));
    }

    #[test]
    fn rejects_unconditional_put_and_oversized_remote_before_reading_body() {
        let config = WebDavConfig {
            enabled: true,
            url: "http://127.0.0.1:1".into(),
            ..Default::default()
        };
        let body =
            STANDARD.encode(br#"{"format":"notgram-settings","version":1,"preferences":{}}"#);
        assert_eq!(
            tauri::async_runtime::block_on(request(
                config,
                "PUT",
                Some(body),
                None,
                false,
                Duration::from_secs(1)
            ))
            .err()
            .as_deref(),
            Some("missing-etag")
        );
        let (url, worker) =
            serve("HTTP/1.1 200 OK\r\nContent-Length: 1400001\r\nConnection: close\r\n\r\n");
        let config = WebDavConfig {
            enabled: true,
            url,
            ..Default::default()
        };
        assert_eq!(
            tauri::async_runtime::block_on(request(
                config,
                "GET",
                None,
                None,
                false,
                Duration::from_secs(1)
            ))
            .err()
            .as_deref(),
            Some("invalid-backup")
        );
        worker.join().unwrap();
    }

    #[test]
    fn conditional_uploads_preserve_precondition_failures() {
        for (create, expected) in [(true, "if-none-match: *"), (false, "if-match: \"v1\"")] {
            let (url, worker) = serve(
                "HTTP/1.1 412 Precondition Failed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            let config = WebDavConfig {
                enabled: true,
                url,
                ..Default::default()
            };
            let body = STANDARD.encode(
                br#"{"format":"notgram-settings","version":1,"preferences":{"chatFontSize":18}}"#,
            );
            let result = tauri::async_runtime::block_on(request(
                config,
                "PUT",
                Some(body),
                Some("\"v1\"".into()),
                create,
                Duration::from_secs(2),
            ))
            .unwrap();
            assert_eq!(result.status, 412);
            let incoming = worker.join().unwrap().to_lowercase();
            assert!(incoming.starts_with("put /dav/notgram-settings.txt "));
            assert!(incoming.contains(expected));
            assert!(incoming.contains("content-type: text/plain; charset=utf-8"));
        }
    }

    #[test]
    fn does_not_follow_redirects_or_return_server_error_bodies() {
        let (url, worker) = serve(
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/credentials\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecret",
        );
        let config = WebDavConfig {
            enabled: true,
            url,
            ..Default::default()
        };
        let result = tauri::async_runtime::block_on(request(
            config,
            "GET",
            None,
            None,
            false,
            Duration::from_secs(1),
        ))
        .unwrap();
        assert_eq!(result.status, 302);
        assert!(result.body.is_empty());
        worker.join().unwrap();
    }

    #[test]
    fn bounds_a_stalled_server_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let worker = thread::spawn(move || {
            let (_socket, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_millis(250));
        });
        let config = WebDavConfig {
            enabled: true,
            url,
            ..Default::default()
        };
        let started = std::time::Instant::now();
        let result = tauri::async_runtime::block_on(request(
            config,
            "GET",
            None,
            None,
            false,
            Duration::from_millis(80),
        ));
        assert_eq!(result.err().as_deref(), Some("network"));
        assert!(started.elapsed() < Duration::from_secs(2));
        worker.join().unwrap();
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn local_webdav_credentials_use_existing_windows_encrypted_persistence() {
        let path = std::env::temp_dir().join(format!(
            "notgram-webdav-test-{}-{}.dat",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let config = StoredConfig {
            config: WebDavConfig {
                enabled: true,
                url: "https://example.test/dav".into(),
                username: "test-only-user".into(),
                password: "test-only-password".into(),
            },
            generation: "one".into(),
        };
        crate::storage::persistence::write_json(&path, &config, true).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("test-only"));
        let restored: StoredConfig = crate::storage::persistence::read_json(&path, true)
            .unwrap()
            .unwrap();
        assert!(restored.config == config.config);
        let summary = serde_json::to_string(&restored.summary()).unwrap();
        assert!(!summary.contains("test-only"));
        fs::remove_file(path).unwrap();
    }
}
