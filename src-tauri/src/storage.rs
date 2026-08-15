pub(crate) mod account;
mod cache;
mod database_key;
pub(crate) mod file_actions;

use account::{account_cache_directory, account_database_directory, active_account_id};
use cache::{
    cache_paths_modified_after, cache_usage, cached_asset_paths, canonical_paths_within_root,
    clear_cache_files, protected_cache_paths,
};
pub use database_key::database_encryption_key;
pub use file_actions::prepare_upload_file;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoragePreferences {
    #[serde(default)]
    pub cache_path: String,
    #[serde(default)]
    pub download_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSettings {
    pub cache_path: String,
    pub download_path: String,
    pub default_cache_path: String,
    pub default_download_path: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UploadFileInfo {
    pub path: String,
    pub size: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CacheCategory {
    Image,
    Video,
    Audio,
    Document,
    Other,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CacheUsageItem {
    pub bytes: u64,
    pub files: u64,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CacheUsage {
    pub total: CacheUsageItem,
    pub images: CacheUsageItem,
    pub videos: CacheUsageItem,
    pub audio: CacheUsageItem,
    pub documents: CacheUsageItem,
    pub other: CacheUsageItem,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheCleanupRequest {
    pub categories: Vec<CacheCategory>,
    pub older_than_days: Option<u32>,
    #[serde(default)]
    pub protected_paths: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CacheCleanupResult {
    pub removed_bytes: u64,
    pub removed_files: u64,
    pub skipped_protected_files: u64,
    pub failed_files: u64,
    pub usage: CacheUsage,
}

const SENT_MEDIA_PROTECTION_DURATION: Duration = Duration::from_secs(7 * 86_400);
const MAX_STAGED_SNAPSHOT_WRITES: usize = 2;
const MAX_SNAPSHOT_CHUNK_ITEMS: usize = 64;

#[derive(Default)]
pub struct SnapshotCacheWriteState {
    writes: Mutex<HashMap<String, Map<String, Value>>>,
}

impl SnapshotCacheWriteState {
    fn begin(&self, transaction_id: &str, header: Value) -> Result<(), String> {
        if transaction_id.is_empty()
            || transaction_id.len() > 64
            || !transaction_id
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || value == b'-')
        {
            return Err("Invalid UI cache transaction id".to_string());
        }
        let snapshot = header
            .as_object()
            .cloned()
            .ok_or_else(|| "UI cache header must be an object".to_string())?;
        let mut writes = self
            .writes
            .lock()
            .map_err(|_| "UI cache staging lock is unavailable".to_string())?;
        if !writes.contains_key(transaction_id) && writes.len() >= MAX_STAGED_SNAPSHOT_WRITES {
            return Err("Too many staged UI cache writes".to_string());
        }
        writes.insert(transaction_id.to_string(), snapshot);
        Ok(())
    }

    fn append(
        &self,
        transaction_id: &str,
        section: &str,
        values: Vec<Value>,
    ) -> Result<(), String> {
        if values.len() > MAX_SNAPSHOT_CHUNK_ITEMS {
            return Err("UI cache chunk is too large".to_string());
        }
        let mut writes = self
            .writes
            .lock()
            .map_err(|_| "UI cache staging lock is unavailable".to_string())?;
        let snapshot = writes
            .get_mut(transaction_id)
            .ok_or_else(|| "UI cache transaction was not started".to_string())?;
        let target = snapshot
            .get_mut(section)
            .and_then(Value::as_array_mut)
            .ok_or_else(|| "UI cache section is not an array".to_string())?;
        target.extend(values);
        Ok(())
    }

    fn take(&self, transaction_id: &str) -> Result<Value, String> {
        self.writes
            .lock()
            .map_err(|_| "UI cache staging lock is unavailable".to_string())?
            .remove(transaction_id)
            .map(Value::Object)
            .ok_or_else(|| "UI cache transaction was not started".to_string())
    }

    fn abort(&self, transaction_id: &str) -> Result<(), String> {
        self.writes
            .lock()
            .map_err(|_| "UI cache staging lock is unavailable".to_string())?
            .remove(transaction_id);
        Ok(())
    }

    fn clear(&self) -> Result<(), String> {
        self.writes
            .lock()
            .map_err(|_| "UI cache staging lock is unavailable".to_string())?
            .clear();
        Ok(())
    }
}

#[tauri::command]
pub fn telegram_storage_settings(app: AppHandle) -> Result<StorageSettings, String> {
    storage_settings(&app)
}

#[tauri::command]
pub fn telegram_save_storage_settings(
    app: AppHandle,
    preferences: StoragePreferences,
) -> Result<StorageSettings, String> {
    let configured = configured_preferences(&app, preferences)?;
    let resolved = resolve_preferences(&app, configured.clone())?;
    create_storage_directories(&resolved)?;
    save_preferences(&app, &configured)?;
    settings_from_preferences(&app, configured)
}

#[tauri::command]
pub fn telegram_cache_usage(app: AppHandle) -> Result<CacheUsage, String> {
    cache_usage(&trusted_tdlib_files_directory(&app)?)
}

#[tauri::command]
pub fn telegram_clear_media_cache(
    app: AppHandle,
    request: CacheCleanupRequest,
    registry: State<'_, crate::telegram::media_stream::MediaStreamRegistry>,
) -> Result<CacheCleanupResult, String> {
    if request.categories.is_empty() {
        return Err("Select at least one cache category".to_string());
    }
    if request.categories.len() > 5 || request.protected_paths.len() > 20_000 {
        return Err("Cache cleanup request is too large".to_string());
    }
    if request.older_than_days.is_some_and(|days| days > 3_650) {
        return Err("Cache retention period is out of range".to_string());
    }

    let root = trusted_tdlib_files_directory(&app)?;
    let mut protected = protected_cache_paths(&root, &request.protected_paths);
    if let Some(snapshot) = read_snapshot_cache_value(&app)? {
        protected.extend(cached_asset_paths(&snapshot, std::slice::from_ref(&root)));
    }
    protected.extend(canonical_paths_within_root(
        &root,
        registry.protected_paths().into_iter(),
    ));
    let sent_media = sent_media_directory(&app)?;
    let sent_media_cutoff = SystemTime::now().checked_sub(SENT_MEDIA_PROTECTION_DURATION);
    if let Some(cutoff) = sent_media_cutoff {
        protected.extend(cache_paths_modified_after(&sent_media, cutoff)?);
    }
    let modified_before = request.older_than_days.and_then(|days| {
        SystemTime::now().checked_sub(Duration::from_secs(u64::from(days) * 86_400))
    });
    let result = clear_cache_files(
        &root,
        &request.categories.into_iter().collect(),
        modified_before,
        &protected,
    )?;
    if let Some(cutoff) = sent_media_cutoff {
        remove_empty_sent_media_directories(&sent_media, cutoff);
    }
    Ok(result)
}

fn remove_empty_sent_media_directories(root: &Path, modified_before: SystemTime) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let old_enough = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| modified <= modified_before);
        if file_type.is_dir() && !file_type.is_symlink() && old_enough {
            let _ = fs::remove_dir(entry.path());
        }
    }
}

#[tauri::command]
pub async fn telegram_read_snapshot_cache(app: AppHandle) -> Result<Option<Value>, String> {
    let worker_app = app.clone();
    let snapshot =
        tauri::async_runtime::spawn_blocking(move || read_snapshot_cache_value(&worker_app))
            .await
            .map_err(|error| format!("Unable to join UI cache reader: {error}"))??;
    if let Some(snapshot) = &snapshot {
        authorize_snapshot_assets(&app, snapshot)?;
    }
    Ok(snapshot)
}

fn read_snapshot_cache_value(app: &AppHandle) -> Result<Option<Value>, String> {
    let path = snapshot_cache_path(app)?;
    let backup = path.with_extension("bak");
    let readable_path = if path.is_file() {
        path
    } else if backup.is_file() {
        backup
    } else {
        return Ok(None);
    };
    let protected = fs::read(&readable_path).map_err(|error| {
        format!(
            "Unable to read UI cache {}: {error}",
            readable_path.display()
        )
    })?;
    let serialized = crate::proxy::unprotect(&protected)?;
    let snapshot: Value = serde_json::from_slice(&serialized)
        .map_err(|error| format!("Unable to parse UI cache: {error}"))?;
    Ok(Some(snapshot))
}

#[tauri::command]
pub async fn telegram_write_snapshot_cache(app: AppHandle, snapshot: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_snapshot_cache_value(&app, snapshot))
        .await
        .map_err(|error| format!("Unable to join UI cache writer: {error}"))?
}

#[tauri::command]
pub fn telegram_begin_snapshot_cache_write(
    state: State<'_, SnapshotCacheWriteState>,
    transaction_id: String,
    header: Value,
) -> Result<(), String> {
    state.begin(&transaction_id, header)
}

#[tauri::command]
pub fn telegram_append_snapshot_cache_chunk(
    state: State<'_, SnapshotCacheWriteState>,
    transaction_id: String,
    section: String,
    values: Vec<Value>,
) -> Result<(), String> {
    state.append(&transaction_id, &section, values)
}

#[tauri::command]
pub async fn telegram_commit_snapshot_cache_write(
    app: AppHandle,
    state: State<'_, SnapshotCacheWriteState>,
    transaction_id: String,
) -> Result<(), String> {
    let snapshot = state.take(&transaction_id)?;
    tauri::async_runtime::spawn_blocking(move || write_snapshot_cache_value(&app, snapshot))
        .await
        .map_err(|error| format!("Unable to join UI cache writer: {error}"))?
}

#[tauri::command]
pub fn telegram_abort_snapshot_cache_write(
    state: State<'_, SnapshotCacheWriteState>,
    transaction_id: String,
) -> Result<(), String> {
    state.abort(&transaction_id)
}

fn write_snapshot_cache_value(app: &AppHandle, snapshot: Value) -> Result<(), String> {
    let path = snapshot_cache_path(app)?;
    let temporary = path.with_extension("tmp");
    let backup = path.with_extension("bak");
    let serialized = serde_json::to_vec(&snapshot)
        .map_err(|error| format!("Unable to serialize UI cache: {error}"))?;
    let protected = crate::proxy::protect(&serialized)?;
    let mut file = fs::File::create(&temporary)
        .map_err(|error| format!("Unable to create UI cache {}: {error}", temporary.display()))?;
    file.write_all(&protected)
        .map_err(|error| format!("Unable to write UI cache {}: {error}", temporary.display()))?;
    file.sync_all()
        .map_err(|error| format!("Unable to flush UI cache {}: {error}", temporary.display()))?;

    if backup.exists() {
        fs::remove_file(&backup).map_err(|error| {
            format!(
                "Unable to remove old UI cache backup {}: {error}",
                backup.display()
            )
        })?;
    }
    if path.exists() {
        fs::rename(&path, &backup)
            .map_err(|error| format!("Unable to rotate UI cache {}: {error}", path.display()))?;
    }
    if let Err(error) = fs::rename(&temporary, &path) {
        if backup.exists() {
            let _ = fs::rename(&backup, &path);
        }
        return Err(format!(
            "Unable to replace UI cache {}: {error}",
            path.display()
        ));
    }
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

#[tauri::command]
pub fn telegram_clear_snapshot_cache(
    app: AppHandle,
    state: State<'_, SnapshotCacheWriteState>,
) -> Result<(), String> {
    state.clear()?;
    let path = snapshot_cache_path(&app)?;
    let temporary = path.with_extension("tmp");
    let backup = path.with_extension("bak");
    for candidate in [&path, &temporary, &backup] {
        if candidate.exists() {
            fs::remove_file(candidate).map_err(|error| {
                format!("Unable to remove UI cache {}: {error}", candidate.display())
            })?;
        }
    }
    Ok(())
}

pub fn tdlib_cache_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let preferences = load_preferences(app)?;
    let resolved = resolve_preferences(app, preferences)?;
    let directory = account_cache_directory(
        PathBuf::from(&resolved.cache_path),
        &active_account_id(app)?,
    );
    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "Unable to create cache directory {}: {error}",
            directory.display()
        )
    })?;
    Ok(directory)
}

