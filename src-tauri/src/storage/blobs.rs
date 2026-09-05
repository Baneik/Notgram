//! Immutable, account-owned encrypted blobs shared by local drafts and uploads.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::AppHandle;

pub const CHUNK_BYTES: usize = 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
static OPERATIONS: Mutex<()> = Mutex::new(());

fn contains_id(value: &serde_json::Value, id: &str) -> bool {
    match value {
        serde_json::Value::Object(object) => object.iter().any(|(key, value)| {
            ((key == "batchId" || key == "id") && value.as_str() == Some(id))
                || contains_id(value, id)
        }),
        serde_json::Value::Array(values) => values.iter().any(|value| contains_id(value, id)),
        _ => false,
    }
}

fn referenced(app: &AppHandle, account_id: &str, id: &str) -> Result<bool, String> {
    let path = super::local_state::account_directory(app, account_id)?.join("unsent.dat");
    for path in [path.clone(), path.with_extension("bak")] {
        if let Some(value) = super::persistence::read_json::<serde_json::Value>(&path, true)?
            && contains_id(&value, id)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[tauri::command]
pub fn telegram_attachment_inventory(
    app: AppHandle,
    account_id: String,
    collect_garbage: bool,
) -> Result<Vec<serde_json::Value>, String> {
    check_account(&app, &account_id)?;
    let _guard = OPERATIONS
        .lock()
        .map_err(|_| "Attachment storage unavailable")?;
    let account = super::local_state::account_directory(&app, &account_id)?;
    let batches = account.join("batches");
    let mut result = Vec::new();
    let mut tokens = std::collections::HashSet::new();
    if batches.is_dir() {
        for entry in fs::read_dir(&batches).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if !path
                .extension()
                .is_some_and(|extension| extension == "dat" || extension == "bak")
            {
                continue;
            }
            if let Some(value) = super::persistence::read_json::<serde_json::Value>(&path, true)?
                && let Some(files) = value["files"].as_array()
            {
                for file in files {
                    if let Some(token) = file["token"].as_str() {
                        tokens.insert(token.to_owned());
                    }
                }
                if path.extension().is_some_and(|extension| extension == "dat") {
                    let id = value["id"].as_str().ok_or("Invalid attachment manifest")?;
                    result.push(serde_json::json!({
                            "id": id, "createdAt": value["createdAt"], "persistent": value["persistent"],
                            "metadata": value["metadata"], "recovery": value["recovery"],
                            "bytes": files.iter().filter_map(|file| file["size"].as_u64()).sum::<u64>(),
                            "referenced": referenced(&app, &account_id, id)?
                        }));
                }
            }
        }
    }
    let blobs = root(&app, &account_id)?;
    if collect_garbage && blobs.is_dir() {
        for entry in fs::read_dir(&blobs).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let token = entry.file_name().to_string_lossy().into_owned();
            if tokens.contains(&token) {
                continue;
            }
            let path = directory(&app, &account_id, &token)?;
            let old = path
                .join("blob.dat")
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|time| time.elapsed().ok())
                .is_some_and(|age| age.as_secs() > 86400);
            // Draft/outbox versions remain discoverable indefinitely. Only
            // unreferenced staging blobs have a 24-hour crash recovery grace.
            if old
                && !super::inventory::is_link(
                    &fs::symlink_metadata(&path).map_err(|e| e.to_string())?,
                )
            {
                fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(result)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobRecord {
    pub token: String,
    pub size: u64,
    pub written: u64,
    pub chunks: Vec<String>,
    pub fingerprint: Option<String>,
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn root(app: &AppHandle, account_id: &str) -> Result<PathBuf, String> {
    Ok(super::local_state::account_directory(app, account_id)?.join("blobs"))
}

fn directory(app: &AppHandle, account_id: &str, token: &str) -> Result<PathBuf, String> {
    if token.len() != 32 || !token.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid attachment token".into());
    }
    Ok(root(app, account_id)?.join(token))
}

fn check_account(app: &AppHandle, account_id: &str) -> Result<(), String> {
    if super::account::active_account_id(app)? != account_id {
        return Err("Attachment account is no longer active".into());
    }
    Ok(())
}

pub(crate) fn record(app: &AppHandle, account_id: &str, token: &str) -> Result<BlobRecord, String> {
    super::persistence::read_json(&directory(app, account_id, token)?.join("blob.dat"), true)?
        .ok_or("Attachment data is missing".into())
}

fn chunk(directory: &Path, record: &BlobRecord, index: usize) -> Result<Vec<u8>, String> {
    let expected = record.chunks.get(index).ok_or("Invalid attachment chunk")?;
    let encrypted = fs::read(directory.join(format!("{index}.dat"))).map_err(|e| e.to_string())?;
    let bytes = crate::proxy::unprotect(&encrypted)?;
    if hex(Sha256::digest(&bytes)) != *expected {
        return Err("Attachment integrity verification failed".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub fn telegram_begin_blob(
    app: AppHandle,
    account_id: String,
    size: u64,
) -> Result<String, String> {
    check_account(&app, &account_id)?;
    if size > MAX_FILE_BYTES {
        return Err("Attachment exceeds the 512 MiB limit".into());
    }
    telegram_attachment_inventory(app.clone(), account_id.clone(), true)?;
    let _guard = OPERATIONS
        .lock()
        .map_err(|_| "Attachment storage unavailable")?;
    // Reserve quota before accepting bytes, across accounts and unfinished writes.
    let all_accounts = crate::distribution::app_config_directory(&app)?.join("local-data");
    let mut reserved = 0_u64;
    let mut count = 0;
    if all_accounts.exists() {
        for account in fs::read_dir(&all_accounts).map_err(|e| e.to_string())? {
            let blobs = account.map_err(|e| e.to_string())?.path().join("blobs");
            if !blobs.is_dir() {
                continue;
            }
            for entry in fs::read_dir(blobs).map_err(|e| e.to_string())? {
                let path = entry.map_err(|e| e.to_string())?.path().join("blob.dat");
                if let Some(blob) = super::persistence::read_json::<BlobRecord>(&path, true)? {
                    reserved = reserved.saturating_add(blob.size);
                    count += 1;
                }
            }
        }
    }
    if reserved.saturating_add(size) > MAX_TOTAL_BYTES || count >= 2000 {
        return Err(
            "Attachment storage quota reached; send or remove existing drafts first".into(),
        );
    }
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    let token = hex(random);
    let path = directory(&app, &account_id, &token)?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    super::persistence::write_json(
        &path.join("blob.dat"),
        &BlobRecord {
            token: token.clone(),
            size,
            written: 0,
            chunks: Vec::new(),
            fingerprint: None,
        },
        true,
    )?;
    Ok(token)
}

#[tauri::command]
pub fn telegram_append_blob(
    app: AppHandle,
    account_id: String,
    token: String,
    offset: u64,
    data_base64: String,
) -> Result<(), String> {
    check_account(&app, &account_id)?;
    if data_base64.len() > CHUNK_BYTES.div_ceil(3) * 4 {
        return Err("Attachment chunk too large".into());
    }
    let bytes = STANDARD.decode(data_base64).map_err(|e| e.to_string())?;
    let _guard = OPERATIONS
        .lock()
        .map_err(|_| "Attachment storage unavailable")?;
    let mut value = record(&app, &account_id, &token)?;
    if value.fingerprint.is_some()
        || offset != value.written
        || bytes.is_empty()
        || bytes.len() > CHUNK_BYTES
        || offset + bytes.len() as u64 > value.size
    {
        return Err("Invalid attachment write sequence".into());
    }
    let path = directory(&app, &account_id, &token)?;
    super::persistence::atomic_write(
        &path.join(format!("{}.dat", value.chunks.len())),
        &crate::proxy::protect(&bytes)?,
    )?;
    value.chunks.push(hex(Sha256::digest(&bytes)));
    value.written += bytes.len() as u64;
    super::persistence::write_json(&path.join("blob.dat"), &value, true)
}

#[tauri::command]
pub fn telegram_commit_blob(
    app: AppHandle,
    account_id: String,
    token: String,
) -> Result<BlobRecord, String> {
    check_account(&app, &account_id)?;
    let _guard = OPERATIONS
        .lock()
        .map_err(|_| "Attachment storage unavailable")?;
    let mut value = record(&app, &account_id, &token)?;
    if value.size != value.written {
        return Err("Attachment write is incomplete".into());
    }
    let path = directory(&app, &account_id, &token)?;
    let mut digest = Sha256::new();
    for index in 0..value.chunks.len() {
        digest.update(chunk(&path, &value, index)?);
    }
    value.fingerprint = Some(hex(digest.finalize()));
    super::persistence::write_json(&path.join("blob.dat"), &value, true)?;
    Ok(value)
}

#[tauri::command]
pub fn telegram_read_blob_chunk(
    app: AppHandle,
    account_id: String,
    token: String,
    index: usize,
) -> Result<String, String> {
    check_account(&app, &account_id)?;
    let value = record(&app, &account_id, &token)?;
    if value.fingerprint.is_none() {
        return Err("Attachment is not committed".into());
    }
    Ok(STANDARD.encode(chunk(
        &directory(&app, &account_id, &token)?,
        &value,
        index,
    )?))
}

pub(crate) fn materialize(
    app: &AppHandle,
    token: &str,
    destination: &Path,
    limit: u64,
) -> Result<(), String> {
    let account_id = super::account::active_account_id(app)?;
    let value = record(app, &account_id, token)?;
    materialize_record(
        &directory(app, &account_id, token)?,
        &value,
        destination,
        limit,
    )
}

fn materialize_record(
    path: &Path,
    value: &BlobRecord,
    destination: &Path,
    limit: u64,
) -> Result<(), String> {
    let expected = value
        .fingerprint
        .as_ref()
        .ok_or("Attachment is not committed")?;
    if value.size > limit {
        return Err("Attachment exceeds this upload type's limit".into());
    }
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    for index in 0..value.chunks.len() {
        let data = chunk(path, value, index)?;
        digest.update(&data);
        bytes += data.len() as u64;
        output.write_all(&data).map_err(|e| e.to_string())?;
    }
    if hex(digest.finalize()) != *expected || bytes != value.size {
        return Err("Attachment integrity verification failed".into());
    }
    output.sync_all().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn telegram_attachment_batch(
    app: AppHandle,
    account_id: String,
    id: String,
    value: Option<serde_json::Value>,
    remove: bool,
) -> Result<Option<serde_json::Value>, String> {
    check_account(&app, &account_id)?;
    if id.len() > 200 {
        return Err("Invalid attachment batch identifier".into());
    }
    let _guard = OPERATIONS
        .lock()
        .map_err(|_| "Attachment storage unavailable")?;
    let root = super::local_state::account_directory(&app, &account_id)?.join("batches");
    let path = root.join(format!("{}.dat", hex(Sha256::digest(id.as_bytes()))));
    if remove {
        if referenced(&app, &account_id, &id)? {
            return Ok(None);
        }
        for path in [
            &path,
            &path.with_extension("bak"),
            &path.with_extension("tmp"),
        ] {
            if path.exists() {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
        return Ok(None);
    }
    if let Some(value) = value {
        if value["id"].as_str() != Some(&id) || value["accountId"].as_str() != Some(&account_id) {
            return Err("Attachment batch ownership mismatch".into());
        }
        let files = value["files"]
            .as_array()
            .ok_or("Invalid attachment batch")?;
        if files.len() > 200
            || serde_json::to_vec(&value).map_err(|e| e.to_string())?.len() > 1024 * 1024
        {
            return Err("Attachment batch metadata exceeds limit".into());
        }
        let mut bytes = 0_u64;
        for file in files {
            let blob = record(
                &app,
                &account_id,
                file["token"].as_str().ok_or("Attachment token missing")?,
            )?;
            if blob.fingerprint.is_none()
                || blob.fingerprint.as_deref() != file["fingerprint"].as_str()
                || Some(blob.size) != file["size"].as_u64()
            {
                return Err("Attachment manifest is inconsistent".into());
            }
            bytes = bytes.saturating_add(blob.size);
        }
        if bytes > MAX_FILE_BYTES {
            return Err("Attachment batch exceeds 512 MiB".into());
        }
        if !path.exists() {
            let all_accounts = crate::distribution::app_config_directory(&app)?.join("local-data");
            let mut count = 0;
            for account in fs::read_dir(all_accounts).map_err(|e| e.to_string())? {
                let folder = account.map_err(|e| e.to_string())?.path().join("batches");
                if !folder.is_dir() {
                    continue;
                }
                count += fs::read_dir(folder)
                    .map_err(|e| e.to_string())?
                    .filter_map(Result::ok)
                    .filter(|entry| {
                        entry
                            .path()
                            .extension()
                            .is_some_and(|extension| extension == "dat")
                    })
                    .count();
            }
            if count >= 50 {
                return Err("Attachment batch quota reached".into());
            }
        }
        super::persistence::write_json(&path, &value, true)?;
        return Ok(Some(value));
    }
    super::persistence::read_json(&path, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streams_above_legacy_64_mib_and_detects_changed_chunks() {
        let root = std::env::temp_dir().join(format!(
            "notgram-blob-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let data = vec![0x6a; CHUNK_BYTES];
        let encrypted = crate::proxy::protect(&data).unwrap();
        let hash = hex(Sha256::digest(&data));
        let mut digest = Sha256::new();
        for index in 0..65 {
            fs::write(root.join(format!("{index}.dat")), &encrypted).unwrap();
            digest.update(&data);
        }
        let record = BlobRecord {
            token: "a".repeat(32),
            size: 65 * CHUNK_BYTES as u64,
            written: 65 * CHUNK_BYTES as u64,
            chunks: vec![hash; 65],
            fingerprint: Some(hex(digest.finalize())),
        };
        let output = root.join("exported");
        materialize_record(&root, &record, &output, MAX_FILE_BYTES).unwrap();
        assert_eq!(fs::metadata(&output).unwrap().len(), record.size);
        assert!(materialize_record(&root, &record, &output, MAX_FILE_BYTES).is_err());
        assert!(
            materialize_record(
                &root,
                &record,
                &root.join("too-large"),
                64 * CHUNK_BYTES as u64
            )
            .is_err()
        );
        assert!(!root.join("too-large").exists());
        fs::write(
            root.join("0.dat"),
            crate::proxy::protect(b"tampered").unwrap(),
        )
        .unwrap();
        assert!(chunk(&root, &record, 0).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
