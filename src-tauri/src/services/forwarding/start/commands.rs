//! Internal main-window ingress. Public callers never supply a UI owner,
//! credential, SSH session, captured host, or trust override.
use super::*;
use crate::ssh::{session::HopCredential, HostKeyInfo, SessionInfo, SshConnectRequest};
use serde::Serialize;
use std::collections::HashMap;
use tauri::WebviewWindow;

fn main_window(window: &WebviewWindow) -> AppResult<()> {
    if window.label() != "main" {
        return Err(AppError::validation("invalid window"));
    }
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Pending {
    receipt: Receipt,
    host: Host,
    jump_hosts: Vec<Host>,
    rule: super::super::contract::ForwardRule,
}

#[tauri::command]
pub(crate) fn forwarding_start_pending(
    app: AppHandle,
    window: WebviewWindow,
    ui_id: String,
) -> AppResult<Option<Pending>> {
    main_window(&window)?;
    if uuid::Uuid::parse_str(&ui_id)
        .ok()
        .is_none_or(|id| id.to_string() != ui_id)
    {
        return Err(AppError::validation("forward.startExpired"));
    }
    let state = app.state::<AppState>();
    let mut manager = state.forward_starts.lock()?;
    Ok(manager
        .book
        .claim(&ui_id, Instant::now())
        .map(|entry| Pending {
            receipt: entry.receipt.clone(),
            host: entry.context.host.clone(),
            jump_hosts: entry.context.jumps.clone(),
            rule: entry.context.entry.rule.clone(),
        }))
}
#[tauri::command]
pub(crate) async fn forwarding_start_probe(
    app: AppHandle,
    window: WebviewWindow,
    request_id: String,
    ui_id: String,
    credentials: HashMap<String, HopCredential>,
) -> AppResult<HostKeyInfo> {
    main_window(&window)?;
    let op = operation::Operation::begin(&app, &request_id, &ui_id)?;
    let target = Target::capture(&app, &op.captured.review)?;
    let info = op.guard(target.probe(&app, &credentials)).await?;
    op.with_current(|_| {
        target.verify(&app)?;
        Ok(info)
    })
}
#[tauri::command]
pub(crate) async fn forwarding_start_trust(
    app: AppHandle,
    window: WebviewWindow,
    request_id: String,
    ui_id: String,
    fingerprint: String,
    expected_host_id: String,
    credentials: HashMap<String, HopCredential>,
) -> AppResult<HostKeyInfo> {
    main_window(&window)?;
    let op = operation::Operation::begin(&app, &request_id, &ui_id)?;
    let target = Target::capture(&app, &op.captured.review)?;
    let info = op.guard(target.probe(&app, &credentials)).await?;
    if info.fingerprint != fingerprint || info.host_id != expected_host_id {
        return Err(AppError::Ssh("ssh.hostKeyChanged".into()));
    }
    op.with_current(|manager| {
        // Cancellation cannot overtake this captured-key write. An approval
        // already committed before cancellation is deliberately not rolled back.
        let entry = manager.book.get(&request_id, Instant::now())?;
        let trusted =
            target.approve_checked(&app, info, || entry.authorize_ui(&ui_id, Instant::now()))?;
        entry.context.review = trusted.review;
        Ok(trusted.info)
    })
}
#[tauri::command]
pub(crate) async fn forwarding_start_connect(
    app: AppHandle,
    window: WebviewWindow,
    request_id: String,
    ui_id: String,
    request: SshConnectRequest,
) -> AppResult<SessionInfo> {
    main_window(&window)?;
    let op = operation::Operation::begin(&app, &request_id, &ui_id)?;
    connections::connect(&op, request).await
}
#[tauri::command]
pub(crate) fn forwarding_start_cancel(
    app: AppHandle,
    window: WebviewWindow,
    request_id: String,
) -> AppResult<Receipt> {
    main_window(&window)?;
    cancel(&app, &request_id)
}
#[tauri::command]
pub(crate) fn forwarding_start_release_ui(
    app: AppHandle,
    window: WebviewWindow,
    ui_id: String,
) -> AppResult<()> {
    main_window(&window)?;
    let state = app.state::<AppState>();
    let mut manager = state.forward_starts.lock()?;
    // A stale document cannot cancel a newer request it never owned.
    manager.book.release_ui(&ui_id, Instant::now());
    drop(manager);
    changed(&app);
    Ok(())
}
