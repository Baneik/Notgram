use tauri::{AppHandle, Manager};

const WINDOW_MARGIN: f64 = 12.0;

pub fn centered_on_main_monitor(app: &AppHandle, width: f64, height: f64) -> Option<(f64, f64)> {
    let monitor = app
        .get_webview_window("main")
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())?;
    Some(centered_position(
        monitor.position().x,
        monitor.position().y,
        monitor.size().width,
        monitor.size().height,
        monitor.scale_factor(),
        width,
        height,
    ))
}

fn centered_position(
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: u32,
    monitor_height: u32,
    scale_factor: f64,
    window_width: f64,
    window_height: f64,
) -> (f64, f64) {
    let scale_factor = scale_factor.max(0.1);
    let x = monitor_x as f64 / scale_factor;
    let y = monitor_y as f64 / scale_factor;
    let width = monitor_width as f64 / scale_factor;
    let height = monitor_height as f64 / scale_factor;
    let centered_x = x + (width - window_width).max(0.0) / 2.0;
    let centered_y = y + (height - window_height).max(0.0) / 2.0;
    (
        centered_x.clamp(
            x + WINDOW_MARGIN,
            (x + width - window_width - WINDOW_MARGIN).max(x + WINDOW_MARGIN),
        ),
        centered_y.clamp(
            y + WINDOW_MARGIN,
            (y + height - window_height - WINDOW_MARGIN).max(y + WINDOW_MARGIN),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::centered_position;

    #[test]
    fn centers_windows_on_the_monitor_containing_the_main_window() {
        assert_eq!(
            centered_position(1920, 0, 2560, 1440, 1.25, 880.0, 680.0),
            (2120.0, 236.0)
        );
    }

    #[test]
    fn preserves_negative_secondary_monitor_coordinates() {
        assert_eq!(
            centered_position(-1920, 0, 1920, 1080, 1.0, 960.0, 720.0),
            (-1440.0, 180.0)
        );
    }
}
