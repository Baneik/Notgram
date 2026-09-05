use super::{StoragePreferences, persistence};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct SessionStorage {
    cache: Mutex<Option<PathBuf>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationFile {
    relative: PathBuf,
    hash: String,
    bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationBackup {
    pub id: String,
    pub path: PathBuf,
    pub bytes: u64,
    files: Vec<MigrationFile>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationBackupSummary {
    pub id: String,
    pub path: PathBuf,
    pub bytes: u64,
}

pub(super) fn backup_summaries(app: &AppHandle) -> Result<Vec<MigrationBackupSummary>, String> {
    Ok(backups(app)?
        .into_iter()
        .map(|value| MigrationBackupSummary {
            id: value.id,
            path: value.path,
            bytes: value.bytes,
        })
        .collect())
}

#[derive(Default, Deserialize, Serialize)]
struct Journal {
    #[serde(default)]
    redirects: Vec<(PathBuf, PathBuf)>,
    pending: Option<(PathBuf, PathBuf)>,
    backups: Vec<MigrationBackup>,
}

fn journal_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::distribution::app_config_directory(app)?.join("cache-migrations.dat"))
}

pub(super) fn effective_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<SessionStorage>();
    let mut cache = state
        .cache
        .lock()
        .map_err(|_| "Storage session unavailable")?;
    if let Some(path) = cache.as_ref() {
        return Ok(path.clone());
    }
    let configured = super::resolve_preferences(app, super::load_preferences(app)?)?;
    let mut root = PathBuf::from(configured.cache_path);
    let path = journal_path(app)?;
    let mut journal: Journal = persistence::read_json(&path, true)?.unwrap_or_default();
    if let Some((from, to)) = journal.pending.clone()
        && super::paths_equal(&root, &to)
    {
        // A failed copy never activates a half-migrated destination.
        match migrate(&from, &to) {
            Ok(backup) => {
                journal.backups.push(backup);
                journal.redirects.push((from.clone(), to.clone()));
                journal.pending = None;
                persistence::write_json(&path, &journal, true)?;
                super::account::rebase_avatar_paths(app, &from, &to)?;
            }
            Err(_) => {
                root = from;
            }
        }
    }
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    *cache = Some(root.clone());
    Ok(root)
}

pub(super) fn schedule(app: &AppHandle, preferences: &StoragePreferences) -> Result<(), String> {
    let from = effective_cache_root(app)?;
    let to = PathBuf::from(&preferences.cache_path);
    validate_paths(&from, &PathBuf::from(&preferences.download_path))?;
    validate_paths(&to, &PathBuf::from(&preferences.download_path))?;
    let database = crate::distribution::app_data_directory(app)?
        .join("tdlib")
        .join("database");
    validate_paths(&database, &PathBuf::from(&preferences.download_path))?;
    let config = crate::distribution::app_config_directory(app)?;
    // The portable default tdlib root intentionally contains its database.
    if !super::paths_equal(&to, &crate::distribution::default_tdlib_cache_path(app)?) {
        validate_paths(&to, &database)?;
        validate_paths(&to, &config)?;
    }
    let path = journal_path(app)?;
    let mut journal: Journal = persistence::read_json(&path, true)?.unwrap_or_default();
    journal.pending = if super::paths_equal(&from, &to) {
        None
    } else {
        validate_paths(&from, &to)?;
        Some((from, to))
    };
    persistence::write_json(&path, &journal, true)
}

fn absolute(path: &Path) -> Result<PathBuf, String> {
    // Resolve junctions/symlinks in the existing prefix, even for new destinations.
    if !path.is_absolute() || path.parent().is_none() {
        return Err("Storage path must name an absolute directory".into());
    }
    let mut normalized = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            _ => normalized.push(part.as_os_str()),
        }
    }
    let mut prefix = normalized.as_path();
    let mut suffix = Vec::new();
    while !prefix.exists() {
        suffix.push(
            prefix
                .file_name()
                .ok_or("Storage path has no existing root")?
                .to_os_string(),
        );
        prefix = prefix.parent().ok_or("Storage path has no parent")?;
    }
    let mut resolved = prefix.canonicalize().map_err(|e| e.to_string())?;
    for part in suffix.into_iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

