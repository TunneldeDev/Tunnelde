//! Local editor publication and staging cleanup share an actual-worker budget.
use super::operations::{Budget, Errors};
use std::sync::LazyLock;

pub(crate) const ERRORS: Errors = Errors {
    domain: "write",
    busy: "editor.saveBusy",
    cancelled: "editor.saveCancelled",
    failed: "editor.saveWorkerFailed",
};

// Independent of read admission: slow storage must not consume preview slots.
pub(crate) static BUDGET: LazyLock<Budget> = LazyLock::new(|| Budget::new(4, ERRORS));
