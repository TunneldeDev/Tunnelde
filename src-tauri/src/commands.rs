use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::{Group, GroupInput, Host, HostInput, TabRecord};
use crate::platform::system::{self, SystemStats};
use crate::plugins;
use crate::settings::{Settings, ACCENTS, DENSITIES, LANGUAGES, THEMES};
use crate::ssh::files::{self as sftp, Listing};
use crate::ssh::monitor;
use crate::ssh::{self, HostKeyInfo, SessionInfo, SshConnectRequest};
use crate::state::AppState;
use crate::update::{self, UpdateState};
use crate::vault;

const TAB_KINDS: [&str; 14] = [
    "sidebar",
    "pluginDetail",
    "knownHosts",
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

#[tauri::command]
pub async fn clipboard_read_text(app: AppHandle) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.clipboard()
            .read_text()
            .map_err(|_| AppError::internal("clipboard.unavailable"))
    })
    .await
    .map_err(|_| AppError::internal("clipboard.unavailable"))?
}

#[tauri::command]
pub async fn clipboard_write_text(app: AppHandle, text: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        app.clipboard()
            .write_text(text)
            .map_err(|_| AppError::internal("clipboard.unavailable"))
    })
    .await
    .map_err(|_| AppError::internal("clipboard.unavailable"))?
}

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
    default_settings: Settings,
    system_languages: Vec<String>,
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

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<'_, AppState>) -> AppInfo {
    let package = app.package_info();
    AppInfo {
        default_settings: Settings::default(),
        system_languages: crate::platform::locale::preferred_languages(),
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
    let previous = state.settings();
    let mut base = serde_json::to_value(&previous)?;
    let colors = patch.get("colors").cloned();
    let keyboard_shortcuts = patch.get("keyboardShortcuts").cloned();
    let shortcut_rules = patch.get("shortcutRules").cloned();
    let network = patch.get("network").cloned();
    let ui_providers = patch.get("uiProviders").cloned();
    merge_json(&mut base, patch);
    if let Some(colors) = colors {
        base["colors"] = colors;
    }
    if let Some(keyboard_shortcuts) = keyboard_shortcuts {
        base["keyboardShortcuts"] = keyboard_shortcuts;
    }
    if let Some(shortcut_rules) = shortcut_rules {
        base["shortcutRules"] = shortcut_rules;
    }
    if let Some(network) = network {
        base["network"] = network;
    }
    // A selection map is a replacement. Deep-merging an empty map would retain
    // the previous provider and undo the user's recovery after the save completes.
    if let Some(ui_providers) = ui_providers {
        base["uiProviders"] = ui_providers;
    }
    let mut next: Settings = serde_json::from_value(base)
        .map_err(|error| AppError::validation(format!("settings.invalid: {error}")))?;
    next.sanitize();
    next.network.validate()?;
    update::validate_preferences(&next)?;
    update::validate_settings_change(&previous, &next, &state.update.snapshot())?;

    let title_bar_changed = next.title_bar_style != previous.title_bar_style;
    if title_bar_changed {
        crate::platform::window::apply_title_bar_style(&app, &next.title_bar_style)?;
    }
    if let Err(error) = state.db.with(|conn| db::settings::save(conn, &next)) {
        if title_bar_changed {
            let _ = crate::platform::window::apply_title_bar_style(&app, &previous.title_bar_style);
        }
        return Err(error);
    }
    for profile in &previous.network.profiles {
        if !next
            .network
            .profiles
            .iter()
            .any(|current| current.id == profile.id)
        {
            if let Err(error) = crate::vault::forget(&format!("proxy:{}", profile.id)) {
                tracing::warn!(%error, "could not remove deleted proxy credential");
            }
        }
    }
    state.set_settings(next.clone());
    crate::platform::window::apply_theme(&app, &next.theme);
    crate::platform::window::apply_background_dock_preference(&app);
    let _ = app.emit("settings://changed", &next);
    Ok(next)
}

