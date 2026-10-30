// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::{Group, GroupInput, Host, HostInput, TabRecord};
use crate::ssh::monitor;
use crate::plugins;
use crate::settings::{Settings, ACCENTS, DENSITIES, LANGUAGES, THEMES};
use crate::ssh::files::{self as sftp, Listing};
use crate::ssh::{self, HostKeyInfo, SessionInfo, SshConnectRequest};
use crate::state::AppState;
use crate::platform::system::{self, SystemStats};
use crate::update::{self, UpdateState, RELEASES_PAGE};
use crate::vault;

const TAB_KINDS: [&str; 11] = [
    "welcome",
    "host",
    "settings",
    "about",
    "updates",
    "terminal",
    "sftp",
    "editor",
    "history",
    "monitor",
    "pluginView",
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
    crate::platform::window::apply_theme(&app, &next.theme);
    crate::platform::menu::apply(&app, next.native_menu, &state.locale())?;
    let _ = app.emit("settings://changed", &next);
    Ok(next)
}

#[tauri::command]
pub fn settings_reset(app: AppHandle, state: State<'_, AppState>) -> AppResult<Settings> {
    let mut next = Settings::default();
    next.sanitize();
    state.db.with(|conn| db::settings::save(conn, &next))?;
    state.set_settings(next.clone());
    crate::platform::window::apply_theme(&app, &next.theme);
    crate::platform::menu::apply(&app, next.native_menu, &state.locale())?;
    let _ = app.emit("settings://changed", &next);
    Ok(next)
}

