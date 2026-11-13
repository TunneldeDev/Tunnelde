//! A transfer attempt owns one dispatch permit and one sealable request epoch.
use super::*;
use crate::services::files::admission::Path;
use crate::ssh::files::native_save::journal::admission::Phase;

pub(crate) struct Transfer {
    active: Option<ActiveMutation>,
    reference: Reference,
    observation: Observation,
}

impl Mutation {
    /// The actual transfer registry and durable permit share one request epoch.
    /// Admission is rechecked after the SQLite dispatch checkpoint and canonical
    /// resolution; none of that preparation may authorize a later changed peer.
    pub(crate) async fn dispatch_transfer_epoch(
        self,
        reference: &Reference,
        targets: &[MutationTarget<'_>],
        observation: Observation,
        authorize: impl Fn() -> AppResult<()>,
    ) -> AppResult<Transfer> {
        if !reference.current(&self.claim)
            || observation.closed()
            || !observation.settled()
            || targets.len() != reference.roots().len()
        {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        authorize()?;
        let permit = self
            .service
            .dispatch_legacy(&self.claim)
            .await
            .map_err(errors::app_journal)?;
        let mut transfer = Transfer {
            active: Some(ActiveMutation {
                _worker: self.service.observe_legacy_worker(&permit.claim().id),
                service: self.service,
                permit,
            }),
            reference: reference.clone(),
            observation,
        };
        let validation = async {
            for (root, target) in reference.roots().iter().zip(targets) {
                if scope::resolve(target.destination, target.sftp, target.paths).await? != *root {
                    return Err(AppError::validation("editor.nativeChanged"));
                }
            }
            authorize()
        }
        .await;
        if let Err(error) = validation {
            transfer.park().await?;
            return Err(error);
        }
        Ok(transfer)
    }

    pub(crate) fn transfer_reference(&self) -> AppResult<Reference> {
        Reference::new(&self.claim)
    }

    pub(crate) async fn dispatch_transfer(
        self,
        reference: &Reference,
        job: &Cancellation,
    ) -> AppResult<Transfer> {
        if !reference.current(&self.claim) {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        let active = self.dispatch(job).await?;
        Ok(Transfer {
            active: Some(active),
            reference: reference.clone(),
            observation: Observation::default(),
        })
    }
}

impl Transfer {
    pub(crate) fn owns_worker(&self) -> bool {
        self.active.is_some()
    }

    pub(crate) fn observation(&self) -> Observation {
        self.observation.clone()
    }

    pub(crate) async fn extend_paths(
        &mut self,
        destination: &SessionIdentity,
        sftp: &SftpSession,
        paths: &[String],
    ) -> AppResult<()> {
        if self.observation.closed() {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        self.active
            .as_mut()
            .ok_or_else(|| AppError::validation("editor.nativeChanged"))?
            .extend_transfer_paths(destination, sftp, paths)
            .await
    }

    /// Only the original admitted worker can park, after draining its actual
    /// children. Sealing prevents delayed queued children from sending later.
    pub(crate) async fn park(&mut self) -> AppResult<Reference> {
        let active = self.end_epoch()?;
        let parked = active
            .service
            .park_transfer(active.permit)
            .await
            .map_err(errors::app_journal)?;
        self.reference.clone().parked(&parked)
    }

    /// Final cleanup/retirement must be confirmed by this same attempt before
    /// release. A timeout, lost response or remaining handle retains the claim.
    pub(crate) async fn settle(&mut self) -> AppResult<()> {
        self.end_epoch()?.settle().await
    }

    pub(super) fn end_epoch(&mut self) -> AppResult<ActiveMutation> {
        if self.active.is_none() {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        // A pending original request must leave the original worker/permit
        // available to observe its late reply and retry the transition. Only a
        // successfully sealed epoch transfers ownership to the durable step.
        if !self.observation.closed() {
            self.observation.seal()?;
        }
        self.active
            .take()
            .ok_or_else(|| AppError::validation("editor.nativeChanged"))
    }
}

impl Manager {
    pub(crate) async fn resume_transfer_mutation(
        &self,
        reference: &Reference,
        targets: &[MutationTarget<'_>],
    ) -> AppResult<Mutation> {
        let changed = || AppError::validation("editor.nativeChanged");
        if !reference.valid() || targets.len() != reference.roots().len() {
            return Err(changed());
        }
        let service = self
            .existing()
            .await
            .map_err(errors::app_journal)?
            .ok_or_else(changed)?;
        let expected = service
            .legacy_claims()
            .await
            .map_err(errors::app_journal)?
            .into_iter()
            .find(|claim| reference.identifies(claim))
            .ok_or_else(changed)?;
        if !matches!(expected.phase, Phase::Prepared | Phase::Recoverable) {
            return Err(AppError::validation("editor.remoteOutcomeUnknown"));
        }
        if !reference.current(&expected) {
            return Err(changed());
        }
        let resolved = async {
            for ((root, claimed), target) in
                reference.roots().iter().zip(&expected.scopes).zip(targets)
            {
                let resolved =
                    scope::resolve(target.destination, target.sftp, target.paths).await?;
                if resolved != *root {
                    return Err(changed());
                }
                // Revalidate generated paths as well as the immutable task roots.
                // A changed symlink or endpoint must not reuse the earlier claim.
                let platform = claimed.platform().ok_or_else(changed)?;
                for path in &claimed.paths {
                    let canonical = admission::resolve(target.sftp, path).await?;
                    let canonical = Path::new(&canonical, platform).ok_or_else(changed)?;
                    if !claimed.paths.iter().any(|reserved| {
                        Path::new(reserved, platform)
                            .is_some_and(|reserved| reserved.contains(&canonical))
                    }) {
                        return Err(changed());
                    }
                }
            }
            Ok::<(), AppError>(())
        };
        tokio::time::timeout(std::time::Duration::from_secs(10), resolved)
            .await
            .map_err(|_| AppError::validation("editor.nativeReconnect"))??;
        // Dispatch is an exact SQLite CAS; preparing a continuation grants no
        // permit to mutate. Cancellation preserves the parked artifact scopes.
        Ok(Mutation {
            service,
            claim: expected,
            retire_on_cancel: false,
        })
    }
}
