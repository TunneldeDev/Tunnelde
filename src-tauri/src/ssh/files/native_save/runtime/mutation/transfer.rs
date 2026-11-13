//! One transfer owner arbitrates all mutated endpoints and generated paths.
mod continuation;
mod reference;
use super::*;
pub(crate) use reference::Reference;

pub(crate) struct Target<'a> {
    pub destination: &'a SessionIdentity,
    pub sftp: &'a SftpSession,
    pub paths: &'a [String],
}

impl Manager {
    /// Reservation only: the actual worker must still durably checkpoint,
    /// authorize dispatch and observe each original mutation before settlement.
    pub(crate) async fn reserve_transfer_mutation(
        &self,
        targets: &[MutationTarget<'_>],
        owner: (&str, &str),
    ) -> AppResult<Option<Mutation>> {
        if targets.is_empty()
            || targets.len() > 4
            || targets
                .iter()
                .map(|target| target.paths.len())
                .sum::<usize>()
                > 16
        {
            return Err(AppError::validation("editor.nativeBusy"));
        }
        let Some(service) = self.existing().await.map_err(errors::app_journal)? else {
            return Ok(None);
        };
        for target in targets {
            let paths: Vec<_> = target.paths.iter().map(String::as_str).collect();
            self.writable(target.destination, target.sftp, &paths)
                .await?;
        }
        if !service
            .admission_enabled()
            .await
            .map_err(errors::app_journal)?
        {
            return Ok(None);
        }
        let mut scopes = Vec::new();
        for target in targets {
            scopes.push(scope::resolve(target.destination, target.sftp, target.paths).await?);
        }
        let owner = Owner {
            id: owner.0.into(),
            generation: owner.1.into(),
        };
        let claim = service
            .reserve_legacy(MutationKind::Transfer, owner, scopes)
            .await
            .map_err(errors::app_journal)?;
        Ok(Some(Mutation {
            service,
            claim,
            retire_on_cancel: true,
        }))
    }
}

impl ActiveMutation {
    /// Enroll generated paths before use; authorization and actual request
    /// observation still belong to the transfer worker, not this reservation.
    pub(crate) async fn extend_transfer_paths(
        &mut self,
        destination: &SessionIdentity,
        sftp: &SftpSession,
        paths: &[String],
    ) -> AppResult<()> {
        let resolved = scope::resolve(destination, sftp, paths).await?;
        self.service
            .extend_transfer(&mut self.permit, vec![resolved.clone()])
            .await
            .map_err(errors::app_journal)?;
        if scope::resolve(destination, sftp, paths).await? != resolved {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        Ok(())
    }
}
