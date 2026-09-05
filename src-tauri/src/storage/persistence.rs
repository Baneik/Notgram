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
    let _guard = WRITES.lock().map_err(|_| "Persistence lock unavailable")?;
    if path.is_file() {
        let previous = fs::read(path).map_err(|e| e.to_string())?;
        let decoded = if protected {
            crate::proxy::unprotect(&previous)
        } else {
            Ok(previous)
        };
        if decoded
            .and_then(|bytes| {
                serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|e| e.to_string())
            })
            .is_err()
        {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            fs::rename(path, path.with_extension(format!("corrupt-{stamp}")))
                .map_err(|e| e.to_string())?;
        }
    }
    atomic_write_inner(path, &bytes)
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let _guard = WRITES.lock().map_err(|_| "Persistence lock unavailable")?;
    atomic_write_inner(path, bytes)
}

fn atomic_write_inner(path: &Path, bytes: &[u8]) -> Result<(), String> {
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
    #[test]
    fn failed_write_preserves_primary_and_backup_and_corrupt_evidence() {
        let root =
            std::env::temp_dir().join(format!("notgram-failed-write-{}", std::process::id()));
        let path = root.join("record.json");
        write_json(&path, &vec![1], false).unwrap();
        write_json(&path, &vec![2], false).unwrap();
        fs::create_dir(path.with_extension("tmp")).unwrap();
        assert!(write_json(&path, &vec![3], false).is_err());
        assert_eq!(read_json::<Vec<u32>>(&path, false).unwrap(), Some(vec![2]));
        fs::remove_dir(path.with_extension("tmp")).unwrap();
        fs::write(&path, b"broken").unwrap();
        write_json(&path, &vec![4], false).unwrap();
        assert_eq!(read_json::<Vec<u32>>(&path, false).unwrap(), Some(vec![4]));
        assert_eq!(
            read_json::<Vec<u32>>(&path.with_extension("bak"), false).unwrap(),
            Some(vec![1])
        );
        assert!(
            fs::read_dir(&root)
                .unwrap()
                .flatten()
                .any(|entry| entry.file_name().to_string_lossy().contains("corrupt-"))
        );
        fs::remove_dir_all(root).unwrap();
    }
}