#[tauri::command]
pub fn settings_reset(app: AppHandle, state: State<'_, AppState>) -> AppResult<Settings> {
    let previous = state.settings();
    let mut next = Settings::default();
    next.sanitize();
    update::validate_settings_change(&previous, &next, &state.update.snapshot())?;
    let title_bar_changed = next.title_bar_style != previous.title_bar_style;
    if title_bar_changed {
        crate::platform::window::apply_title_bar_style(&app, &next.title_bar_style)?;
    }
    if let Err(error) = state.db.with(|conn| db::settings::save(conn, &next)) {
        if title_bar_changed {
            let _ = crate::platform::window::apply_title_bar_style(&app, &previous.title_bar_style);
        }
        return Err(error);
    }
    for profile in &previous.network.profiles {
        if !next
            .network
            .profiles
            .iter()
            .any(|current| current.id == profile.id)
        {
            if let Err(error) = crate::vault::forget(&format!("proxy:{}", profile.id)) {
                tracing::warn!(%error, "could not remove deleted proxy credential");
            }
        }
    }
    state.set_settings(next.clone());
    crate::platform::window::apply_theme(&app, &next.theme);
    crate::platform::window::apply_background_dock_preference(&app);
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
    crate::platform::menu::apply(&app, &locale)?;
    Ok(())
}

#[tauri::command]
pub fn hosts_snapshot(state: State<'_, AppState>) -> AppResult<crate::services::hosts::Snapshot> {
    crate::services::hosts::snapshot(&state.db)
}

#[tauri::command]
pub fn host_create(
    app: AppHandle,
    state: State<'_, AppState>,
    input: HostInput,
) -> AppResult<Host> {
    crate::services::hosts::service(&app, &state).create(input)
}

#[tauri::command]
pub fn host_update(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    input: HostInput,
) -> AppResult<Host> {
    crate::services::hosts::service(&app, &state).update(&id, input)
}

#[tauri::command]
pub fn host_delete(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    crate::services::hosts::service(&app, &state).delete(&id)
}

#[tauri::command]
pub fn host_mark_used(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    crate::services::hosts::service(&app, &state).mark_used(&id)
}

