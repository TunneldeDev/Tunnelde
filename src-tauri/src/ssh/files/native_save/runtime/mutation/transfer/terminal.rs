//! Terminal evidence can be projected after restart, never dispatched again.
use super::*;
use crate::ssh::files::native_save::journal::admission::{Phase, TransferOutcome, TransferTask};

#[derive(Clone)]
pub(crate) struct Terminal(Claim);
impl Terminal {
    pub(in crate::ssh::files::native_save) fn new(claim: Claim) -> AppResult<Self> {
        if !claim.valid() || claim.phase != Phase::Terminal {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        Ok(Self(claim))
    }
    pub(crate) fn task(&self) -> &TransferTask {
        self.0
            .transfer_task
            .as_ref()
            .expect("validated terminal task")
    }
    pub(crate) fn outcome(&self) -> &TransferOutcome {
        self.0
            .terminal
            .as_ref()
            .expect("validated terminal outcome")
    }
    pub(crate) fn reference(&self) -> AppResult<Reference> {
        Reference::terminal(&self.0)
    }
}
impl Transfer {
    pub(crate) async fn complete(&mut self, outcome: TransferOutcome) -> AppResult<Terminal> {
        if !outcome.valid() {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        let active = self.end_epoch()?;
        let claim = active
            .service
            .complete_transfer(active.permit, outcome)
            .await
            .map_err(errors::app_journal)?;
        Terminal::new(claim)
    }
}
impl Manager {
    pub(crate) async fn transfer_terminals(&self) -> AppResult<Vec<Terminal>> {
        let Some(service) = self.existing().await.map_err(errors::app_journal)? else {
            return Ok(Vec::new());
        };
        service
            .legacy_claims()
            .await
            .map_err(errors::app_journal)?
            .into_iter()
            .filter(|claim| claim.phase == Phase::Terminal)
            .map(Terminal::new)
            .collect()
    }

    pub(crate) async fn project_transfer_terminal(
        &self,
        terminal: &Terminal,
        checkpoint: impl FnOnce(&Terminal) -> AppResult<()>,
    ) -> AppResult<()> {
        let service = self
            .existing()
            .await
            .map_err(errors::app_journal)?
            .ok_or_else(|| AppError::validation("editor.nativeChanged"))?;
        let current = service.legacy_claims().await.map_err(errors::app_journal)?;
        if !current.contains(&terminal.0) {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        // Sync the application projection before relinquishing path authority.
        // Callback failure retains the exact private terminal for later retry.
        checkpoint(terminal)?;
        service
            .retire_transfer_terminal(&terminal.0)
            .await
            .map_err(errors::app_journal)
    }

    pub(crate) async fn dispose_empty_task(&self, task_id: &str) -> AppResult<Option<Terminal>> {
        let Some(service) = self.existing().await.map_err(errors::app_journal)? else {
            return Ok(None);
        };
        let mut matches = service
            .legacy_claims()
            .await
            .map_err(errors::app_journal)?
            .into_iter()
            .filter(|claim| claim.owner.id == task_id);
        let Some(claim) = matches.next() else {
            return Ok(None);
        };
        if matches.next().is_some() || claim.transfer_task.is_none() {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        if claim.phase == Phase::Terminal {
            return Terminal::new(claim).map(Some);
        }
        Terminal::new(
            service
                .dispose_empty_transfer(&claim)
                .await
                .map_err(errors::app_journal)?,
        )
        .map(Some)
    }
}
