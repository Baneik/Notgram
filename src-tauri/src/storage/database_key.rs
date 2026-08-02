use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const LEGACY_EMPTY_DATABASE_KEY_MARKER: &str = "notgram:legacy-empty-database-key:v1";

pub fn database_encryption_key(app: &AppHandle) -> Result<String, String> {
    if let Some(configured) = env::var("NOTGRAM_DATABASE_KEY_BASE64")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(configured);
    }

    let path = database_key_path(app, &super::active_account_id(app)?)?;
    if let Some(record) = read_protected_string(&path)? {
        return Ok(database_key_from_record(&record));
    }

    let database_directory = super::tdlib_database_directory(app)?;
    if directory_has_entries(&database_directory)? {
        // Preserve the empty key used before per-account keys were introduced.
        write_protected_string(&path, LEGACY_EMPTY_DATABASE_KEY_MARKER)?;
        return Ok(String::new());
    }

    let key = generate_database_key()?;
    write_protected_string(&path, &key)?;
    Ok(key)
}

fn database_key_from_record(record: &str) -> String {
    if record == LEGACY_EMPTY_DATABASE_KEY_MARKER {
        String::new()
    } else {
        record.to_string()
    }
}

fn database_key_path(app: &AppHandle, account_id: &str) -> Result<PathBuf, String> {
    super::account::validate_account_id(account_id)?;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Unable to resolve app config directory: {error}"))?
        .join("database-keys");
    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "Unable to create database key directory {}: {error}",
            directory.display()
        )
    })?;
    Ok(directory.join(format!("{account_id}.dat")))
}

pub(super) fn remove_database_key(app: &AppHandle, account_id: &str) -> Result<(), String> {
    let path = database_key_path(app, account_id)?;
    for candidate in [
        &path,
        &path.with_extension("tmp"),
        &path.with_extension("bak"),
    ] {
        if candidate.exists() {
            fs::remove_file(candidate).map_err(|error| {
                format!(
                    "Unable to remove database key {}: {error}",
                    candidate.display()
                )
            })?;
        }
    }
    Ok(())
}

fn read_protected_string(path: &Path) -> Result<Option<String>, String> {
    let backup = path.with_extension("bak");
    let readable = if path.is_file() {
        path
    } else if backup.is_file() {
        &backup
    } else {
        return Ok(None);
    };
    let protected = fs::read(readable).map_err(|error| {
        format!(
            "Unable to read protected value {}: {error}",
            readable.display()
        )
    })?;
    let value = String::from_utf8(crate::proxy::unprotect(&protected)?)
        .map_err(|_| "Protected database key is not valid UTF-8".to_string())?;
    if value.trim().is_empty() {
        return Err("Protected database key is empty".to_string());
    }
    Ok(Some(value))
}

fn write_protected_string(path: &Path, value: &str) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let backup = path.with_extension("bak");
    let protected = crate::proxy::protect(value.as_bytes())?;
    let mut file = fs::File::create(&temporary).map_err(|error| {
        format!(
            "Unable to create database key {}: {error}",
            temporary.display()
        )
    })?;
    file.write_all(&protected).map_err(|error| {
        format!(
            "Unable to write database key {}: {error}",
            temporary.display()
        )
    })?;
    file.sync_all().map_err(|error| {
        format!(
            "Unable to flush database key {}: {error}",
            temporary.display()
        )
    })?;
    if backup.exists() {
        fs::remove_file(&backup)
            .map_err(|error| format!("Unable to remove old database key backup: {error}"))?;
    }
    if path.exists() {
        fs::rename(path, &backup).map_err(|error| {
            format!("Unable to rotate database key {}: {error}", path.display())
        })?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(format!(
            "Unable to replace database key {}: {error}",
            path.display()
        ));
    }
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn directory_has_entries(path: &Path) -> Result<bool, String> {
    if !path.is_dir() {
        return Ok(false);
    }
    Ok(fs::read_dir(path)
        .map_err(|error| format!("Unable to inspect TDLib database directory: {error}"))?
        .next()
        .transpose()
        .map_err(|error| format!("Unable to inspect TDLib database entry: {error}"))?
        .is_some())
}

fn generate_database_key() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Unable to generate TDLib database key: {error}"))?;
    Ok(STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_strong_database_keys() {
        let first = generate_database_key().unwrap();
        let second = generate_database_key().unwrap();

        assert_ne!(first, second);
        assert_eq!(STANDARD.decode(first).unwrap().len(), 32);
        assert_eq!(STANDARD.decode(second).unwrap().len(), 32);
    }

    #[test]
    fn preserves_legacy_empty_database_keys_during_upgrade() {
        assert_eq!(
            database_key_from_record(LEGACY_EMPTY_DATABASE_KEY_MARKER),
            ""
        );
        assert_eq!(database_key_from_record("stored-key"), "stored-key");
    }
}