#[tauri::command]
pub fn hosts_reorder(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<()> {
    crate::services::hosts::service(&app, &state).reorder(&ids)
}

#[tauri::command]
pub fn group_create(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GroupInput,
) -> AppResult<Group> {
    crate::services::hosts::service(&app, &state).create_group(input)
}

#[tauri::command]
pub fn group_update(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    input: GroupInput,
) -> AppResult<Group> {
    crate::services::hosts::service(&app, &state).update_group(&id, input)
}

#[tauri::command]
pub fn group_delete(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    crate::services::hosts::service(&app, &state).delete_group(&id)
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
pub async fn update_history(
    app: AppHandle,
    version: String,
) -> AppResult<update::history::ReleaseHistory> {
    update::history::load(app, version).await
}

#[tauri::command]
pub fn open_release_page(app: AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    let snapshot = state.update.snapshot();
    let page = update::release_page(&state.settings(), &snapshot);
    app.opener()
        .open_url(page, None::<&str>)
        .map_err(|error| AppError::Internal(error.to_string()))
}

#[tauri::command]
pub fn open_log_dir(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    app.opener()
        .open_path(state.log_dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| AppError::Internal(error.to_string()))
}

#[tauri::command]
pub fn open_latest_log(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let name = crate::logs::latest_name(&state.log_dir)?
        .ok_or_else(|| AppError::validation("logs.noFile"))?;
    let path = state.log_dir.join(name);
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
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

/// Reveal an existing local item in the native file manager without invoking a shell.
#[tauri::command]
pub async fn reveal_local_path(path: String) -> AppResult<()> {
    let target = std::path::PathBuf::from(path);
    if !target.is_absolute() {
        return Err(AppError::NotFound("path.notFound".into()));
    }
    tauri::async_runtime::spawn_blocking(move || {
        if !target.exists() {
            return Err(AppError::NotFound("path.notFound".into()));
        }
        tauri_plugin_opener::reveal_item_in_dir(target)
            .map_err(|error| AppError::Internal(error.to_string()))
    })
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?
}

/// README links open only after an explicit user action, using web protocols.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> AppResult<()> {
    let url = external_web_url(&url)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| AppError::Internal(error.to_string()))
}

fn external_web_url(value: &str) -> AppResult<String> {
    let url = reqwest::Url::parse(value).map_err(|_| AppError::validation("url.notAllowed"))?;
    if value.len() > 4096
        || value.chars().any(char::is_control)
        || !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AppError::validation("url.notAllowed"));
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod external_url_tests {
    use super::external_web_url;

    #[test]
    fn accepts_plugin_authors_web_links_and_rejects_other_launches() {
        assert!(external_web_url("https://nodejs.org/en/download#install").is_ok());
        assert!(external_web_url("http://localhost:8000/docs").is_ok());
        for url in [
            "javascript:alert(1)",
            "file:///C:/Windows/notepad.exe",
            "mailto:author@example.com",
            "data:text/html,example",
            "https://user:password@example.com/",
            "https://example.com/\nscript",
            "relative/path",
        ] {
            assert!(external_web_url(url).is_err(), "{url}");
        }
    }
}

/// Stores a pasted private key inside the app data folder and returns its path.
#[tauri::command]
pub fn key_import(state: State<'_, AppState>, content: String) -> AppResult<String> {
    if content.len() > 64 * 1024 || !content.contains("PRIVATE KEY") {
        return Err(AppError::validation("key.invalid"));
    }
    let directory = state.storage.dir(crate::storage::layout::Category::Keys);
    std::fs::create_dir_all(directory)?;
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
pub async fn ssh_probe(
    app: AppHandle,
    host_id: String,
    jump_credentials: Option<std::collections::HashMap<String, ssh::session::HopCredential>>,
) -> AppResult<HostKeyInfo> {
    ssh::session::probe_route(&app, &host_id, jump_credentials.unwrap_or_default()).await
}

#[tauri::command]
pub async fn ssh_test_connection(
    app: AppHandle,
    id: String,
    host_id: String,
    jump_credentials: Option<std::collections::HashMap<String, ssh::session::HopCredential>>,
) -> AppResult<ssh::diagnostics::ConnectionQuality> {
    ssh::diagnostics::test(app, id, host_id, jump_credentials.unwrap_or_default()).await
}

#[tauri::command]
pub fn ssh_cancel_test(state: State<'_, AppState>, id: String) {
    ssh::diagnostics::cancel(&state.ssh, &id);
}

#[tauri::command]
pub async fn ssh_trust(
    app: AppHandle,
    host_id: String,
    fingerprint: String,
    expected_host_id: Option<String>,
    jump_credentials: Option<std::collections::HashMap<String, ssh::session::HopCredential>>,
) -> AppResult<HostKeyInfo> {
    ssh::session::trust_route(
        &app,
        &host_id,
        &fingerprint,
        expected_host_id.as_deref(),
        jump_credentials.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
pub async fn ssh_connect(app: AppHandle, request: SshConnectRequest) -> AppResult<SessionInfo> {
    let session = ssh::connect(app.clone(), request).await?;
    crate::logs::record(
        &app.state::<AppState>().db,
        "ssh.connect",
        Some(&session.host_id),
    );
    Ok(session)
}

#[tauri::command]
pub fn ssh_attach(app: AppHandle, session_id: String) -> AppResult<()> {
    ssh::session::attach(&app, &session_id)
}

#[tauri::command]
pub async fn ssh_detach(app: AppHandle, session_id: String) -> AppResult<u64> {
    app.state::<AppState>().ssh.detach(&session_id).await
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
    ssh::disconnect(&app, &session_id)?;
    crate::logs::record(&app.state::<AppState>().db, "ssh.disconnect", None);
    Ok(())
}

/// Installs Tunnelde's public key with the password the user just typed and
/// switches the host to key authentication.
#[tauri::command]
pub async fn ssh_install_key(
    app: AppHandle,
    host_id: String,
    password: Option<String>,
    jump_credentials: Option<std::collections::HashMap<String, ssh::session::HopCredential>>,
) -> AppResult<ssh::InstalledKey> {
    ssh::keys::install(
        &app,
        &host_id,
        password,
        jump_credentials.unwrap_or_default(),
    )
    .await
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
pub async fn files_search(
    app: AppHandle,
    request_id: String,
    session_id: Option<String>,
    root: String,
    query: String,
    content: bool,
    selection: Option<sftp::search::SearchSelection>,
) -> AppResult<sftp::search::SearchResult> {
    sftp::search::search(app, request_id, session_id, root, query, content, selection).await
}

#[tauri::command]
pub fn files_search_cancel(request_id: String) {
    sftp::search::cancel(&request_id);
}

#[tauri::command]
pub async fn search_preview_local(path: String) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let path = std::path::PathBuf::from(path);
        if !path.is_absolute() || !path.is_file() {
            return Err(AppError::validation("search.invalidRoot"));
        }
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(512 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 512 * 1024 {
            return Err(AppError::validation("sftp.fileTooLarge"));
        }
        if bytes.contains(&0) {
            return Err(AppError::validation("sftp.binaryFile"));
        }
        String::from_utf8(bytes).map_err(|_| AppError::validation("sftp.unsupportedEncoding"))
    })
    .await
    .map_err(|error| AppError::internal(error.to_string()))?
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
    overwrite: Option<bool>,
) -> AppResult<()> {
    sftp::remote_rename(&app, &session_id, from, to, overwrite.unwrap_or(false)).await
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
pub async fn local_rename(
    app: AppHandle,
    from: String,
    to: String,
    overwrite: Option<bool>,
) -> AppResult<()> {
    let result = sftp::local_rename(from.clone(), to.clone(), overwrite.unwrap_or(false));
    #[cfg(windows)]
    if let Err(error) = &result {
        // ERROR_NOT_SAME_DEVICE is an explicit OS result. A generic SFTP
        // Failure, permission error or lost reply never authorizes this fallback.
        let cross_volume = matches!(error, AppError::Io(error) if error.raw_os_error() == Some(windows_sys::Win32::Foundation::ERROR_NOT_SAME_DEVICE as i32));
        let directory_merge = matches!(error, AppError::Validation(key) if key == "sftp.directoryMergeMoveUnavailable");
        if cross_volume || directory_merge {
            return sftp::start_local_move(app, from, to, overwrite.unwrap_or(false))?
                .wait()
                .await;
        }
    }
    #[cfg(not(windows))]
    let _ = app;
    result
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
    overwrite: Option<bool>,
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
        overwrite.unwrap_or(false),
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
pub async fn remote_kill(
    app: AppHandle,
    session_id: String,
    pid: u32,
    expected_start_ticks: Option<u64>,
) -> AppResult<()> {
    monitor::kill(&app, &session_id, pid, expected_start_ticks).await
}

#[tauri::command]
pub async fn local_read_text(path: String) -> AppResult<sftp::TextFile> {
    sftp::local_read_text(&path).await
}

#[tauri::command]
pub async fn local_write_text(
    app: AppHandle,
    path: String,
    content: String,
    baseline: String,
) -> AppResult<()> {
    sftp::local_editor::save(app, path, content, baseline).await
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
    baseline: Option<String>,
) -> AppResult<()> {
    sftp::write_text(&app, &session_id, &path, &content, baseline.as_deref()).await
}

#[tauri::command]
pub async fn plugins_list(app: AppHandle) -> AppResult<Vec<plugins::PluginInfo>> {
    let state = app.state::<AppState>();
    Ok(state.plugins.list().await)
}

#[tauri::command]
pub async fn plugin_start(app: AppHandle, id: String) -> AppResult<plugins::PluginInfo> {
    let state = app.state::<AppState>();
    let result = state.plugins.start(&app, &id).await;
    if let Err(error) = &result {
        // Do not persist untrusted plugin output or user paths in diagnostic logs.
        let detail = error.to_string();
        let reason = detail.split(':').next().unwrap_or("");
        let reason = if reason.starts_with("plugin.") || reason.starts_with("node.") {
            reason
        } else {
            error.code()
        };
        if let AppError::PluginEngineUnsupported {
            plugin_version,
            host_version,
            required,
            ..
        } = error
        {
            tracing::warn!(plugin_id = %id, reason, stage = "compatibility", plugin_version, host_version, required_host = required, action = "update_application_or_install_compatible_plugin", "plugin start failed");
        } else if let AppError::PluginUiSdkUnsupported {
            required,
            available,
        } = error
        {
            tracing::warn!(plugin_id = %id, reason, stage = "ui-sdk-compatibility", required_sdk = required, available_sdk = available, action = "update_application_or_install_compatible_plugin", "plugin start failed");
        } else {
            tracing::warn!(plugin_id = %id, reason, error_code = error.code(), stage = "startup", "plugin start failed");
        }
    }
    result
}

#[tauri::command]
pub async fn plugin_stop(app: AppHandle, id: String) -> AppResult<plugins::PluginInfo> {
    let state = app.state::<AppState>();
    state.plugins.stop(&app, &id).await
}

#[tauri::command]
pub async fn plugin_run(
    app: AppHandle,
    id: String,
    command: String,
    input: Option<Value>,
) -> AppResult<Value> {
    let state = app.state::<AppState>();
    state.plugins.run(&id, &command, input).await
}

/// Lets the user pick the folder that contains a plugin.
#[tauri::command]
pub async fn plugin_pick_folder(
    app: AppHandle,
    title: Option<String>,
) -> AppResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(
            title
                .as_deref()
                .unwrap_or("Plugin folder")
                .chars()
                .take(120)
                .collect::<String>(),
        )
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    let picked = rx
        .await
        .map_err(|_| AppError::internal("dialog.cancelled"))?;
    Ok(picked.map(|path| path.to_string()))
}

/// Choosing an executable does not run it or authorize its runtime.
#[tauri::command]
pub async fn plugin_pick_executable(
    app: AppHandle,
    title: Option<String>,
) -> AppResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(
            title
                .as_deref()
                .unwrap_or("Executable")
                .chars()
                .take(120)
                .collect::<String>(),
        )
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    Ok(rx
        .await
        .map_err(|_| AppError::internal("dialog.cancelled"))?
        .map(|path| path.to_string()))
}

/// Lets the user pick a zipped plugin.
#[tauri::command]
pub async fn plugin_pick_archive(app: AppHandle) -> AppResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Plugin archive")
        .add_filter("Zip", &["zip"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let picked = rx
        .await
        .map_err(|_| AppError::internal("dialog.cancelled"))?;
    Ok(picked.map(|path| path.to_string()))
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
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
    command: String,
) -> AppResult<Option<crate::services::history::Entry>> {
    crate::services::history::service(&app, &state).record(&host_id, &command)
}

#[tauri::command]
pub fn history_list(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
    limit: Option<i64>,
) -> AppResult<Vec<crate::services::history::Entry>> {
    crate::services::history::service(&app, &state).list(&host_id, limit)
}

#[tauri::command]
pub fn history_delete(app: AppHandle, state: State<'_, AppState>, id: i64) -> AppResult<()> {
    crate::services::history::service(&app, &state).delete(id)
}

#[tauri::command]
pub fn history_clear(app: AppHandle, state: State<'_, AppState>, host_id: String) -> AppResult<()> {
    crate::services::history::service(&app, &state).clear(&host_id)
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
pub async fn plugin_render_view(
    app: AppHandle,
    id: String,
    view: String,
    locale: Option<String>,
) -> AppResult<Value> {
    let state = app.state::<AppState>();
    state
        .plugins
        .render_view(&id, &view, locale.as_deref())
        .await
}

/// Installs a plugin archive the webview downloaded; the pinned checksum must
/// match before anything is unpacked.
#[tauri::command]
pub async fn marketplace_install(
    app: AppHandle,
    id: String,
    sha256: String,
    data: String,
) -> AppResult<plugins::PluginInfo> {
    let result = plugins::marketplace::install_archive(&app, &id, &sha256, &data).await;
    plugins::security::emit_state(&app).await;
    if let Ok(plugin) = &result {
        crate::logs::record(
            &app.state::<AppState>().db,
            "plugin.install",
            Some(&plugin.id),
        );
    }
    result
}

#[tauri::command]
pub fn plugin_config(state: State<'_, AppState>) -> AppResult<plugins::config::PluginConfig> {
    state.db.with(plugins::config::load)
}

#[tauri::command]
pub fn plugin_sources_save(
    app: AppHandle,
    sources: Vec<plugins::config::MarketSource>,
) -> AppResult<plugins::config::PluginConfig> {
    let state = app.state::<AppState>();
    let next = state.db.with(|conn| {
        let mut config = plugins::config::load(conn)?;
        config.sources = sources;
        plugins::config::save(conn, &config)?;
        Ok(config)
    })?;
    let _ = app.emit("plugins://config", &next);
    Ok(next)
}

#[tauri::command]
pub async fn plugin_source_test(app: AppHandle, url: String) -> AppResult<usize> {
    let payload = plugins::network::fetch_json::<Value>(&app, &url, 2 * 1024 * 1024).await?;
    payload
        .get("plugins")
        .and_then(|p| p.as_array())
        .map(|p| p.len())
        .ok_or_else(|| AppError::validation("market.invalidCatalogue"))
}

#[tauri::command]
pub async fn marketplace_catalogue(
    app: AppHandle,
    source_id: String,
    refresh: bool,
) -> AppResult<plugins::marketplace::Catalogue> {
    let state = app.state::<AppState>();
    let source = state
        .db
        .with(plugins::config::load)?
        .sources
        .into_iter()
        .find(|source| source.id == source_id && source.enabled)
        .ok_or_else(|| AppError::validation("market.sourceDisabled"))?;
    plugins::marketplace::catalogue(
        &app,
        state.storage.dir(crate::storage::layout::Category::Cache),
        &source,
        refresh,
    )
    .await
}

#[tauri::command]
pub async fn marketplace_download(
    app: AppHandle,
    source_id: String,
    id: String,
    version: String,
    sha256: String,
    task_id: String,
    update: bool,
) -> AppResult<plugins::PluginInfo> {
    let result = plugins::marketplace::install_remote(
        &app, &source_id, &id, &version, &sha256, &task_id, update,
    )
    .await;
    plugins::security::emit_state(&app).await;
    if let Ok(plugin) = &result {
        crate::logs::record(
            &app.state::<AppState>().db,
            "plugin.install",
            Some(&plugin.id),
        );
    }
    result
}

#[tauri::command]
pub fn plugin_download_cancel(app: AppHandle, task_id: String) -> bool {
    plugins::network::cancel(&app, &task_id)
}

#[tauri::command]
pub async fn node_detect(app: AppHandle) -> AppResult<plugins::node::NodeRuntimeInfo> {
    let state = app.state::<AppState>();
    let config = state.db.with(plugins::config::load)?;
    plugins::node::resolve(
        state
            .storage
            .dir(crate::storage::layout::Category::Runtimes),
        config.node_path.as_deref().map(std::path::Path::new),
        config.node_system_allowed,
    )
    .await
}

#[tauri::command]
pub async fn node_install(
    app: AppHandle,
    task_id: String,
) -> AppResult<plugins::node::NodeRuntimeInfo> {
    let info = plugins::node::install(&app, &task_id).await?;
    let state = app.state::<AppState>();
    let next = state.db.with(|conn| {
        let mut config = plugins::config::load(conn)?;
        config.node_path = None;
        plugins::config::save(conn, &config)?;
        Ok(config)
    })?;
    let _ = app.emit("plugins://config", next);
    Ok(info)
}

#[tauri::command]
pub async fn node_set_path(
    app: AppHandle,
    path: Option<String>,
) -> AppResult<plugins::node::NodeRuntimeInfo> {
    let state = app.state::<AppState>();
    let previous = state.db.with(plugins::config::load)?;
    let info = plugins::node::resolve(
        state
            .storage
            .dir(crate::storage::layout::Category::Runtimes),
        path.as_deref().map(std::path::Path::new),
        previous.node_system_allowed,
    )
    .await?;
    if path.is_some() && !info.compatible {
        return Err(AppError::validation("node.incompatible"));
    }
    let next = state.db.with(|conn| {
        let mut config = plugins::config::load(conn)?;
        config.node_path = path;
        plugins::config::save(conn, &config)?;
        Ok(config)
    })?;
    let _ = app.emit("plugins://config", next);
    Ok(info)
}

#[tauri::command]
pub async fn node_allow_system(
    app: AppHandle,
    allowed: bool,
) -> AppResult<plugins::node::NodeRuntimeInfo> {
    let state = app.state::<AppState>();
    let next = state.db.with(|conn| {
        let mut config = plugins::config::load(conn)?;
        config.node_system_allowed = allowed;
        plugins::config::save(conn, &config)?;
        Ok(config)
    })?;
    let _ = app.emit("plugins://config", &next);
    if !allowed {
        state.plugins.stop_system_nodes(&app).await;
    }
    plugins::node::resolve(
        state
            .storage
            .dir(crate::storage::layout::Category::Runtimes),
        next.node_path.as_deref().map(std::path::Path::new),
        allowed,
    )
    .await
}

#[tauri::command]
pub async fn node_pick(app: AppHandle) -> AppResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Node executable")
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    Ok(rx
        .await
        .map_err(|_| AppError::internal("dialog.cancelled"))?
        .map(|p| p.to_string()))
}

#[tauri::command]
pub async fn sftp_copy(
    app: AppHandle,
    session_id: String,
    from: String,
    to: String,
    overwrite: Option<bool>,
) -> AppResult<()> {
    app.state::<AppState>().ssh.handle(&session_id)?;
    sftp::start_copy(
        app,
        sftp::Endpoint {
            session: Some(session_id.clone()),
            path: from,
        },
        sftp::Endpoint {
            session: Some(session_id),
            path: to,
        },
        overwrite.unwrap_or(false),
        None,
    )?
    .wait()
    .await
}

#[tauri::command]
pub async fn local_copy(
    app: AppHandle,
    from: String,
    to: String,
    overwrite: Option<bool>,
) -> AppResult<()> {
    sftp::start_copy(
        app,
        sftp::Endpoint {
            session: None,
            path: from,
        },
        sftp::Endpoint {
            session: None,
            path: to,
        },
        overwrite.unwrap_or(false),
        None,
    )?
    .wait()
    .await
}

#[tauri::command]
pub async fn plugin_install(app: AppHandle, path: String) -> AppResult<plugins::PluginInfo> {
    let state = app.state::<AppState>();
    let result = state.plugins.install(&path).await;
    plugins::security::emit_state(&app).await;
    if let Ok(plugin) = &result {
        crate::logs::record(&state.db, "plugin.install", Some(&plugin.id));
    }
    result
}

#[tauri::command]
pub fn plugin_inspect(path: String) -> AppResult<plugins::manifest::PluginManifest> {
    plugins::inspect(&path)
}

#[tauri::command]
pub async fn plugin_uninstall(app: AppHandle, id: String) -> AppResult<()> {
    let state = app.state::<AppState>();
    state.plugins.revoke_background(&app, &id);
    let result = state.plugins.uninstall(&id).await;
    state.plugins.revoke_background(&app, &id);
    plugins::security::emit_state(&app).await;
    if result.is_ok() {
        crate::logs::record(&state.db, "plugin.uninstall", Some(&id));
    }
    result
}

#[tauri::command]
pub async fn plugin_reload(app: AppHandle) -> AppResult<Vec<plugins::PluginInfo>> {
    let state = app.state::<AppState>();
    for plugin in state.plugins.list().await {
        state.plugins.revoke_background(&app, &plugin.id);
    }
    let result = state.plugins.reload().await;
    for plugin in &result {
        state.plugins.revoke_background(&app, &plugin.id);
    }
    plugins::security::emit_state(&app).await;
    Ok(result)
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
