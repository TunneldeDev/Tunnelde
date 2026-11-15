//! Native file navigation pinned to an exact recovery record and original SSH identity.
mod connection;
pub mod contracts;
mod destination;
mod operation;
mod preparation;
pub(in crate::plugins::runners) mod registry;
mod verification;

use crate::{
    error::{AppError, AppResult},
    ssh::{session, HostKeyInfo, SshConnectRequest},
    state::AppState,
};
use contracts::{OpenRequest, Plan, Target};
use std::{collections::HashMap, time::Duration};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn runner_recovery_browser_prepare(
    app: AppHandle,
    request: OpenRequest,
) -> AppResult<Plan> {
    preparation::prepare(&app, request).await
}

#[cfg(test)]
mod tests;

fn cancel(app: &AppHandle, id: &str) {
    if let Some(pending) = app.state::<AppState>().runners.browsers.remove(id) {
        connection::dispose(app, &pending);
    }
}

#[tauri::command]
pub fn runner_recovery_browser_cancel(app: AppHandle, id: String) {
    cancel(&app, &id);
}

#[tauri::command]
pub async fn runner_recovery_browser_probe(
    app: AppHandle,
    id: String,
    jump_credentials: HashMap<String, session::HopCredential>,
) -> AppResult<HostKeyInfo> {
    let pending = app.state::<AppState>().runners.browsers.get(&id)?;
    verification::probe(&app, &pending, &jump_credentials).await
}

#[tauri::command]
pub async fn runner_recovery_browser_trust(
    app: AppHandle,
    id: String,
    fingerprint: String,
    expected_host_id: Option<String>,
    jump_credentials: HashMap<String, session::HopCredential>,
) -> AppResult<HostKeyInfo> {
    let pending = app.state::<AppState>().runners.browsers.get(&id)?;
    verification::trust(
        &app,
        &pending,
        &fingerprint,
        expected_host_id.as_deref(),
        &jump_credentials,
    )
    .await
}

#[tauri::command]
pub async fn runner_recovery_browser_connect(
    app: AppHandle,
    id: String,
    request: SshConnectRequest,
) -> AppResult<session::SessionInfo> {
    let pending = app.state::<AppState>().runners.browsers.get(&id)?;
    tokio::time::timeout(
        Duration::from_secs(120),
        connection::connect(&app, &pending, request),
    )
    .await
    .map_err(|_| AppError::validation("ssh.timeout"))?
}

#[tauri::command]
pub async fn runner_recovery_browser_open(app: AppHandle, id: String) -> AppResult<Target> {
    let state = app.state::<AppState>();
    let pending = state.runners.browsers.get(&id)?;
    let result = connection::accept(&app, &id, &pending).await;
    // Do not cancel an in-flight operation merely because another open was busy.
    if !matches!(&result, Err(AppError::Validation(key)) if key == "plugin.runners.busy") {
        if let Some(removed) = state.runners.browsers.remove_matching(&id, &pending) {
            connection::dispose(&app, &removed);
        }
    }
    if let Ok(target) = &result {
        if target.acquired {
            session::announce_connection(&app);
            crate::logs::record(&state.db, "ssh.connect", Some(&target.session.host_id));
        }
    }
    result
}
