//! A transfer attempt owns one dispatch permit and one sealable request epoch.
use super::*;
use crate::services::files::admission::Path;
use crate::ssh::files::native_save::journal::admission::Phase;

pub(crate) struct Transfer {
    active: ActiveMutation,
    reference: Reference,
    observation: Observation,
}

impl Mutation {
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
            active,
            reference: reference.clone(),
            observation: Observation::default(),
        })
    }
}

impl Transfer {
    pub(crate) fn observation(&self) -> Observation {
        self.observation.clone()
    }

    pub(crate) async fn extend_paths(
        &mut self,
        destination: &SessionIdentity,
        sftp: &SftpSession,
        paths: &[String],
    ) -> AppResult<()> {
        self.active
            .extend_transfer_paths(destination, sftp, paths)
            .await
    }

    /// Only the original admitted worker can park, after draining its actual
    /// children. Sealing prevents delayed queued children from sending later.
    pub(crate) async fn park(self) -> AppResult<Reference> {
        self.observation.seal()?;
        let parked = self
            .active
            .service
            .park_transfer(self.active.permit)
            .await
            .map_err(errors::app_journal)?;
        self.reference.parked(&parked)
    }

    /// Final cleanup/retirement must be confirmed by this same attempt before
    /// release. A timeout, lost response or remaining handle retains the claim.
    pub(crate) async fn settle(self) -> AppResult<()> {
        self.observation.seal()?;
        self.active.settle().await
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