#[tauri::command]
pub fn set_locale(app: AppHandle, state: State<'_, AppState>, locale: String) -> AppResult<()> {
    if !["zh-CN", "en-US"].contains(&locale.as_str()) {
        return Err(AppError::validation("locale.invalid"));
    }
    state.set_locale(locale.clone());
    crate::platform::tray::set_language(&app, &locale)?;
    let native_menu = state.settings().native_menu;
    crate::platform::menu::apply(&app, native_menu, &locale)?;
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
    let host = state.db.with(|conn| db::hosts::find_host(conn, &id))?;
    state.db.with(|conn| db::hosts::delete_host(conn, &id))?;
    let _ = crate::vault::forget(&host.id);
    Ok(())
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

/// Opens one existing local file or folder with the system default handler.
#[tauri::command]
pub fn open_local_path(app: AppHandle, path: String) -> AppResult<()> {
    let target = std::path::PathBuf::from(&path);
    if !target.exists() {
        return Err(AppError::NotFound("path.notFound".into()));
    }
    app.opener()
        .open_path(target.to_string_lossy().into_owned(), None::<&str>)
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

/// Stores a pasted private key inside the app data folder and returns its path.
#[tauri::command]
pub fn key_import(state: State<'_, AppState>, content: String) -> AppResult<String> {
    if content.len() > 64 * 1024 || !content.contains("PRIVATE KEY") {
        return Err(AppError::validation("key.invalid"));
    }
    let directory = state.data_dir.join("keys");
    std::fs::create_dir_all(&directory)?;
    let path = directory.join(format!("{}.key", uuid::Uuid::new_v4()));
    std::fs::write(&path, content.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Lets the user pick a private key file for a host.
#[tauri::command]
pub async fn key_pick(app: AppHandle) -> AppResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Private key")
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let picked = rx
        .await
        .map_err(|_| AppError::internal("dialog.cancelled"))?;
    Ok(picked.map(|path| path.to_string()))
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

#[tauri::command]
pub fn credential_save(
    state: State<'_, AppState>,
    host_id: String,
    password: String,
) -> AppResult<()> {
    if password.is_empty() {
        return Err(AppError::validation("ssh.passwordRequired"));
    }
    state.db.with(|conn| db::hosts::find_host(conn, &host_id))?;
    vault::save(&host_id, &password)
}

#[tauri::command]
pub fn credential_forget(host_id: String) -> AppResult<()> {
    vault::forget(&host_id)
}

#[tauri::command]
pub fn credential_status(host_id: String) -> AppResult<bool> {
    vault::has(&host_id)
}

#[tauri::command]
pub async fn sftp_list(
    app: AppHandle,
    session_id: String,
    path: Option<String>,
) -> AppResult<Listing> {
    sftp::remote_list(&app, &session_id, path).await
}

#[tauri::command]
pub fn local_list(path: Option<String>) -> AppResult<Listing> {
    sftp::local_list(path)
}

#[tauri::command]
pub fn local_home() -> String {
    sftp::home_dir().to_string_lossy().into_owned()
}

#[tauri::command]
pub async fn sftp_mkdir(app: AppHandle, session_id: String, path: String) -> AppResult<()> {
    sftp::remote_mkdir(&app, &session_id, path).await
}

#[tauri::command]
pub async fn sftp_rename(
    app: AppHandle,
    session_id: String,
    from: String,
    to: String,
) -> AppResult<()> {
    sftp::remote_rename(&app, &session_id, from, to).await
}

#[tauri::command]
pub async fn sftp_delete(
    app: AppHandle,
    session_id: String,
    path: String,
    is_dir: bool,
) -> AppResult<()> {
    sftp::remote_delete(&app, &session_id, path, is_dir).await
}

#[tauri::command]
pub fn local_mkdir(path: String) -> AppResult<()> {
    sftp::local_mkdir(path)
}

#[tauri::command]
pub fn local_rename(from: String, to: String) -> AppResult<()> {
    sftp::local_rename(from, to)
}

#[tauri::command]
pub fn local_delete(path: String, is_dir: bool) -> AppResult<()> {
    sftp::local_delete(path, is_dir)
}

#[tauri::command]
pub fn fs_transfer(
    app: AppHandle,
    from_session: Option<String>,
    from_path: String,
    to_session: Option<String>,
    to_path: String,
    remove_source: bool,
) -> AppResult<String> {
    sftp::spawn_transfer(
        app,
        sftp::Endpoint {
            session: from_session,
            path: from_path,
        },
        sftp::Endpoint {
            session: to_session,
            path: to_path,
        },
        remove_source,
    )
}

#[tauri::command]
pub fn local_create_file(path: String) -> AppResult<()> {
    sftp::local_create_file(path)
}

#[tauri::command]
pub async fn sftp_create_file(app: AppHandle, session_id: String, path: String) -> AppResult<()> {
    sftp::remote_create_file(&app, &session_id, path).await
}

#[tauri::command]
pub fn transfer_cancel(state: State<'_, AppState>, transfer_id: String) {
    state.transfers.cancel(&transfer_id);
}

#[tauri::command]
pub async fn remote_stats(app: AppHandle, session_id: String) -> AppResult<monitor::RemoteStats> {
    monitor::sample(&app, &session_id).await
}

#[tauri::command]
pub async fn remote_processes(
    app: AppHandle,
    session_id: String,
) -> AppResult<Vec<monitor::RemoteProcess>> {
    monitor::processes(&app, &session_id).await
}

#[tauri::command]
pub async fn remote_kill(app: AppHandle, session_id: String, pid: u32) -> AppResult<()> {
    monitor::kill(&app, &session_id, pid).await
}

#[tauri::command]
pub async fn sftp_read_text(
    app: AppHandle,
    session_id: String,
    path: String,
) -> AppResult<sftp::TextFile> {
    sftp::read_text(&app, &session_id, &path).await
}

#[tauri::command]
pub async fn sftp_write_text(
    app: AppHandle,
    session_id: String,
    path: String,
    content: String,
) -> AppResult<()> {
    sftp::write_text(&app, &session_id, &path, &content).await
}

#[tauri::command]
pub async fn plugins_list(app: AppHandle) -> AppResult<Vec<plugins::PluginInfo>> {
    let state = app.state::<AppState>();
    Ok(state.plugins.list().await)
}

#[tauri::command]
pub async fn plugin_start(app: AppHandle, id: String) -> AppResult<plugins::PluginInfo> {
    let state = app.state::<AppState>();
    state.plugins.start(&app, &id).await
}

#[tauri::command]
pub async fn plugin_stop(app: AppHandle, id: String) -> AppResult<plugins::PluginInfo> {
    let state = app.state::<AppState>();
    state.plugins.stop(&app, &id).await
}

#[tauri::command]
pub async fn plugin_run(app: AppHandle, id: String, command: String) -> AppResult<Value> {
    let state = app.state::<AppState>();
    state.plugins.run(&id, &command).await
}

#[tauri::command]
pub fn plugin_open_dir(app: AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    app.opener()
        .open_path(
            state.plugins.directory().to_string_lossy().into_owned(),
            None::<&str>,
        )
        .map_err(|error| AppError::Internal(error.to_string()))
}

#[tauri::command]
pub fn history_record(
    state: State<'_, AppState>,
    host_id: String,
    command: String,
) -> AppResult<Option<db::history::HistoryEntry>> {
    state.db.with(|conn| {
        db::hosts::find_host(conn, &host_id)?;
        db::history::record(conn, &host_id, &command)
    })
}

#[tauri::command]
pub fn history_list(
    state: State<'_, AppState>,
    host_id: String,
    limit: Option<i64>,
) -> AppResult<Vec<db::history::HistoryEntry>> {
    state
        .db
        .with(|conn| db::history::list(conn, &host_id, limit.unwrap_or(200)))
}

#[tauri::command]
pub fn history_delete(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    state.db.with(|conn| db::history::delete(conn, id))
}

#[tauri::command]
pub fn history_clear(state: State<'_, AppState>, host_id: String) -> AppResult<()> {
    state.db.with(|conn| db::history::clear(conn, &host_id))
}

#[tauri::command]
pub fn known_hosts_list(
    state: State<'_, AppState>,
) -> AppResult<Vec<db::known_hosts::KnownHostEntry>> {
    state.db.with(db::known_hosts::list)
}

#[tauri::command]
pub fn known_hosts_forget(state: State<'_, AppState>, host: String, port: i64) -> AppResult<bool> {
    state
        .db
        .with(|conn| db::known_hosts::forget(conn, &host, port))
}

#[tauri::command]
pub async fn plugin_render_view(app: AppHandle, id: String, view: String) -> AppResult<Value> {
    let state = app.state::<AppState>();
    state.plugins.render_view(&id, &view).await
}

#[tauri::command]
pub async fn sftp_copy(
    app: AppHandle,
    session_id: String,
    from: String,
    to: String,
) -> AppResult<()> {
    sftp::remote_copy(&app, &session_id, from, to).await
}

#[tauri::command]
pub fn local_copy(from: String, to: String) -> AppResult<()> {
    sftp::local_copy(from, to)
}

#[tauri::command]
pub async fn plugin_install(app: AppHandle, path: String) -> AppResult<plugins::PluginInfo> {
    let state = app.state::<AppState>();
    state.plugins.install(&path).await
}

#[tauri::command]
pub async fn plugin_uninstall(app: AppHandle, id: String) -> AppResult<()> {
    let state = app.state::<AppState>();
    state.plugins.uninstall(&id).await
}

#[tauri::command]
pub async fn plugin_reload(app: AppHandle) -> AppResult<Vec<plugins::PluginInfo>> {
    let state = app.state::<AppState>();
    Ok(state.plugins.reload().await)
}

#[tauri::command]
pub fn app_open_data_dir(app: AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    app.opener()
        .open_path(state.data_dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| AppError::Internal(error.to_string()))
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
