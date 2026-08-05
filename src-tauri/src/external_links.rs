const MAX_EXTERNAL_URL_LENGTH: usize = 4_096;
const ALLOWED_SCHEMES: [&str; 5] = ["http", "https", "mailto", "tel", "tg"];

fn validate_external_url(url: &str) -> Result<&str, String> {
    if url.is_empty() || url.len() > MAX_EXTERNAL_URL_LENGTH || url.trim() != url {
        return Err("invalid external URL".to_string());
    }
    if url.chars().any(char::is_control) {
        return Err("invalid external URL".to_string());
    }
    let (scheme, remainder) = url
        .split_once(':')
        .ok_or_else(|| "external URL is missing a scheme".to_string())?;
    if !ALLOWED_SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) || remainder.is_empty() {
        return Err("unsupported external URL scheme".to_string());
    }
    if matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https")
        && !remainder.starts_with("//")
    {
        return Err("invalid web URL".to_string());
    }
    Ok(url)
}

#[tauri::command]
pub fn notgram_open_external_url(url: String) -> Result<(), String> {
    open_external_url(validate_external_url(&url)?)
}

#[cfg(target_os = "windows")]
fn open_external_url(url: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

    let operation = "open\0".encode_utf16().collect::<Vec<_>>();
    let target = std::ffi::OsStr::new(url)
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
    if result as isize <= 32 {
        Err("Windows could not open the external URL".to_string())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn open_external_url(url: &str) -> Result<(), String> {
    open_with_command("open", url)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_external_url(url: &str) -> Result<(), String> {
    open_with_command("xdg-open", url)
}

#[cfg(not(target_os = "windows"))]
fn open_with_command(command: &str, url: &str) -> Result<(), String> {
    std::process::Command::new(command)
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("unable to open external URL: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_supported_external_schemes() {
        for url in [
            "https://example.com/path?q=1",
            "http://example.com",
            "mailto:user@example.com",
            "tel:+8610000000000",
            "tg://resolve?domain=telegram",
        ] {
            assert_eq!(validate_external_url(url), Ok(url));
        }
    }

    #[test]
    fn rejects_unsafe_or_malformed_urls() {
        for url in [
            "javascript:alert(1)",
            "file:///C:/secret.txt",
            " https://example.com",
            "https:example.com",
            "https://example.com\nmalicious",
            "https://example.com\0malicious",
        ] {
            assert!(validate_external_url(url).is_err(), "unexpectedly accepted {url:?}");
        }
        assert!(validate_external_url(&format!("https://example.com/{}", "x".repeat(4096))).is_err());
    }
}
