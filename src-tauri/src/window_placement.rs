use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    thread,
    time::Duration,
};
use tauri::{
    App, AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, Window, WindowEvent,
};

const WINDOW_MARGIN: f64 = 12.0;
const MAIN_WINDOW_LABEL: &str = "main";
const MAIN_WINDOW_PLACEMENT_FILE: &str = "main-window-placement.json";
const MAIN_WINDOW_PLACEMENT_SCHEMA_VERSION: u8 = 1;
const PLACEMENT_WRITE_DELAY: Duration = Duration::from_millis(300);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MainWindowPlacement {
    schema_version: u8,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Default)]
struct PendingPlacement {
    latest: Option<MainWindowPlacement>,
    revision: u64,
}

struct PlacementPersistence {
    path: PathBuf,
    pending: Mutex<PendingPlacement>,
    wake: Condvar,
    write_lock: Mutex<()>,
}

#[derive(Clone)]
pub struct MainWindowPlacementState {
    persistence: Arc<PlacementPersistence>,
}

impl MainWindowPlacementState {
    fn new(path: PathBuf, placement: Option<MainWindowPlacement>) -> Self {
        let persistence = Arc::new(PlacementPersistence {
            path,
            pending: Mutex::new(PendingPlacement {
                latest: placement,
                revision: 0,
            }),
            wake: Condvar::new(),
            write_lock: Mutex::new(()),
        });
        start_persistence_worker(Arc::clone(&persistence));
        Self { persistence }
    }

    fn update(&self, placement: MainWindowPlacement) {
        if let Ok(mut pending) = self.persistence.pending.lock() {
            pending.latest = Some(placement);
            pending.revision = pending.revision.wrapping_add(1);
            self.persistence.wake.notify_one();
        }
    }

    fn latest(&self) -> Option<MainWindowPlacement> {
        self.persistence
            .pending
            .lock()
            .ok()
            .and_then(|pending| pending.latest)
    }

    pub fn flush(&self) {
        persist_latest(&self.persistence);
    }
}

fn start_persistence_worker(persistence: Arc<PlacementPersistence>) {
    thread::spawn(move || {
        let mut persisted_revision = 0;
        loop {
            let Ok(pending) = persistence.pending.lock() else {
                return;
            };
            let Ok((pending, _)) =
                persistence
                    .wake
                    .wait_timeout_while(pending, PLACEMENT_WRITE_DELAY, |state| {
                        state.revision == persisted_revision
                    })
            else {
                return;
            };
            if pending.revision == persisted_revision {
                continue;
            }
            let revision = pending.revision;
            drop(pending);
            thread::sleep(PLACEMENT_WRITE_DELAY);
            let Ok(pending) = persistence.pending.lock() else {
                return;
            };
            if pending.revision != revision {
                continue;
            }
            persisted_revision = revision;
            drop(pending);
            persist_latest(&persistence);
        }
    });
}

fn persist_latest(persistence: &PlacementPersistence) {
    let Ok(_write_guard) = persistence.write_lock.lock() else {
        return;
    };
    let placement = persistence
        .pending
        .lock()
        .ok()
        .and_then(|pending| pending.latest);
    if let Some(placement) = placement
        && let Err(error) = write_placement(&persistence.path, placement)
    {
        eprintln!("Unable to save Notgram main window placement: {error}");
    }
}

fn read_placement(path: &Path) -> Option<MainWindowPlacement> {
    let placement = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<MainWindowPlacement>(&bytes).ok())?;
    (placement.schema_version == MAIN_WINDOW_PLACEMENT_SCHEMA_VERSION
        && placement.width > 0
        && placement.height > 0)
        .then_some(placement)
}

fn write_placement(path: &Path, placement: MainWindowPlacement) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("window placement path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("tmp");
    let payload = serde_json::to_vec(&placement)?;
    let mut file = fs::File::create(&temporary)?;
    file.write_all(&payload)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temporary, path)
}

fn intersection_area(placement: MainWindowPlacement, work_area: WorkArea) -> u64 {
    let left = i64::from(placement.x).max(i64::from(work_area.x));
    let top = i64::from(placement.y).max(i64::from(work_area.y));
    let right = (i64::from(placement.x) + i64::from(placement.width))
        .min(i64::from(work_area.x) + i64::from(work_area.width));
    let bottom = (i64::from(placement.y) + i64::from(placement.height))
        .min(i64::from(work_area.y) + i64::from(work_area.height));
    u64::try_from((right - left).max(0) * (bottom - top).max(0)).unwrap_or_default()
}

fn fit_placement_to_work_areas(
    placement: MainWindowPlacement,
    work_areas: &[WorkArea],
    primary_work_area: Option<WorkArea>,
) -> Option<MainWindowPlacement> {
    let target = work_areas
        .iter()
        .copied()
        .max_by_key(|work_area| intersection_area(placement, *work_area))
        .filter(|work_area| intersection_area(placement, *work_area) > 0)
        .or(primary_work_area)
        .or_else(|| work_areas.first().copied())?;
    let width = placement.width.min(target.width).max(1);
    let height = placement.height.min(target.height).max(1);
    let maximum_x = i64::from(target.x) + i64::from(target.width) - i64::from(width);
    let maximum_y = i64::from(target.y) + i64::from(target.height) - i64::from(height);
    Some(MainWindowPlacement {
        x: i64::from(placement.x)
            .clamp(i64::from(target.x), maximum_x)
            .try_into()
            .unwrap_or(target.x),
        y: i64::from(placement.y)
            .clamp(i64::from(target.y), maximum_y)
            .try_into()
            .unwrap_or(target.y),
        width,
        height,
        ..placement
    })
}