pub fn tdlib_database_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve app data directory: {error}"))?
        .join("tdlib");
    Ok(account_database_directory(root, &active_account_id(app)?))
}

pub fn download_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let preferences = load_preferences(app)?;
    let resolved = resolve_preferences(app, preferences)?;
    fs::create_dir_all(&resolved.download_path).map_err(|error| {
        format!(
            "Unable to create download directory {}: {error}",
            resolved.download_path
        )
    })?;
    Ok(PathBuf::from(resolved.download_path))
}

pub(crate) fn trusted_tdlib_files_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = tdlib_cache_directory(app)?.join("files");
    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "Unable to create trusted TDLib files directory {}: {error}",
            directory.display()
        )
    })?;
    directory
        .canonicalize()
        .map_err(|error| format!("Unable to resolve trusted TDLib files directory: {error}"))
}

pub(crate) fn sent_media_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = trusted_tdlib_files_directory(app)?.join(".notgram-sent-media");
    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "Unable to create sent media directory {}: {error}",
            directory.display()
        )
    })?;
    directory
        .canonicalize()
        .map_err(|error| format!("Unable to resolve sent media directory: {error}"))
}

fn snapshot_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(tdlib_cache_directory(app)?.join("notgram-ui-cache.dat"))
}

fn authorize_snapshot_assets(app: &AppHandle, snapshot: &Value) -> Result<(), String> {
    let roots = [tdlib_cache_directory(app)?, tdlib_database_directory(app)?]
        .into_iter()
        .filter_map(|path| path.canonicalize().ok())
        .collect::<Vec<_>>();

    for path in cached_asset_paths(snapshot, &roots) {
        app.asset_protocol_scope()
            .allow_file(&path)
            .map_err(|error| format!("Unable to authorize a cached TDLib asset: {error}"))?;
    }
    Ok(())
}

