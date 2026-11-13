//! Desktop lifecycle: load existing recovery authority, never silently initialize it.
mod admission;
pub(in crate::ssh::files::native_save) mod errors;
mod initialization;
mod mutation;
mod retirement;
mod saving;
pub(crate) use super::journal::admission::Kind as MutationKind;
pub(crate) use super::journal::admission::{TaskEndpoint, TransferOutcome, TransferTask};
pub(crate) use mutation::{
    terminal_mutation_status, ActiveMutation, Mutation, MutationReceipt, MutationReference,
    Observation as MutationObservation,
};
pub(crate) use mutation::{MutationTarget, Transfer, TransferReference, TransferTerminal};
mod projection;
#[cfg(test)]
mod tests;

use super::{journal, secrets::System, service::Service};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::{Mutex, Semaphore};

pub(crate) struct Manager {
    directory: PathBuf,
    application: String,
    service: Mutex<Option<Arc<Service<System>>>>,
    io: Arc<Semaphore>,
    observed: Arc<AtomicBool>,
}
impl Manager {
    pub(crate) async fn setup(
        &self,
        app: tauri::AppHandle,
        session: String,
        path: String,
    ) -> crate::error::AppResult<bool> {
        super::setup::install(app, session, path).await
    }
    pub(in crate::ssh::files::native_save) fn directory(&self) -> &Path {
        &self.directory
    }
    pub(in crate::ssh::files::native_save) async fn ready_setup(
        &self,
        plan: &journal::setup::Plan,
    ) -> crate::error::AppResult<bool> {
        let Some(service) = self.existing().await.map_err(errors::app_journal)? else {
            return Ok(false);
        };
        let setups = service.setups().await.map_err(errors::app_journal)?;
        let matching = setups.iter().find(|record| {
            record.plan.destination.address == plan.destination.address
                && record.plan.context == plan.context
        });
        match matching {
            Some(record) if record.stage == journal::setup::Stage::Ready => Ok(true),
            Some(_) => Err(crate::error::AppError::validation(
                "editor.remoteOutcomeUnknown",
            )),
            None => Ok(false),
        }
    }
    pub fn new(database: &Path, application: &str) -> Self {
        Self {
            directory: database.join("native-file-saves"),
            application: application.into(),
            service: Mutex::new(None),
            io: Arc::new(Semaphore::new(1)),
            observed: Arc::new(AtomicBool::new(false)),
        }
    }
    async fn existing(&self) -> journal::Result<Option<Arc<Service<System>>>> {
        let mut current = self.service.lock().await;
        if let Some(service) = current.as_ref() {
            return Ok(Some(service.clone()));
        }
        let directory = self.directory.clone();
        let application = self.application.clone();
        let observed = self.observed.clone();
        let permit = self
            .io
            .clone()
            .try_acquire_owned()
            .map_err(|_| journal::Error::Capacity)?;
        let found = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            if crate::storage::layout::metadata(&directory)
                .map_err(|_| journal::Error::Unavailable)?
                .is_none()
            {
                return if observed.load(Ordering::Acquire) || initialization::marked(&directory)? {
                    Err(journal::Error::Changed)
                } else {
                    Ok(None)
                };
            }
            observed.store(true, Ordering::Release);
            let journal = journal::Journal::open(&directory)?;
            Ok(Some(Arc::new(Service::new(
                journal,
                System::new(&application)?,
            ))))
        })
        .await
        .map_err(|_| journal::Error::Unavailable)??;
        *current = found.clone();
        Ok(found)
    }
    pub async fn pending(&self) -> Vec<super::super::remote_editor::PendingCleanup> {
        let result = async {
            match self.existing().await? {
                None => Ok(Vec::new()),
                Some(service) => {
                    let mut pending: Vec<_> = service
                        .records()
                        .await?
                        .iter()
                        .map(|record| {
                            let mut view = projection::record(record);
                            view.running =
                                service.legacy_worker_running(&record.binding.operation_id);
                            view
                        })
                        .collect();
                    pending.extend(service.legacy_claims().await?.iter().map(|claim| {
                        projection::legacy(claim, service.legacy_worker_running(&claim.id))
                    }));
                    pending.extend(
                        service
                            .setups()
                            .await?
                            .iter()
                            .filter(|setup| setup.stage != super::journal::setup::Stage::Ready)
                            .map(|setup| {
                                let mut view = projection::setup(setup);
                                view.running = service.legacy_worker_running(&setup.id);
                                view
                            }),
                    );
                    Ok(pending)
                }
            }
        }
        .await;
        match result {
            Ok(records) => records,
            Err(error) => {
                tracing::warn!(target: "files.recovery", reason = errors::journal(error), "Native file recovery records remain inaccessible");
                vec![projection::unavailable(errors::journal(error))]
            }
        }
    }
    pub async fn retry(&self, app: &tauri::AppHandle, id: &str) -> crate::error::AppResult<()> {
        use super::{client::Client, journal::Stage, transport::ssh::Ssh};
        use crate::{error::AppError, state::AppState};
        use tauri::{Emitter, Manager as _};
        let result = async {
            let service = self
                .existing()
                .await
                .map_err(errors::app_journal)?
                .ok_or_else(|| {
                    AppError::validation(if id == "native-store" {
                        "editor.nativeJournalUnavailable"
                    } else {
                        "editor.cleanupMissing"
                    })
                })?;
            if id == "native-store" {
                service.records().await.map_err(errors::app_journal)?;
                return Ok(());
            }
            if let Some(operation) = id.strip_prefix("native-setup-") {
                let setup = service
                    .setups()
                    .await
                    .map_err(errors::app_journal)?
                    .into_iter()
                    .find(|setup| setup.id == operation)
                    .ok_or_else(|| AppError::validation("editor.cleanupMissing"))?;
                // Unknown installation is diagnostic only. Neither reinitialize
                // nor remove a remote path on a retry of this recovery entry.
                return service
                    .discard_setup(&setup)
                    .await
                    .map_err(errors::app_journal);
            }
            if let Some(operation) = id.strip_prefix("native-legacy-") {
                let claim = service
                    .legacy_claims()
                    .await
                    .map_err(errors::app_journal)?
                    .into_iter()
                    .find(|claim| claim.id == operation)
                    .ok_or_else(|| AppError::validation("editor.cleanupMissing"))?;
                if claim.phase == super::journal::admission::Phase::Terminal {
                    let terminal = TransferTerminal::new(claim)?;
                    let state = app.state::<AppState>();
                    let _reservation = state.transfers.reserve_cleanup(&terminal.task().id)?;
                    return self
                        .project_transfer_terminal(&terminal, |terminal| {
                            state.db.with(|conn| {
                                super::super::transfer_ownership::terminal::project(conn, terminal)
                            })
                        })
                        .await;
                }
                if claim.phase != super::journal::admission::Phase::Prepared {
                    return Err(AppError::validation("editor.remoteOutcomeUnknown"));
                }
                if let Some(task) = claim.transfer_task.as_ref() {
                    let state = app.state::<AppState>();
                    let _reservation = state.transfers.reserve_cleanup(&task.id)?;
                    return super::super::transfer_ownership::terminal::dispose_empty(
                        app, &task.id,
                    )
                    .await;
                }
                // Only definitely unsent claims may be retired. A remote path
                // probe or a newly installed helper cannot settle legacy SFTP.
                return service
                    .retire_unsent_legacy(&claim)
                    .await
                    .map_err(errors::app_journal);
            }
            let operation = id
                .strip_prefix("native-")
                .ok_or_else(|| AppError::validation("editor.cleanupMissing"))?;
            let record = service
                .records()
                .await
                .map_err(errors::app_journal)?
                .into_iter()
                .find(|record| record.binding.operation_id == operation)
                .ok_or_else(|| AppError::validation("editor.cleanupMissing"))?;
            if matches!(
                record.stage,
                Stage::Reserved | Stage::Ready | Stage::Abandoned | Stage::Retired
            ) || record.released()
            {
                return service.finalize(&record).await.map_err(errors::app_journal);
            }
            let state = app.state::<AppState>();
            let destination = record.binding.destination.clone();
            let session = state
                .ssh
                .list()
                .into_iter()
                .find(|session| {
                    state
                        .ssh
                        .identity(&session.id)
                        .is_ok_and(|identity| identity == destination)
                })
                .ok_or_else(|| AppError::validation("editor.nativeReconnect"))?;
            let transport = Ssh::selected(
                app.clone(),
                session.id.clone(),
                destination.clone(),
                record.binding.platform(),
                &record.binding.selection.executable,
                &record.binding.selection.directory,
                record.binding.authority.context.scope.clone(),
            )
            .map_err(errors::app_remote)?;
            let client = Client::restore(
                transport,
                record.binding.authority.clone(),
                record.binding.platform(),
            )
            .map_err(errors::app_remote)?;
            // Query the original authority without initializing, resubmitting or
            // cancelling. A releasable result may then offer explicit backup cleanup.
            let record = service
                .recover(&record, &client, |_| {
                    state
                        .ssh
                        .identity(&session.id)
                        .map_err(|_| journal::Error::Changed)
                        .and_then(|actual| {
                            if actual == destination {
                                Ok(())
                            } else {
                                Err(journal::Error::Changed)
                            }
                        })
                })
                .await
                .map_err(errors::app_service)?;
            retirement::release(&service, record, &client, app, &session.id, &destination).await?;
            Ok(())
        }
        .await;
        let _ = app.emit("editor://cleanup-changed", ());
        result
    }
}
