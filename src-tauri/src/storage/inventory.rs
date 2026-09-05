use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::AppHandle;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageLayer {
    kind: &'static str,
    path: String,
    bytes: u64,
    files: u64,
    partial: bool,
}

pub(super) fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

fn measure(kind: &'static str, path: PathBuf, exclude: &[PathBuf]) -> StorageLayer {
    fn visit(
        path: &Path,
        exclude: &[PathBuf],
        row: &mut StorageLayer,
        deadline: Instant,
        depth: usize,
    ) {
        if exclude.iter().any(|root| path.starts_with(root)) {
            return;
        }
        if Instant::now() >= deadline || row.files >= 100_000 || depth > 64 {
            row.partial = true;
            return;
        }
        let metadata = match fs::symlink_metadata(path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) => {
                row.partial = true;
                return;
            }
        };
        if is_link(&metadata) {
            row.partial = true;
            return;
        }
        if metadata.is_file() {
            row.bytes += metadata.len();
            row.files += 1;
            return;
        }
        match fs::read_dir(path) {
            Ok(entries) => {
                for entry in entries {
                    if Instant::now() >= deadline {
                        row.partial = true;
                        break;
                    }
                    match entry {
                        Ok(entry) => visit(&entry.path(), exclude, row, deadline, depth + 1),
                        Err(_) => row.partial = true,
                    }
                }
            }
            Err(_) => row.partial = true,
        }
    }
    let mut row = StorageLayer {
        kind,
        path: path.display().to_string(),
        bytes: 0,
        files: 0,
        partial: false,
    };
    visit(
        &path,
        exclude,
        &mut row,
        Instant::now() + Duration::from_secs(2),
        0,
    );
    row
}

#[tauri::command]
pub async fn telegram_storage_inventory(app: AppHandle) -> Result<Vec<StorageLayer>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = super::account::active_account_id(&app)?;
        let root = super::paths::effective_cache_root(&app)?;
        let cache = super::account::account_cache_directory(root.clone(), &account);
        let data = crate::distribution::app_data_directory(&app)?.join("tdlib");
        let database = super::account::account_database_directory(data.clone(), &account);
        let config = crate::distribution::app_config_directory(&app)?;
        let local = super::local_state::account_directory(&app, &account)?;
        let downloads = super::download_directory(&app)?;
        let mut rows = vec![
            measure("database", database.clone(), &[]),
            measure(
                "media",
                cache.join("files"),
                &[cache.join("files/.notgram-sent-media")],
            ),
            measure("staging", cache.join("files/.notgram-sent-media"), &[]),
            measure(
                "snapshot",
                cache.clone(),
                &[
                    cache.join("files"),
                    cache.join("accounts"),
                    cache.join("database"),
                ],
            ),
            measure("unsent", local.clone(), &[]),
            measure(
                "shared",
                config.clone(),
                &[
                    config.join("local-data"),
                    config.join("tdlib"),
                    config.join("diagnostics"),
                ],
            ),
            measure(
                "webview",
                crate::distribution::webview_data_directory(&app)?,
                &[
                    root.clone(),
                    data.clone(),
                    config.clone(),
                    downloads.clone(),
                ],
            ),
            measure("downloads", downloads, &[]),
        ];
        let program = std::env::current_exe().map_err(|e| e.to_string())?;
        rows.push(measure(
            "logs",
            program
                .parent()
                .ok_or("Executable has no parent")?
                .join("logs"),
            &[],
        ));
        rows.push(measure("diagnostics", config.join("diagnostics"), &[]));
        rows.push(measure(
            "otherAccounts",
            root.join("accounts"),
            &if account == "default" {
                vec![]
            } else {
                vec![cache]
            },
        ));
        rows.push(measure("otherUnsent", config.join("local-data"), &[local]));
        if !super::paths_equal(&data, &root) {
            rows.push(measure(
                "otherDatabases",
                data.join("accounts"),
                &[database],
            ));
        }
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counts_files_without_double_counting_excluded_subtrees() {
        let root = std::env::temp_dir().join(format!("notgram-inventory-{}", std::process::id()));
        fs::create_dir_all(root.join("excluded")).unwrap();
        fs::write(root.join("owned"), b"abc").unwrap();
        fs::write(root.join("excluded/exported"), b"12345").unwrap();
        let result = measure("test", root.clone(), &[root.join("excluded")]);
        assert_eq!((result.bytes, result.files, result.partial), (3, 1, false));
        fs::remove_dir_all(root).unwrap();
    }
}