fn storage_settings(app: &AppHandle) -> Result<StorageSettings, String> {
    let preferences = configured_preferences(app, load_preferences(app)?)?;
    let resolved = resolve_preferences(app, preferences.clone())?;
    create_storage_directories(&resolved)?;
    settings_from_preferences(app, preferences)
}

fn settings_from_preferences(
    app: &AppHandle,
    preferences: StoragePreferences,
) -> Result<StorageSettings, String> {
    Ok(StorageSettings {
        cache_path: preferences.cache_path,
        download_path: preferences.download_path,
        default_cache_path: default_cache_path_template(app),
        default_download_path: default_download_path_template(),
    })
}

fn configured_preferences(
    app: &AppHandle,
    preferences: StoragePreferences,
) -> Result<StoragePreferences, String> {
    let default_cache_template = default_cache_path_template(app);
    let default_download_template = default_download_path_template();
    let cache_path = configured_path(
        &preferences.cache_path,
        &default_cache_template,
        &[default_cache_path(app)?],
    )?;
    let download_path = configured_path(
        &preferences.download_path,
        &default_download_template,
        &[
            default_download_path()?,
            program_directory()?.join("downloads"),
        ],
    )?;
    Ok(StoragePreferences {
        cache_path,
        download_path,
    })
}

fn configured_path(
    value: &str,
    default_template: &str,
    legacy_defaults: &[PathBuf],
) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(default_template.to_string());
    }
    let expanded = normalize_path(trimmed, PathBuf::new())?;
    if legacy_defaults
        .iter()
        .any(|legacy| paths_equal(Path::new(&expanded), legacy))
    {
        return Ok(default_template.to_string());
    }
    Ok(trimmed.to_string())
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

