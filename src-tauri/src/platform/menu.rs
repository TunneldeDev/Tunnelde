// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter};

use crate::error::AppResult;

const REPOSITORY: &str = "https://github.com/TunneldeDev/Tunnelde";
const LICENSE: &str = "https://www.gnu.org/licenses/gpl-3.0.html";

struct Labels {
    file: &'static str,
    settings: &'static str,
    quit: &'static str,
    view: &'static str,
    welcome: &'static str,
    updates: &'static str,
    about: &'static str,
    help: &'static str,
    repository: &'static str,
    license: &'static str,
}

fn labels(locale: &str) -> Labels {
    if locale == "zh-CN" {
        Labels {
            file: "文件",
            settings: "设置…",
            quit: "退出",
            view: "视图",
            welcome: "欢迎页",
            updates: "检查更新",
            about: "关于 Tunnelde",
            help: "帮助",
            repository: "项目主页",
            license: "许可证",
        }
    } else {
        Labels {
            file: "File",
            settings: "Settings…",
            quit: "Quit",
            view: "View",
            welcome: "Welcome",
            updates: "Check for updates",
            about: "About Tunnelde",
            help: "Help",
            repository: "Project page",
            license: "License",
        }
    }
}

/// The OS menu bar is optional: the app already has its own compact chrome,
/// so Windows and Linux only show a menu when the user asks for one.
pub fn apply(app: &AppHandle, enabled: bool, locale: &str) -> AppResult<()> {
    if !enabled {
        app.remove_menu()?;
        return Ok(());
    }

    let text = labels(locale);
    let settings = MenuItem::with_id(app, "settings", text.settings, true, Some("CmdOrCtrl+,"))?;
    let welcome = MenuItem::with_id(app, "welcome", text.welcome, true, None::<&str>)?;
    let updates = MenuItem::with_id(app, "updates", text.updates, true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", text.about, true, None::<&str>)?;
    let repository = MenuItem::with_id(app, "repository", text.repository, true, None::<&str>)?;
    let license = MenuItem::with_id(app, "license", text.license, true, None::<&str>)?;

    let file = Submenu::with_items(
        app,
        text.file,
        true,
        &[
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(text.quit))?,
        ],
    )?;
    let view = Submenu::with_items(app, text.view, true, &[&welcome, &updates])?;
    let help = Submenu::with_items(
        app,
        text.help,
        true,
        &[&about, &repository, &license],
    )?;

    let menu = Menu::with_items(app, &[&file, &view, &help])?;
    app.set_menu(menu)?;
    Ok(())
}

pub fn handle_event(app: &AppHandle, id: &str) {
    match id {
        "settings" | "welcome" | "updates" | "about" => {
            let _ = app.emit("ui://navigate", id);
        }
        "repository" => open(app, REPOSITORY),
        "license" => open(app, LICENSE),
        _ => {}
    }
}

fn open(app: &AppHandle, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(url, None::<&str>);
}
