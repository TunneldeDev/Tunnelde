//! A host-selected web link needs no SSHFS/FUSE scan. Retain its actual opener,
//! and recheck the original origin, invocation and read grant at launch admission.
use super::unmount::{Admission, Policy};
use crate::{
    error::AppResult,
    plugins::security::Lease,
    services::operations::{Budget, Errors},
    state::AppState,
};
use std::sync::LazyLock;
use tauri::{AppHandle, Manager};

pub(super) fn url() -> &'static str {
    if cfg!(windows) {
        "https://github.com/winfsp/sshfs-win"
    } else {
        "https://github.com/libfuse/sshfs"
    }
}
struct ReadPolicy {
    app: AppHandle,
    lease: Lease,
}
impl Policy for ReadPolicy {
    fn with_authorized<T>(&self, effect: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
        self.app
            .state::<AppState>()
            .plugins
            .security
            .with_authorized(&self.lease, &["mounts.read"], effect)
    }
}
const ERRORS: Errors = Errors {
    domain: "mounts.documentation",
    busy: "mounts.operations.busy",
    cancelled: "plugin.api.cancelled",
    failed: "mounts.operations.failed",
};
pub(crate) async fn open(app: AppHandle, lease: Lease) -> AppResult<()> {
    let admission = Admission::capture(ReadPolicy {
        app: app.clone(),
        lease,
    });
    static OPENERS: LazyLock<Budget> = LazyLock::new(|| Budget::new(4, ERRORS));
    run(&OPENERS, admission, move || {
        crate::commands::open_external(app, url().into())
    })
    .await
}
async fn run<P: Policy>(
    budget: &Budget,
    admission: Admission<P>,
    launch: impl FnOnce() -> AppResult<()> + Send + 'static,
) -> AppResult<()> {
    budget
        .blocking(move |cancel| {
            admission.commit(cancel)?;
            // Never launch a browser inside metadata gates. After admission,
            // finish the accepted OS work even if its delivery is cancelled.
            launch()
        })
        .await
}

#[cfg(test)]
pub(crate) mod tests;
