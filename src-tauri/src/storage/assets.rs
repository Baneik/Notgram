//! Asset permissions are checked against the active account on every request.
//! The built-in asset scope remains empty; old URLs do not retain authority.
use std::{
    collections::HashSet,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{
    AppHandle, Manager,
    http::{Request, Response},
};

#[derive(Default)]
pub struct AccountAssets {
    allowed: Mutex<HashSet<PathBuf>>,
    avatars: Mutex<HashSet<PathBuf>>,
}

pub(crate) fn allow(app: &AppHandle, path: &Path) -> Result<(), String> {
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    app.state::<AccountAssets>()
        .allowed
        .lock()
        .map_err(|_| "Asset registry unavailable")?
        .insert(path);
    Ok(())
}

pub(crate) fn set_account_avatars(app: &AppHandle, paths: HashSet<PathBuf>) -> Result<(), String> {
    *app.state::<AccountAssets>()
        .avatars
        .lock()
        .map_err(|_| "Avatar registry unavailable")? = paths;
    Ok(())
}

pub(crate) fn reset_session(app: &AppHandle) {
    if let Ok(mut allowed) = app.state::<AccountAssets>().allowed.lock() {
        allowed.clear();
    }
}

fn decode_path(encoded: &str) -> Result<PathBuf, String> {
    let mut bytes = Vec::new();
    let mut input = encoded.trim_start_matches('/').as_bytes().iter().copied();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let high = input
                .next()
                .and_then(|c| (c as char).to_digit(16))
                .ok_or("Invalid asset URL")?;
            let low = input
                .next()
                .and_then(|c| (c as char).to_digit(16))
                .ok_or("Invalid asset URL")?;
            bytes.push((high * 16 + low) as u8);
        } else {
            bytes.push(byte);
        }
    }
    Ok(PathBuf::from(
        String::from_utf8(bytes).map_err(|_| "Invalid asset path")?,
    ))
}

pub(crate) fn respond(app: &AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let result = (|| -> Result<Response<Vec<u8>>, String> {
        let generation = app
            .state::<crate::telegram::media_stream::MediaStreamRegistry>()
            .generation();
        let path = decode_path(request.uri().path())?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let assets = app.state::<AccountAssets>();
        let avatar = assets
            .avatars
            .lock()
            .map_err(|_| "Asset registry unavailable")?
            .contains(&path);
        let permitted = assets
            .allowed
            .lock()
            .map_err(|_| "Asset registry unavailable")?
            .contains(&path);
        let roots = [
            super::trusted_tdlib_files_directory(app)?,
            super::tdlib_database_directory(app)?,
        ];
        if !avatar
            && (!permitted
                || !roots
                    .iter()
                    .filter_map(|root| root.canonicalize().ok())
                    .any(|root| path.starts_with(root)))
        {
            return Err("Asset does not belong to the active account".into());
        }
        app.state::<crate::telegram::media_stream::MediaStreamRegistry>()
            .check_expiry(&path)?;
        let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        let range = request
            .headers()
            .get("range")
            .and_then(|value| value.to_str().ok());
        let (start, end) = if let Some(range) = range {
            let (start, end) = range
                .strip_prefix("bytes=")
                .and_then(|s| s.split_once('-'))
                .ok_or("Invalid asset range")?;
            let start: u64 = start.parse().map_err(|_| "Invalid asset range")?;
            let end = if end.is_empty() {
                size.saturating_sub(1).min(start + 1024 * 1024 - 1)
            } else {
                end.parse().map_err(|_| "Invalid asset range")?
            };
            if start >= size || end < start || end >= size {
                return Err("Invalid asset range".into());
            }
            (start, end)
        } else {
            (0, size.saturating_sub(1))
        };
        let length = if size == 0 { 0 } else { end - start + 1 };
        if length > 64 * 1024 * 1024 {
            return Err("Asset requires ranged streaming".into());
        }
        file.seek(SeekFrom::Start(start))
            .map_err(|e| e.to_string())?;
        let mut body = vec![0; length as usize];
        file.read_exact(&mut body).map_err(|e| e.to_string())?;
        if generation
            != app
                .state::<crate::telegram::media_stream::MediaStreamRegistry>()
                .generation()
        {
            return Err("Asset session expired".into());
        }
        let mime = match path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str()
        {
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "mp4" | "m4v" => "video/mp4",
            "webm" => "video/webm",
            "ogg" | "oga" | "opus" => "audio/ogg",
            "mp3" => "audio/mpeg",
            "m4a" => "audio/mp4",
            "wav" => "audio/wav",
            "tgs" => "application/gzip",
            _ => "application/octet-stream",
        };
        let mut response = Response::builder()
            .status(if range.is_some() { 206 } else { 200 })
            .header("Content-Type", mime)
            .header("Content-Length", length.to_string())
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "no-store");
        if range.is_some() {
            response = response.header("Content-Range", format!("bytes {start}-{end}/{size}"));
        }
        response.body(body).map_err(|e| e.to_string())
    })();
    result.unwrap_or_else(|_| {
        Response::builder()
            .status(403)
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "no-store")
            .body(Vec::new())
            .unwrap()
    })
}
