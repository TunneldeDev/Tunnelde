//! Internal desktop connection dialog ingress. Reviews constrain configuration;
//! they do not confer plugin or local-automation authority.
use crate::{
    error::AppResult,
    models::Host,
    ssh::{self, session::review, HostKeyInfo, SessionInfo, SshConnectRequest},
    state::AppState,
};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub(crate) fn connection_review_prepare(
    app: AppHandle,
    displayed: Host,
) -> AppResult<review::Plan> {
    review::prepare(&app, &displayed)
}

#[tauri::command]
pub(crate) async fn connection_review_probe(
    app: AppHandle,
    review: review::Review,
    credentials: HashMap<String, ssh::session::HopCredential>,
) -> AppResult<HostKeyInfo> {
    review::Target::capture(&app, &review)?
        .probe(&app, &credentials)
        .await
}

#[tauri::command]
pub(crate) async fn connection_review_trust(
    app: AppHandle,
    review: review::Review,
    fingerprint: String,
    expected_host_id: String,
    credentials: HashMap<String, ssh::session::HopCredential>,
) -> AppResult<review::Trusted> {
    review::Target::capture(&app, &review)?
        .trust(&app, &fingerprint, &expected_host_id, &credentials)
        .await
}

#[tauri::command]
pub(crate) async fn connection_review_connect(
    app: AppHandle,
    review: review::Review,
    request: SshConnectRequest,
) -> AppResult<SessionInfo> {
    let session = review::Target::capture(&app, &review)?
        .connect(app.clone(), request, false, true)
        .await?;
    crate::logs::record(
        &app.state::<AppState>().db,
        "ssh.connect",
        Some(&session.host_id),
    );
    Ok(session)
}

#[tauri::command]
pub(crate) async fn connection_review_test(
    app: AppHandle,
    id: String,
    review: review::Review,
    credentials: HashMap<String, ssh::session::HopCredential>,
) -> AppResult<ssh::diagnostics::ConnectionQuality> {
    ssh::diagnostics::test_reviewed(app, id, review, credentials).await
}

#[tauri::command]
pub(crate) async fn connection_review_install_key(
    app: AppHandle,
    review: review::Review,
    password: Option<String>,
    credentials: HashMap<String, ssh::session::HopCredential>,
) -> AppResult<ssh::InstalledKey> {
    let target = review::Target::capture(&app, &review)?;
    ssh::keys::install_target(&app, target, password, credentials).await
}

#[tauri::command]
pub(crate) fn connection_review_credential(
    app: AppHandle,
    review: review::Review,
    host_id: String,
    password: Option<String>,
) -> AppResult<()> {
    review::Target::capture(&app, &review)?.credential(&app, &host_id, password.as_deref())
}