fn resolve_preferences(
    app: &AppHandle,
    preferences: StoragePreferences,
) -> Result<StoragePreferences, String> {
    Ok(StoragePreferences {
        cache_path: normalize_path(&preferences.cache_path, default_cache_path(app)?)?,
        download_path: normalize_path(&preferences.download_path, default_download_path()?)?,
    })
}

fn normalize_path(value: &str, default_path: PathBuf) -> Result<String, String> {
    let trimmed = value.trim();
    let expanded = if trimmed.is_empty() {
        default_path.display().to_string()
    } else {
        expand_environment_variables(trimmed)?
    };
    let path = if expanded.is_empty() {
        default_path
    } else {
        let configured = PathBuf::from(expanded);
        if configured.is_absolute() {
            configured
        } else {
            program_directory()?.join(configured)
        }
    };
    Ok(path.display().to_string())
}

fn expand_environment_variables(value: &str) -> Result<String, String> {
    expand_environment_variables_from(value, |name| env::var(name).ok())
}

fn expand_environment_variables_from(
    value: &str,
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<String, String> {
    let mut expanded = String::with_capacity(value.len());
    let mut remaining = value;
    while let Some(start) = remaining.find('%') {
        expanded.push_str(&remaining[..start]);
        let after_start = &remaining[start + 1..];
        let Some(end) = after_start.find('%') else {
            expanded.push_str(&remaining[start..]);
            return Ok(expanded);
        };
        let name = &after_start[..end];
        if name.is_empty()
            || !name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            expanded.push('%');
            remaining = after_start;
            continue;
        }
        let replacement =
            lookup(name).ok_or_else(|| format!("Environment variable %{name}% is unavailable"))?;
        expanded.push_str(&replacement);
        remaining = &after_start[end + 1..];
    }
    expanded.push_str(remaining);
    Ok(expanded)
}

