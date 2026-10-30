// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::{Group, GroupInput, Host, HostInput, TabRecord};
use crate::settings::{Settings, ACCENTS, DENSITIES, LANGUAGES, THEMES};
use crate::ssh::{self, HostKeyInfo, SessionInfo, SshConnectRequest};
use crate::state::AppState;
use crate::system::{self, SystemStats};
use crate::update::{self, UpdateState, RELEASES_PAGE};

const TAB_KINDS: [&str; 6] = [
    "welcome", "host", "settings", "about", "updates", "terminal",
];
const MAX_TABS: usize = 40;
const MAX_USER_CSS: usize = 200_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSchema {
    languages: Vec<&'static str>,
    themes: Vec<&'static str>,
    accents: Vec<&'static str>,
    densities: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: String,
    version: String,
    tauri_version: String,
    os: String,
    arch: String,
    debug: bool,
    data_dir: String,
    log_dir: String,
    schema: SettingsSchema,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostsSnapshot {
    groups: Vec<Group>,
    hosts: Vec<Host>,
}

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<'_, AppState>) -> AppInfo {
    let package = app.package_info();
    AppInfo {
        name: "Tunnelde".into(),
        version: package.version.to_string(),
        tauri_version: tauri::VERSION.to_string(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        debug: cfg!(debug_assertions),
        data_dir: state.data_dir.to_string_lossy().into_owned(),
        log_dir: state.log_dir.to_string_lossy().into_owned(),
        schema: SettingsSchema {
            languages: LANGUAGES.to_vec(),
            themes: THEMES.to_vec(),
            accents: ACCENTS.to_vec(),
            densities: DENSITIES.to_vec(),
        },
    }
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
pub fn settings_update(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: Value,
) -> AppResult<Settings> {
    let mut base = serde_json::to_value(state.settings())?;
    merge_json(&mut base, patch);
    let mut next: Settings = serde_json::from_value(base)
        .map_err(|error| AppError::validation(format!("settings.invalid: {error}")))?;
    next.sanitize();

    state.db.with(|conn| db::settings::save(conn, &next))?;
    state.set_settings(next.clone());
    crate::window::apply_theme(&app, &next.theme);
    let _ = app.emit("settings://changed", &next);
    Ok(next)
}

#[tauri::command]
pub fn settings_reset(app: AppHandle, state: State<'_, AppState>) -> AppResult<Settings> {
    let mut next = Settings::default();
    next.sanitize();
    state.db.with(|conn| db::settings::save(conn, &next))?;
    state.set_settings(next.clone());
    crate::window::apply_theme(&app, &next.theme);
    let _ = app.emit("settings://changed", &next);
    Ok(next)
}

#[tauri::command]
pub fn set_locale(app: AppHandle, state: State<'_, AppState>, locale: String) -> AppResult<()> {
    if !["zh-CN", "en-US"].contains(&locale.as_str()) {
        return Err(AppError::validation("locale.invalid"));
    }
    state.set_locale(locale.clone());
    crate::tray::set_language(&app, &locale)?;
    Ok(())
}

#[tauri::command]
pub fn hosts_snapshot(state: State<'_, AppState>) -> AppResult<HostsSnapshot> {
    state.db.with(|conn| {
        Ok(HostsSnapshot {
            groups: db::hosts::list_groups(conn)?,
            hosts: db::hosts::list_hosts(conn)?,
        })
    })
}

#[tauri::command]
pub fn host_create(state: State<'_, AppState>, input: HostInput) -> AppResult<Host> {
    let draft = input.validate()?;
    state.db.with(|conn| db::hosts::create_host(conn, &draft))
}

#[tauri::command]
pub fn host_update(state: State<'_, AppState>, id: String, input: HostInput) -> AppResult<Host> {
    let draft = input.validate()?;
    state
        .db
        .with(|conn| db::hosts::update_host(conn, &id, &draft))
}

#[tauri::command]
pub fn host_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.db.with(|conn| db::hosts::delete_host(conn, &id))
}

#[tauri::command]
pub fn host_mark_used(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.db.with(|conn| db::hosts::mark_used(conn, &id))
}

#[tauri::command]
pub fn group_create(state: State<'_, AppState>, input: GroupInput) -> AppResult<Group> {
    let (name, parent_id) = input.validate()?;
    state
        .db
        .with(|conn| db::hosts::create_group(conn, &name, parent_id.as_deref()))
}

#[tauri::command]
pub fn group_update(state: State<'_, AppState>, id: String, input: GroupInput) -> AppResult<Group> {
    let (name, parent_id) = input.validate()?;
    state
        .db
        .with(|conn| db::hosts::update_group(conn, &id, &name, parent_id.as_deref()))
}

#[tauri::command]
pub fn group_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.db.with(|conn| db::hosts::delete_group(conn, &id))
}

#[tauri::command]
pub fn tabs_snapshot(state: State<'_, AppState>) -> AppResult<Vec<TabRecord>> {
    state.db.with(db::tabs::list)
}

