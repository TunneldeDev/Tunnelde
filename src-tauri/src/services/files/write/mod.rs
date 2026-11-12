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

pub(crate) const REMOTE_ERRORS: Errors = Errors {
    domain: "remote-write",
    busy: "editor.remoteSaveBusy",
    cancelled: "editor.saveCancelled",
    failed: "editor.remoteSaveWorkerFailed",
};

// Slow network replies must not exhaust local saves or preview admission.
pub(crate) static REMOTE_BUDGET: LazyLock<Budget> = LazyLock::new(|| Budget::new(4, REMOTE_ERRORS));
