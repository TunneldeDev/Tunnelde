mod config;
mod inventory;
pub mod layout;
mod migration;
mod restore;

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use layout::{Category, Paths, CATEGORIES};

static MUTATIONS: Mutex<()> = Mutex::new(());

pub fn initialize(
    home: std::path::PathBuf,
    logs: std::path::PathBuf,
    plugins: Option<std::path::PathBuf>,
) -> AppResult<Paths> {
    let mut config = config::load(&home)?;
    for path in config.locations.values_mut() {
        *path = layout::normalize(path)?;
    }
    let paths = Paths::new(
        home.clone(),
        logs.clone(),
        &config.locations,
        plugins.clone(),
    );
    if config.pending.is_some() {
        if let Err(error) = migration::apply(&paths, &mut config) {
            // Continue using original locations; retain plan and explain recovery in Settings.
            config.last_error = Some(error.to_string());
            config::save(&home, &config)?;
        }
    }
    Ok(Paths::new(home, logs, &config.locations, plugins))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    category: Category,
    path: String,
    default_path: String,
    bytes: u64,
    files: u64,
    error: Option<String>,
    overridden: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    locations: Vec<Location>,
    pending: Option<config::Pending>,
    previous: std::collections::BTreeMap<Category, std::path::PathBuf>,
    archives: std::collections::BTreeMap<Category, std::path::PathBuf>,
    last_error: Option<String>,
}

fn status(paths: &Paths) -> AppResult<Status> {
    let config = config::load(&paths.home)?;
    let locations = CATEGORIES
        .into_iter()
        .map(|category| {
            let scan = inventory::scan(category, paths.dir(category));
            Location {
                category,
                path: paths.dir(category).to_string_lossy().into_owned(),
                default_path: paths.defaults[&category].to_string_lossy().into_owned(),
                bytes: scan.as_ref().map(|scan| scan.bytes).unwrap_or_default(),
                files: scan.as_ref().map(|scan| scan.files).unwrap_or_default(),
                error: scan.err().map(|error| error.to_string()),
                overridden: category == Category::Plugins && paths.plugins_override,
            }
        })
        .collect();
    Ok(Status {
        locations,
        pending: config.pending,
        previous: config.previous,
        archives: config.archives,
        last_error: config.last_error,
    })
}

#[tauri::command]
pub async fn storage_status(app: AppHandle) -> AppResult<Status> {
    let paths = app.state::<AppState>().storage.clone();
    tauri::async_runtime::spawn_blocking(move || status(&paths))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
pub async fn storage_schedule(app: AppHandle, changes: Vec<config::Change>) -> AppResult<Status> {
    let paths = app.state::<AppState>().storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _mutation = MUTATIONS
            .lock()
            .map_err(|_| AppError::internal("storage.lock"))?;
        let mut config = config::load(&paths.home)?;
        migration::schedule(&paths, &mut config, changes)?;
        status(&paths)
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
pub async fn storage_cancel(app: AppHandle) -> AppResult<Status> {
    let paths = app.state::<AppState>().storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _mutation = MUTATIONS
            .lock()
            .map_err(|_| AppError::internal("storage.lock"))?;
        let mut config = config::load(&paths.home)?;
        migration::cancel(&paths, &mut config)?;
        status(&paths)
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
pub fn storage_open(
    app: AppHandle,
    state: State<'_, AppState>,
    category: Category,
) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let path = state.storage.dir(category);
    std::fs::create_dir_all(path)?;
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| AppError::internal(e.to_string()))
}

#[tauri::command]
pub async fn storage_pick(app: AppHandle) -> AppResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(if app.state::<AppState>().locale().starts_with("zh") {
            "选择存储文件夹"
        } else {
            "Choose storage folder"
        })
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    Ok(rx
        .await
        .map_err(|_| AppError::internal("dialog.cancelled"))?
        .map(|path| path.to_string()))
}

/// Relocate references only to keys managed by Tunnelde; external keys retain their paths.
pub fn relocate_key_references(database: &crate::db::Database, paths: &Paths) -> AppResult<()> {
    let config = config::load(&paths.home)?;
    database.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        if let Some(previous) = config.previous.get(&Category::Keys) {
            let previous = layout::normalize(previous)?;
            let current = paths.dir(Category::Keys);
            let mut query =
                conn.prepare("SELECT id,key_path FROM hosts WHERE key_path IS NOT NULL")?;
            let rows = query
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (id, path) in rows {
                let Ok(path) = layout::normalize(std::path::Path::new(&path)) else {
                    continue;
                };
                if let Ok(relative) = path.strip_prefix(&previous) {
                    let next = current.join(relative);
                    if next.is_file() {
                        conn.execute(
                            "UPDATE hosts SET key_path=?1 WHERE id=?2",
                            rusqlite::params![next.to_string_lossy(), id],
                        )?;
                    }
                }
            }
        }
        if let Some(previous) = config.previous.get(&Category::Runtimes) {
            let mut plugin = crate::plugins::config::load(conn)?;
            if let Some(path) = plugin
                .node_path
                .as_ref()
                .and_then(|path| layout::normalize(std::path::Path::new(path)).ok())
            {
                let previous = layout::normalize(previous)?;
                if let Ok(relative) = path.strip_prefix(&previous) {
                    let next = paths.dir(Category::Runtimes).join(relative);
                    if next.is_file() {
                        plugin.node_path = Some(next.to_string_lossy().into_owned());
                        crate::plugins::config::save(conn, &plugin)?;
                    }
                }
            }
        }
        tx.commit()?;
        Ok(())
    })
}

#[cfg(test)]
mod tests;
