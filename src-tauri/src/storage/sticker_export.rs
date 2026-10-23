use super::{account::active_account_id, file_actions, persistence, trusted_tdlib_files_directory};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, Window};
use tauri_plugin_dialog::DialogExt;
use zip::{ZipWriter, write::SimpleFileOptions};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickerExportDirectory {
    directory: String,
    account_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StickerExportFile {
    source_path: String,
    file_name: String,
}

fn initial_directory(record: &Path, downloads: PathBuf) -> PathBuf {
    persistence::read_json::<PathBuf>(record, true)
        .ok()
        .flatten()
        .filter(|path| path.is_absolute() && path.is_dir())
        .unwrap_or(downloads)
}

#[tauri::command]
pub async fn telegram_choose_sticker_export_directory(
    app: AppHandle,
    window: Window,
    title: String,
) -> Result<Option<StickerExportDirectory>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account_id = active_account_id(&app)?;
        let record =
            crate::distribution::app_data_directory(&app)?.join("sticker-export-directory.json");
        let directory = initial_directory(
            &record,
            app.path()
                .download_dir()
                .map_err(|error| error.to_string())?,
        );
        let Some(selected) = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title(title)
            .set_directory(directory)
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        if account_id != active_account_id(&app)? {
            return Err("Sticker export account changed".to_string());
        }
        let directory = selected.into_path().map_err(|error| error.to_string())?;
        if !directory.is_absolute() || !directory.is_dir() {
            return Err("Sticker export directory is unavailable".to_string());
        }
        // This local path is deliberately separate from synced preferences.
        persistence::write_json(&record, &directory, true)?;
        Ok(Some(StickerExportDirectory {
            directory: directory.to_string_lossy().into_owned(),
            account_id,
        }))
    })
    .await
    .map_err(|error| format!("Unable to join sticker directory worker: {error}"))?
}

#[tauri::command]
pub async fn telegram_export_stickers(
    app: AppHandle,
    directory: String,
    account_id: String,
    name: String,
    files: Vec<StickerExportFile>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let validate = |source: &Path| {
            if account_id != active_account_id(&app)? {
                return Err("Sticker export account changed".to_string());
            }
            let source = file_actions::canonical_file_within_roots(
                source,
                &[trusted_tdlib_files_directory(&app)?],
            )?;
            app.state::<crate::telegram::media_stream::MediaStreamRegistry>()
                .check_export(&source)?;
            Ok(source)
        };
        write_export(Path::new(&directory), &name, &files, validate).map(|_| ())
    })
    .await
    .map_err(|error| format!("Unable to join sticker export worker: {error}"))?
}

