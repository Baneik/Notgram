//! Small durable records. Keep the last readable generation and never delete
//! the only copy in response to a read, parse, or disk-full error.
use serde::{Serialize, de::DeserializeOwned};
use std::{fs, io::Write, path::Path, sync::Mutex};

static WRITES: Mutex<()> = Mutex::new(());

pub(crate) fn read_json<T: DeserializeOwned>(
    path: &Path,
    protected: bool,
) -> Result<Option<T>, String> {
    let _guard = WRITES.lock().map_err(|_| "Persistence lock unavailable")?;
    let mut failure = None;
    for candidate in [path.to_path_buf(), path.with_extension("bak")] {
        if !candidate.exists() {
            continue;
        }
        let result = (|| {
            let bytes = fs::read(&candidate).map_err(|e| e.to_string())?;
            let bytes = if protected {
                crate::proxy::unprotect(&bytes)?
            } else {
                bytes
            };
            serde_json::from_slice(&bytes).map_err(|e| format!("Invalid durable record: {e}"))
        })();
        match result {
            Ok(value) => return Ok(Some(value)),
            Err(error) => failure = Some(error),
        }
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(None),
    }
}

pub(crate) fn write_json<T: Serialize>(
    path: &Path,
    value: &T,
    protected: bool,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let bytes = if protected {
        crate::proxy::protect(&bytes)?
    } else {
        bytes
    };
    atomic_write(path, &bytes)
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let _guard = WRITES.lock().map_err(|_| "Persistence lock unavailable")?;
    let parent = path.parent().ok_or("Durable record requires a directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("tmp");
    let backup = path.with_extension("bak");
    let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    if path.exists() {
        if backup.exists() {
            fs::remove_file(&backup).map_err(|e| e.to_string())?;
        }
        fs::rename(path, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        if !path.exists() && backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_last_good_generation_when_primary_is_corrupt() {
        let root = std::env::temp_dir().join(format!(
            "notgram-record-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = root.join("record.json");
        write_json(&path, &vec![1], false).unwrap();
        write_json(&path, &vec![2], false).unwrap();
        fs::write(&path, b"broken").unwrap();
        assert_eq!(read_json::<Vec<u32>>(&path, false).unwrap(), Some(vec![1]));
        assert!(path.is_file());
        fs::remove_dir_all(root).unwrap();
    }
}
