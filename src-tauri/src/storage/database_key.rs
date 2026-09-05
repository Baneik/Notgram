use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::AppHandle;

const LEGACY_EMPTY_DATABASE_KEY_MARKER: &str = "notgram:legacy-empty-database-key:v1";

pub fn database_encryption_key(app: &AppHandle) -> Result<String, String> {
    if let Some(configured) = crate::development::environment_value("NOTGRAM_DATABASE_KEY_BASE64")
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
    let directory = crate::distribution::app_config_directory(app)?.join("database-keys");
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
    let mut error = None;
    for candidate in [path.to_path_buf(), path.with_extension("bak")] {
        if !candidate.is_file() {
            continue;
        }
        let result = fs::read(&candidate)
            .map_err(|e| e.to_string())
            .and_then(|bytes| crate::proxy::unprotect(&bytes))
            .and_then(|bytes| {
                String::from_utf8(bytes).map_err(|_| "Protected key is not UTF-8".to_string())
            })
            .and_then(|value| {
                if value.trim().is_empty() {
                    Err("Protected key is empty".to_string())
                } else {
                    Ok(value)
                }
            });
        match result {
            Ok(value) => return Ok(Some(value)),
            Err(cause) => error = Some(cause),
        }
    }
    match error {
        Some(error) => Err(error),
        None => Ok(None),
    }
}

fn write_protected_string(path: &Path, value: &str) -> Result<(), String> {
    super::persistence::atomic_write(path, &crate::proxy::protect(value.as_bytes())?)
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