fn safe_export_name(value: &str) -> String {
    let name: String = value
        .chars()
        .take(120)
        .map(|c| {
            if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let name = name.trim_matches([' ', '.']);
    if name.is_empty() {
        return "stickers".to_string();
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
        || (stem.chars().count() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.chars().last(), Some('1'..='9' | '¹' | '²' | '³')))
    {
        format!("_{name}")
    } else {
        name.to_string()
    }
}

fn write_export(
    directory: &Path,
    name: &str,
    files: &[StickerExportFile],
    validate: impl Fn(&Path) -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    if files.is_empty() || files.len() > 1_000 {
        return Err("Sticker export must contain between 1 and 1000 files".to_string());
    }
    if !directory.is_absolute() || !directory.is_dir() {
        return Err("Sticker export directory is unavailable".to_string());
    }
    let mut names = HashSet::new();
    let entries = files
        .iter()
        .map(|file| {
            let (stem, extension) = file
                .file_name
                .rsplit_once('.')
                .ok_or("Invalid sticker filename")?;
            let file_name = format!("{}.{}", safe_export_name(stem), extension);
            if !matches!(extension, "webp" | "webm" | "tgs")
                || !names.insert(file_name.to_lowercase())
            {
                return Err("Invalid or duplicate sticker export filename".to_string());
            }
            Ok((validate(Path::new(&file.source_path))?, file_name))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let file_name = if files.len() == 1 {
        entries[0].1.clone()
    } else {
        format!("{}.zip", safe_export_name(name))
    };
    let (destination, mut output) = file_actions::reserve_download(directory, &file_name)?;
    let result = (|| {
        if files.len() == 1 {
            let source = validate(&entries[0].0)?;
            io::copy(
                &mut fs::File::open(source).map_err(|e| e.to_string())?,
                &mut output,
            )
            .map_err(|e| e.to_string())?;
        } else {
            // Stream originals from disk; large packs never occupy one in-memory buffer.
            let mut archive = ZipWriter::new(&mut output);
            for (source, file_name) in &entries {
                let source = validate(source)?;
                archive
                    .start_file(file_name, SimpleFileOptions::default())
                    .map_err(|e| e.to_string())?;
                io::copy(
                    &mut fs::File::open(source).map_err(|e| e.to_string())?,
                    &mut archive,
                )
                .map_err(|e| e.to_string())?;
            }
            archive.finish().map_err(|e| e.to_string())?;
        }
        validate(&entries[0].0)?;
        output.sync_all().map_err(|e| e.to_string())
    })();
    drop(output);
    if let Err(error) = result {
        let _ = fs::remove_file(&destination);
        return Err(error);
    }
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::Cell,
        io::Read,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct Fixture {
        directory: PathBuf,
        sources: PathBuf,
        output: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let directory = std::env::temp_dir().join(format!("notgram-sticker-export-{suffix}"));
            let sources = directory.join("sources");
            let output = directory.join("output");
            fs::create_dir_all(&sources).unwrap();
            fs::create_dir_all(&output).unwrap();
            Self {
                directory,
                sources,
                output,
            }
        }
        fn file(&self, name: &str, bytes: &[u8]) -> StickerExportFile {
            let source = self.sources.join(name);
            fs::write(&source, bytes).unwrap();
            StickerExportFile {
                source_path: source.to_string_lossy().into_owned(),
                file_name: name.to_string(),
            }
        }
        fn validate(&self, source: &Path) -> Result<PathBuf, String> {
            file_actions::canonical_file_within_roots(
                source,
                &[self.sources.canonicalize().unwrap()],
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn single_sticker_preserves_original_bytes_and_avoids_overwriting() {
        let fixture = Fixture::new();
        let files = [fixture.file("pack_001.tgs", b"original gzip bytes")];
        let first = write_export(&fixture.output, "pack", &files, |p| fixture.validate(p)).unwrap();
        let second =
            write_export(&fixture.output, "pack", &files, |p| fixture.validate(p)).unwrap();
        assert_eq!(first.file_name().unwrap(), "pack_001.tgs");
        assert_eq!(second.file_name().unwrap(), "pack_001 (1).tgs");
        assert_eq!(fs::read(first).unwrap(), b"original gzip bytes");
        assert_eq!(fs::read(second).unwrap(), b"original gzip bytes");
    }

    #[test]
    fn zip_contains_all_original_formats_in_order_and_avoids_overwriting() {
        let fixture = Fixture::new();
        let files = [
            fixture.file("可爱_001.webp", b"webp original"),
            fixture.file("可爱_002.tgs", b"gzip original"),
            fixture.file("可爱_003.webm", b"webm original"),
        ];
        let first = write_export(&fixture.output, "可爱贴纸", &files, |p| {
            fixture.validate(p)
        })
        .unwrap();
        let second = write_export(&fixture.output, "可爱贴纸", &files, |p| {
            fixture.validate(p)
        })
        .unwrap();
        assert_eq!(first.file_name().unwrap(), "可爱贴纸.zip");
        assert_eq!(second.file_name().unwrap(), "可爱贴纸 (1).zip");
        let mut archive = zip::ZipArchive::new(fs::File::open(first).unwrap()).unwrap();
        assert_eq!(archive.len(), 3);
        for (index, file) in files.iter().enumerate() {
            let mut entry = archive.by_index(index).unwrap();
            assert_eq!(entry.name(), file.file_name);
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, fs::read(&file.source_path).unwrap());
        }
    }

    #[test]
    fn rejects_untrusted_sources_before_creating_an_export() {
        let fixture = Fixture::new();
        let outside = fixture.directory.join("private.webp");
        fs::write(&outside, b"private").unwrap();
        let files = [StickerExportFile {
            source_path: outside.to_string_lossy().into_owned(),
            file_name: "sticker.webp".to_string(),
        }];
        assert!(write_export(&fixture.output, "pack", &files, |p| fixture.validate(p)).is_err());
        assert_eq!(fs::read_dir(&fixture.output).unwrap().count(), 0);
    }

    #[test]
    fn removes_incomplete_zip_if_a_source_expires_during_export() {
        let fixture = Fixture::new();
        let files = [
            fixture.file("one.webp", b"one"),
            fixture.file("two.webp", b"two"),
        ];
        let calls = Cell::new(0);
        let result = write_export(&fixture.output, "pack", &files, |p| {
            calls.set(calls.get() + 1);
            if calls.get() == 4 {
                return Err("This message cannot be saved or has expired".to_string());
            }
            fixture.validate(p)
        });
        assert!(result.is_err());
        assert_eq!(fs::read_dir(&fixture.output).unwrap().count(), 0);
    }

    #[test]
    fn validates_windows_names_and_rejects_duplicate_zip_entries() {
        let fixture = Fixture::new();
        for (name, expected) in [
            ("CON", "_CON"),
            ("LPT²", "_LPT²"),
            ("AUX", "_AUX"),
            ("a/b:c?*", "a_b_c__"),
            (".. ", "stickers"),
        ] {
            assert_eq!(safe_export_name(name), expected);
        }
        let mut files = [
            fixture.file("one.webp", b"one"),
            fixture.file("two.webp", b"two"),
        ];
        files[0].file_name = "../CON.webp".to_string();
        files[1].file_name = "TWO.webp".to_string();
        let exported =
            write_export(&fixture.output, "../pack", &files, |p| fixture.validate(p)).unwrap();
        assert_eq!(exported.parent(), Some(fixture.output.as_path()));
        let mut archive = zip::ZipArchive::new(fs::File::open(exported).unwrap()).unwrap();
        assert!(!archive.by_index(0).unwrap().name().contains('/'));
        files[1].file_name = files[0].file_name.to_uppercase();
        assert!(
            write_export(&fixture.output, "duplicate", &files, |p| fixture
                .validate(p))
            .is_err()
        );
        assert!(!fixture.output.join("duplicate.zip").exists());
    }

    #[test]
    fn folder_history_survives_restart_and_falls_back_when_missing() {
        let fixture = Fixture::new();
        let record = fixture.directory.join("last-directory.json");
        assert_eq!(
            initial_directory(&record, fixture.sources.clone()),
            fixture.sources
        );
        persistence::write_json(&record, &fixture.output, true).unwrap();
        assert_eq!(
            initial_directory(&record, fixture.sources.clone()),
            fixture.output
        );
        fs::remove_dir(&fixture.output).unwrap();
        assert_eq!(
            initial_directory(&record, fixture.sources.clone()),
            fixture.sources
        );
    }
}