pub(super) fn validate_paths(left: &Path, right: &Path) -> Result<(), String> {
    let left = absolute(left)?;
    let right = absolute(right)?;
    let left = PathBuf::from(left.to_string_lossy().to_lowercase());
    let right = PathBuf::from(right.to_string_lossy().to_lowercase());
    if left.starts_with(&right) || right.starts_with(&left) {
        return Err("Cache, download and database directories must not overlap".into());
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let size = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if size == 0 {
            break;
        }
        digest.update(&buffer[..size]);
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn collect(root: &Path, path: &Path, files: &mut Vec<MigrationFile>) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Storage migration does not follow links".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Storage migration does not follow junctions".into());
        }
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            collect(root, &entry.map_err(|e| e.to_string())?.path(), files)?;
        }
    } else if metadata.is_file() {
        if files.len() >= 100_000 {
            return Err("Cache migration exceeds file budget".into());
        }
        files.push(MigrationFile {
            relative: path.strip_prefix(root).map_err(|e| e.to_string())?.into(),
            hash: hash_file(path)?,
            bytes: metadata.len(),
        });
    }
    Ok(())
}

fn account_files(
    root: &Path,
    account: &Path,
    files: &mut Vec<MigrationFile>,
) -> Result<(), String> {
    collect(root, &account.join("files"), files)?;
    for name in ["notgram-ui-cache.dat", "notgram-ui-cache.bak"] {
        collect(root, &account.join(name), files)?;
    }
    Ok(())
}

pub(super) fn migrate(from: &Path, to: &Path) -> Result<MigrationBackup, String> {
    validate_paths(from, to)?;
    let mut files = Vec::new();
    account_files(from, from, &mut files)?;
    let accounts = from.join("accounts");
    if accounts.is_dir() {
        for account in fs::read_dir(accounts).map_err(|e| e.to_string())? {
            let account = account.map_err(|e| e.to_string())?;
            super::account::validate_account_id(&account.file_name().to_string_lossy())?;
            account_files(from, &account.path(), &mut files)?;
        }
    }
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    let destination_root = absolute(to)?;
    for file in &files {
        let source = from.join(&file.relative);
        let destination = to.join(&file.relative);
        fs::create_dir_all(
            destination
                .parent()
                .ok_or("Migration destination has no parent")?,
        )
        .map_err(|e| e.to_string())?;
        if !absolute(
            destination
                .parent()
                .ok_or("Migration destination has no parent")?,
        )?
        .starts_with(&destination_root)
        {
            return Err("Migration destination follows a link outside its root".into());
        }
        if destination.exists() {
            if hash_file(&destination)? != file.hash {
                return Err("Migration destination contains different data".into());
            }
        } else {
            let temporary =
                destination.with_file_name(format!(".notgram-migration-{}.part", file.hash));
            let mut input = fs::File::open(&source).map_err(|e| e.to_string())?;
            let mut output = fs::File::create(&temporary).map_err(|e| e.to_string())?;
            std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
            output
                .flush()
                .and_then(|()| output.sync_all())
                .map_err(|e| e.to_string())?;
            drop(output);
            if hash_file(&temporary)? != file.hash {
                return Err("Cache changed during migration".into());
            }
            fs::rename(&temporary, &destination).map_err(|e| e.to_string())?;
        }
    }
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string();
    Ok(MigrationBackup {
        id,
        path: from.into(),
        bytes: files.iter().map(|f| f.bytes).sum(),
        files,
    })
}

pub(super) fn rebase_paths(value: &mut serde_json::Value, from: &Path, to: &Path) {
    match value {
        serde_json::Value::Object(object) => {
            for (key, value) in object {
                if matches!(
                    key.as_str(),
                    "localPath" | "imagePath" | "previewPath" | "thumbnailPath"
                ) {
                    if let Some(path) = value
                        .as_str()
                        .and_then(|s| Path::new(s).strip_prefix(from).ok())
                    {
                        *value = serde_json::Value::String(to.join(path).display().to_string());
                    }
                } else {
                    rebase_paths(value, from, to);
                }
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                rebase_paths(value, from, to);
            }
        }
        _ => {}
    }
}

