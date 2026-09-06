use serde_json::{Value, json};
use std::path::PathBuf;
use tauri::AppHandle;

pub(super) const LOCAL_FIELDS: [&str; 3] = ["drafts", "localAttachmentDrafts", "outbox"];

pub(crate) fn account_directory(app: &AppHandle, account_id: &str) -> Result<PathBuf, String> {
    super::account::validate_account_id(account_id)?;
    Ok(crate::distribution::app_config_directory(app)?
        .join("local-data")
        .join(account_id))
}

fn path(app: &AppHandle, account_id: &str) -> Result<PathBuf, String> {
    Ok(account_directory(app, account_id)?.join("unsent.dat"))
}

pub(super) fn read(app: &AppHandle, account_id: &str) -> Result<Option<Value>, String> {
    super::persistence::read_json(&path(app, account_id)?, true)
}

pub(super) fn write(app: &AppHandle, account_id: &str, value: &Value) -> Result<(), String> {
    let mut record =
        json!({"version": 1, "currentUserId": value["currentUserId"], "savedAt": value["savedAt"]});
    for field in LOCAL_FIELDS {
        let entries = value
            .get(field)
            .and_then(Value::as_array)
            .ok_or("Invalid local state section")?;
        if entries.iter().any(|entry| !entry.is_object()) {
            return Err("Invalid local state entry".into());
        }
        record[field] = Value::Array(entries.clone());
    }
    // Unsent content must never be evicted to satisfy a cache budget.
    if serde_json::to_vec(&record)
        .map_err(|e| e.to_string())?
        .len()
        > 32 * 1024 * 1024
    {
        return Err("Local drafts and outbox exceed the 32 MiB metadata limit; send or remove items before adding more".into());
    }
    super::persistence::write_json(&path(app, account_id)?, &record, true)
}

#[tauri::command]
pub async fn telegram_read_local_state(
    app: AppHandle,
    account_id: String,
) -> Result<Option<Value>, String> {
    if super::account::active_account_id(&app)? != account_id {
        return Err("Account changed during local read".into());
    }
    tauri::async_runtime::spawn_blocking(move || read(&app, &account_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn telegram_write_local_state(
    app: AppHandle,
    account_id: String,
    value: Value,
) -> Result<(), String> {
    if super::account::active_account_id(&app)? != account_id {
        return Err("Account changed during local save".into());
    }
    tauri::async_runtime::spawn_blocking(move || write(&app, &account_id, &value))
        .await
        .map_err(|e| e.to_string())?
}
