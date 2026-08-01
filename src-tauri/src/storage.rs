use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

pub const DEFAULT_ACCOUNT_ID: &str = "default";

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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountAvatar {
    pub label: String,
    pub color: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramAccount {
    pub id: String,
    pub user_id: String,
    pub display_name: String,
    pub avatar: AccountAvatar,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramAccountRegistration {
    pub user_id: String,
    pub display_name: String,
    pub avatar: AccountAvatar,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramAccountState {
    pub active_account_id: String,
    pub accounts: Vec<TelegramAccount>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountRegistry {
    active_account_id: String,
    accounts: Vec<TelegramAccount>,
}

impl Default for AccountRegistry {
    fn default() -> Self {
        Self {
            active_account_id: DEFAULT_ACCOUNT_ID.to_string(),
            accounts: Vec::new(),
        }
    }
}

impl From<AccountRegistry> for TelegramAccountState {
    fn from(value: AccountRegistry) -> Self {
        Self {
            active_account_id: value.active_account_id,
            accounts: value.accounts,
        }
    }
}

#[tauri::command]
pub fn telegram_account_state(app: AppHandle) -> Result<TelegramAccountState, String> {
    Ok(load_account_registry(&app)?.into())
}

#[tauri::command]
pub fn telegram_register_account(
    app: AppHandle,
    account: TelegramAccountRegistration,
) -> Result<TelegramAccountState, String> {
    let mut registry = load_account_registry(&app)?;
    let id = registry.active_account_id.clone();
    validate_account_id(&id)?;
    let account = TelegramAccount {
        id: id.clone(),
        user_id: account.user_id,
        display_name: account.display_name,
        avatar: account.avatar,
    };
    if let Some(existing) = registry.accounts.iter_mut().find(|item| item.id == id) {
        *existing = account;
    } else {
        registry.accounts.push(account);
    }
    save_account_registry(&app, &registry)?;
    Ok(registry.into())
}

#[tauri::command]
pub fn telegram_select_account(
    app: AppHandle,
    account_id: String,
) -> Result<TelegramAccountState, String> {
    validate_account_id(&account_id)?;
    let mut registry = load_account_registry(&app)?;
    registry.active_account_id = account_id;
    save_account_registry(&app, &registry)?;
    Ok(registry.into())
}

#[tauri::command]
pub fn telegram_remove_account(
    app: AppHandle,
    account_id: String,
) -> Result<TelegramAccountState, String> {
    validate_account_id(&account_id)?;
    let mut registry = load_account_registry(&app)?;
    registry.accounts.retain(|account| account.id != account_id);
    if registry.active_account_id == account_id {
        registry.active_account_id = registry
            .accounts
            .first()
            .map(|account| account.id.clone())
            .unwrap_or_else(|| DEFAULT_ACCOUNT_ID.to_string());
    }
    clear_account_storage(&app, &account_id)?;
    save_account_registry(&app, &registry)?;
    Ok(registry.into())
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
    let resolved = resolve_preferences(&app, preferences)?;
    create_storage_directories(&resolved)?;
    allow_asset_directories(&app, &resolved)?;
    save_preferences(&app, &resolved)?;
    settings_from_preferences(&app, resolved)
}

#[tauri::command]
pub fn telegram_save_downloaded_file(
    app: AppHandle,
    source_path: String,
    file_name: String,
) -> Result<String, String> {
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err(format!(
            "Downloaded cache file does not exist: {}",
            source.display()
        ));
    }
    let directory = download_directory(&app)?;
    let destination = available_download_path(&directory, &safe_file_name(&file_name));
    fs::copy(&source, &destination).map_err(|error| {
        format!(
            "Unable to save downloaded file to {}: {error}",
            destination.display()
        )
    })?;
    Ok(destination.display().to_string())
}

#[tauri::command]
pub fn telegram_prepare_upload(path: String) -> Result<UploadFileInfo, String> {
    prepare_upload_file(Path::new(&path))
}

#[tauri::command]
pub fn telegram_read_snapshot_cache(app: AppHandle) -> Result<Option<Value>, String> {
    let path = snapshot_cache_path(&app)?;
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
    let snapshot = serde_json::from_slice(&serialized)
        .map_err(|error| format!("Unable to parse UI cache: {error}"))?;
    Ok(Some(snapshot))
}

#[tauri::command]
pub fn telegram_write_snapshot_cache(app: AppHandle, snapshot: Value) -> Result<(), String> {
    let path = snapshot_cache_path(&app)?;
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
pub fn telegram_clear_snapshot_cache(app: AppHandle) -> Result<(), String> {
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
    allow_asset_directories(app, &resolved)?;
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
    allow_asset_directories(app, &resolved)?;
    Ok(PathBuf::from(resolved.download_path))
}

fn snapshot_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(tdlib_cache_directory(app)?.join("notgram-ui-cache.dat"))
}

pub fn active_account_id(app: &AppHandle) -> Result<String, String> {
    Ok(load_account_registry(app)?.active_account_id)
}

fn account_cache_directory(root: PathBuf, account_id: &str) -> PathBuf {
    if account_id == DEFAULT_ACCOUNT_ID {
        root
    } else {
        root.join("accounts").join(account_id)
    }
}

fn account_database_directory(root: PathBuf, account_id: &str) -> PathBuf {
    if account_id == DEFAULT_ACCOUNT_ID {
        root.join("database")
    } else {
        root.join("accounts").join(account_id).join("database")
    }
}

fn clear_account_storage(app: &AppHandle, account_id: &str) -> Result<(), String> {
    let app_data_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve app data directory: {error}"))?
        .join("tdlib");
    let preferences = resolve_preferences(app, load_preferences(app)?)?;
    let cache_root = PathBuf::from(preferences.cache_path);

    if account_id == DEFAULT_ACCOUNT_ID {
        remove_directory_if_present(&app_data_root.join("database"))?;
        remove_directory_if_present(&cache_root.join("files"))?;
        remove_snapshot_files(&cache_root)?;
    } else {
        remove_directory_if_present(&app_data_root.join("accounts").join(account_id))?;
        remove_directory_if_present(&cache_root.join("accounts").join(account_id))?;
    }
    Ok(())
}

fn remove_snapshot_files(directory: &Path) -> Result<(), String> {
    let path = directory.join("notgram-ui-cache.dat");
    let temporary = path.with_extension("tmp");
    let backup = path.with_extension("bak");
    for candidate in [&path, &temporary, &backup] {
        if candidate.exists() {
            fs::remove_file(candidate).map_err(|error| {
                format!(
                    "Unable to remove account cache {}: {error}",
                    candidate.display()
                )
            })?;
        }
    }
    Ok(())
}

fn remove_directory_if_present(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_dir_all(path).map_err(|error| {
            format!(
                "Unable to remove account directory {}: {error}",
                path.display()
            )
        })?;
    }
    Ok(())
}

fn validate_account_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 80
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Invalid account identifier".to_string());
    }
    Ok(())
}

