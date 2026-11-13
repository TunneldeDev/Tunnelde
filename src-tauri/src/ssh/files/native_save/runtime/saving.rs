//! Actual editor dispatch through original setup authority and bilateral admission.
use super::super::{
    client::Client,
    contracts::{
        self,
        operation::{Baseline, Prepared},
        receipt::{Phase, Publication},
    },
    journal::{Binding, Owner},
    transport::ssh::Ssh,
};
use super::*;
use crate::{
    error::{AppError, AppResult},
    ssh::session::SessionIdentity,
    state::AppState,
};
use tauri::{AppHandle, Emitter, Manager as _};

impl Manager {
    /// False means this folder has no native setup. Every uncertain or invalid
    /// setup produces an error; callers must never fall back to SFTP on an error.
    pub(crate) async fn save_if_ready(
        &self,
        app: AppHandle,
        session: String,
        path: String,
        content: String,
        baseline: Option<String>,
    ) -> AppResult<bool> {
        let Some(service) = self.existing().await.map_err(errors::app_journal)? else {
            return Ok(false);
        };
        let destination = app.state::<AppState>().ssh.identity(&session)?;
        let setups: Vec<_> = service
            .setups()
            .await
            .map_err(errors::app_journal)?
            .into_iter()
            .filter(|record| record.plan.same_host(&destination))
            .collect();
        if setups.is_empty() {
            return Ok(false);
        }
        // Resolve the actual editor parent using the saved platform, not the host's
        // editable display settings. Unknown relevant records stay blocking.
        for setup in setups {
            let platform = setup
                .plan
                .package
                .platform()
                .ok_or_else(|| AppError::validation("editor.nativeChanged"))?;
            if !platform.absolute(&path) {
                continue;
            }
            let (parent, name) = super::super::setup::split_editor_path(&path, platform)?;
            let sftp = super::super::super::session(&app, &session).await?;
            let canonical = sftp.canonicalize(parent).await;
            let _ = sftp.close().await;
            let canonical = canonical.map_err(super::super::super::map_sftp)?;
            let canonical = super::super::setup::canonical_editor_path(canonical, platform);
            if canonical != setup.plan.context.scope {
                continue;
            }
            if setup.stage != journal::setup::Stage::Ready
                || setup.plan.context
                    != contracts::authority::Context::authenticated(
                        &destination,
                        canonical,
                        platform,
                    )
                    .ok_or_else(|| AppError::validation("editor.nativeAuthorityChanged"))?
            {
                return Err(AppError::validation("editor.remoteOutcomeUnknown"));
            }
            let authority = setup
                .authority
                .ok_or_else(|| AppError::validation("editor.nativeChanged"))?;
            let baseline = baseline.ok_or_else(|| AppError::validation("editor.nativeChanged"))?;
            let prepared = Prepared::new(
                &authority,
                vec![name],
                Baseline::Existing {
                    length: baseline.len() as u64,
                    sha256: contracts::hash(b"", baseline.as_bytes()),
                },
                content,
            )
            .ok_or_else(|| AppError::validation("editor.nativeChanged"))?;
            let binding = Binding::new(
                authority.clone(),
                &prepared,
                Owner {
                    id: uuid::Uuid::new_v4().to_string(),
                    generation: uuid::Uuid::new_v4().to_string(),
                },
                destination.clone(),
                setup.plan.selection.clone(),
            )
            .map_err(errors::app_journal)?;
            let transport = Ssh::selected(
                app.clone(),
                session.clone(),
                destination.clone(),
                platform,
                &setup.plan.selection.executable,
                &setup.plan.selection.directory,
                authority.context.scope.clone(),
            )
            .map_err(errors::app_remote)?;
            let client =
                Client::restore(transport, authority, platform).map_err(errors::app_remote)?;
            // A previous known publication may keep an original backup. Ask before
            // retiring it; unknown records cannot be cleared to make room.
            for previous in service.records().await.map_err(errors::app_journal)? {
                if previous.blocks_target() && previous.binding.overlaps(&binding) {
                    if previous.binding.authority != binding.authority {
                        return Err(AppError::validation("editor.remoteOutcomeUnknown"));
                    }
                    let original = service
                        .recover(&previous, &client, |_| {
                            if app
                                .state::<AppState>()
                                .ssh
                                .identity(&session)
                                .is_ok_and(|actual| actual == destination)
                            {
                                Ok(())
                            } else {
                                Err(journal::Error::Changed)
                            }
                        })
                        .await
                        .map_err(errors::app_service)?;
                    if !retirement::release(
                        &service,
                        original,
                        &client,
                        &app,
                        &session,
                        &destination,
                    )
                    .await?
                    {
                        return Err(AppError::validation("editor.nativeBackupRetained"));
                    }
                }
            }
            let record = service
                .reserve(binding, &prepared)
                .await
                .map_err(errors::app_journal)?;
            // Do not tie remote worker lifetime to an IPC receiver or WebView.
            return tauri::async_runtime::spawn(async move {
                let worker = service.observe_legacy_worker(&record.binding.operation_id);
                let _ = app.emit("editor://cleanup-changed", ());
                let result = save(
                    service,
                    record,
                    prepared,
                    client,
                    &app,
                    &session,
                    &destination,
                )
                .await;
                drop(worker);
                let _ = app.emit("editor://cleanup-changed", ());
                result.map(|()| true)
            })
            .await
            .map_err(|_| AppError::validation("editor.remoteOutcomeUnknown"))?;
        }
        Ok(false)
    }
}
async fn save(
    service: Arc<Service<System>>,
    record: journal::Record,
    prepared: Prepared,
    client: Client<Ssh>,
    app: &AppHandle,
    session: &str,
    destination: &SessionIdentity,
) -> AppResult<()> {
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
    let mut record = service
        .submit(&record, &prepared, &client, authorize)
        .await
        .map_err(errors::app_service)?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let receipt = record
            .observation
            .as_ref()
            .ok_or_else(|| AppError::validation("editor.remoteOutcomeUnknown"))?;
        if receipt.live == Some(false)
            && matches!(
                receipt.phase,
                Phase::Succeeded | Phase::Conflict | Phase::Failed | Phase::Cancelled
            )
        {
            if receipt.phase == Phase::Succeeded && receipt.publication == Publication::Published {
                return Ok(());
            }
            return Err(AppError::validation(match receipt.error.as_deref() {
                Some("files.save.baselineChanged") => "editor.remoteFileChanged",
                Some("files.save.displacedBaselineChanged") => "editor.nativePublishedConflict",
                _ => "editor.remoteOutcomeUnknown",
            }));
        }
        if tokio::time::Instant::now() >= deadline
            || matches!(
                receipt.phase,
                Phase::Unknown | Phase::Releasing | Phase::Released
            )
        {
            return Err(AppError::validation("editor.remoteOutcomeUnknown"));
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        record = service
            .recover(&record, &client, authorize)
            .await
            .map_err(errors::app_service)?;
    }
}
