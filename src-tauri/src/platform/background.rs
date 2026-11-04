use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_window_state::AppHandleExt;

use crate::error::{AppError, AppResult};

const MAX_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Default)]
struct Lifecycle {
    generation: u64,
    request: Option<u64>,
    suspended: bool,
    creating: bool,
    reopen: bool,
    snapshot: Option<String>,
    navigation: Option<String>,
}

#[derive(Default)]
pub struct BackgroundWindow(Mutex<Lifecycle>);

fn enabled(app: &AppHandle) -> bool {
    app.state::<crate::state::AppState>()
        .settings()
        .release_webview_in_tray
}

pub fn request(app: &AppHandle) {
    if !enabled(app) {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(true) {
        return;
    }
    let state = app.state::<BackgroundWindow>();
    let token = {
        let mut guard = state.0.lock().unwrap_or_else(|error| error.into_inner());
        if guard.request.is_some() || guard.suspended || guard.creating {
            return;
        }
        guard.generation += 1;
        let token = guard.generation;
        guard.request = Some(token);
        token
    };
    if window.emit("ui://suspend", token).is_err() {
        cancel(app);
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;
        let pending = handle
            .state::<BackgroundWindow>()
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .request
            == Some(token);
        if pending {
            cancel(&handle);
            retry(&handle);
        }
    });
}

fn retry(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        request(&handle);
    });
}

pub fn cancel(app: &AppHandle) {
    {
        let state = app.state::<BackgroundWindow>();
        let mut guard = state.0.lock().unwrap_or_else(|error| error.into_inner());
        // Once accepted, only the new WebView may reattach the SSH streams.
        // A rapid tray click must not send pending bytes to the dying view.
        if guard.suspended {
            return;
        }
        guard.request = None;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("ui://resume", ());
    }
}

pub fn keep_alive(app: &AppHandle) -> bool {
    let state = app.state::<BackgroundWindow>();
    let guard = state.0.lock().unwrap_or_else(|error| error.into_inner());
    guard.suspended || guard.creating
}

/// True means the caller must wait for recreation/readiness before showing.
pub fn show_or_create(app: &AppHandle) -> bool {
    cancel(app);
    let state = app.state::<BackgroundWindow>();
    {
        let mut guard = state.0.lock().unwrap_or_else(|error| error.into_inner());
        if guard.suspended && app.get_webview_window("main").is_some() {
            guard.reopen = true;
            return true;
        }
        if app.get_webview_window("main").is_some() {
            return false;
        }
        if guard.creating {
            return true;
        }
        guard.creating = true;
        guard.reopen = false;
    }
    let handle = app.clone();
    // WebView2 creation from a synchronous native event handler can deadlock.
    std::thread::spawn(move || {
        tracing::debug!("recreating main window");
        let result = create_window(&handle);
        tracing::debug!("main window recreation finished");
        let state = handle.state::<BackgroundWindow>();
        let mut guard = state.0.lock().unwrap_or_else(|error| error.into_inner());
        guard.creating = false;
        if let Err(error) = result {
            tracing::error!(%error, "could not recreate main window");
        }
    });
    true
}

fn create_window(app: &AppHandle) -> AppResult<()> {
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .ok_or_else(|| AppError::internal("missing main window configuration"))?
        .clone();
    config.visible = false;
    super::window::reset_readiness(app);
    tracing::debug!("building main WebView");
    tauri::WebviewWindowBuilder::from_config(app, &config)?.build()?;
    let handle = app.clone();
    // The window-state plugin locks its cache while applying geometry. Doing
    // this on a worker can race a queued resize event: the event waits for the
    // cache while the worker waits for a native main-thread geometry query.
    app.run_on_main_thread(move || {
        tracing::debug!("restoring main window geometry");
        super::window::restore_main_geometry(&handle);
        let settings = handle.state::<crate::state::AppState>().settings();
        super::window::apply_theme(&handle, &settings.theme);
        if let Err(error) = super::window::apply_title_bar_style(&handle, &settings.title_bar_style)
        {
            tracing::warn!(%error, "could not restore title bar style");
        }
        super::window::install_close_handler(&handle);
        super::window::configure_webview(&handle);
    })?;
    Ok(())
}

pub fn destroyed(app: &AppHandle) {
    let reopen = {
        let state = app.state::<BackgroundWindow>();
        let mut guard = state.0.lock().unwrap_or_else(|error| error.into_inner());
        guard.request = None;
        std::mem::take(&mut guard.reopen)
    };
    super::window::apply_background_dock_preference(app);
    if reopen {
        let handle = app.clone();
        std::thread::spawn(move || {
            for _ in 0..100 {
                if handle.get_webview_window("main").is_none() {
                    show_or_create(&handle);
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            tracing::warn!("main window destruction did not complete before reopen");
        });
    }
}

pub fn ready(app: &AppHandle) {
    let navigation = {
        let state = app.state::<BackgroundWindow>();
        let mut guard = state.0.lock().unwrap_or_else(|error| error.into_inner());
        guard.suspended = false;
        guard.snapshot = None;
        guard.navigation.take()
    };
    if let Some(page) = navigation {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit("ui://navigate", page);
        }
    }
}

pub fn navigate(app: &AppHandle, page: &str) {
    if keep_alive(app) || !super::window::is_ready(app) {
        app.state::<BackgroundWindow>()
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .navigation = Some(page.to_owned());
    } else if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("ui://navigate", page);
    }
    super::window::show_main(app);
}

#[tauri::command]
pub fn main_window_snapshot(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> AppResult<Option<String>> {
    if window.label() != "main" {
        return Err(AppError::validation("invalid window"));
    }
    Ok(app
        .state::<BackgroundWindow>()
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .snapshot
        .clone())
}

#[tauri::command]
pub async fn main_window_suspend(
    app: AppHandle,
    window: tauri::WebviewWindow,
    token: u64,
    snapshot: Option<String>,
) -> AppResult<bool> {
    if window.label() != "main" {
        return Err(AppError::validation("invalid window"));
    }
    let Some(snapshot) = snapshot else {
        let current = app
            .state::<BackgroundWindow>()
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .request
            == Some(token);
        if current {
            cancel(&app);
            retry(&app);
        }
        return Ok(false);
    };
    if snapshot.len() > MAX_SNAPSHOT_BYTES || !snapshot.starts_with('{') {
        return Err(AppError::validation("window.snapshotTooLarge"));
    }
    if !enabled(&app) || window.is_visible()? {
        return Ok(false);
    }
    {
        let state = app.state::<BackgroundWindow>();
        let mut guard = state.0.lock().unwrap_or_else(|error| error.into_inner());
        if guard.request != Some(token) {
            return Ok(false);
        }
        guard.request = None;
        guard.snapshot = Some(snapshot);
        guard.suspended = true;
    }
    if let Err(error) = app.save_window_state(super::window::SAVED_STATE_FLAGS) {
        tracing::warn!(%error, "could not persist window geometry before suspension");
    }
    super::window::reset_readiness(&app);
    if let Err(error) = window.destroy() {
        let state = app.state::<BackgroundWindow>();
        let mut guard = state.0.lock().unwrap_or_else(|error| error.into_inner());
        guard.suspended = false;
        guard.snapshot = None;
        drop(guard);
        super::window::set_readiness(&app);
        cancel(&app);
        return Err(error.into());
    }
    Ok(true)
}
