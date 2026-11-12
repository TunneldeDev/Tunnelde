//! Actual legacy worker ownership, independent of caller delivery and cancellation.
mod editor;
mod observation;
mod scope;
mod transfer;
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
pub(crate) use editor::Reference as MutationReference;
pub(crate) use observation::Observation;
pub(crate) use observation::{terminal as terminal_mutation_status, Receipt as MutationReceipt};
use russh_sftp::client::SftpSession;
use std::future::Future;
pub(crate) use transfer::Target as MutationTarget;

pub(crate) struct Mutation {
    service: Arc<Service<System>>,
    claim: Claim,
    retire_on_cancel: bool,
}
pub(crate) struct ActiveMutation {
    service: Arc<Service<System>>,
    permit: Dispatched,
    _worker: super::super::service::LegacyWorker,
}
impl Mutation {
    pub(crate) fn reference(&self) -> MutationReference {
        MutationReference::new(&self.claim)
    }
    pub(crate) async fn retire(self) -> AppResult<()> {
        self.service
            .retire_unsent_legacy(&self.claim)
            .await
            .map_err(errors::app_journal)
    }
    pub(crate) async fn dispatch(self, job: &Cancellation) -> AppResult<ActiveMutation> {
        if let Err(error) = job.check() {
            if self.retire_on_cancel {
                self.retire().await?;
            }
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
    pub(crate) async fn park_editor_cleanup(self) -> AppResult<()> {
        self.service
            .park_editor_cleanup(self.permit)
            .await
            .map_err(errors::app_journal)
    }
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
        self.reserve_owned_mutation(
            destination,
            sftp,
            kind,
            paths,
            Owner {
                id: uuid::Uuid::new_v4().to_string(),
                generation: uuid::Uuid::new_v4().to_string(),
            },
        )
        .await
    }
    async fn reserve_owned_mutation(
        &self,
        destination: &SessionIdentity,
        sftp: &SftpSession,
        kind: MutationKind,
        paths: &[String],
        owner: Owner,
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
        let scope = scope::resolve(destination, sftp, paths).await?;
        // Final native/legacy overlap check AND reservation are one transaction,
        // after resolution. The earlier read/check alone is not admission.
        let claim = service
            .reserve_legacy(kind, owner, vec![scope])
            .await
            .map_err(errors::app_journal)?;
        Ok(Some(Mutation {
            service,
            claim,
            retire_on_cancel: kind != MutationKind::Editor,
        }))
    }
    #[cfg(test)]
    pub(crate) async fn mutate<W: Future<Output = AppResult<()>>>(
        &self,
        destination: &SessionIdentity,
        sftp: &SftpSession,
        kind: MutationKind,
        paths: &[String],
        job: &Cancellation,
        work: impl FnOnce(Observation) -> W,
    ) -> AppResult<()> {
        self.mutate_checked(destination, sftp, kind, paths, job, (|| job.commit(), work))
            .await
    }

    pub(crate) async fn mutate_checked<W: Future<Output = AppResult<()>>>(
        &self,
        destination: &SessionIdentity,
        sftp: &SftpSession,
        kind: MutationKind,
        paths: &[String],
        job: &Cancellation,
        (admit, work): (
            impl FnOnce() -> AppResult<()>,
            impl FnOnce(Observation) -> W,
        ),
    ) -> AppResult<()> {
        job.check()?;
        let reserved = self
            .reserve_mutation(destination, sftp, kind, paths)
            .await?;
        if let Err(cancelled) = job.check() {
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
        // Re-resolve after the disk checkpoint without holding authorization
        // locks. A changed alias must not dispatch under an earlier scope.
        if let Some(active) = &dispatched {
            let resolved = scope::resolve(destination, sftp, paths).await;
            if !resolved
                .as_ref()
                .is_ok_and(|scope| active.permit.claim().scopes == [scope.clone()])
            {
                let error = resolved
                    .err()
                    .unwrap_or_else(|| AppError::validation("editor.nativeChanged"));
                dispatched.unwrap().settle().await?;
                return Err(error);
            }
        }
        // Disk dispatch can await a blocking worker. Authorization/cancellation
        // must be admitted after it, before any remote mutation can be polled.
        if let Err(error) = admit() {
            if let Some(active) = dispatched {
                active.settle().await?;
            }
            return Err(error);
        }
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
