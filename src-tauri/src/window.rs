// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use tauri::{AppHandle, Manager, Theme, WindowEvent};

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
