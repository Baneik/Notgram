use serde::Serialize;
use tauri::WebviewWindow;

const DEFAULT_REFRESH_RATE_HZ: f64 = 60.0;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayTiming {
    refresh_rate_hz: f64,
    native: bool,
}

fn valid_refresh_rate(refresh_rate_hz: u32) -> Option<f64> {
    (24..=1_000)
        .contains(&refresh_rate_hz)
        .then_some(refresh_rate_hz as f64)
}

#[cfg(windows)]
fn current_display_refresh_rate(window: &WebviewWindow) -> Result<f64, String> {
    use std::mem::size_of;
    use windows_sys::Win32::Graphics::Gdi::{
        DEVMODEW, ENUM_CURRENT_SETTINGS, EnumDisplaySettingsW, GetMonitorInfoW,
        MONITOR_DEFAULTTONEAREST, MONITORINFO, MONITORINFOEXW, MonitorFromWindow,
    };

    let hwnd = window
        .hwnd()
        .map_err(|error| format!("无法读取窗口句柄: {error}"))?;
    let monitor = unsafe { MonitorFromWindow(hwnd.0, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_null() {
        return Err("无法定位窗口所在的显示器".to_string());
    }

    let mut monitor_info = MONITORINFOEXW::default();
    monitor_info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    let monitor_info_ok =
        unsafe { GetMonitorInfoW(monitor, &mut monitor_info.monitorInfo as *mut MONITORINFO) };
    if monitor_info_ok == 0 {
        return Err("无法读取显示器信息".to_string());
    }

    let mut mode = DEVMODEW {
        dmSize: size_of::<DEVMODEW>() as u16,
        ..DEVMODEW::default()
    };
    let mode_ok = unsafe {
        EnumDisplaySettingsW(
            monitor_info.szDevice.as_ptr(),
            ENUM_CURRENT_SETTINGS,
            &mut mode,
        )
    };
    if mode_ok == 0 {
        return Err("无法读取显示器当前模式".to_string());
    }

    valid_refresh_rate(mode.dmDisplayFrequency)
        .ok_or_else(|| "显示器返回了无效的刷新率".to_string())
}

#[cfg(not(windows))]
fn current_display_refresh_rate(_window: &WebviewWindow) -> Result<f64, String> {
    Err("当前平台不提供原生显示器刷新率".to_string())
}

#[tauri::command]
pub fn notgram_display_timing(window: WebviewWindow) -> DisplayTiming {
    match current_display_refresh_rate(&window) {
        Ok(refresh_rate_hz) => DisplayTiming {
            refresh_rate_hz,
            native: true,
        },
        Err(_) => DisplayTiming {
            refresh_rate_hz: DEFAULT_REFRESH_RATE_HZ,
            native: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::valid_refresh_rate;

    #[test]
    fn accepts_realistic_display_refresh_rates() {
        assert_eq!(valid_refresh_rate(30), Some(30.0));
        assert_eq!(valid_refresh_rate(60), Some(60.0));
        assert_eq!(valid_refresh_rate(144), Some(144.0));
        assert_eq!(valid_refresh_rate(360), Some(360.0));
    }

    #[test]
    fn rejects_default_and_implausible_display_modes() {
        assert_eq!(valid_refresh_rate(0), None);
        assert_eq!(valid_refresh_rate(1), None);
        assert_eq!(valid_refresh_rate(1_001), None);
    }
}
