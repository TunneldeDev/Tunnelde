//! Explicit backup disposal remains bound to the original authority and revision.
use super::super::{
    client::Client,
    journal::{Binding, Record},
    transport::ssh::Ssh,
};
use super::*;
use crate::{
    error::{AppError, AppResult},
    ssh::session::SessionIdentity,
    state::AppState,
};
use tauri::{AppHandle, Manager as _};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

pub(super) async fn release(
    service: &Service<System>,
    record: Record,
    client: &Client<Ssh>,
    app: &AppHandle,
    session: &str,
    destination: &SessionIdentity,
) -> AppResult<bool> {
    let Some(receipt) = record
        .observation
        .as_ref()
        .filter(|receipt| receipt.releasable())
    else {
        return Ok(false);
    };
    let backup = receipt.backup_retained == Some(true);
    if backup && !confirm(app, &record).await? {
        return Ok(false);
    }
    let authorize = |_: &Binding| {
        if app
            .state::<AppState>()
            .ssh
            .identity(session)
            .is_ok_and(|actual| actual == *destination)
        {
            Ok(())
        } else {
            Err(journal::Error::Changed)
        }
    };
    let released = service
        .release(&record, client, backup, authorize)
        .await
        .map_err(errors::app_service)?;
    service
        .finalize(&released)
        .await
        .map_err(errors::app_journal)?;
    Ok(true)
}

async fn confirm(app: &AppHandle, record: &Record) -> AppResult<bool> {
    use std::{
        sync::{Arc, OnceLock},
        time::Duration,
    };
    static DIALOGS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let permit = DIALOGS
        .get_or_init(|| Arc::new(Semaphore::new(1)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::validation("editor.nativeBusy"))?;
    let chinese = app.state::<AppState>().locale().starts_with("zh");
    let (title, text, yes, no) = if chinese {
        (
            "清理上次保存的备份？",
            "上次保存已结束。清理保留的原文件备份和恢复凭据，之后可再次保存。此操作无法撤销。",
            "清理备份",
            "保留",
        )
    } else {
        ("Discard the previous save's backup?", "The previous save has ended. Discard its retained original-file backup and recovery credentials to allow another save. This cannot be undone.", "Discard backup", "Keep")
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "{text}\n\n{}\n{}",
            record.binding.destination.address,
            record.binding.target_path()
        ))
        .title(title)
        .buttons(MessageDialogButtons::OkCancelCustom(yes.into(), no.into()))
        .show(move |accepted| {
            let _ = sender.send(accepted);
            drop(permit);
        });
    tokio::time::timeout(Duration::from_secs(120), receiver)
        .await
        .map_err(|_| AppError::validation("editor.nativeSetupExpired"))?
        .map_err(|_| AppError::validation("editor.nativeSetupExpired"))
}
