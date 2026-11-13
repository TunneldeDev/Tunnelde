use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, Theme, WindowEvent};
use tauri_plugin_window_state::{StateFlags, WindowExt};

use crate::error::AppResult;
use crate::state::AppState;
pub(crate) mod close;

// Visibility belongs to startup/tray handling; decorations belong to settings.
pub const SAVED_STATE_FLAGS: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED)
    .union(StateFlags::FULLSCREEN);

#[derive(Default)]
pub struct StartupWindow(AtomicBool);

pub fn is_ready(app: &AppHandle) -> bool {
    app.state::<StartupWindow>().0.load(Ordering::Acquire)
}

pub fn reset_readiness(app: &AppHandle) {
    app.state::<StartupWindow>()
        .0
        .store(false, Ordering::Release);
}

pub fn set_readiness(app: &AppHandle) {
    app.state::<StartupWindow>()
        .0
        .store(true, Ordering::Release);
}

pub fn restore_main_geometry(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // Defer fullscreen: native fullscreen transitions can reveal a window.
        let geometry = SAVED_STATE_FLAGS.difference(StateFlags::FULLSCREEN);
        if let Err(error) = window.restore_state(geometry) {
            tracing::warn!(%error, "could not restore window geometry");
        }
    }
}

#[tauri::command]
pub fn main_window_ready(app: AppHandle, window: tauri::WebviewWindow) -> AppResult<()> {
    if window.label() != "main" {
        return Err(crate::error::AppError::validation("invalid window"));
    }
    if !app.state::<StartupWindow>().0.swap(true, Ordering::AcqRel) {
        if let Err(error) = window.restore_state(StateFlags::FULLSCREEN) {
            tracing::warn!(%error, "could not restore fullscreen state");
        }
        super::background::ready(&app);
        show_main(&app);
    }
    Ok(())
}

pub fn show_main(app: &AppHandle) {
    if super::background::show_or_create(app) {
        return;
    }
    // A second launch, Dock click or tray action must not expose startup frames.
    if !app.state::<StartupWindow>().0.load(Ordering::Acquire) {
        return;
    }
    // Restore Dock presence before focusing the window. This also covers tray
    // actions and a second launch while the app is running without a Dock icon.
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Err(error) = handle.set_activation_policy(tauri::ActivationPolicy::Regular) {
                tracing::warn!(%error, "could not restore Dock icon");
            }
            let _ = handle.show();
            show_main_window(&handle);
        });
    }
    #[cfg(not(target_os = "macos"))]
    show_main_window(app);
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Re-evaluate on the main thread so preference changes and close/reopen events
/// use the current window state, even when queued close together.
pub fn apply_background_dock_preference(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let visible = handle
                .get_webview_window("main")
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(false);
            let show_in_background = handle
                .try_state::<AppState>()
                .map(|state| state.settings().show_dock_icon_in_background)
                .unwrap_or(false);
            // Accessory mode keeps the menu-bar tray available. Use activation
            // policy rather than Dock transforms, which can drop rapid hides.
            let policy = if visible || show_in_background {
                tauri::ActivationPolicy::Regular
            } else {
                tauri::ActivationPolicy::Accessory
            };
            if let Err(error) = handle.set_activation_policy(policy) {
                tracing::warn!(%error, "could not update background Dock icon");
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Keeps the native title bar in sync with the in-app theme.
pub fn apply_theme(app: &AppHandle, mode: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let theme = match mode {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None,
    };
    let _ = window.set_theme(theme);
    let background = app
        .try_state::<AppState>()
        .and_then(|state| {
            state
                .settings()
                .colors
                .get("background")
                .and_then(|s| s.parse().ok())
        })
        .unwrap_or_else(|| {
            if theme.or_else(|| window.theme().ok()) == Some(Theme::Light) {
                tauri::window::Color(242, 245, 250, 255)
            } else {
                tauri::window::Color(7, 11, 18, 255)
            }
        });
    let _ = window.set_background_color(Some(background));
}

/// Applies native chrome immediately, including when the preference changes.
pub fn apply_title_bar_style(app: &AppHandle, style: &str) -> AppResult<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let compact = style == "compact";

    #[cfg(not(target_os = "macos"))]
    {
        // On Windows Tauri installs its native edge/corner resize hit testing
        // when decorations are disabled, and removes it when they return.
        let decorated = !compact;
        if window.is_decorated()? != decorated {
            window.set_decorations(decorated)?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        // Keep native traffic lights, resizing, fullscreen and accessibility.
        if !window.is_decorated()? {
            window.set_decorations(true)?;
        }
        window.set_title_bar_style(if compact {
            tauri::TitleBarStyle::Overlay
        } else {
            tauri::TitleBarStyle::Visible
        })?;
        let target = window.clone();
        window.run_on_main_thread(move || {
            if let Ok(pointer) = target.ns_window() {
                // SAFETY: Tauri returned the live NSWindow for this target,
                // and all AppKit access runs on its required main thread.
                let native = unsafe { &*pointer.cast::<objc2_app_kit::NSWindow>() };
                native.setTitleVisibility(if compact {
                    objc2_app_kit::NSWindowTitleVisibility::Hidden
                } else {
                    objc2_app_kit::NSWindowTitleVisibility::Visible
                });
            }
        })?;
    }
    Ok(())
}

/// macOS keeps the app alive after the window closes; Windows and Linux
/// quit unless the user opted into the tray.
pub fn install_close_handler(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let handle = app.clone();
    let target = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let keep_alive = cfg!(target_os = "macos") || close_to_tray(&handle);
            let needs_review = close::intercept(&handle, keep_alive);
            if keep_alive {
                api.prevent_close();
                if target.hide().is_ok() {
                    apply_background_dock_preference(&handle);
                    super::background::request(&handle);
                }
            } else if needs_review {
                api.prevent_close();
            }
        }
    });
}

fn close_to_tray(app: &AppHandle) -> bool {
    app.try_state::<AppState>()
        .map(|state| state.settings().close_to_tray)
        .unwrap_or(false)
}

/// Strips the browser traits from the embedded WebView: no autofill popups,
/// no password bubbles, no page context menu, no reload/print shortcuts and
/// no devtools outside debug builds.
#[cfg(windows)]
pub fn configure_webview(app: &AppHandle) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Settings3, ICoreWebView2Settings4,
    };
    use windows_core::Interface;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let _ = window.with_webview(|webview| {
        let controller = webview.controller();
        let core = unsafe { controller.CoreWebView2() };
        let Ok(core) = core else {
            return;
        };
        let settings = unsafe { core.Settings() };
        let Ok(settings) = settings else {
            return;
        };

        let _ = unsafe { settings.SetAreDefaultContextMenusEnabled(false) };
        let _ = unsafe { settings.SetAreDevToolsEnabled(cfg!(debug_assertions)) };
        let _ = unsafe { settings.SetIsStatusBarEnabled(false) };
        let _ = unsafe { settings.SetIsZoomControlEnabled(false) };
        let _ = unsafe { settings.SetIsBuiltInErrorPageEnabled(false) };

        if let Ok(extension) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = unsafe { extension.SetAreBrowserAcceleratorKeysEnabled(false) };
        }
        if let Ok(extension) = settings.cast::<ICoreWebView2Settings4>() {
            let _ = unsafe { extension.SetIsGeneralAutofillEnabled(false) };
            let _ = unsafe { extension.SetIsPasswordAutosaveEnabled(false) };
        }
    });
}

#[cfg(not(windows))]
pub fn configure_webview(_app: &AppHandle) {}
