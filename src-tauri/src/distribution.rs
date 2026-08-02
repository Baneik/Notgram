use serde::Serialize;
use std::{env, path::Path};

const PORTABLE_MARKER: &str = ".notgram-portable";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DistributionKind {
    Installed,
    Portable,
    Unknown,
}

fn kind_for_directory(directory: &Path) -> DistributionKind {
    if directory.join(PORTABLE_MARKER).is_file() {
        DistributionKind::Portable
    } else {
        DistributionKind::Installed
    }
}

pub fn current_kind() -> DistributionKind {
    env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(kind_for_directory))
        .unwrap_or(DistributionKind::Unknown)
}

pub fn supports_native_updater() -> bool {
    current_kind() == DistributionKind::Installed
}

#[tauri::command]
pub fn notgram_distribution_kind() -> DistributionKind {
    current_kind()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn test_directory() -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        env::temp_dir().join(format!("notgram-distribution-{suffix}"))
    }

    #[test]
    fn portable_marker_disables_native_updates() {
        let directory = test_directory();
        fs::create_dir_all(&directory).expect("test directory should be created");
        assert_eq!(kind_for_directory(&directory), DistributionKind::Installed);

        fs::write(directory.join(PORTABLE_MARKER), "Notgram portable\n")
            .expect("portable marker should be created");
        assert_eq!(kind_for_directory(&directory), DistributionKind::Portable);

        fs::remove_dir_all(directory).expect("test directory should be removed");
    }
}
