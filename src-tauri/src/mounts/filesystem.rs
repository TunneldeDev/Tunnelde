//! OS/FUSE work can outlive delivery deadlines. Every blocking worker retains
//! its bounded slot and inherited native effect until the actual call returns.
use super::*;
use crate::services::operations::{Budget, Cancellation, Errors};
use std::{sync::LazyLock, time::Duration};

const ERRORS: Errors = Errors {
    domain: "mounts.filesystem",
    busy: "mounts.pathBusy",
    cancelled: "mounts.pathTimeout",
    failed: "mounts.pathTimeout",
};
pub(super) async fn bounded<T: Send + 'static>(
    budget: &Budget,
    deadline: Duration,
    action: impl FnOnce(&Cancellation) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tokio::time::timeout(deadline, budget.blocking(action))
        .await
        .map_err(|_| AppError::validation("mounts.pathTimeout"))?
}

pub(super) async fn resolve_mounted_target(root: PathBuf, relative: PathBuf) -> AppResult<PathBuf> {
    static WORKERS: LazyLock<Budget> = LazyLock::new(|| Budget::new(4, ERRORS));
    bounded(&WORKERS, Duration::from_secs(5), move |cancel| {
        cancel.check()?;
        let canonical_root = root.canonicalize()?;
        let target = root.join(relative).canonicalize()?;
        if !target.starts_with(&canonical_root) {
            return Err(AppError::validation("mounts.remotePath.outsideMount"));
        }
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::fs::MetadataExt;
            if canonical_root.metadata()?.dev() != target.metadata()?.dev() {
                return Err(AppError::validation("mounts.remotePath.outsideMount"));
            }
        }
        cancel.check()?;
        Ok(target)
    })
    .await
}

/// Compatibility for one-off mounts: dropping the caller prevents a late OS
/// launch, but never releases the actual worker's slot or native effect early.
pub(super) async fn cancellable_open(
    action: impl FnOnce(std::sync::Arc<std::sync::atomic::AtomicBool>) -> AppResult<()> + Send + 'static,
) -> AppResult<()> {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    struct CancelOnDrop(Arc<AtomicBool>);
    impl Drop for CancelOnDrop {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }
    static WORKERS: LazyLock<Budget> = LazyLock::new(|| Budget::new(4, ERRORS));
    let allowed = Arc::new(AtomicBool::new(true));
    let _cancel = CancelOnDrop(allowed.clone());
    WORKERS
        .blocking(move |cancel| {
            cancel.check()?;
            action(allowed)
        })
        .await
}

#[cfg(target_os = "macos")]
pub(super) async fn mac_mount_device(path: PathBuf) -> AppResult<u64> {
    use std::os::unix::fs::MetadataExt;
    static WORKERS: LazyLock<Budget> = LazyLock::new(|| Budget::new(4, ERRORS));
    bounded(&WORKERS, Duration::from_secs(5), move |cancel| {
        cancel.check()?;
        let device = path.metadata()?.dev();
        cancel.check()?;
        Ok(device)
    })
    .await
}

#[cfg(target_os = "linux")]
pub(super) async fn mount_table() -> AppResult<String> {
    static WORKERS: LazyLock<Budget> = LazyLock::new(|| Budget::new(4, ERRORS));
    bounded(&WORKERS, Duration::from_secs(5), move |cancel| {
        use std::io::Read;
        cancel.check()?;
        let mut table = String::new();
        std::fs::File::open("/proc/self/mountinfo")?
            .take(4 * 1024 * 1024 + 1)
            .read_to_string(&mut table)?;
        cancel.check()?;
        if table.len() > 4 * 1024 * 1024 {
            return Err(AppError::validation("mounts.helperOutputTooLarge"));
        }
        Ok(table)
    })
    .await
}

#[cfg(test)]
mod tests;
