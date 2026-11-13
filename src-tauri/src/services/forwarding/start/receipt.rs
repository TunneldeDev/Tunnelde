//! Bounded, process-local request lifetime. A receipt records admission, not the
//! continued health of the listener; use forwards.list for current runtime state.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use tokio::sync::watch;

pub(crate) const REQUEST_BUDGET: Duration = Duration::from_secs(300);
pub(crate) const UI_BUDGET: Duration = Duration::from_secs(15);
const RETENTION: Duration = Duration::from_secs(900);
const CAPACITY: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Input {
    pub id: String,
    pub revision: String,
    pub request_id: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Phase {
    Consent,
    Credentials,
    Connecting,
    Preparing,
    Running,
    Dismissed,
    Cancelled,
    Expired,
    Failed,
}
impl Phase {
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Running | Self::Dismissed | Self::Cancelled | Self::Expired | Self::Failed
        )
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    #[serde(flatten)]
    pub input: Input,
    pub phase: Phase,
    pub expires_at: i64,
    /// Fixed diagnostic key only. Raw transport errors and secrets stay native.
    pub error: Option<&'static str>,
}
pub(super) struct Entry<T> {
    pub receipt: Receipt,
    pub context: T,
    pub deadline: Instant,
    finished: Option<Instant>,
    pub ui: Option<String>,
    ui_deadline: Option<Instant>,
    pub busy: bool,
    pub cancel: watch::Sender<bool>,
}
impl<T> Entry<T> {
    pub fn finish(&mut self, phase: Phase, error: Option<&'static str>, now: Instant) {
        if !self.receipt.phase.terminal() {
            self.receipt.phase = phase;
            self.receipt.error = error;
            self.finished = Some(now);
            self.cancel.send_replace(true);
        }
    }
    pub fn check(&self, now: Instant) -> AppResult<()> {
        if self.receipt.phase.terminal()
            || now >= self.deadline
            || self.ui_deadline.is_some_and(|deadline| now >= deadline)
        {
            return Err(AppError::validation("forward.startExpired"));
        }
        Ok(())
    }
    pub fn authorize_ui(&self, ui: &str, now: Instant) -> AppResult<()> {
        self.check(now)?;
        if self.ui.as_deref() != Some(ui) {
            return Err(AppError::validation("forward.startExpired"));
        }
        Ok(())
    }
}
pub(super) struct Book<T> {
    entries: BTreeMap<String, Entry<T>>,
}
impl<T> Default for Book<T> {
    fn default() -> Self {
        Self {
            entries: BTreeMap::new(),
        }
    }
}
impl<T> Book<T> {
    pub fn sweep(&mut self, now: Instant) {
        for entry in self.entries.values_mut() {
            if entry.check(now).is_err() && !entry.receipt.phase.terminal() {
                entry.finish(Phase::Expired, Some("forward.startExpired"), now);
            }
        }
        self.entries.retain(|_, entry| {
            entry
                .finished
                .is_none_or(|at| now.saturating_duration_since(at) < RETENTION)
        });
    }
    pub fn replay(&mut self, input: &Input, now: Instant) -> AppResult<Option<Receipt>> {
        self.sweep(now);
        let Some(entry) = self.entries.get(&input.request_id) else {
            return Ok(None);
        };
        if entry.receipt.input != *input {
            return Err(AppError::validation("forward.startReused"));
        }
        Ok(Some(entry.receipt.clone()))
    }
    pub fn insert(
        &mut self,
        input: Input,
        context: T,
        now: Instant,
        wall: i64,
    ) -> AppResult<Receipt> {
        if let Some(receipt) = self.replay(&input, now)? {
            return Ok(receipt);
        }
        if self
            .entries
            .values()
            .any(|entry| !entry.receipt.phase.terminal())
            || self.entries.len() >= CAPACITY
        {
            return Err(AppError::validation("forward.startBusy"));
        }
        let receipt = Receipt {
            input: input.clone(),
            phase: Phase::Consent,
            expires_at: wall.saturating_add(REQUEST_BUDGET.as_millis() as i64),
            error: None,
        };
        self.entries.insert(
            input.request_id.clone(),
            Entry {
                receipt: receipt.clone(),
                context,
                deadline: now + REQUEST_BUDGET,
                finished: None,
                ui: None,
                ui_deadline: None,
                busy: false,
                cancel: watch::channel(false).0,
            },
        );
        Ok(receipt)
    }
    pub fn get(&mut self, id: &str, now: Instant) -> AppResult<&mut Entry<T>> {
        self.sweep(now);
        self.entries
            .get_mut(id)
            .ok_or_else(|| AppError::validation("forward.startUnknown"))
    }
    pub fn cancel(&mut self, id: &str, now: Instant) -> AppResult<Receipt> {
        let entry = self.get(id, now)?;
        entry.finish(Phase::Cancelled, None, now);
        Ok(entry.receipt.clone())
    }
    pub fn cancel_pending(&mut self, now: Instant) {
        self.sweep(now);
        for entry in self.entries.values_mut() {
            entry.finish(Phase::Cancelled, None, now);
        }
    }
    pub fn release_ui(&mut self, ui: &str, now: Instant) {
        self.sweep(now);
        for entry in self
            .entries
            .values_mut()
            .filter(|entry| entry.ui.as_deref() == Some(ui))
        {
            entry.finish(Phase::Cancelled, None, now);
        }
    }
    pub fn claim(&mut self, ui: &str, now: Instant) -> Option<&mut Entry<T>> {
        self.sweep(now);
        let entry = self
            .entries
            .values_mut()
            .find(|e| !e.receipt.phase.terminal() && e.receipt.phase != Phase::Consent)?;
        if entry.ui.as_ref().is_some_and(|owner| owner != ui) {
            entry.finish(Phase::Cancelled, Some("forward.startUiChanged"), now);
            return None;
        }
        entry.ui = Some(ui.into());
        entry.ui_deadline = Some(now + UI_BUDGET);
        Some(entry)
    }
}

#[cfg(test)]
mod tests;
