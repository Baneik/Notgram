//! Small durable records. Keep the last readable generation and never delete
//! the only copy in response to a read, parse, or disk-full error.
use serde::{Serialize, de::DeserializeOwned};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};

type RecordLocks = HashMap<PathBuf, Weak<Mutex<()>>>;
static RECORD_LOCKS: OnceLock<Mutex<RecordLocks>> = OnceLock::new();

fn record_lock(path: &Path) -> Result<Arc<Mutex<()>>, String> {
    // Primary, .bak and .tmp share a rotation namespace. This also protects a
    // direct recovery read and primaries whose extensions differ.
    let key = std::path::absolute(path)
        .map_err(|error| error.to_string())?
        .with_extension("");
    #[cfg(windows)]
    let key = PathBuf::from(key.to_string_lossy().to_lowercase());
    let mut locks = RECORD_LOCKS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Persistence lock registry unavailable")?;
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    // Serialize a primary record and its rotation, not unrelated records. A
    // large snapshot read/write must never hold up account metadata or input.
    locks.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

pub(crate) fn read_json<T: DeserializeOwned>(
    path: &Path,
    protected: bool,
) -> Result<Option<T>, String> {
    let lock = record_lock(path)?;
    let _guard = lock.lock().map_err(|_| "Persistence lock unavailable")?;
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
    let lock = record_lock(path)?;
    let _guard = lock.lock().map_err(|_| "Persistence lock unavailable")?;
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
    let lock = record_lock(path)?;
    let _guard = lock.lock().map_err(|_| "Persistence lock unavailable")?;
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
    fn unrelated_records_progress_while_a_snapshot_transaction_is_locked() {
        use std::{sync::mpsc, thread, time::Duration};
        let root =
            std::env::temp_dir().join(format!("notgram-record-concurrency-{}", std::process::id()));
        let snapshot = root.join("snapshot.dat");
        let metadata = root.join("metadata.dat");
        write_json(&metadata, &vec![1], false).unwrap();
        let lock = record_lock(&snapshot).unwrap();
        let guard = lock.lock().unwrap();
        let (ready, result) = mpsc::channel();
        let worker_path = metadata.clone();
        let worker = thread::spawn(move || {
            let read = read_json::<Vec<u32>>(&worker_path, false);
            ready.send(read).unwrap();
        });
        let progress = result.recv_timeout(Duration::from_millis(250));
        drop(guard);
        worker.join().unwrap();
        fs::remove_dir_all(root).unwrap();
        assert_eq!(progress.unwrap(), Ok(Some(vec![1])));
    }

    #[test]
    fn concurrent_writers_preserve_primary_and_recovery_generations() {
        use std::{sync::Barrier, thread};
        let root =
            std::env::temp_dir().join(format!("notgram-record-writers-{}", std::process::id()));
        let path = root.join("record.json");
        let barrier = Arc::new(Barrier::new(3));
        let workers: Vec<_> = (0..3)
            .map(|writer| {
                let path = path.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    for version in 0..8 {
                        write_json(&path, &vec![writer, version], false).unwrap();
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        for candidate in [&path, &path.with_extension("bak")] {
            let record = read_json::<Vec<u32>>(candidate, false).unwrap().unwrap();
            assert_eq!(record.len(), 2);
            assert!(record[0] < 3 && record[1] < 8);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_read_waits_for_its_primary_rotation() {
        use std::{sync::mpsc, thread, time::Duration};
        let root =
            std::env::temp_dir().join(format!("notgram-record-recovery-{}", std::process::id()));
        let path = root.join("record.json");
        write_json(&path, &vec![1], false).unwrap();
        write_json(&path, &vec![2], false).unwrap();
        let lock = record_lock(&path).unwrap();
        let guard = lock.lock().unwrap();
        let (entered, wait_for_entry) = mpsc::channel();
        let (finished, result) = mpsc::channel();
        let worker_path = path.with_extension("bak");
        let worker = thread::spawn(move || {
            entered.send(()).unwrap();
            finished
                .send(read_json::<Vec<u32>>(&worker_path, false))
                .unwrap();
        });
        wait_for_entry.recv().unwrap();
        let early = result.recv_timeout(Duration::from_millis(40));
        drop(guard);
        let completed = if early.is_err() {
            result.recv_timeout(Duration::from_secs(1)).unwrap()
        } else {
            early.clone().unwrap()
        };
        worker.join().unwrap();
        fs::remove_dir_all(root).unwrap();
        assert!(matches!(early, Err(mpsc::RecvTimeoutError::Timeout)));
        assert_eq!(completed, Ok(Some(vec![1])));
    }
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
