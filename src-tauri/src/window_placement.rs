use tauri::{AppHandle, Manager};

const WINDOW_MARGIN: f64 = 12.0;

pub fn centered_on_main_window(app: &AppHandle, width: f64, height: f64) -> Option<(f64, f64)> {
    let window = app.get_webview_window("main")?;
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let scale_factor = window.scale_factor().ok()?;
    Some(centered_in_window(
        position.x,
        position.y,
        size.width,
        size.height,
        scale_factor,
        width,
        height,
    ))
}

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

fn centered_in_window(
    main_x: i32,
    main_y: i32,
    main_width: u32,
    main_height: u32,
    scale_factor: f64,
    window_width: f64,
    window_height: f64,
) -> (f64, f64) {
    let scale_factor = scale_factor.max(0.1);
    let x = main_x as f64 / scale_factor;
    let y = main_y as f64 / scale_factor;
    let width = main_width as f64 / scale_factor;
    let height = main_height as f64 / scale_factor;
    (
        x + (width - window_width) / 2.0,
        y + (height - window_height) / 2.0,
    )
}

#[cfg(test)]
mod tests {
    use super::{centered_in_window, centered_position};

    #[test]
    fn centers_settings_over_the_main_window_like_the_previous_modal() {
        assert_eq!(
            centered_in_window(100, 80, 1220, 780, 1.0, 880.0, 680.0),
            (270.0, 130.0)
        );
    }

    #[test]
    fn centers_over_a_scaled_main_window_on_a_secondary_monitor() {
        assert_eq!(
            centered_in_window(2400, 125, 1525, 975, 1.25, 880.0, 680.0),
            (2090.0, 150.0)
        );
    }

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
