// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{RwLock, RwLockWriteGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::now_ms;
use crate::state::AppState;

pub const RELEASES_PAGE: &str = "https://github.com/TunneldeDev/Tunnelde/releases/latest";
const EVENT: &str = "update://state";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Ready,
    Unsupported,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub phase: Phase,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<i64>,
    pub progress: Option<u64>,
    pub content_length: Option<u64>,
    pub error: Option<String>,
    pub last_checked: Option<i64>,
    pub available: bool,
    pub auto_install: bool,
    pub unsupported_reason: Option<String>,
    pub download_url: Option<String>,
    pub skipped: bool,
}

impl UpdateState {
    fn new(current_version: String) -> Self {
        Self {
            phase: Phase::Idle,
            current_version,
            version: None,
            notes: None,
            published_at: None,
            progress: None,
            content_length: None,
            error: None,
            last_checked: None,
            available: false,
            auto_install: false,
            unsupported_reason: None,
            download_url: None,
            skipped: false,
        }
    }
}

pub struct UpdateService {
    state: RwLock<UpdateState>,
    busy: AtomicBool,
}

impl UpdateService {
    pub fn new(current_version: String) -> Self {
        Self {
            state: RwLock::new(UpdateState::new(current_version)),
            busy: AtomicBool::new(false),
        }
    }

    pub fn snapshot(&self) -> UpdateState {
        self.state
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn write(&self) -> RwLockWriteGuard<'_, UpdateState> {
        self.state
            .write()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn publish(&self, app: &AppHandle) {
        let _ = app.emit(EVENT, self.snapshot());
    }

    fn set_progress(&self, downloaded: u64, total: Option<u64>) {
        let mut guard = self.write();
        guard.progress = Some(downloaded);
        if total.is_some() {
            guard.content_length = total;
        }
    }

    fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }
}

pub struct Capability {
    pub supported: bool,
    pub auto_install: bool,
    pub reason: &'static str,
}

/// Which install path this build can actually use. Signing gaps are
/// reported to the UI instead of failing silently mid-download.
pub fn capability() -> Capability {
    if cfg!(debug_assertions) {
        return Capability {
            supported: false,
            auto_install: false,
            reason: "dev",
        };
    }

    if cfg!(target_os = "windows") {
        Capability {
            supported: true,
            auto_install: true,
            reason: "",
        }
    } else if cfg!(target_os = "macos") {
        Capability {
            supported: false,
            auto_install: false,
            reason: "unsigned",
        }
    } else if cfg!(target_os = "linux") {
        if std::env::var_os("APPIMAGE").is_some() {
            Capability {
                supported: true,
                auto_install: true,
                reason: "",
            }
        } else {
            Capability {
                supported: false,
                auto_install: false,
                reason: "package",
            }
        }
    } else {
        Capability {
            supported: false,
            auto_install: false,
            reason: "unsupported",
        }
    }
}

pub async fn check(app: AppHandle, force: bool) -> AppResult<UpdateState> {
    let service = app.state::<AppState>();
    if service.update.is_busy() {
        return Ok(service.update.snapshot());
    }
    service.update.busy.store(true, Ordering::SeqCst);
    let outcome = run_check(&app, force).await;
    service.update.busy.store(false, Ordering::SeqCst);

    match outcome {
        Ok(snapshot) => Ok(snapshot),
        Err(error) => {
            {
                let mut guard = service.update.write();
                guard.phase = Phase::Error;
                guard.error = Some(error.to_string());
                guard.last_checked = Some(now_ms());
            }
            service.update.publish(&app);
            Err(error)
        }
    }
}

