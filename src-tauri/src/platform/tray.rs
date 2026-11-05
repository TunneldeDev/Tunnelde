use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::state::AppState;

const TRAY_ID: &str = "tunnelde";

struct Labels {
    show: &'static str,
    settings: &'static str,
    updates: &'static str,
    about: &'static str,
    restart: &'static str,
    quit: &'static str,
}

fn labels(chinese: bool) -> Labels {
    if chinese {
        Labels {
            show: "显示 Tunnelde",
            settings: "设置…",
            updates: "检查更新",
            about: "关于 Tunnelde",
            restart: "重启 Tunnelde…",
            quit: "退出",
        }
    } else {
        Labels {
            show: "Show Tunnelde",
            settings: "Settings…",
            updates: "Check for Updates",
            about: "About Tunnelde",
            restart: "Restart Tunnelde…",
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
            &MenuItem::with_id(app, "restart", labels.restart, true, None::<&str>)?,
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
            crate::platform::background::navigate(app, "settings");
        }
        "about" => {
            crate::platform::background::navigate(app, "about");
        }
        "updates" => {
            crate::platform::background::navigate(app, "updates");
            crate::update::spawn_check(app.clone());
        }
        "restart" => {
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
            let chinese = is_chinese(&app.state::<AppState>().locale());
            let (title, message, yes, no) = if chinese {
                (
                    "重启 Tunnelde？",
                    "重启会断开连接、中断后台任务并丢失未保存的编辑。请先保存工作。",
                    "重启",
                    "取消",
                )
            } else {
                ("Restart Tunnelde?", "Restarting disconnects sessions, interrupts background tasks and discards unsaved edits. Save your work first.", "Restart", "Cancel")
            };
            let handle = app.clone();
            app.dialog()
                .message(message)
                .title(title)
                .buttons(MessageDialogButtons::OkCancelCustom(yes.into(), no.into()))
                .show(move |confirmed| {
                    if confirmed {
                        if let Err(error) = crate::platform::restart::restart(&handle) {
                            tracing::error!(%error, "could not restart Tunnelde");
                            handle
                                .dialog()
                                .message(error.to_string())
                                .title("Tunnelde")
                                .show(|_| {});
                        }
                    }
                });
        }
        "quit" => app.exit(0),
        _ => {}
    }
}
