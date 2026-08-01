use serde::{Deserialize, Serialize};
use std::{
    env, fs,
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

pub fn tdlib_cache_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let preferences = load_preferences(app)?;
    let resolved = resolve_preferences(app, preferences)?;
    fs::create_dir_all(&resolved.cache_path).map_err(|error| {
        format!(
            "Unable to create cache directory {}: {error}",
            resolved.cache_path
        )
    })?;
    allow_asset_directories(app, &resolved)?;
    Ok(PathBuf::from(resolved.cache_path))
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
    scope
        .allow_directory(PathBuf::from(&preferences.cache_path).join("files"), true)
        .map_err(|error| format!("Unable to allow cache assets: {error}"))?;
    scope
        .allow_directory(&preferences.download_path, true)
        .map_err(|error| format!("Unable to allow download assets: {error}"))
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
}