fn account_registry_path(app: &AppHandle) -> Result<PathBuf, String> {
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
    Ok(directory.join("accounts.dat"))
}

fn load_account_registry(app: &AppHandle) -> Result<AccountRegistry, String> {
    let path = account_registry_path(app)?;
    let backup = path.with_extension("bak");
    let readable_path = if path.is_file() {
        &path
    } else if backup.is_file() {
        &backup
    } else {
        return Ok(AccountRegistry::default());
    };
    let protected = fs::read(readable_path).map_err(|error| {
        format!(
            "Unable to read account registry {}: {error}",
            readable_path.display()
        )
    })?;
    let serialized = crate::proxy::unprotect(&protected)?;
    let registry: AccountRegistry = serde_json::from_slice(&serialized)
        .map_err(|error| format!("Unable to parse account registry: {error}"))?;
    validate_account_id(&registry.active_account_id)?;
    for account in &registry.accounts {
        validate_account_id(&account.id)?;
    }
    Ok(registry)
}

fn save_account_registry(app: &AppHandle, registry: &AccountRegistry) -> Result<(), String> {
    let path = account_registry_path(app)?;
    let temporary = path.with_extension("tmp");
    let backup = path.with_extension("bak");
    let serialized = serde_json::to_vec(registry)
        .map_err(|error| format!("Unable to serialize account registry: {error}"))?;
    let protected = crate::proxy::protect(&serialized)?;
    fs::write(&temporary, protected).map_err(|error| {
        format!(
            "Unable to write account registry {}: {error}",
            temporary.display()
        )
    })?;
    if backup.exists() {
        fs::remove_file(&backup).map_err(|error| {
            format!(
                "Unable to remove account registry backup {}: {error}",
                backup.display()
            )
        })?;
    }
    if path.exists() {
        fs::rename(&path, &backup).map_err(|error| {
            format!(
                "Unable to rotate account registry {}: {error}",
                path.display()
            )
        })?;
    }
    if let Err(error) = fs::rename(&temporary, &path) {
        if backup.exists() {
            let _ = fs::rename(&backup, &path);
        }
        return Err(format!(
            "Unable to replace account registry {}: {error}",
            path.display()
        ));
    }
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn storage_settings(app: &AppHandle) -> Result<StorageSettings, String> {
    let preferences = load_preferences(app)?;
    let resolved = resolve_preferences(app, preferences)?;
    create_storage_directories(&resolved)?;
    allow_asset_directories(app, &resolved)?;
    settings_from_preferences(app, resolved)
}

fn settings_from_preferences(
    app: &AppHandle,
    preferences: StoragePreferences,
) -> Result<StorageSettings, String> {
    Ok(StorageSettings {
        cache_path: preferences.cache_path,
        download_path: preferences.download_path,
        default_cache_path: default_cache_path(app)?.display().to_string(),
        default_download_path: default_download_path()?.display().to_string(),
    })
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
    let path = if trimmed.is_empty() {
        default_path
    } else {
        let configured = PathBuf::from(trimmed);
        if configured.is_absolute() {
            configured
        } else {
            program_directory()?.join(configured)
        }
    };
    Ok(path.display().to_string())
}

fn create_storage_directories(preferences: &StoragePreferences) -> Result<(), String> {
    create_directory(&preferences.cache_path, "cache")?;
    create_directory(&preferences.download_path, "download")
}

fn allow_asset_directories(
    app: &AppHandle,
    preferences: &StoragePreferences,
) -> Result<(), String> {
    let scope = app.asset_protocol_scope();
    allow_tdlib_database_assets(app)?;
    let cache_directory = account_cache_directory(
        PathBuf::from(&preferences.cache_path),
        &active_account_id(app)?,
    );
    scope
        .allow_directory(cache_directory.join("files"), true)
        .map_err(|error| format!("Unable to allow cache assets: {error}"))?;
    scope
        .allow_directory(&preferences.download_path, true)
        .map_err(|error| format!("Unable to allow download assets: {error}"))
}

fn allow_tdlib_database_assets(app: &AppHandle) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_directory(tdlib_database_directory(app)?, true)
        .map_err(|error| format!("Unable to allow TDLib database assets: {error}"))
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
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Unable to resolve Windows app cache directory: {error}"))?
        .join("tdlib"))
}

