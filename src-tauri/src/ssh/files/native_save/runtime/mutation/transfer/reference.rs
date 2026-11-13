//! Internal task association, separate from the public transfer projection.
use super::*;
use crate::ssh::files::native_save::{
    contracts,
    journal::admission::{Kind, Phase, TransferTask},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Reference {
    journal_id: String,
    claim_id: String,
    owner: Owner,
    revision: u64,
    // Immutable initial roots. Generated staging paths extend a claim, never
    // replace the roots or become an alternative source/destination on resume.
    roots: Vec<Scope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    task: Option<TransferTask>,
}

impl Reference {
    pub(crate) fn belongs_to_task(&self, id: &str) -> bool {
        self.valid() && self.task.as_ref().is_some_and(|task| task.id == id)
    }

    pub(crate) fn same_task(&self, other: &Self) -> bool {
        self.valid()
            && other.valid()
            && self.journal_id == other.journal_id
            && self.claim_id == other.claim_id
            && self.owner == other.owner
            && self.roots == other.roots
            && self.task == other.task
    }

    pub(super) fn new(claim: &Claim) -> AppResult<Self> {
        if claim.kind != Kind::Transfer
            || !claim.valid()
            || !matches!(claim.phase, Phase::Prepared | Phase::Recoverable)
        {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        Self::from_claim(claim)
    }

    pub(super) fn terminal(claim: &Claim) -> AppResult<Self> {
        if !claim.valid() || claim.phase != Phase::Terminal {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        Self::from_claim(claim)
    }

    fn from_claim(claim: &Claim) -> AppResult<Self> {
        Ok(Self {
            journal_id: claim.journal_id.clone(),
            claim_id: claim.id.clone(),
            owner: claim.owner.clone(),
            revision: claim.revision,
            roots: claim
                .transfer_roots
                .clone()
                .ok_or_else(|| AppError::validation("editor.nativeChanged"))?,
            task: claim.transfer_task.clone(),
        })
    }

    pub(super) fn valid(&self) -> bool {
        contracts::uuid(&self.journal_id)
            && contracts::uuid(&self.claim_id)
            && contracts::uuid(&self.owner.id)
            && contracts::uuid(&self.owner.generation)
            && self.revision > 0
            && self.revision <= i64::MAX as u64
            && self.revision % 2 != 0
            && !self.roots.is_empty()
            && self.roots.len() <= 4
            && self
                .roots
                .iter()
                .map(|root| root.paths.len())
                .sum::<usize>()
                <= 32
            && self.roots.iter().all(Scope::valid)
            && self
                .task
                .as_ref()
                .is_none_or(|task| task.valid() && task.id == self.owner.id)
    }

    pub(super) fn identifies(&self, claim: &Claim) -> bool {
        self.valid()
            && claim.valid()
            && claim.kind == Kind::Transfer
            && self.journal_id == claim.journal_id
            && self.claim_id == claim.id
            && self.owner == claim.owner
            && self.task == claim.transfer_task
            && claim.transfer_roots.as_ref() == Some(&self.roots)
            && self.roots.len() == claim.scopes.len()
            && self.roots.iter().zip(&claim.scopes).all(|(root, scope)| {
                root.destination == scope.destination
                    && root.platform == scope.platform
                    && scope.paths.starts_with(&root.paths)
            })
    }

    pub(super) fn current(&self, claim: &Claim) -> bool {
        self.identifies(claim) && self.revision == claim.revision
    }

    pub(super) fn roots(&self) -> &[Scope] {
        &self.roots
    }

    pub(super) fn parked(mut self, claim: &Claim) -> AppResult<Self> {
        if !self.identifies(claim)
            || claim.phase != Phase::Recoverable
            || claim.revision <= self.revision
        {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        self.revision = claim.revision;
        Ok(self)
    }
}
