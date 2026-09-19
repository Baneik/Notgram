use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Shortcut {
    code: String,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Availability {
    Available,
    Conflict,
    #[cfg(not(windows))]
    Unsupported,
}

fn virtual_key(code: &str) -> Option<u32> {
    match code {
        "ArrowUp" => Some(0x26),
        "ArrowDown" => Some(0x28),
        "ArrowLeft" => Some(0x25),
        "ArrowRight" => Some(0x27),
        "PageUp" => Some(0x21),
        "PageDown" => Some(0x22),
        "Home" => Some(0x24),
        "End" => Some(0x23),
        "Insert" => Some(0x2d),
        "Delete" => Some(0x2e),
        "Backspace" => Some(0x08),
        "Space" => Some(0x20),
        _ => {
            if let Some(letter) = code.strip_prefix("Key") {
                return (letter.len() == 1 && letter.as_bytes()[0].is_ascii_uppercase())
                    .then(|| u32::from(letter.as_bytes()[0]));
            }
            if let Some(digit) = code.strip_prefix("Digit") {
                return (digit.len() == 1 && digit.as_bytes()[0].is_ascii_digit())
                    .then(|| u32::from(digit.as_bytes()[0]));
            }
            let function = code.strip_prefix('F')?.parse::<u32>().ok()?;
            (1..=24).contains(&function).then_some(0x6f + function)
        }
    }
}

fn reserved(shortcut: &Shortcut) -> bool {
    shortcut.meta
        || shortcut.code == "F12"
        || (shortcut.alt && matches!(shortcut.code.as_str(), "F4" | "Space"))
        || (shortcut.ctrl && shortcut.alt && shortcut.code == "Delete")
}

#[cfg(windows)]
fn key_for_active_layout(code: &str, fallback: u32) -> Result<u32, String> {
    use windows_sys::Win32::UI::{
        Input::KeyboardAndMouse::{GetKeyboardLayout, MAPVK_VSC_TO_VK_EX, MapVirtualKeyExW},
        WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
    };
    // DOM code identifies a physical key; RegisterHotKey takes a layout-dependent
    // virtual key. Use the foreground WebView's layout, not the worker's layout.
    let scan = code
        .strip_prefix("Key")
        .and_then(|key| {
            ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"]
                .iter()
                .zip([0x10, 0x1e, 0x2c])
                .find_map(|(row, base)| row.find(key).map(|index| base + index as u32))
        })
        .or_else(|| {
            code.strip_prefix("Digit")
                .and_then(|digit| "1234567890".find(digit).map(|index| index as u32 + 2))
        });
    let Some(scan) = scan else {
        return Ok(fallback);
    };
    let key = unsafe {
        let thread = GetWindowThreadProcessId(GetForegroundWindow(), std::ptr::null_mut());
        MapVirtualKeyExW(scan, MAPVK_VSC_TO_VK_EX, GetKeyboardLayout(thread))
    };
    if key == 0 {
        return Err("unsupported keyboard layout".into());
    }
    Ok(key)
}

#[tauri::command]
pub async fn notgram_check_shortcut(shortcut: Shortcut) -> Result<Availability, String> {
    if reserved(&shortcut) {
        return Ok(Availability::Conflict);
    }
    let key = virtual_key(&shortcut.code).ok_or("unsupported shortcut key")?;
    if !shortcut.ctrl && !shortcut.alt && !(0x70..=0x87).contains(&key) {
        return Err("shortcut requires a modifier".into());
    }
    #[cfg(windows)]
    {
        let key = key_for_active_layout(&shortcut.code, key)?;
        // Own the registration on a short-lived thread. Never retain a global
        // shortcut or leave WM_HOTKEY messages on the UI/runtime thread's queue.
        tauri::async_runtime::spawn_blocking(move || {
            std::thread::spawn(move || probe(&shortcut, key))
                .join()
                .map_err(|_| "shortcut check failed".to_string())?
        })
        .await
        .map_err(|_| "shortcut check failed".to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (shortcut.shift, key);
        Ok(Availability::Unsupported)
    }
}

#[cfg(windows)]
fn probe(shortcut: &Shortcut, key: u32) -> Result<Availability, String> {
    use windows_sys::Win32::{
        Foundation::{ERROR_HOTKEY_ALREADY_REGISTERED, GetLastError},
        UI::Input::KeyboardAndMouse::{
            MOD_ALT, MOD_CONTROL, MOD_SHIFT, RegisterHotKey, UnregisterHotKey,
        },
    };
    let modifiers = (if shortcut.ctrl { MOD_CONTROL } else { 0 })
        | (if shortcut.alt { MOD_ALT } else { 0 })
        | (if shortcut.shift { MOD_SHIFT } else { 0 });
    unsafe {
        if RegisterHotKey(std::ptr::null_mut(), 1, modifiers, key) == 0 {
            return match GetLastError() {
                ERROR_HOTKEY_ALREADY_REGISTERED => Ok(Availability::Conflict),
                error => Err(format!("shortcut check failed ({error})")),
            };
        }
        if UnregisterHotKey(std::ptr::null_mut(), 1) == 0 {
            return Err("failed to release shortcut check".into());
        }
    }
    Ok(Availability::Available)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_supported_keys_and_rejects_invalid_input() {
        assert_eq!(virtual_key("ArrowUp"), Some(0x26));
        assert_eq!(virtual_key("PageDown"), Some(0x22));
        assert_eq!(virtual_key("KeyA"), Some(0x41));
        assert_eq!(virtual_key("Digit9"), Some(0x39));
        assert_eq!(virtual_key("F24"), Some(0x87));
        for code in ["Key", "KeyAB", "Digit", "Digit-1", "F0", "F25", "Escape"] {
            assert_eq!(virtual_key(code), None);
        }
    }

    #[cfg(windows)]
    #[test]
    fn detects_another_threads_hotkey_and_releases_probe() {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            MOD_ALT, MOD_CONTROL, MOD_SHIFT, RegisterHotKey, UnregisterHotKey,
        };
        let shortcut = || Shortcut {
            code: "F23".into(),
            ctrl: true,
            alt: true,
            shift: true,
            meta: false,
        };
        std::thread::spawn(move || {
            assert_eq!(probe(&shortcut(), 0x86), Ok(Availability::Available));
            assert_ne!(
                unsafe {
                    RegisterHotKey(
                        std::ptr::null_mut(),
                        2,
                        MOD_CONTROL | MOD_ALT | MOD_SHIFT,
                        0x86,
                    )
                },
                0
            );
            let result = std::thread::spawn(move || probe(&shortcut(), 0x86)).join();
            // Release the fixture before asserting, including on a failed probe.
            assert_ne!(unsafe { UnregisterHotKey(std::ptr::null_mut(), 2) }, 0);
            assert_eq!(result.unwrap(), Ok(Availability::Conflict));
            assert_eq!(probe(&shortcut(), 0x86), Ok(Availability::Available));
        })
        .join()
        .unwrap();
    }
}