fn default_download_path() -> Result<PathBuf, String> {
    Ok(program_directory()?.join("downloads"))
}

fn safe_file_name(value: &str) -> String {
    let name = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    let sanitized = name
        .chars()
        .map(|character| {
            if character.is_control() || r#"<>:"/\|?*"#.contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    if sanitized.trim().is_empty() {
        "download".to_string()
    } else {
        sanitized
    }
}

fn available_download_path(directory: &Path, file_name: &str) -> PathBuf {
    let original = directory.join(file_name);
    if !original.exists() {
        return original;
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 1..10_000 {
        let candidate = match extension {
            Some(extension) => directory.join(format!("{stem} ({index}).{extension}")),
            None => directory.join(format!("{stem} ({index})")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem}-{}", std::process::id()))
}

fn prepare_upload_file(path: &Path) -> Result<UploadFileInfo, String> {
    if !path.is_absolute() {
        return Err("Selected upload path must be absolute".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "Selected upload file is unavailable".to_string())?;
    let metadata = canonical
        .metadata()
        .map_err(|_| "Unable to read selected upload file".to_string())?;
    if !metadata.is_file() {
        return Err("Selected upload path is not a file".to_string());
    }
    let path = canonical
        .to_str()
        .ok_or_else(|| "Selected upload path contains unsupported characters".to_string())?;
    Ok(UploadFileInfo {
        path: path.to_string(),
        size: metadata.len(),
    })
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
    use super::*;

    #[test]
    fn normalizes_relative_paths_against_program_directory() {
        let expected = program_directory().unwrap().join("downloads");
        assert_eq!(
            normalize_path("downloads", PathBuf::from("ignored")).unwrap(),
            expected.display().to_string()
        );
    }

    #[test]
    fn sanitizes_download_file_names() {
        assert_eq!(safe_file_name(r#"..\report?.pdf"#), "report_.pdf");
    }

    #[test]
    fn isolates_secondary_account_directories() {
        let cache_root = PathBuf::from("cache-root");
        let database_root = PathBuf::from("database-root");

        assert_eq!(
            account_cache_directory(cache_root.clone(), DEFAULT_ACCOUNT_ID),
            cache_root
        );
        assert_eq!(
            account_cache_directory(PathBuf::from("cache-root"), "account-2"),
            PathBuf::from("cache-root")
                .join("accounts")
                .join("account-2")
        );
        assert_eq!(
            account_database_directory(database_root.clone(), DEFAULT_ACCOUNT_ID),
            database_root.join("database")
        );
        assert_eq!(
            account_database_directory(PathBuf::from("database-root"), "account-2"),
            PathBuf::from("database-root")
                .join("accounts")
                .join("account-2")
                .join("database")
        );
    }

    #[test]
    fn validates_account_ids_before_using_them_as_paths() {
        assert!(validate_account_id(DEFAULT_ACCOUNT_ID).is_ok());
        assert!(validate_account_id("account-1234_abcd").is_ok());
        assert!(validate_account_id("").is_err());
        assert!(validate_account_id("../account").is_err());
        assert!(validate_account_id("account/child").is_err());
        assert!(validate_account_id(&"a".repeat(81)).is_err());
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
}
