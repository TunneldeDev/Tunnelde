//! The review captured before showing credentials survives probes and retries.
use super::{
    destination,
    operation::Operation,
    registry::{self, Pending},
};
use crate::{
    error::{AppError, AppResult},
    ssh::{session::HopCredential, HostKeyInfo},
};
use std::collections::HashMap;
use tauri::AppHandle;

pub(super) async fn probe(
    app: &AppHandle,
    pending: &Pending,
    credentials: &HashMap<String, HopCredential>,
) -> AppResult<HostKeyInfo> {
    let (op, target) = Operation::begin(app, pending)?;
    let info = registry::guard(
        pending,
        target.probe_bound(app, credentials, destination::identity(&pending.record)?),
    )
    .await?;
    op.with_current(|_| {
        target.verify(app)?;
        Ok(info)
    })
}

pub(super) async fn trust(
    app: &AppHandle,
    pending: &Pending,
    fingerprint: &str,
    expected_host_id: Option<&str>,
    credentials: &HashMap<String, HopCredential>,
) -> AppResult<HostKeyInfo> {
    let (op, target) = Operation::begin(app, pending)?;
    let info = registry::guard(
        pending,
        target.probe_bound(app, credentials, destination::identity(&pending.record)?),
    )
    .await?;
    if info.fingerprint != fingerprint || expected_host_id != Some(info.host_id.as_str()) {
        return Err(AppError::validation("ssh.hostKeyChanged"));
    }
    op.with_current(|connection| {
        // Exact-record and cancellation authority remain held through the key
        // write and review advance. Only the captured endpoint can be approved.
        let trusted = target.approve_checked(app, info, || {
            if *pending.cancelled.borrow() {
                return Err(AppError::validation("plugin.runners.browserExpired"));
            }
            Ok(())
        })?;
        connection.review = Some(trusted.review);
        Ok(trusted.info)
    })
}
