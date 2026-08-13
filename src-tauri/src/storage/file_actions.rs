use super::{UploadFileInfo, download_directory, trusted_tdlib_files_directory};
use std::{
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub fn telegram_save_downloaded_file(
    app: AppHandle,
    source_path: String,
    file_name: String,
) -> Result<String, String> {
    let source = PathBuf::from(source_path)
        .canonicalize()
        .map_err(|_| "Downloaded cache file is unavailable".to_string())?;
    if !source.is_file() {
        return Err(format!(
            "Downloaded cache file does not exist: {}",
            source.display()
        ));
    }
    let trusted_files = trusted_tdlib_files_directory(&app)?;
    if !source.starts_with(&trusted_files) {
        return Err("Downloaded file is outside the active TDLib files directory".to_string());
    }
    let directory = download_directory(&app)?;
    let destination = copy_to_available_download(
        &source,
        &directory,
        &download_file_name(&file_name, &source),
    )?;
    Ok(destination.display().to_string())
}

#[tauri::command]
pub fn telegram_open_cached_file(app: AppHandle, source_path: String) -> Result<(), String> {
    let source = trusted_local_file(&app, &source_path)?;
    open_path(&source)
}

#[tauri::command]
pub async fn telegram_save_cached_file_as(
    app: AppHandle,
    source_path: String,
    file_name: String,
) -> Result<bool, String> {
    let source = trusted_local_file(&app, &source_path)?;
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("另存 Telegram 文件")
        .set_file_name(safe_file_name(&file_name))
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let destination = selected
        .into_path()
        .map_err(|error| format!("Unable to resolve selected save path: {error}"))?;
    if !destination.is_absolute() {
        return Err("Selected save path must be absolute".to_string());
    }
    if destination.is_dir() {
        return Err("Selected save path is a directory".to_string());
    }
    if destination == source {
        return Ok(true);
    }
    fs::copy(&source, &destination).map_err(|error| {
        format!(
            "Unable to save cached file to {}: {error}",
            destination.display()
        )
    })?;
    Ok(true)
}

#[tauri::command]
pub fn telegram_open_download_directory(app: AppHandle) -> Result<(), String> {
    open_path(&download_directory(&app)?)
}

pub(super) fn trusted_local_file(app: &AppHandle, source_path: &str) -> Result<PathBuf, String> {
    let roots = [
        trusted_tdlib_files_directory(app)?,
        download_directory(app)?
            .canonicalize()
            .map_err(|error| format!("Unable to resolve configured download directory: {error}"))?,
    ];
    canonical_file_within_roots(Path::new(source_path), &roots)
}

pub(super) fn canonical_file_within_roots(
    source: &Path,
    roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let source = source
        .canonicalize()
        .map_err(|_| "Cached file is unavailable".to_string())?;
    if !source.is_file() {
        return Err("Cached path is not a file".to_string());
    }
    if !roots.iter().any(|root| source.starts_with(root)) {
        return Err("Cached file is outside trusted storage directories".to_string());
    }
    Ok(source)
}

#[cfg(target_os = "windows")]
pub(super) fn open_path(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

    let operation = "open\0".encode_utf16().collect::<Vec<_>>();
    let target = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as usize <= 32 {
        return Err(format!("Unable to open {}", path.display()));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn open_path(path: &Path) -> Result<(), String> {
    open_with_command("open", path)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub(super) fn open_path(path: &Path) -> Result<(), String> {
    open_with_command("xdg-open", path)
}

#[cfg(not(target_os = "windows"))]
fn open_with_command(command: &str, path: &Path) -> Result<(), String> {
    std::process::Command::new(command)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Unable to open {}: {error}", path.display()))
}

pub(super) fn safe_file_name(value: &str) -> String {
    let name = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    let sanitized = name
        .chars()
        .map(|character| {
            if character.is_control() || r#"<>:"/\|?*"#.contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    if sanitized.trim().is_empty() {
        "download".to_string()
    } else {
        sanitized
    }
}

pub(super) fn download_file_name(value: &str, source: &Path) -> String {
    let safe_name = safe_file_name(value);
    if Path::new(&safe_name).extension().is_some() {
        return safe_name;
    }
    let Some(extension) = source.extension().and_then(|value| value.to_str()) else {
        return safe_name;
    };
    if extension.is_empty() {
        safe_name
    } else {
        format!("{safe_name}.{extension}")
    }
}

fn numbered_download_path(directory: &Path, file_name: &str, index: usize) -> PathBuf {
    if index == 0 {
        return directory.join(file_name);
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let extension = path.extension().and_then(|value| value.to_str());
    match extension {
        Some(extension) => directory.join(format!("{stem} ({index}).{extension}")),
        None => directory.join(format!("{stem} ({index})")),
    }
}

pub(super) fn copy_to_available_download(
    source: &Path,
    directory: &Path,
    file_name: &str,
) -> Result<PathBuf, String> {
    for index in 0..10_000 {
        let destination = numbered_download_path(directory, file_name, index);
        let mut output = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
        {
            Ok(output) => output,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Unable to reserve downloaded file {}: {error}",
                    destination.display()
                ));
            }
        };
        let result = fs::File::open(source)
            .and_then(|mut input| io::copy(&mut input, &mut output))
            .and_then(|_| output.sync_all());
        if let Err(error) = result {
            drop(output);
            let _ = fs::remove_file(&destination);
            return Err(format!(
                "Unable to save downloaded file to {}: {error}",
                destination.display()
            ));
        }
        return Ok(destination);
    }
    Err("Unable to choose an available download file name".to_string())
}

pub fn prepare_upload_file(path: &Path) -> Result<UploadFileInfo, String> {
    if !path.is_absolute() {
        return Err("Selected upload path must be absolute".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "Selected upload file is unavailable".to_string())?;
    let metadata = canonical
        .metadata()
        .map_err(|_| "Unable to read selected upload file".to_string())?;
    if !metadata.is_file() {
        return Err("Selected upload path is not a file".to_string());
    }
    let path = canonical
        .to_str()
        .ok_or_else(|| "Selected upload path contains unsupported characters".to_string())?;
    Ok(UploadFileInfo {
        path: path.to_string(),
        size: metadata.len(),
    })
}
