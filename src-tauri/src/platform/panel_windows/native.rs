//! Registered native-window adapter. Every command gets its identity from the
//! native caller, not a label or token claimed by JavaScript.
use super::{
    geometry,
    ownership::{Ownership, MAIN},
    protocol::Command,
};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde_json::Value;
use std::{sync::Mutex, time::Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};

#[derive(Default)]
pub(crate) struct Registry {
    ownership: Mutex<Ownership>,
    // Native focus order only; never trust browser screenX/screenY for drops.
    focus: Mutex<Vec<String>>,
}
fn lock(registry: &Registry) -> std::sync::MutexGuard<'_, Ownership> {
    registry
        .ownership
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}
fn invalid(error: &'static str) -> AppError {
    AppError::validation(error)
}
pub(crate) fn has_satellites(app: &AppHandle) -> bool {
    app.try_state::<Registry>()
        .is_some_and(|registry| lock(&registry).has_satellites())
}
pub(crate) fn without_satellites<T>(app: &AppHandle, action: impl FnOnce() -> T) -> Option<T> {
    let registry = app.state::<Registry>();
    let ownership = lock(&registry);
    if ownership.has_satellites() {
        return None;
    }
    Some(action())
}
pub(crate) fn registered(app: &AppHandle, window: &str) -> bool {
    app.try_state::<Registry>()
        .is_some_and(|registry| lock(&registry).document(window).is_some())
}
pub(crate) fn changed(app: &AppHandle) {
    let windows = lock(&app.state::<Registry>()).windows();
    for window in windows {
        if let Some(window) = app.get_webview_window(&window.id) {
            // Invalidation only. Staged drafts and document tokens must never
            // become event-bus payloads visible to unrelated plugin views.
            let _ = window.emit("ui://panel-windows-changed", ());
        }
    }
}
pub(crate) fn navigation_started(app: &AppHandle, window: &str) {
    let registry = app.state::<Registry>();
    let mut ownership = lock(&registry);
    if window == MAIN || ownership.document(window).is_some() {
        let _ = ownership.register(window);
        drop(ownership);
        changed(app);
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Initialization {
    window_id: String,
    document: String,
}
#[tauri::command]
pub(crate) fn panel_window_initialize(window: WebviewWindow) -> AppResult<Initialization> {
    let registry = window.state::<Registry>();
    let mut ownership = lock(&registry);
    // A native main document can initialize after a view-only recreation.
    // Every satellite must have been registered by the host builder first.
    if window.label() == MAIN && ownership.document(MAIN).is_none() {
        ownership.register(MAIN).map_err(invalid)?;
    }
    let document = ownership
        .document(window.label())
        .ok_or_else(|| invalid("invalid window"))?
        .to_owned();
    Ok(Initialization {
        window_id: window.label().into(),
        document,
    })
}
#[tauri::command]
pub(crate) fn panel_window_control(
    window: WebviewWindow,
    document: String,
    request: Command,
) -> AppResult<Value> {
    let app = window.app_handle();
    let registry = app.state::<Registry>();
    let notify = !matches!(
        &request,
        Command::Snapshot {}
            | Command::Authorize { .. }
            | Command::View { .. }
            | Command::Staged { .. }
            | Command::Checkpoint { .. }
            | Command::IssueDrag { .. }
            | Command::AcceptDrag { .. }
    );
    let result = lock(&registry)
        .dispatch(window.label(), &document, request, Instant::now())
        .map_err(invalid)?;
    if notify {
        changed(app);
    }
    Ok(result)
}
fn coordinator(registry: &Registry, window: &WebviewWindow, document: &str) -> AppResult<()> {
    if window.label() != MAIN {
        return Err(invalid("coordinator required"));
    }
    lock(registry)
        .authorize(window.label(), document)
        .map_err(invalid)
}
#[tauri::command]
pub(crate) async fn panel_window_create(
    app: AppHandle,
    window: WebviewWindow,
    document: String,
) -> AppResult<String> {
    let registry = app.state::<Registry>();
    coordinator(&registry, &window, &document)?;
    let id = format!("panel-{}", uuid::Uuid::new_v4());
    // Register before building: pending creations also keep the coordinator
    // alive. A tray checkpoint already queued is invalidated before it commits.
    {
        let mut ownership = lock(&registry);
        if !super::super::window::is_ready(&app) || super::super::background::keep_alive(&app) {
            return Err(invalid("coordinator unavailable"));
        }
        ownership.register(&id).map_err(invalid)?;
    }
    super::super::background::cancel(&app);
    let bounds = match placement(&window) {
        Ok(bounds) => bounds,
        Err(error) => {
            let _ = lock(&registry).destroyed(&id);
            return Err(error);
        }
    };
    let build_app = app.clone();
    let build_id = id.clone();
    // WebView2 construction in a sync IPC/main-thread callback can deadlock.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let target = tauri::WebviewWindowBuilder::new(
            &build_app,
            &build_id,
            tauri::WebviewUrl::App("index.html?panelWindow=1".into()),
        )
        .title("Tunnelde")
        .inner_size(720.0, 520.0)
        .min_inner_size(320.0, 240.0)
        .visible(false)
        .build()?;
        target.set_position(tauri::PhysicalPosition::new(
            bounds.x.round() as i32,
            bounds.y.round() as i32,
        ))?;
        target.set_size(tauri::PhysicalSize::new(
            bounds.width.round() as u32,
            bounds.height.round() as u32,
        ))?;
        let settings = build_app.state::<crate::state::AppState>().settings();
        super::super::window::apply_theme(&build_app, &settings.theme);
        super::super::window::apply_title_bar_style(&build_app, &settings.title_bar_style)?;
        super::super::window::configure_webview(&build_app);
        let handle = build_app.clone();
        let target_id = build_id.clone();
        target.on_window_event(move |event| native_event(&handle, &target_id, event));
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|error| AppError::internal(error.to_string()))
    .and_then(|result| result);
    if let Err(error) = result {
        if let Some(target) = app.get_webview_window(&id) {
            let _ = target.destroy();
        }
        let _ = lock(&registry).destroyed(&id);
        changed(&app);
        return Err(error);
    }
    // Creation must become ready in bounded time or rollback the empty window.
    let timeout_app = app.clone();
    let timeout_id = id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        let registry = timeout_app.state::<Registry>();
        let ownership = lock(&registry);
        let timed_out = ownership
            .windows()
            .iter()
            .any(|window| window.id == timeout_id && !window.ready)
            && ownership.can_destroy(&timeout_id);
        drop(ownership);
        if timed_out {
            if let Some(window) = timeout_app.get_webview_window(&timeout_id) {
                let _ = window.destroy();
            }
        }
    });
    changed(&app);
    Ok(id)
}
fn placement(window: &WebviewWindow) -> AppResult<geometry::Rect> {
    let position = window.outer_position()?;
    let scale = window.scale_factor()?;
    let monitors: Vec<_> = window
        .available_monitors()?
        .into_iter()
        .map(|monitor| {
            let area = monitor.work_area();
            geometry::Monitor {
                scale: monitor.scale_factor(),
                work_area: geometry::Rect {
                    x: area.position.x as f64,
                    y: area.position.y as f64,
                    width: area.size.width as f64,
                    height: area.size.height as f64,
                },
            }
        })
        .collect();
    geometry::restore(
        geometry::SavedBounds {
            scale,
            rect: geometry::Rect {
                x: position.x as f64 + 40.0 * scale,
                y: position.y as f64 + 40.0 * scale,
                width: 720.0 * scale,
                height: 520.0 * scale,
            },
        },
        &monitors,
    )
    .ok_or_else(|| invalid("window monitor unavailable"))
}
#[tauri::command]
pub(crate) fn panel_window_show(window: WebviewWindow, document: String) -> AppResult<()> {
    let registry = window.state::<Registry>();
    let ownership = lock(&registry);
    ownership
        .authorize(window.label(), &document)
        .map_err(invalid)?;
    if window.label() == MAIN
        || !ownership
            .windows()
            .iter()
            .any(|item| item.id == window.label() && item.ready && !item.closing)
    {
        return Err(invalid("window not ready"));
    }
    drop(ownership);
    window.show()?;
    window.set_focus()?;
    super::super::window::apply_background_dock_preference(window.app_handle());
    Ok(())
}
#[tauri::command]
pub(crate) fn panel_window_destroy(
    window: WebviewWindow,
    document: String,
    target: String,
) -> AppResult<()> {
    let registry = window.state::<Registry>();
    let ownership = lock(&registry);
    ownership
        .authorize(window.label(), &document)
        .map_err(invalid)?;
    if window.label() != MAIN && window.label() != target {
        return Err(invalid("invalid window"));
    }
    if ownership.document(&target).is_none() || !ownership.can_destroy(&target) {
        return Err(invalid("window still owns panels"));
    }
    drop(ownership);
    if let Some(target) = window.app_handle().get_webview_window(&target) {
        target.destroy()?;
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn panel_window_drop_target(
    window: WebviewWindow,
    document: String,
) -> AppResult<Option<String>> {
    let app = window.app_handle();
    let registry = app.state::<Registry>();
    lock(&registry)
        .authorize(window.label(), &document)
        .map_err(invalid)?;
    let cursor = app.cursor_position()?;
    let registered = lock(&registry).windows();
    let focus = registry
        .focus
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let mut windows: Vec<_> = registered
        .into_iter()
        .filter_map(|item| {
            let window = app.get_webview_window(&item.id)?;
            let position = window.outer_position().ok()?;
            let size = window.outer_size().ok()?;
            Some((
                item.id,
                geometry::Rect {
                    x: position.x as f64,
                    y: position.y as f64,
                    width: size.width as f64,
                    height: size.height as f64,
                },
                window.is_visible().ok()? && !window.is_minimized().ok()?,
            ))
        })
        .collect();
    windows.sort_by_key(|(id, _, _)| {
        focus
            .iter()
            .position(|item| item == id)
            .unwrap_or(usize::MAX)
    });
    let bounds: Vec<_> = windows
        .iter()
        .map(|(id, rect, visible)| geometry::WindowBounds {
            id,
            rect: *rect,
            visible: *visible,
        })
        .collect();
    Ok(geometry::drop_target(cursor.x, cursor.y, &bounds).map(str::to_owned))
}
pub(crate) fn native_event(app: &AppHandle, window: &str, event: &WindowEvent) {
    let registry = app.state::<Registry>();
    match event {
        WindowEvent::Focused(true) => {
            let mut order = registry
                .focus
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            order.retain(|id| id != window);
            order.insert(0, window.into());
        }
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            // The UI must freeze/capture all panels and return them before this
            // window can be destroyed. No session/task cleanup happens here.
            if let Some(target) = app.get_webview_window(window) {
                let _ = target.emit("ui://panel-window-close", ());
            }
        }
        WindowEvent::Destroyed if window != MAIN => {
            let _ = lock(&registry).destroyed(window);
            registry
                .focus
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .retain(|id| id != window);
            changed(app);
            super::super::window::apply_background_dock_preference(app);
            if !has_satellites(app) {
                super::super::background::request(app);
            }
        }
        _ => {}
    }
}
pub(crate) fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let expired = lock(&app.state::<Registry>()).expire(Instant::now());
            if !expired.is_empty() {
                changed(&app);
            }
        }
    });
}