async fn run_check(app: &AppHandle, force: bool) -> AppResult<UpdateState> {
    let capability = capability();
    let service = app.state::<AppState>();
    let settings = service.settings();

    {
        let mut guard = service.update.write();
        guard.phase = Phase::Checking;
        guard.error = None;
        guard.skipped = false;
    }
    service.update.publish(app);

    if !capability.supported {
        let mut next = service.update.snapshot();
        next.phase = Phase::Unsupported;
        next.available = false;
        next.auto_install = false;
        next.unsupported_reason = Some(capability.reason.to_string());
        next.download_url = Some(RELEASES_PAGE.to_string());
        next.last_checked = Some(now_ms());
        *service.update.write() = next;
        persist_last_check(app);
        service.update.publish(app);
        return Ok(service.update.snapshot());
    }

    let updater = app
        .updater()
        .map_err(|error| AppError::Update(error.to_string()))?;
    let checked = tokio::time::timeout(Duration::from_secs(30), updater.check()).await;

    let mut next = service.update.snapshot();
    next.last_checked = Some(now_ms());

    match checked {
        Err(_) => {
            next.phase = Phase::Error;
            next.error = Some("timeout".into());
        }
        Ok(Err(error)) => {
            next.phase = Phase::Error;
            next.error = Some(error.to_string());
        }
        Ok(Ok(None)) => {
            next.phase = Phase::UpToDate;
            next.available = false;
        }
        Ok(Ok(Some(update))) => {
            next.phase = Phase::Available;
            next.available = true;
            next.auto_install = capability.auto_install;
            next.download_url = Some(RELEASES_PAGE.to_string());
            next.skipped =
                !force && settings.skipped_version.as_deref() == Some(update.version.as_str());
            next.version = Some(update.version.clone());
            next.notes = update.body.clone();
            next.published_at = update.date.map(|date| date.unix_timestamp() * 1000);
        }
    }

    *service.update.write() = next;
    persist_last_check(app);
    service.update.publish(app);
    Ok(service.update.snapshot())
}

pub async fn install(app: AppHandle) -> AppResult<UpdateState> {
    let capability = capability();
    if !capability.auto_install {
        return Err(AppError::Update("unsupported".into()));
    }

    let service = app.state::<AppState>();
    {
        let mut guard = service.update.write();
        guard.phase = Phase::Downloading;
        guard.progress = Some(0);
        guard.error = None;
    }
    service.update.publish(&app);

    let updater = app
        .updater()
        .map_err(|error| AppError::Update(error.to_string()))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|error| AppError::Update(error.to_string()))?
    else {
        let mut guard = service.update.write();
        guard.phase = Phase::UpToDate;
        guard.available = false;
        drop(guard);
        service.update.publish(&app);
        return Ok(service.update.snapshot());
    };

    let progress_app = app.clone();
    let mut downloaded: u64 = 0;
    let result = update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let state = progress_app.state::<AppState>();
                state.update.set_progress(downloaded, total);
                state.update.publish(&progress_app);
            },
            || {},
        )
        .await;

    match result {
        Ok(()) => {
            {
                let mut guard = service.update.write();
                guard.phase = Phase::Ready;
                guard.progress = guard.content_length;
            }
            service.update.publish(&app);
            tracing::info!("update installed, restarting");
            app.restart();
        }
        Err(error) => {
            let mut guard = service.update.write();
            guard.phase = Phase::Error;
            guard.error = Some(error.to_string());
            drop(guard);
            service.update.publish(&app);
            Err(AppError::Update(error.to_string()))
        }
    }
}

pub fn spawn_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = check(app, true).await;
    });
}

pub fn spawn_auto_check(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(4)).await;
        let enabled = app.state::<AppState>().settings().auto_check_updates;
        if !enabled || !capability().supported {
            return;
        }
        if let Err(error) = check(app, false).await {
            tracing::debug!(%error, "automatic update check failed");
        }
    });
}

fn persist_last_check(app: &AppHandle) {
    let service = app.state::<AppState>();
    let mut settings = service.settings();
    settings.last_update_check = Some(now_ms());
    if let Err(error) = service.db.with(|conn| db::settings::save(conn, &settings)) {
        tracing::warn!(%error, "failed to persist the update check timestamp");
    } else {
        service.set_settings(settings);
    }
}