fn work_area(monitor: &tauri::window::Monitor) -> WorkArea {
    let area = monitor.work_area();
    WorkArea {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    }
}

fn captured_placement(
    minimized: bool,
    maximized: bool,
    position: Option<PhysicalPosition<i32>>,
    size: Option<PhysicalSize<u32>>,
    previous: Option<MainWindowPlacement>,
) -> Option<MainWindowPlacement> {
    if minimized {
        return previous;
    }
    if maximized {
        return previous.map(|placement| MainWindowPlacement {
            maximized: true,
            ..placement
        });
    }
    let position = position?;
    let size = size?;
    Some(MainWindowPlacement {
        schema_version: MAIN_WINDOW_PLACEMENT_SCHEMA_VERSION,
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: false,
    })
}

fn capture_window_placement(
    window: &Window,
    previous: Option<MainWindowPlacement>,
) -> Option<MainWindowPlacement> {
    captured_placement(
        window.is_minimized().ok()?,
        window.is_maximized().ok()?,
        window.outer_position().ok(),
        window.outer_size().ok(),
        previous,
    )
}

fn capture_webview_window_placement(
    window: &WebviewWindow,
    previous: Option<MainWindowPlacement>,
) -> Option<MainWindowPlacement> {
    captured_placement(
        window.is_minimized().ok()?,
        window.is_maximized().ok()?,
        window.outer_position().ok(),
        window.outer_size().ok(),
        previous,
    )
}

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let path = crate::distribution::app_config_directory(app.handle())
        .map_err(std::io::Error::other)?
        .join(MAIN_WINDOW_PLACEMENT_FILE);
    let stored = read_placement(&path);
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or("Notgram main window is unavailable")?;
    let monitors = window.available_monitors()?;
    let work_areas = monitors.iter().map(work_area).collect::<Vec<_>>();
    let primary_work_area = window.primary_monitor()?.as_ref().map(work_area);
    let restored = stored.and_then(|placement| {
        fit_placement_to_work_areas(placement, &work_areas, primary_work_area)
    });
    if let Some(placement) = restored {
        window.set_size(PhysicalSize::new(placement.width, placement.height))?;
        window.set_position(PhysicalPosition::new(placement.x, placement.y))?;
        if placement.maximized {
            window.maximize()?;
        }
    }
    let state = MainWindowPlacementState::new(path, restored);
    if restored.is_none()
        && let Some(placement) = capture_webview_window_placement(&window, None)
    {
        state.update(placement);
    }
    app.manage(state);
    Ok(())
}

pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW_LABEL
        || !matches!(
            event,
            WindowEvent::Moved(_)
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
        )
    {
        return;
    }
    let Some(state) = window.try_state::<MainWindowPlacementState>() else {
        return;
    };
    let previous = state.latest();
    if let Some(placement) = capture_window_placement(window, previous) {
        state.update(placement);
    }
}

pub fn flush_window(window: &Window) {
    let Some(state) = window.try_state::<MainWindowPlacementState>() else {
        return;
    };
    if let Some(placement) = capture_window_placement(window, state.latest()) {
        state.update(placement);
    }
    state.flush();
}

pub fn flush_main_window(app: &AppHandle) {
    let Some(state) = app.try_state::<MainWindowPlacementState>() else {
        return;
    };
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL)
        && let Some(placement) = capture_webview_window_placement(&window, state.latest())
    {
        state.update(placement);
    }
    state.flush();
}

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
    use super::{
        MainWindowPlacement, WorkArea, centered_in_window, centered_position,
        fit_placement_to_work_areas, intersection_area,
    };

    fn placement(x: i32, y: i32, width: u32, height: u32) -> MainWindowPlacement {
        MainWindowPlacement {
            schema_version: 1,
            x,
            y,
            width,
            height,
            maximized: false,
        }
    }

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

    #[test]
    fn keeps_a_visible_placement_on_its_existing_monitor() {
        let secondary = WorkArea {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1040,
        };
        let original = placement(-1600, 120, 1220, 780);
        assert_eq!(
            fit_placement_to_work_areas(original, &[secondary], Some(secondary)),
            Some(original)
        );
        assert_eq!(intersection_area(original, secondary), 951_600);
    }

    #[test]
    fn moves_an_offscreen_placement_to_the_primary_work_area() {
        let primary = WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };
        assert_eq!(
            fit_placement_to_work_areas(placement(2400, 200, 1220, 780), &[primary], Some(primary)),
            Some(placement(700, 200, 1220, 780))
        );
    }

    #[test]
    fn shrinks_a_placement_that_is_larger_than_the_available_work_area() {
        let primary = WorkArea {
            x: 0,
            y: 0,
            width: 1024,
            height: 720,
        };
        assert_eq!(
            fit_placement_to_work_areas(placement(-50, -50, 1800, 1200), &[primary], Some(primary)),
            Some(placement(0, 0, 1024, 720))
        );
    }
}
