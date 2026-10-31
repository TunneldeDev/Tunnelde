// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use tauri::{AppHandle, Manager, Theme, WindowEvent};

use crate::error::AppResult;
use crate::state::AppState;

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
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
            if keep_alive {
                api.prevent_close();
                let _ = target.hide();
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
