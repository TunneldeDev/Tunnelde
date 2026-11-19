//! Registered native-window adapter. Every command gets its identity from the
//! native caller, not a label or token claimed by JavaScript.
use super::{
    geometry,
    ownership::{Lease, Ownership, MAIN},
    protocol::Command,
};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashMap, sync::Mutex, time::Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};

#[derive(Clone)]
struct Creation {
    window: String,
    document: String,
}
#[derive(Default)]
pub(crate) struct Registry {
    creations: Mutex<HashMap<String, Creation>>,
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
        Command::ClaimActions {}
            | Command::ActionResult { .. }
            | Command::Snapshot {}
            | Command::Authorize { .. }
            | Command::View { .. }
            | Command::Staged { .. }
            | Command::ReadModel { .. }
            | Command::BeginModel { .. }
            | Command::StagedModel { .. }
            | Command::Checkpoint { .. }
            | Command::IssueDrag { .. }
            | Command::AcceptDrag { .. }
            | Command::CancelDrag { .. }
    );
    let result = lock(&registry)
        .dispatch(window.label(), &document, request, Instant::now())
        .map_err(invalid)?;
    if notify {
        changed(app);
    }
    Ok(result)
}
#[tauri::command]
pub(crate) async fn panel_window_create(
    app: AppHandle,
    window: WebviewWindow,
    document: String,
    lease: Option<Lease>,
) -> AppResult<String> {
    let registry = app.state::<Registry>();
    lock(&registry)
        .authorize_creation(window.label(), &document, lease.as_ref())
        .map_err(invalid)?;
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
    registry
        .creations
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(
            id.clone(),
            Creation {
                window: window.label().into(),
                document: document.clone(),
            },
        );
    super::super::background::cancel(&app);
    let bounds = match placement(&window) {
        Ok(bounds) => bounds,
        Err(error) => {
            let _ = lock(&registry).destroyed(&id);
            registry
                .creations
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&id);
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
    // Source ownership may have changed while native WebView construction was
    // awaiting the platform thread. Never return a destination to a stale caller.
    let result = result.and_then(|()| {
        lock(&registry)
            .authorize_creation(window.label(), &document, lease.as_ref())
            .map_err(invalid)
    });
    if let Err(error) = result {
        if let Some(target) = app.get_webview_window(&id) {
            let _ = target.destroy();
        }
        let _ = lock(&registry).destroyed(&id);
        registry
            .creations
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&id);
        changed(&app);
        return Err(error);
    }
    // An initialized destination can still be abandoned (source reload, failed
    // capture, cancelled handoff). Reap it even if it reached frontend ready;
    // never destroy an owned window or interrupt an active transfer.
    let timeout_app = app.clone();
    let timeout_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let deadline = Instant::now() + std::time::Duration::from_secs(20);
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let registry = timeout_app.state::<Registry>();
            let (gone_or_owned, empty) = {
                let ownership = lock(&registry);
                (
                    ownership.document(&timeout_id).is_none()
                        || ownership
                            .leases()
                            .iter()
                            .any(|lease| lease.window_id == timeout_id),
                    ownership.can_destroy(&timeout_id),
                )
            };
            if gone_or_owned {
                registry
                    .creations
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&timeout_id);
                break;
            }
            if empty && Instant::now() >= deadline {
                let Ok(_) = lock(&registry).reserve_empty_close(&timeout_id) else {
                    continue;
                };
                if let Some(window) = timeout_app.get_webview_window(&timeout_id) {
                    if window.destroy().is_err() {
                        lock(&registry).release_empty_close(&timeout_id);
                        continue;
                    }
                }
                let _ = lock(&registry).destroyed(&timeout_id);
                registry
                    .creations
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&timeout_id);
                changed(&timeout_app);
                break;
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
    if !ownership
        .windows()
        .iter()
        .any(|item| item.id == window.label() && item.ready && !item.closing)
    {
        return Err(invalid("window not ready"));
    }
    drop(ownership);
    if window.label() == MAIN {
        super::super::window::show_main(window.app_handle());
        return Ok(());
    }
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
    let mut ownership = lock(&registry);
    ownership
        .authorize(window.label(), &document)
        .map_err(invalid)?;
    if window.label() != MAIN && window.label() != target {
        let created = registry
            .creations
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&target)
            .cloned();
        if !created.is_some_and(|creation| {
            creation.window == window.label() && creation.document == document
        }) {
            return Err(invalid("invalid window"));
        }
    }
    ownership.reserve_empty_close(&target).map_err(invalid)?;
    drop(ownership);
    if let Some(target_window) = window.app_handle().get_webview_window(&target) {
        if let Err(error) = target_window.destroy() {
            lock(&registry).release_empty_close(&target);
            changed(window.app_handle());
            return Err(error.into());
        }
    } else {
        let _ = lock(&registry).destroyed(&target);
        registry
            .creations
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&target);
        changed(window.app_handle());
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn panel_window_drop_target(
    window: WebviewWindow,
    document: String,
) -> AppResult<Option<String>> {
    let registry = window.state::<Registry>();
    lock(&registry)
        .authorize(window.label(), &document)
        .map_err(invalid)?;
    native_drop_target(window.app_handle())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DragRelease {
    lease: Lease,
    target_window: Option<String>,
}
#[tauri::command]
pub(crate) fn panel_window_release_drag(
    window: WebviewWindow,
    document: String,
    token: String,
) -> AppResult<DragRelease> {
    let registry = window.state::<Registry>();
    // Sample on the native side at release. macOS normalizes per-window and
    // primary-monitor scales into one Cocoa desktop space, never browser CSS.
    let target_window = native_drop_target(window.app_handle())?;
    let lease = lock(&registry)
        .release_drag(window.label(), &document, &token, Instant::now())
        .map_err(invalid)?;
    Ok(DragRelease {
        lease,
        target_window,
    })
}
fn native_drop_target(app: &AppHandle) -> AppResult<Option<String>> {
    let registry = app.state::<Registry>();
    let cursor = app.cursor_position()?;
    #[cfg(target_os = "macos")]
    let cursor = {
        let scale = app
            .primary_monitor()?
            .ok_or_else(|| invalid("drop monitor unavailable"))?
            .scale_factor();
        if !scale.is_finite() || scale <= 0.0 {
            return Err(invalid("drop monitor unavailable"));
        }
        tauri::PhysicalPosition::new(cursor.x / scale, cursor.y / scale)
    };
    if !cursor.x.is_finite() || !cursor.y.is_finite() {
        return Err(invalid("drop cursor unavailable"));
    }
    let registered = lock(&registry).windows();
    let focus = registry
        .focus
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let mut windows: Vec<_> = registered
        .into_iter()
        .map(|item| {
            let window = app
                .get_webview_window(&item.id)
                .ok_or_else(|| invalid("drop geometry unavailable"))?;
            let visible = window.is_visible()? && !window.is_minimized()?;
            let position = window.outer_position()?;
            let size = window.outer_size()?;
            let rect = geometry::Rect {
                x: position.x as f64,
                y: position.y as f64,
                width: size.width as f64,
                height: size.height as f64,
            };
            #[cfg(target_os = "macos")]
            let rect = geometry::desktop_points(rect, window.scale_factor()?)
                .ok_or_else(|| invalid("drop geometry unavailable"))?;
            Ok((item.id, rect, visible))
        })
        .collect::<AppResult<_>>()?;
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
                .creations
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(window);
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

// The closed gateway does not accept an arbitrary command, host, credentials,
// or target window. Native identity + current lease authorize every action.
#[tauri::command]
pub(crate) async fn panel_window_disconnect(
    app: AppHandle,
    window: WebviewWindow,
    document: String,
    lease: Lease,
    session_id: String,
) -> AppResult<()> {
    if session_id.is_empty() || session_id.len() > 128 {
        return Err(invalid("invalid session"));
    }
    let registry = app.state::<Registry>();
    let id = lock(&registry)
        .begin_native_action(window.label(), &document, &lease)
        .map_err(invalid)?;
    struct ActionGuard {
        app: AppHandle,
        panel: String,
        id: String,
    }
    impl Drop for ActionGuard {
        fn drop(&mut self) {
            lock(&self.app.state::<Registry>()).finish_native_action(&self.panel, &self.id);
            changed(&self.app);
        }
    }
    let _guard = ActionGuard {
        app: app.clone(),
        panel: lease.panel_id,
        id,
    };
    crate::commands::ssh_disconnect(app.clone(), session_id).await
}

#[tauri::command]
pub(crate) fn panel_window_focus(
    window: WebviewWindow,
    document: String,
    panel_id: String,
) -> AppResult<()> {
    let app = window.app_handle();
    let registry = app.state::<Registry>();
    let ownership = lock(&registry);
    ownership
        .authorize(window.label(), &document)
        .map_err(invalid)?;
    let target = ownership
        .leases()
        .into_iter()
        .find(|lease| lease.panel_id == panel_id)
        .ok_or_else(|| invalid("panel not found"))?
        .window_id;
    if !ownership
        .windows()
        .iter()
        .any(|item| item.id == target && item.ready && !item.closing)
    {
        return Err(invalid("window not ready"));
    }
    drop(ownership);
    if target == MAIN {
        super::super::window::show_main(app);
    } else {
        let target = app
            .get_webview_window(&target)
            .ok_or_else(|| invalid("invalid window"))?;
        target.show()?;
        target.unminimize()?;
        target.set_focus()?;
        super::super::window::apply_background_dock_preference(app);
    }
    Ok(())
}
