use serde::Serialize;
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};

const PORTABLE_MARKER: &str = ".notgram-portable";
const RELEASE_PROBE_PREFIX: &str = "--notgram-release-probe=";
const REQUIRED_RUNTIME_FILES: &[&str] = &[
    "tdjson.dll",
    "libcrypto-3-x64.dll",
    "libssl-3-x64.dll",
    "z.dll",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DistributionKind {
    Installed,
    Portable,
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseProbe {
    schema_version: u32,
    distribution: DistributionKind,
    version: &'static str,
    runtime_verified: bool,
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

fn requested_probe_path() -> Option<PathBuf> {
    env::args().find_map(|argument| {
        argument
            .strip_prefix(RELEASE_PROBE_PREFIX)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    })
}

fn probe_for_directory(directory: &Path) -> Result<ReleaseProbe, String> {
    let runtime_directory = directory.join("tdlib");
    let runtime_verified = REQUIRED_RUNTIME_FILES
        .iter()
        .all(|file| runtime_directory.join(file).is_file());
    if !runtime_verified {
        return Err("Release runtime dependencies are incomplete".to_string());
    }
    Ok(ReleaseProbe {
        schema_version: 1,
        distribution: kind_for_directory(directory),
        version: env!("CARGO_PKG_VERSION"),
        runtime_verified,
    })
}

fn write_release_probe(output: &Path) -> Result<(), String> {
    if !output.is_absolute() || output.extension().and_then(|value| value.to_str()) != Some("json")
    {
        return Err("Release probe output must be an absolute JSON path".to_string());
    }
    let executable =
        env::current_exe().map_err(|_| "Unable to resolve the release executable".to_string())?;
    let directory = executable
        .parent()
        .ok_or_else(|| "Release executable has no parent directory".to_string())?;
    let probe = probe_for_directory(directory)?;
    let payload = serde_json::to_vec(&probe)
        .map_err(|_| "Unable to serialize release probe result".to_string())?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .map_err(|_| "Unable to create release probe result".to_string())?;
    file.write_all(&payload)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|_| "Unable to write release probe result".to_string())
}

pub fn run_release_probe_if_requested() -> bool {
    let Some(output) = requested_probe_path() else {
        return false;
    };
    if let Err(error) = write_release_probe(&output) {
        eprintln!("{error}");
        std::process::exit(1);
    }
    true
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

    #[test]
    fn release_probe_requires_complete_runtime_without_exposing_paths() {
        let directory = test_directory();
        let runtime = directory.join("tdlib");
        fs::create_dir_all(&runtime).expect("runtime directory should be created");
        for file in REQUIRED_RUNTIME_FILES {
            fs::write(runtime.join(file), b"runtime").expect("runtime file should be created");
        }

        let probe = probe_for_directory(&directory).expect("release probe should pass");
        let payload = serde_json::to_string(&probe).expect("release probe should serialize");
        assert_eq!(probe.distribution, DistributionKind::Installed);
        assert!(probe.runtime_verified);
        assert!(!payload.contains(directory.to_string_lossy().as_ref()));

        fs::remove_file(runtime.join(REQUIRED_RUNTIME_FILES[0]))
            .expect("runtime file should be removed");
        assert!(probe_for_directory(&directory).is_err());
        fs::remove_dir_all(directory).expect("test directory should be removed");
    }
}
