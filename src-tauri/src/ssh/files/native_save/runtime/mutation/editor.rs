//! Resume only the original explicitly parked editor claim, never an unknown write.
use super::super::super::journal::admission::{Kind, Phase};
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Reference {
    journal_id: String,
    claim_id: String,
}
impl Reference {
    pub(super) fn new(claim: &Claim) -> Self {
        Self {
            journal_id: claim.journal_id.clone(),
            claim_id: claim.id.clone(),
        }
    }
}
impl Manager {
    pub(crate) async fn reserve_editor_mutation(
        &self,
        destination: &SessionIdentity,
        sftp: &SftpSession,
        paths: &[String],
        operation: &str,
        generation: &str,
    ) -> AppResult<Option<Mutation>> {
        self.reserve_owned_mutation(
            destination,
            sftp,
            Kind::Editor,
            paths,
            Owner {
                id: operation.into(),
                generation: generation.into(),
            },
        )
        .await
    }

    pub(crate) async fn resume_editor_cleanup(
        &self,
        destination: &SessionIdentity,
        sftp: &SftpSession,
        paths: &[String],
        operation: (&str, &str),
        reference: &Reference,
    ) -> AppResult<Mutation> {
        let changed = || AppError::validation("editor.nativeChanged");
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
            .find(|claim| Reference::new(claim) == *reference)
            .ok_or_else(changed)?;
        if expected.kind != Kind::Editor
            || expected.owner.id != operation.0
            || expected.owner.generation != operation.1
            || !matches!(expected.phase, Phase::Prepared | Phase::Recoverable)
        {
            return Err(AppError::validation("editor.remoteOutcomeUnknown"));
        }
        // Do not bypass another owner or expand the original reservation.
        // Final dispatch uses exact journal CAS; two continuations cannot win.
        let resolved = scope::resolve(destination, sftp, paths).await?;
        if expected.scopes != [resolved] {
            return Err(changed());
        }
        Ok(Mutation {
            service,
            claim: expected,
            retire_on_cancel: false,
        })
    }
}
