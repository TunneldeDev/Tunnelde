//! Native file navigation pinned to an exact recovery record and original SSH identity.
mod connection;
pub mod contracts;
mod destination;
mod operation;
pub(in crate::plugins::runners) mod registry;
mod verification;

use crate::{
    error::{AppError, AppResult},
    ssh::{session, HostKeyInfo, SshConnectRequest},
    state::AppState,
};
use contracts::{OpenRequest, Plan, Target};
use registry::{Connection, Pending};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn runner_recovery_browser_prepare(app: AppHandle, request: OpenRequest) -> AppResult<Plan> {
    uuid::Uuid::parse_str(&request.id)
        .map_err(|_| AppError::validation("plugin.api.invalid:id"))?;
    let context = super::query::context(&app, &request.plugin_id)?;
    let record = super::query::selected(&context, &request.token)?;
    destination::identity(&record)?;
    super::super::validate_directory(&record.deployment.directory, &record.deployment.platform)?;
    let state = app.state::<AppState>();
    let mut sessions = state.ssh.list();
    sessions.sort_by(|a, b| a.id.cmp(&b.id));
    let session = sessions
        .into_iter()
        .find(|session| destination::reusable(&app, &record, session));
    let host = if session.is_none() {
        Some(destination::host(&app, &record)?)
    } else {
        None
    };
    let target = host
        .as_ref()
        .map(|host| session::review::Target::from_displayed(&app, host))
        .transpose()?;
    let jump_hosts = target
        .as_ref()
        .map_or_else(Vec::new, |target| target.jump_hosts());
    let review = target.as_ref().map(|target| target.review());
    let lease = state
        .runners
        .admit(&request.plugin_id, &format!("browser:{}", request.token))?;
    let (cancelled, mut signal) = tokio::sync::watch::channel(false);
    let pending = Arc::new(Pending {
        plugin_id: request.plugin_id,
        token: request.token,
        record,
        cancelled,
        connection: std::sync::Mutex::new(Connection {
            session,
            review,
            ..Default::default()
        }),
        _lease: lease,
    });
    state
        .runners
        .browsers
        .insert(request.id.clone(), pending.clone())?;
    // A lost webview cannot retain private transports or admission forever.
    let expiry_app = app.clone();
    let pending = Arc::downgrade(&pending);
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(900)) => {
                if let Some(pending) = pending.upgrade() {
                    if let Some(expired) = expiry_app.state::<AppState>().runners.browsers.remove_matching(&request.id, &pending) {
                        connection::dispose(&expiry_app, &expired);
                    }
                }
            }
            _ = signal.changed() => {}
        }
    });
    Ok(Plan { host, jump_hosts })
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
pub fn runner_recovery_browser_open(app: AppHandle, id: String) -> AppResult<Target> {
    let state = app.state::<AppState>();
    // Serialize acceptance with cancellation; no registry lock crosses a network operation.
    let entries = state
        .runners
        .browsers
        .entries
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let pending = entries
        .get(&id)
        .ok_or_else(|| AppError::validation("plugin.runners.browserExpired"))?;
    let result = connection::accept(&app, pending);
    drop(entries);
    cancel(&app, &id);
    if let Ok(target) = &result {
        if target.acquired {
            session::announce_connection(&app);
            crate::logs::record(&state.db, "ssh.connect", Some(&target.session.host_id));
        }
    }
    result
}
