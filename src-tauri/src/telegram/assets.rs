use super::runtime_log::RuntimeLogger;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

pub(super) fn trusted_asset_roots(
    database_directory: &Path,
    files_directory: &Path,
) -> Vec<PathBuf> {
    [database_directory, files_directory]
        .into_iter()
        .filter_map(|path| path.canonicalize().ok())
        .collect()
}

pub(super) fn allow_tdlib_assets(
    app: &AppHandle,
    update: &Value,
    trusted_roots: &[PathBuf],
    allowed_assets: &mut HashSet<PathBuf>,
    logger: Option<&RuntimeLogger>,
) {
    for path in trusted_tdlib_asset_paths(update, trusted_roots) {
        if !allowed_assets.insert(path.clone()) {
            continue;
        }
        if app.asset_protocol_scope().allow_file(&path).is_err()
            && let Some(logger) = logger
        {
            logger.write("warn", "asset_authorization_failed", json!({}));
        }
    }
}

fn trusted_tdlib_asset_paths(value: &Value, trusted_roots: &[PathBuf]) -> Vec<PathBuf> {
    fn collect(value: &Value, trusted_roots: &[PathBuf], paths: &mut Vec<PathBuf>) {
        match value {
            Value::Object(object) => {
                if let Some(local) = object.get("local").and_then(Value::as_object)
                    && let Some(path) = local.get("path").and_then(Value::as_str)
                    && !path.is_empty()
                    && let Ok(path) = PathBuf::from(path).canonicalize()
                    && trusted_roots.iter().any(|root| path.starts_with(root))
                    && (local
                        .get("is_downloading_completed")
                        .and_then(Value::as_bool)
                        == Some(true)
                        || path
                            .components()
                            .any(|component| component.as_os_str() == ".notgram-sent-media"))
                {
                    paths.push(path);
                }
                for nested in object.values() {
                    collect(nested, trusted_roots, paths);
                }
            }
            Value::Array(values) => {
                for nested in values {
                    collect(nested, trusted_roots, paths);
                }
            }
            _ => {}
        }
    }

    let mut paths = Vec::new();
    collect(value, trusted_roots, &mut paths);
    paths.sort();
    paths.dedup();
    paths
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env, fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn asset_authorization_only_accepts_completed_files_under_tdlib_roots() {
        let root = env::temp_dir().join(format!(
            "notgram-assets-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let trusted = root.join("trusted");
        let outside = root.join("outside");
        fs::create_dir_all(&trusted).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let trusted_file = trusted.join("avatar.jpg");
        let incomplete_file = trusted.join("partial.jpg");
        let sent_directory = trusted.join(".notgram-sent-media");
        let outside_file = outside.join("private.txt");
        fs::create_dir_all(&sent_directory).unwrap();
        let sent_file = sent_directory.join("upload.jpg");
        fs::write(&trusted_file, b"image").unwrap();
        fs::write(&incomplete_file, b"partial").unwrap();
        fs::write(&outside_file, b"private").unwrap();
        fs::write(&sent_file, b"upload").unwrap();
        let update = json!({
            "files": [
                {
                    "@type": "file",
                    "local": {
                        "is_downloading_completed": true,
                        "path": trusted_file.display().to_string()
                    }
                },
                {
                    "@type": "file",
                    "local": {
                        "is_downloading_completed": false,
                        "path": incomplete_file.display().to_string()
                    }
                },
                {
                    "@type": "file",
                    "local": {
                        "is_downloading_completed": false,
                        "path": sent_file.display().to_string()
                    }
                },
                {
                    "@type": "file",
                    "local": {
                        "is_downloading_completed": true,
                        "path": outside_file.display().to_string()
                    }
                }
            ]
        });

        let paths = trusted_tdlib_asset_paths(&update, &[trusted.canonicalize().unwrap()]);
        assert_eq!(
            paths,
            vec![
                sent_file.canonicalize().unwrap(),
                trusted_file.canonicalize().unwrap()
            ]
        );
        fs::remove_dir_all(root).unwrap();
    }
}
