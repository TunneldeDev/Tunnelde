//! Bounded in-flight observations/disposals, separate from live domain state.
use crate::error::{AppError, AppResult};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
};

#[derive(Default)]
pub(super) struct Budget(Mutex<BTreeMap<String, usize>>);
pub(super) struct Permit {
    budget: Arc<Budget>,
    owner: String,
}
impl Budget {
    pub(super) fn acquire(self: &Arc<Self>, owner: &str) -> AppResult<Permit> {
        let mut counts = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if counts.values().sum::<usize>() >= super::OPERATIONS_TOTAL
            || counts.get(owner).copied().unwrap_or_default() >= super::OPERATIONS_PER_PLUGIN
        {
            return Err(AppError::validation("plugin.resources.busy"));
        }
        *counts.entry(owner.to_owned()).or_default() += 1;
        Ok(Permit {
            budget: self.clone(),
            owner: owner.to_owned(),
        })
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut counts = self.budget.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = counts.get_mut(&self.owner) {
            *count -= 1;
            if *count == 0 {
                counts.remove(&self.owner);
            }
        }
    }
}
pub(super) fn acquire(owner: &str) -> AppResult<Permit> {
    static BUDGET: OnceLock<Arc<Budget>> = OnceLock::new();
    BUDGET
        .get_or_init(|| Arc::new(Budget::default()))
        .acquire(owner)
}
#[cfg(test)]
#[path = "tests/admission.rs"]
mod tests;
