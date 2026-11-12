//! Actual legacy worker ownership, independent of caller delivery and cancellation.
mod observation;
use super::super::journal::{
    admission::{Claim, Dispatched, Scope},
    Owner,
};
use super::*;
use crate::{
    error::{AppError, AppResult},
    services::files::operations::Cancellation,
    ssh::session::SessionIdentity,
};
pub(crate) use observation::Observation;
use russh_sftp::client::SftpSession;
use std::future::Future;

pub(crate) struct Mutation {
    service: Arc<Service<System>>,
    claim: Claim,
}
pub(crate) struct ActiveMutation {
    service: Arc<Service<System>>,
    permit: Dispatched,
    _worker: super::super::service::LegacyWorker,
}
impl Mutation {
    pub(crate) async fn retire(self) -> AppResult<()> {
        self.service
            .retire_unsent_legacy(&self.claim)
            .await
            .map_err(errors::app_journal)
    }
    pub(crate) async fn dispatch(self, job: &Cancellation) -> AppResult<ActiveMutation> {
        if let Err(error) = job.check() {
            self.retire().await?;
            return Err(error);
        }
        let permit = self
            .service
            .dispatch_legacy(&self.claim)
            .await
            .map_err(errors::app_journal)?;
        Ok(ActiveMutation {
            _worker: self.service.observe_legacy_worker(&permit.claim().id),
            service: self.service,
            permit,
        })
    }
}
impl ActiveMutation {
    pub(crate) async fn settle(self) -> AppResult<()> {
        self.service
            .settle_legacy(self.permit)
            .await
            .map_err(errors::app_journal)
    }
}
impl Manager {
    pub(crate) async fn reserve_mutation(
        &self,
        destination: &SessionIdentity,
        sftp: &SftpSession,
        kind: MutationKind,
        paths: &[String],
    ) -> AppResult<Option<Mutation>> {
        let Some(service) = self.existing().await.map_err(errors::app_journal)? else {
            return Ok(None);
        };
        let refs: Vec<_> = paths.iter().map(String::as_str).collect();
        self.writable(destination, sftp, &refs).await?;
        if !service
            .admission_enabled()
            .await
            .map_err(errors::app_journal)?
        {
            return Ok(None);
        };
        if paths.is_empty() || paths.len() > 16 {
            return Err(AppError::validation("editor.nativeBusy"));
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut spellings = Vec::new();
        for path in paths {
            spellings.push(path.clone());
            spellings.push(
                tokio::time::timeout_at(deadline, admission::resolve(sftp, path))
                    .await
                    .map_err(|_| AppError::validation("editor.nativeReconnect"))??,
            );
        }
        let windows = spellings.iter().any(|path| {
            crate::services::files::admission::Path::new(
                path,
                crate::services::files::admission::Platform::Windows,
            )
            .is_some()
        });
        let scope = Scope {
            destination: destination.clone(),
            platform: if windows { "windows" } else { "posix" }.into(),
            paths: spellings,
        };
        // Final native/legacy overlap check AND reservation are one transaction,
        // after resolution. The earlier read/check alone is not admission.
        let claim = service
            .reserve_legacy(
                kind,
                Owner {
                    id: uuid::Uuid::new_v4().to_string(),
                    generation: uuid::Uuid::new_v4().to_string(),
                },
                vec![scope],
            )
            .await
            .map_err(errors::app_journal)?;
        Ok(Some(Mutation { service, claim }))
    }
    pub(crate) async fn mutate<W: Future<Output = AppResult<()>>>(
        &self,
        destination: &SessionIdentity,
        sftp: &SftpSession,
        kind: MutationKind,
        paths: &[String],
        job: &Cancellation,
        work: impl FnOnce(Observation) -> W,
    ) -> AppResult<()> {
        job.check()?;
        let reserved = self
            .reserve_mutation(destination, sftp, kind, paths)
            .await?;
        if let Err(cancelled) = job.commit() {
            if let Some(reserved) = reserved {
                reserved.retire().await?;
            }
            return Err(cancelled);
        }
        let dispatched = if let Some(reserved) = reserved {
            Some(reserved.dispatch(job).await?)
        } else {
            None
        };
        let observation = Observation::default();
        // Only original typed request completions acknowledge dispatch. An
        // unrelated success or matching AppError text cannot settle an unknown.
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(300),
            work(observation.clone()),
        )
        .await
        .map_err(|_| AppError::validation("editor.remoteOutcomeUnknown"))?;
        if observation.settled() {
            if let Some(active) = dispatched {
                active.settle().await?;
            }
        } else if result.is_ok() {
            return Err(AppError::validation("editor.remoteOutcomeUnknown"));
        }
        result
    }
}
