use super::{CacheCategory, CacheCleanupResult, CacheUsage, CacheUsageItem};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

pub(super) fn cache_category(path: &Path) -> CacheCategory {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "avif" | "bmp" | "gif" | "heic" | "jpeg" | "jpg" | "png" | "tgs" | "webp" => {
            CacheCategory::Image
        }
        "avi" | "m4v" | "mkv" | "mov" | "mp4" | "webm" => CacheCategory::Video,
        "aac" | "flac" | "m4a" | "mp3" | "oga" | "ogg" | "opus" | "wav" => CacheCategory::Audio,
        "csv" | "doc" | "docx" | "epub" | "json" | "md" | "odp" | "ods" | "odt" | "pdf" | "ppt"
        | "pptx" | "rtf" | "txt" | "xls" | "xlsx" | "xml" | "zip" => CacheCategory::Document,
        _ => CacheCategory::Other,
    }
}

pub(super) fn cache_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    fn visit(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
        let entries = fs::read_dir(directory).map_err(|error| {
            format!(
                "Unable to read cache directory {}: {error}",
                directory.display()
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                format!(
                    "Unable to read cache entry in {}: {error}",
                    directory.display()
                )
            })?;
            let file_type = entry.file_type().map_err(|error| {
                format!(
                    "Unable to inspect cache entry {}: {error}",
                    entry.path().display()
                )
            })?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                visit(&entry.path(), files)?;
            } else if file_type.is_file() {
                files.push(entry.path());
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    visit(root, &mut files)?;
    Ok(files)
}

fn usage_item_mut(usage: &mut CacheUsage, category: CacheCategory) -> &mut CacheUsageItem {
    match category {
        CacheCategory::Image => &mut usage.images,
        CacheCategory::Video => &mut usage.videos,
        CacheCategory::Audio => &mut usage.audio,
        CacheCategory::Document => &mut usage.documents,
        CacheCategory::Other => &mut usage.other,
    }
}

fn add_usage(usage: &mut CacheUsage, category: CacheCategory, bytes: u64) {
    usage.total.bytes = usage.total.bytes.saturating_add(bytes);
    usage.total.files = usage.total.files.saturating_add(1);
    let item = usage_item_mut(usage, category);
    item.bytes = item.bytes.saturating_add(bytes);
    item.files = item.files.saturating_add(1);
}

pub(super) fn cache_usage(root: &Path) -> Result<CacheUsage, String> {
    let mut usage = CacheUsage::default();
    for path in cache_files(root)? {
        let metadata = path.metadata().map_err(|error| {
            format!("Unable to inspect cached file {}: {error}", path.display())
        })?;
        add_usage(&mut usage, cache_category(&path), metadata.len());
    }
    Ok(usage)
}

pub(super) fn canonical_paths_within_root(
    root: &Path,
    paths: impl Iterator<Item = PathBuf>,
) -> HashSet<PathBuf> {
    paths
        .filter_map(|path| path.canonicalize().ok())
        .filter(|path| path.is_file() && path.starts_with(root))
        .collect()
}

pub(super) fn protected_cache_paths(root: &Path, paths: &[String]) -> HashSet<PathBuf> {
    canonical_paths_within_root(root, paths.iter().map(PathBuf::from))
}

pub(super) fn clear_cache_files(
    root: &Path,
    categories: &HashSet<CacheCategory>,
    modified_before: Option<SystemTime>,
    protected: &HashSet<PathBuf>,
) -> Result<CacheCleanupResult, String> {
    let mut result = CacheCleanupResult {
        removed_bytes: 0,
        removed_files: 0,
        skipped_protected_files: 0,
        usage: CacheUsage::default(),
    };
    for path in cache_files(root)? {
        if !categories.contains(&cache_category(&path)) {
            continue;
        }
        let canonical = path.canonicalize().map_err(|error| {
            format!("Unable to resolve cached file {}: {error}", path.display())
        })?;
        if !canonical.starts_with(root) || !canonical.is_file() {
            continue;
        }
        if protected.contains(&canonical) {
            result.skipped_protected_files = result.skipped_protected_files.saturating_add(1);
            continue;
        }
        let metadata = canonical.metadata().map_err(|error| {
            format!(
                "Unable to inspect cached file {}: {error}",
                canonical.display()
            )
        })?;
        if modified_before.is_some_and(|cutoff| {
            metadata
                .modified()
                .map_or(true, |modified| modified > cutoff)
        }) {
            continue;
        }
        fs::remove_file(&canonical).map_err(|error| {
            format!(
                "Unable to remove cached file {}: {error}",
                canonical.display()
            )
        })?;
        result.removed_bytes = result.removed_bytes.saturating_add(metadata.len());
        result.removed_files = result.removed_files.saturating_add(1);
    }
    result.usage = cache_usage(root)?;
    Ok(result)
}

pub(super) fn cached_asset_paths(snapshot: &Value, trusted_roots: &[PathBuf]) -> HashSet<PathBuf> {
    fn visit(
        value: &Value,
        key: Option<&str>,
        trusted_roots: &[PathBuf],
        paths: &mut HashSet<PathBuf>,
    ) {
        match value {
            Value::Object(object) => {
                for (child_key, child) in object {
                    visit(child, Some(child_key), trusted_roots, paths);
                }
            }
            Value::Array(array) => {
                for child in array {
                    visit(child, key, trusted_roots, paths);
                }
            }
            Value::String(path)
                if matches!(key, Some("imagePath" | "localPath" | "thumbnailPath")) =>
            {
                if let Ok(path) = PathBuf::from(path).canonicalize()
                    && path.is_file()
                    && trusted_roots.iter().any(|root| path.starts_with(root))
                {
                    paths.insert(path);
                }
            }
            _ => {}
        }
    }

    let mut paths = HashSet::new();
    visit(snapshot, None, trusted_roots, &mut paths);
    paths
}
