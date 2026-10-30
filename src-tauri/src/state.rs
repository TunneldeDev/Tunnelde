// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use sysinfo::{Disks, System};
use tauri::{AppHandle, Manager};
use tracing_appender::non_blocking::WorkerGuard;

use crate::db::{self, Database};
use crate::error::{AppError, AppResult};
use crate::monitor::MonitorCache;
use crate::settings::Settings;
use crate::sftp::TransferRegistry;
use crate::ssh::SshManager;
use crate::update::UpdateService;

pub struct AppState {
    pub db: Database,
    pub settings: RwLock<Settings>,
    pub update: UpdateService,
    pub ssh: SshManager,
    pub transfers: TransferRegistry,
    pub monitor: MonitorCache,
    pub locale: RwLock<String>,
    pub system: Mutex<System>,
    pub disks: Mutex<Disks>,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    _log_guard: Mutex<Option<WorkerGuard>>,
}

impl AppState {
    pub fn settings(&self) -> Settings {
        self.settings
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn set_settings(&self, next: Settings) {
        let mut guard = self
            .settings
            .write()
            .unwrap_or_else(|error| error.into_inner());
        *guard = next;
    }

    pub fn locale(&self) -> String {
        self.locale
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn set_locale(&self, locale: impl Into<String>) {
        let mut guard = self
            .locale
            .write()
            .unwrap_or_else(|error| error.into_inner());
        *guard = locale.into();
    }
}

pub fn init(app: &AppHandle) -> AppResult<()> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::internal(error.to_string()))?;
    std::fs::create_dir_all(&data_dir)?;

    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| AppError::internal(error.to_string()))?;
    let guard = crate::logging::init(&log_dir)?;

    let db_path = data_dir.join("tunnelde.db");
    let database = match Database::open(&db_path) {
        Ok(database) => database,
        Err(error) => {
            tracing::error!(%error, "database unavailable, recreating a fresh copy");
            quarantine(&db_path)?;
            Database::open(&db_path)?
        }
    };

    let settings = database.with(db::settings::load)?;
    let version = app.package_info().version.to_string();

    app.manage(AppState {
        db: database,
        settings: RwLock::new(settings),
        update: UpdateService::new(version),
        ssh: SshManager::default(),
        transfers: TransferRegistry::default(),
        monitor: MonitorCache::default(),
        locale: RwLock::new("en-US".into()),
        system: Mutex::new(System::new_all()),
        disks: Mutex::new(Disks::new_with_refreshed_list()),
        data_dir,
        log_dir,
        _log_guard: Mutex::new(Some(guard)),
    });

    Ok(())
}

/// Moves a corrupt database (and its WAL sidecars) aside instead of deleting
/// it, so a user can still recover data manually.
fn quarantine(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Ok(());
    }
    let suffix = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let target = path.with_extension(format!("corrupt-{suffix}.db"));
    std::fs::rename(path, &target)?;
    for sidecar in ["-wal", "-shm"] {
        let from = PathBuf::from(format!("{}{sidecar}", path.display()));
        if from.exists() {
            let to = PathBuf::from(format!("{}{sidecar}", target.display()));
            let _ = std::fs::rename(from, to);
        }
    }
    Ok(())
}
