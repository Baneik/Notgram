pub(crate) mod account;
mod database_key;

use account::{account_cache_directory, account_database_directory, active_account_id};
pub use database_key::database_encryption_key;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

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
    save_preferences(&app, &resolved)?;
    settings_from_preferences(&app, resolved)
}

#[tauri::command]
pub fn telegram_save_downloaded_file(
    app: AppHandle,
    source_path: String,
    file_name: String,
) -> Result<String, String> {
    let source = PathBuf::from(source_path)
        .canonicalize()
        .map_err(|_| "Downloaded cache file is unavailable".to_string())?;
    if !source.is_file() {
        return Err(format!(
            "Downloaded cache file does not exist: {}",
            source.display()
        ));
    }
    let trusted_files = tdlib_cache_directory(&app)?.join("files");
    fs::create_dir_all(&trusted_files).map_err(|error| {
        format!(
            "Unable to create trusted TDLib files directory {}: {error}",
            trusted_files.display()
        )
    })?;
    let trusted_files = trusted_files
        .canonicalize()
        .map_err(|error| format!("Unable to resolve trusted TDLib files directory: {error}"))?;
    if !source.starts_with(&trusted_files) {
        return Err("Downloaded file is outside the active TDLib files directory".to_string());
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
    let snapshot: Value = serde_json::from_slice(&serialized)
        .map_err(|error| format!("Unable to parse UI cache: {error}"))?;
    authorize_snapshot_assets(&app, &snapshot)?;
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

fn cached_asset_paths(snapshot: &Value, trusted_roots: &[PathBuf]) -> HashSet<PathBuf> {
    fn visit(
        value: &Value,
        key: Option<&str>,
        trusted_roots: &[PathBuf],
        paths: &mut HashSet<PathBuf>,
    ) {
        match value {
            Value::Object(object) => {
                for (child_key, child) in object {
                    visit(child, Some(child_key), trusted_roots, paths);
                }
            }
            Value::Array(array) => {
                for child in array {
                    visit(child, key, trusted_roots, paths);
                }
            }
            Value::String(path)
                if matches!(key, Some("imagePath" | "localPath" | "thumbnailPath")) =>
            {
                if let Ok(path) = PathBuf::from(path).canonicalize()
                    && path.is_file()
                    && trusted_roots.iter().any(|root| path.starts_with(root))
                {
                    paths.insert(path);
                }
            }
            _ => {}
        }
    }

    let mut paths = HashSet::new();
    visit(snapshot, None, trusted_roots, &mut paths);
    paths
}

fn storage_settings(app: &AppHandle) -> Result<StorageSettings, String> {
    let preferences = load_preferences(app)?;
    let resolved = resolve_preferences(app, preferences)?;
    create_storage_directories(&resolved)?;
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

pub fn prepare_upload_file(path: &Path) -> Result<UploadFileInfo, String> {
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