fn create_storage_directories(preferences: &StoragePreferences) -> Result<(), String> {
    create_directory(&preferences.cache_path, "cache")?;
    create_directory(&preferences.download_path, "download")
}

fn create_directory(path: &str, label: &str) -> Result<(), String> {
    let path = PathBuf::from(path);
    if path.is_file() {
        return Err(format!(
            "The configured {label} path is a file, not a directory: {}",
            path.display()
        ));
    }
    fs::create_dir_all(&path).map_err(|error| {
        format!(
            "Unable to create {label} directory {}: {error}",
            path.display()
        )
    })
}

fn preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Unable to resolve app config directory: {error}"))?;
    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "Unable to create app config directory {}: {error}",
            directory.display()
        )
    })?;
    Ok(directory.join("storage-settings.json"))
}

fn load_preferences(app: &AppHandle) -> Result<StoragePreferences, String> {
    let path = preferences_path(app)?;
    if !path.is_file() {
        return Ok(StoragePreferences {
            cache_path: String::new(),
            download_path: String::new(),
        });
    }
    let serialized = fs::read(&path).map_err(|error| {
        format!(
            "Unable to read storage settings {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_slice(&serialized)
        .map_err(|error| format!("Unable to parse storage settings: {error}"))
}

fn save_preferences(app: &AppHandle, preferences: &StoragePreferences) -> Result<(), String> {
    let path = preferences_path(app)?;
    let serialized = serde_json::to_vec_pretty(preferences)
        .map_err(|error| format!("Unable to serialize storage settings: {error}"))?;
    fs::write(&path, serialized).map_err(|error| {
        format!(
            "Unable to save storage settings {}: {error}",
            path.display()
        )
    })
}

fn default_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(PathBuf::from(expand_environment_variables(
        &default_cache_path_template(app),
    )?))
}

fn default_download_path() -> Result<PathBuf, String> {
    Ok(PathBuf::from(expand_environment_variables(
        &default_download_path_template(),
    )?))
}

fn default_cache_path_template(app: &AppHandle) -> String {
    Path::new("%LOCALAPPDATA%")
        .join(&app.config().identifier)
        .join("tdlib")
        .display()
        .to_string()
}

fn default_download_path_template() -> String {
    Path::new("%USERPROFILE%")
        .join("Downloads")
        .join("downloads")
        .display()
        .to_string()
}

fn program_directory() -> Result<PathBuf, String> {
    env::current_exe()
        .map_err(|error| format!("Unable to resolve executable path: {error}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Executable path has no parent directory".to_string())
}

#[cfg(test)]
mod tests {
    use super::file_actions::{canonical_file_within_roots, download_file_name, safe_file_name};
    use super::*;
    use std::collections::HashSet;

    fn unique_test_directory(label: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "notgram-storage-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn assembles_snapshot_cache_chunks_transactionally() {
        let state = SnapshotCacheWriteState::default();
        state
            .begin(
                "test-transaction",
                serde_json::json!({
                    "version": 3,
                    "currentUserId": "self",
                    "messages": [],
                }),
            )
            .unwrap();
        state
            .append(
                "test-transaction",
                "messages",
                vec![
                    serde_json::json!({ "id": "1", "chatId": "chat" }),
                    serde_json::json!({ "id": "2", "chatId": "chat" }),
                ],
            )
            .unwrap();

        assert_eq!(
            state.take("test-transaction").unwrap(),
            serde_json::json!({
                "version": 3,
                "currentUserId": "self",
                "messages": [
                    { "id": "1", "chatId": "chat" },
                    { "id": "2", "chatId": "chat" },
                ],
            })
        );
        assert!(state.take("test-transaction").is_err());
    }

    #[test]
    fn rejects_invalid_snapshot_cache_chunks() {
        let state = SnapshotCacheWriteState::default();
        assert!(state.begin("invalid id", serde_json::json!({})).is_err());
        state
            .begin("valid-id", serde_json::json!({ "messages": [] }))
            .unwrap();
        assert!(
            state
                .append("valid-id", "missing", vec![serde_json::json!({})])
                .is_err()
        );
        assert!(
            state
                .append(
                    "valid-id",
                    "messages",
                    vec![serde_json::json!({}); MAX_SNAPSHOT_CHUNK_ITEMS + 1],
                )
                .is_err()
        );
    }

    #[test]
    fn normalizes_relative_paths_against_program_directory() {
        let expected = program_directory().unwrap().join("downloads");
        assert_eq!(
            normalize_path("downloads", PathBuf::from("ignored")).unwrap(),
            expected.display().to_string()
        );
    }

    #[test]
    fn expands_windows_environment_variables_without_persisting_machine_paths() {
        let expanded =
            expand_environment_variables_from(r#"%USERPROFILE%\Downloads\downloads"#, |name| {
                (name == "USERPROFILE").then(|| r#"C:\Users\Example"#.to_string())
            })
            .unwrap();
        assert_eq!(expanded, r#"C:\Users\Example\Downloads\downloads"#);
        assert_eq!(
            default_download_path_template(),
            Path::new("%USERPROFILE%")
                .join("Downloads")
                .join("downloads")
                .display()
                .to_string()
        );
    }

    #[test]
    fn rejects_unavailable_environment_variables_in_storage_paths() {
        assert!(
            expand_environment_variables_from(r#"%MISSING%\cache"#, |_| None)
                .unwrap_err()
                .contains("%MISSING%")
        );
    }

    #[test]
    fn sanitizes_download_file_names() {
        assert_eq!(safe_file_name(r#"..\report?.pdf"#), "report_.pdf");
        assert_eq!(
            download_file_name("视频", Path::new(r#"C:\cache\video.mp4"#)),
            "视频.mp4"
        );
        assert_eq!(
            download_file_name("review.webm", Path::new(r#"C:\cache\video.mp4"#)),
            "review.webm"
        );
    }

    #[test]
    fn accepts_only_canonical_files_inside_trusted_roots() {
        let directory = unique_test_directory("trusted-file");
        let trusted = directory.join("trusted");
        let outside = directory.join("outside");
        fs::create_dir_all(&trusted).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let accepted = trusted.join("report.txt");
        let rejected = outside.join("secret.txt");
        fs::write(&accepted, b"accepted").unwrap();
        fs::write(&rejected, b"rejected").unwrap();
        let trusted = trusted.canonicalize().unwrap();

        assert_eq!(
            canonical_file_within_roots(&accepted, std::slice::from_ref(&trusted)).unwrap(),
            accepted.canonicalize().unwrap()
        );
        assert!(canonical_file_within_roots(&rejected, &[trusted]).is_err());

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_directories_and_missing_files_from_trusted_roots() {
        let directory = unique_test_directory("invalid-file");
        let trusted = directory.join("trusted");
        fs::create_dir_all(&trusted).unwrap();
        let trusted = trusted.canonicalize().unwrap();

        assert!(canonical_file_within_roots(&trusted, std::slice::from_ref(&trusted)).is_err());
        assert!(canonical_file_within_roots(&trusted.join("missing.txt"), &[trusted]).is_err());

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn limits_openable_files_to_canonical_trusted_roots() {
        let root = env::temp_dir().join(format!(
            "notgram-open-file-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let trusted = root.join("trusted");
        let outside = root.join("outside");
        fs::create_dir_all(&trusted).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let trusted_file = trusted.join("message.txt");
        let outside_file = outside.join("secret.txt");
        fs::write(&trusted_file, b"message").unwrap();
        fs::write(&outside_file, b"secret").unwrap();
        let roots = [trusted.canonicalize().unwrap()];

        assert_eq!(
            canonical_file_within_roots(&trusted_file, &roots).unwrap(),
            trusted_file.canonicalize().unwrap()
        );
        assert!(canonical_file_within_roots(&outside_file, &roots).is_err());
        assert!(canonical_file_within_roots(&trusted, &roots).is_err());
        assert!(canonical_file_within_roots(&trusted.join("missing"), &roots).is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reports_cache_usage_by_media_category() {
        let root = unique_test_directory("cache-usage");
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("photo.jpg"), b"image").unwrap();
        fs::write(root.join("nested").join("clip.mp4"), b"video!").unwrap();
        fs::write(root.join("notes.pdf"), b"doc").unwrap();
        fs::write(root.join("unknown.bin"), b"other-data").unwrap();

        let usage = cache_usage(&root).unwrap();

        assert_eq!(
            usage.total,
            CacheUsageItem {
                bytes: 24,
                files: 4
            }
        );
        assert_eq!(usage.images, CacheUsageItem { bytes: 5, files: 1 });
        assert_eq!(usage.videos, CacheUsageItem { bytes: 6, files: 1 });
        assert_eq!(usage.documents, CacheUsageItem { bytes: 3, files: 1 });
        assert_eq!(
            usage.other,
            CacheUsageItem {
                bytes: 10,
                files: 1
            }
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clears_only_selected_unprotected_cache_files() {
        let root = unique_test_directory("cache-protection");
        fs::create_dir_all(&root).unwrap();
        let removable = root.join("remove.jpg");
        let protected = root.join("keep.jpg");
        let other_category = root.join("keep.mp4");
        fs::write(&removable, b"remove").unwrap();
        fs::write(&protected, b"protected").unwrap();
        fs::write(&other_category, b"video").unwrap();
        let root = root.canonicalize().unwrap();
        let protected = [protected.canonicalize().unwrap()].into_iter().collect();

        let result = clear_cache_files(
            &root,
            &[CacheCategory::Image].into_iter().collect(),
            None,
            &protected,
        )
        .unwrap();

        assert_eq!(result.removed_files, 1);
        assert_eq!(result.removed_bytes, 6);
        assert_eq!(result.skipped_protected_files, 1);
        assert!(!removable.exists());
        assert!(root.join("keep.jpg").exists());
        assert!(other_category.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_files_newer_than_the_cleanup_cutoff() {
        let root = unique_test_directory("cache-retention");
        fs::create_dir_all(&root).unwrap();
        let recent = root.join("recent.ogg");
        fs::write(&recent, b"audio").unwrap();
        let root = root.canonicalize().unwrap();

        let kept = clear_cache_files(
            &root,
            &[CacheCategory::Audio].into_iter().collect(),
            SystemTime::now().checked_sub(Duration::from_secs(60)),
            &HashSet::new(),
        )
        .unwrap();
        assert_eq!(kept.removed_files, 0);
        assert!(recent.exists());

        let removed = clear_cache_files(
            &root,
            &[CacheCategory::Audio].into_iter().collect(),
            SystemTime::now().checked_add(Duration::from_secs(60)),
            &HashSet::new(),
        )
        .unwrap();
        assert_eq!(removed.removed_files, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn protects_only_recent_sent_media_cache_files() {
        let root = unique_test_directory("sent-media-retention");
        fs::create_dir_all(&root).unwrap();
        let upload = root.join("upload.jpg");
        fs::write(&upload, b"upload").unwrap();
        let root = root.canonicalize().unwrap();
        let upload = upload.canonicalize().unwrap();

        let recent = cache_paths_modified_after(
            &root,
            SystemTime::now()
                .checked_sub(Duration::from_secs(60))
                .unwrap(),
        )
        .unwrap();
        assert!(recent.contains(&upload));

        let expired = cache_paths_modified_after(
            &root,
            SystemTime::now()
                .checked_add(Duration::from_secs(60))
                .unwrap(),
        )
        .unwrap();
        assert!(expired.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn saves_concurrent_downloads_without_overwriting_existing_files() {
        let root = unique_test_directory("download-copy");
        let downloads = root.join("downloads");
        fs::create_dir_all(&downloads).unwrap();
        let source = root.join("source.bin");
        fs::write(&source, b"download-content").unwrap();

        let workers = (0..8)
            .map(|_| {
                let source = source.clone();
                let downloads = downloads.clone();
                std::thread::spawn(move || {
                    file_actions::copy_to_available_download(&source, &downloads, "archive.bin")
                        .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let paths = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<HashSet<_>>();

        assert_eq!(paths.len(), 8);
        for path in paths {
            assert_eq!(fs::read(path).unwrap(), b"download-content");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validates_and_canonicalizes_upload_files() {
        let path = env::temp_dir().join(format!(
            "notgram-upload-{}-{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, b"upload").unwrap();

        let info = prepare_upload_file(&path).unwrap();

        assert_eq!(info.size, 6);
        assert_eq!(PathBuf::from(info.path), path.canonicalize().unwrap());
        fs::remove_file(path).unwrap();
        assert!(prepare_upload_file(Path::new("relative.txt")).is_err());
    }

    #[test]
    fn cached_assets_are_limited_to_known_fields_and_trusted_roots() {
        let root = env::temp_dir().join(format!(
            "notgram-assets-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let trusted = root.join("trusted");
        let outside = root.join("outside");
        fs::create_dir_all(&trusted).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let avatar = trusted.join("avatar.jpg");
        let media = trusted.join("media.jpg");
        let secret = outside.join("secret.txt");
        fs::write(&avatar, b"avatar").unwrap();
        fs::write(&media, b"media").unwrap();
        fs::write(&secret, b"secret").unwrap();

        let snapshot = serde_json::json!({
            "avatar": { "imagePath": avatar },
            "messages": [{ "content": { "localPath": media, "thumbnailPath": secret } }],
            "unrecognizedPath": trusted.join("ignored.jpg")
        });
        let paths = cached_asset_paths(&snapshot, &[trusted.canonicalize().unwrap()]);

        assert_eq!(paths.len(), 2);
        assert!(paths.contains(&avatar.canonicalize().unwrap()));
        assert!(paths.contains(&media.canonicalize().unwrap()));
        assert!(!paths.contains(&secret.canonicalize().unwrap()));
        fs::remove_dir_all(root).unwrap();
    }
}
