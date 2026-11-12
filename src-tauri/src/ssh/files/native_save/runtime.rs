//! Desktop lifecycle: load existing recovery authority, never silently initialize it.
mod admission;
mod errors;
mod mutation;
pub(crate) use super::journal::admission::Kind as MutationKind;
pub(crate) use mutation::{Mutation, Observation as MutationObservation};
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
                return if observed.load(Ordering::Acquire) {
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
                        .map(projection::record)
                        .collect();
                    pending.extend(service.legacy_claims().await?.iter().map(|claim| {
                        projection::legacy(claim, service.legacy_worker_running(&claim.id))
                    }));
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
            if let Some(operation) = id.strip_prefix("native-legacy-") {
                let claim = service
                    .legacy_claims()
                    .await
                    .map_err(errors::app_journal)?
                    .into_iter()
                    .find(|claim| claim.id == operation)
                    .ok_or_else(|| AppError::validation("editor.cleanupMissing"))?;
                if claim.phase != super::journal::admission::Phase::Prepared {
                    return Err(AppError::validation("editor.remoteOutcomeUnknown"));
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
            // Explicit user action queries the original authority. No initialize, submit,
            // cancellation or backup release is performed by this task's retry action.
            service
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
            Ok(())
        }
        .await;
        let _ = app.emit("editor://cleanup-changed", ());
        result
    }
}
