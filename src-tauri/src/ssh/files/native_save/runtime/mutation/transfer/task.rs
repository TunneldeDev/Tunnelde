//! Bind operation identity to the original private recovery claim.
use super::*;
use crate::ssh::files::native_save::journal::admission::{Phase, TransferTask};

impl Manager {
    /// Read immutable intent for local cleanup planning, never dispatch authority.
    pub(crate) async fn transfer_task_intent(&self, id: &str) -> AppResult<Option<TransferTask>> {
        let Some(service) = self.existing().await.map_err(errors::app_journal)? else {
            return Ok(None);
        };
        let mut matches = service
            .legacy_claims()
            .await
            .map_err(errors::app_journal)?
            .into_iter()
            .filter(|claim| {
                claim.owner.id == id
                    || claim
                        .transfer_task
                        .as_ref()
                        .is_some_and(|task| task.id == id)
            });
        let Some(claim) = matches.next() else {
            return Ok(None);
        };
        if matches.next().is_some() || claim.kind != MutationKind::Transfer {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        claim
            .transfer_task
            .map(Some)
            .ok_or_else(|| AppError::validation("editor.nativeChanged"))
    }

    pub(crate) async fn reserve_transfer_task(
        &self,
        targets: &[MutationTarget<'_>],
        task: TransferTask,
        generation: &str,
    ) -> AppResult<Option<Mutation>> {
        if !task.valid() || targets.is_empty() || targets.len() > 4 {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        let Some(service) = self.existing().await.map_err(errors::app_journal)? else {
            return Ok(None);
        };
        if !service
            .admission_enabled()
            .await
            .map_err(errors::app_journal)?
        {
            return Ok(None);
        }
        let mut scopes = Vec::new();
        for target in targets {
            let paths: Vec<_> = target.paths.iter().map(String::as_str).collect();
            self.writable(target.destination, target.sftp, &paths)
                .await?;
            scopes.push(scope::resolve(target.destination, target.sftp, target.paths).await?);
        }
        let claim = service
            .reserve_transfer_task(
                Owner {
                    id: task.id.clone(),
                    generation: generation.into(),
                },
                scopes,
                task,
            )
            .await
            .map_err(errors::app_journal)?;
        Ok(Some(Mutation {
            service,
            claim,
            retire_on_cancel: false,
        }))
    }

    /// A lost application projection never authorizes a new owner. Recover the
    /// original private association by task id, then require exact intent.
    pub(crate) async fn transfer_task_reference(
        &self,
        task: &TransferTask,
    ) -> AppResult<Option<Reference>> {
        if !task.valid() {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        let Some(service) = self.existing().await.map_err(errors::app_journal)? else {
            return Ok(None);
        };
        let claims = service.legacy_claims().await.map_err(errors::app_journal)?;
        let mut matching = claims.iter().filter(|claim| {
            claim.owner.id == task.id
                || claim
                    .transfer_task
                    .as_ref()
                    .is_some_and(|original| original.id == task.id)
        });
        let Some(claim) = matching.next() else {
            return Ok(None);
        };
        if matching.next().is_some() || claim.transfer_task.as_ref() != Some(task) {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        if claim.phase == Phase::Dispatched {
            return Err(AppError::validation("editor.remoteOutcomeUnknown"));
        }
        Reference::new(claim).map(Some)
    }
}