pub(super) fn backups(app: &AppHandle) -> Result<Vec<MigrationBackup>, String> {
    Ok(
        persistence::read_json::<Journal>(&journal_path(app)?, true)?
            .unwrap_or_default()
            .backups,
    )
}

#[tauri::command]
pub fn telegram_remove_migration_backup(
    app: AppHandle,
    id: String,
    _state: State<'_, SessionStorage>,
) -> Result<u64, String> {
    let active = effective_cache_root(&app)?;
    let path = journal_path(&app)?;
    let mut journal: Journal = persistence::read_json(&path, true)?.unwrap_or_default();
    let pending_target = journal.pending.as_ref().map(|(_, to)| to.clone());
    let backup = journal
        .backups
        .iter_mut()
        .find(|backup| backup.id == id)
        .ok_or("Migration backup not found")?;
    validate_paths(&active, &backup.path)?;
    if let Some(target) = pending_target {
        validate_paths(&target, &backup.path)?;
    }
    let root = absolute(&backup.path)?;
    let mut removed = 0;
    let mut remaining = Vec::new();
    for file in &backup.files {
        let target = backup.path.join(&file.relative);
        if !target.exists() {
            continue;
        }
        let resolved = target.canonicalize().map_err(|e| e.to_string())?;
        if !resolved.starts_with(&root) || hash_file(&resolved)? != file.hash {
            remaining.push(file.clone());
            continue;
        }
        fs::remove_file(resolved).map_err(|e| e.to_string())?;
        removed += file.bytes;
    }
    backup.files = remaining;
    backup.bytes = backup.files.iter().map(|file| file.bytes).sum();
    journal.backups.retain(|backup| !backup.files.is_empty());
    persistence::write_json(&path, &journal, true)?;
    Ok(removed)
}

pub(super) fn rebase_snapshot(
    app: &AppHandle,
    value: &mut serde_json::Value,
) -> Result<(), String> {
    let current = effective_cache_root(app)?;
    let journal: Journal = persistence::read_json(&journal_path(app)?, true)?.unwrap_or_default();
    for (from, to) in &journal.redirects {
        rebase_paths(value, from, to);
    }
    for backup in &journal.backups {
        rebase_paths(value, &backup.path, &current);
    }
    Ok(())
}

pub(super) fn remove_account_backups(app: &AppHandle, account: &str) -> Result<(), String> {
    let path = journal_path(app)?;
    let mut journal: Journal = persistence::read_json(&path, true)?.unwrap_or_default();
    for backup in &mut journal.backups {
        let root = absolute(&backup.path)?;
        let mut remaining = Vec::new();
        for file in &backup.files {
            let owned = if account == "default" {
                !file.relative.starts_with("accounts")
            } else {
                file.relative
                    .starts_with(Path::new("accounts").join(account))
            };
            if !owned {
                remaining.push(file.clone());
                continue;
            }
            let target = backup.path.join(&file.relative);
            if !target.exists() {
                continue;
            }
            let resolved = target.canonicalize().map_err(|e| e.to_string())?;
            if !resolved.starts_with(&root) || hash_file(&resolved)? != file.hash {
                return Err("Account backup changed; cleanup requires retry".into());
            }
            fs::remove_file(resolved).map_err(|e| e.to_string())?;
        }
        backup.files = remaining;
        backup.bytes = backup.files.iter().map(|file| file.bytes).sum();
    }
    journal.backups.retain(|backup| !backup.files.is_empty());
    persistence::write_json(&path, &journal, true)?;
    persistence::write_json(&path, &journal, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copies_only_owned_cache_files_and_keeps_originals() {
        let root = std::env::temp_dir().join(format!(
            "notgram-migration-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let from = root.join("old");
        let to = root.join("new");
        fs::create_dir_all(from.join("files")).unwrap();
        fs::create_dir_all(from.join("database")).unwrap();
        fs::write(from.join("files/photo.jpg"), b"photo").unwrap();
        fs::write(from.join("database/db"), b"db").unwrap();
        let backup = migrate(&from, &to).unwrap();
        assert_eq!(backup.bytes, 5);
        assert!(from.join("files/photo.jpg").is_file());
        assert_eq!(fs::read(to.join("files/photo.jpg")).unwrap(), b"photo");
        assert!(!to.join("database").exists());
        assert!(validate_paths(&from, &from.join("files/downloads")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
