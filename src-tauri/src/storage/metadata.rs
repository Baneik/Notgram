use serde_json::Value;
use tauri::AppHandle;

const KEYS: [&str; 3] = [
    "notgram:managed-downloads:v1",
    "notgram:local-user-blocks:v1",
    "notgram:conversation-activity:v1",
];

fn path(app: &AppHandle, key: &str) -> Result<std::path::PathBuf, String> {
    let index = KEYS
        .iter()
        .position(|candidate| *candidate == key)
        .ok_or("Invalid metadata key")?;
    Ok(crate::distribution::app_config_directory(app)?
        .join("account-metadata")
        .join(format!("{index}.dat")))
}

#[tauri::command]
pub fn telegram_read_account_metadata(
    app: AppHandle,
    key: String,
) -> Result<Option<Vec<Value>>, String> {
    super::persistence::read_json(&path(&app, &key)?, true)
}

#[tauri::command]
pub fn telegram_write_account_metadata(
    app: AppHandle,
    key: String,
    records: Vec<Value>,
) -> Result<(), String> {
    if records.len() > 10_000
        || serde_json::to_vec(&records)
            .map_err(|e| e.to_string())?
            .len()
            > 8 * 1024 * 1024
    {
        return Err("Account metadata exceeds storage budget".into());
    }
    for record in &records {
        super::account::validate_account_id(
            record["accountId"]
                .as_str()
                .ok_or("Metadata account missing")?,
        )?;
    }
    super::persistence::write_json(&path(&app, &key)?, &records, true)
}

pub(super) fn remove_account(app: &AppHandle, account_id: &str) -> Result<(), String> {
    for key in KEYS {
        let path = path(app, key)?;
        if let Some(mut records) = super::persistence::read_json::<Vec<Value>>(&path, true)? {
            records.retain(|record| record["accountId"].as_str() != Some(account_id));
            // Rotate twice: neither recovery generation may retain a logged-out identity.
            super::persistence::write_json(&path, &records, true)?;
            super::persistence::write_json(&path, &records, true)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn telegram_locate_download(app: AppHandle, file_id: i64) -> Result<(), String> {
    let account = super::account::active_account_id(&app)?;
    let records =
        telegram_read_account_metadata(app.clone(), KEYS[0].to_string())?.unwrap_or_default();
    let saved = records
        .iter()
        .find(|record| {
            record["accountId"].as_str() == Some(&account)
                && record["fileId"].as_i64() == Some(file_id)
        })
        .and_then(|record| record["savedPath"].as_str())
        .ok_or("Saved download location is unavailable")?;
    let path = std::path::Path::new(saved);
    if !path.is_absolute() || !path.is_file() {
        return Err("Saved download was moved or deleted".into());
    }
    super::file_actions::open_path(path.parent().ok_or("Saved download has no parent")?)
}
