// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

const TRAY_ID: &str = "tunnelde";

struct Labels {
    show: &'static str,
    settings: &'static str,
    updates: &'static str,
    about: &'static str,
    quit: &'static str,
}

fn labels(chinese: bool) -> Labels {
    if chinese {
        Labels {
            show: "显示 Tunnelde",
            settings: "设置…",
            updates: "检查更新",
            about: "关于 Tunnelde",
            quit: "退出",
        }
    } else {
        Labels {
            show: "Show Tunnelde",
            settings: "Settings…",
            updates: "Check for Updates",
            about: "About Tunnelde",
            quit: "Quit",
        }
    }
}

fn is_chinese(locale: &str) -> bool {
    locale.starts_with("zh")
}

fn menu(app: &AppHandle, chinese: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let labels = labels(chinese);
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "show", labels.show, true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "settings", labels.settings, true, None::<&str>)?,
            &MenuItem::with_id(app, "updates", labels.updates, true, None::<&str>)?,
            &MenuItem::with_id(app, "about", labels.about, true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", labels.quit, true, None::<&str>)?,
        ],
    )
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let chinese = is_chinese(&app.state::<AppState>().locale());

    #[cfg(target_os = "macos")]
    let icon_bytes: &[u8] = include_bytes!("../../../resources/trayTemplate@2x.png");
    #[cfg(not(target_os = "macos"))]
    let icon_bytes: &[u8] = include_bytes!("../../../resources/tray-32.png");

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tauri::image::Image::from_bytes(icon_bytes)?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Tunnelde")
        .menu(&menu(app, chinese)?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::platform::window::show_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Rebuilds the tray menu after the UI language changes.
pub fn set_language(app: &AppHandle, locale: &str) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu(app, is_chinese(locale))?))?;
    }
    Ok(())
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "show" => crate::platform::window::show_main(app),
        "settings" => {
            crate::platform::window::show_main(app);
            let _ = app.emit("ui://navigate", "settings");
        }
        "about" => {
            crate::platform::window::show_main(app);
            let _ = app.emit("ui://navigate", "about");
        }
        "updates" => {
            crate::platform::window::show_main(app);
            let _ = app.emit("ui://navigate", "updates");
            crate::update::spawn_check(app.clone());
        }
        "quit" => app.exit(0),
        _ => {}
    }
}