#[tauri::command]
pub fn tabs_save(state: State<'_, AppState>, tabs: Vec<TabRecord>) -> AppResult<()> {
    let mut clean = Vec::new();
    for tab in tabs.into_iter().take(MAX_TABS) {
        let mut tab = tab;
        if !TAB_KINDS.contains(&tab.kind.as_str()) {
            continue;
        }
        tab.title = tab.title.trim().chars().take(120).collect();
        if tab.title.is_empty() {
            tab.title = "Tunnelde".into();
        }
        tab.state = tab.state.take();
        clean.push(tab);
    }
    state.db.with(|conn| db::tabs::save_all(conn, &clean))
}

#[tauri::command]
pub fn system_stats(state: State<'_, AppState>) -> SystemStats {
    let mut system = state
        .system
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut disks = state
        .disks
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    system::snapshot(&mut system, &mut disks)
}

#[tauri::command]
pub fn update_state(state: State<'_, AppState>) -> UpdateState {
    state.update.snapshot()
}

#[tauri::command]
pub async fn update_check(app: AppHandle, force: Option<bool>) -> AppResult<UpdateState> {
    update::check(app, force.unwrap_or(true)).await
}

#[tauri::command]
pub async fn update_install(app: AppHandle) -> AppResult<UpdateState> {
    update::install(app).await
}

#[tauri::command]
pub fn open_release_page(app: AppHandle) -> AppResult<()> {
    app.opener()
        .open_url(RELEASES_PAGE, None::<&str>)
        .map_err(|error| AppError::Internal(error.to_string()))
}

#[tauri::command]
pub fn open_log_dir(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    app.opener()
        .open_path(state.log_dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| AppError::Internal(error.to_string()))
}

/// Only these origins may be opened in the system browser; everything else
/// is rejected so a malformed link cannot turn into an arbitrary launch.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> AppResult<()> {
    const ALLOWED: [&str; 3] = [
        "https://github.com/TunneldeDev/",
        "https://www.gnu.org/licenses/",
        "https://tunnelde.dev/",
    ];
    if !ALLOWED.iter().any(|prefix| url.starts_with(prefix)) {
        return Err(AppError::validation("url.notAllowed"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| AppError::Internal(error.to_string()))
}

#[tauri::command]
pub async fn user_css_import(app: AppHandle) -> AppResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("CSS", &["css"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });

    let picked = rx
        .await
        .map_err(|_| AppError::internal("dialog.cancelled"))?;
    let Some(path) = picked else {
        return Ok(None);
    };

    let text = std::fs::read_to_string(std::path::PathBuf::from(path.to_string()))?;
    if text.len() > MAX_USER_CSS {
        return Err(AppError::validation("css.tooLarge"));
    }
    Ok(Some(text))
}

#[tauri::command]
pub async fn user_css_export(app: AppHandle, css: String) -> AppResult<Option<String>> {
    if css.len() > MAX_USER_CSS {
        return Err(AppError::validation("css.tooLarge"));
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("CSS", &["css"])
        .set_file_name("tunnelde-user.css")
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    let picked = rx
        .await
        .map_err(|_| AppError::internal("dialog.cancelled"))?;
    let Some(path) = picked else {
        return Ok(None);
    };

    let target = std::path::PathBuf::from(path.to_string());
    std::fs::write(&target, css)?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn ssh_sessions(state: State<'_, AppState>) -> Vec<SessionInfo> {
    state.ssh.list()
}

#[tauri::command]
pub async fn ssh_probe(app: AppHandle, host_id: String) -> AppResult<HostKeyInfo> {
    ssh::probe(&app, &host_id).await
}

#[tauri::command]
pub async fn ssh_trust(app: AppHandle, host_id: String) -> AppResult<HostKeyInfo> {
    ssh::trust(&app, &host_id).await
}

#[tauri::command]
pub async fn ssh_connect(app: AppHandle, request: SshConnectRequest) -> AppResult<SessionInfo> {
    ssh::connect(app, request).await
}

#[tauri::command]
pub fn ssh_write(app: AppHandle, session_id: String, data: String) -> AppResult<()> {
    ssh::write(&app, &session_id, &data)
}

#[tauri::command]
pub fn ssh_resize(app: AppHandle, session_id: String, cols: u32, rows: u32) -> AppResult<()> {
    ssh::resize(&app, &session_id, cols, rows)
}

#[tauri::command]
pub fn ssh_disconnect(app: AppHandle, session_id: String) -> AppResult<()> {
    ssh::disconnect(&app, &session_id)
}

fn merge_json(base: &mut Value, patch: Value) {
    match (base, patch) {
        (Value::Object(base_map), Value::Object(patch_map)) => {
            for (key, value) in patch_map {
                match base_map.get_mut(&key) {
                    Some(slot) if slot.is_object() && value.is_object() => merge_json(slot, value),
                    _ => {
                        base_map.insert(key, value);
                    }
                }
            }
        }
        (slot, value) => *slot = value,
    }
}
