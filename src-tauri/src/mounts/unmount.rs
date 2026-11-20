//! One owned mount transaction survives delivery cancellation through cleanup.
use super::*;
use crate::services::operations::{Budget, Cancellation, Errors};
use std::{sync::Arc, sync::LazyLock};
use tokio::sync::OwnedMutexGuard;

/// Synchronous metadata-only admission. The effect callback must not await or
/// perform filesystem I/O. Callers retain their own policy lock through commit.
pub(crate) trait Policy: Send + Sync + 'static {
    fn with_authorized<T>(&self, effect: impl FnOnce() -> AppResult<T>) -> AppResult<T>;
    /// Metadata-only stop intent may be committed alongside effect admission.
    /// Called only inside with_authorized and the original origin/request gates.
    /// Implementations must not reenter those gates or perform I/O.
    fn commit(&self, effect: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
        effect()
    }
    /// Notification after releasing origin/policy/invocation metadata locks.
    fn admitted(&self) {}
    /// Host bookkeeping for an admitted transaction, not result delivery. This
    /// must survive cancellation or permission loss after effect admission.
    fn settled(&self, _result: &AppResult<()>) {}
}
impl<F: Fn() -> AppResult<()> + Send + Sync + 'static> Policy for F {
    fn with_authorized<T>(&self, effect: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
        self()?;
        effect()
    }
}
/// One-off mounts retain their original plugin write grant; unlike shared-rule
/// operations they do not acquire the persistent mount coordinator's admission.
pub(crate) struct PluginPolicy {
    pub(crate) app: AppHandle,
    pub(crate) lease: crate::plugins::security::Lease,
}
impl Policy for PluginPolicy {
    fn with_authorized<T>(&self, effect: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
        self.app
            .state::<crate::state::AppState>()
            .plugins
            .security
            .with_authorized(&self.lease, &["mounts.write"], effect)
    }
}
pub(super) struct Admission<P> {
    policy: P,
    origin: Option<crate::platform::panel_windows::plugin_views::origin::Origin>,
    invocation: Option<crate::plugins::InvocationFence>,
}
impl<P: Policy> Admission<P> {
    pub(super) fn capture(policy: P) -> Self {
        Self {
            policy,
            origin: crate::platform::panel_windows::plugin_views::origin::current(),
            invocation: crate::plugins::current_invocation_fence(),
        }
    }
    pub(super) fn with_current<T>(&self, effect: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
        let run = || {
            self.policy.with_authorized(|| match &self.invocation {
                Some(invocation) => invocation.with_live(effect),
                None => effect(),
            })
        };
        match &self.origin {
            Some(origin) => origin.with_current(run),
            None => run(),
        }
    }
    pub(super) fn commit(&self, cancel: &Cancellation) -> AppResult<()> {
        self.with_current(|| self.policy.commit(|| cancel.commit()))
    }
}

impl MountRegistry {
    pub(crate) async fn unmount_checked(
        &self,
        owner: &str,
        id: &str,
        force: bool,
        generation: Option<u64>,
        policy: impl Policy,
    ) -> AppResult<()> {
        let admission = Admission::capture(policy);
        // Cancellation while waiting for the lock starts no detached job.
        let mounts = self.mounts.clone().lock_owned().await;
        run(
            mounts,
            Request {
                owner: owner.to_owned(),
                id: id.to_owned(),
                force,
                generation,
            },
            admission,
            SystemEffects,
        )
        .await
    }
}
struct Request {
    owner: String,
    id: String,
    force: bool,
    generation: Option<u64>,
}
async fn run<P: Policy, E: Effects>(
    mounts: OwnedMutexGuard<HashMap<String, ActiveMount>>,
    request: Request,
    admission: Admission<P>,
    effects: E,
) -> AppResult<()> {
    static WORKERS: LazyLock<Budget> = LazyLock::new(|| {
        Budget::new(
            4,
            Errors {
                domain: "mounts.unmount",
                busy: "mounts.operations.busy",
                cancelled: "mounts.operations.cancelled",
                failed: "mounts.operations.failed",
            },
        )
    });
    run_with_budget(&WORKERS, mounts, request, admission, effects).await
}
async fn run_with_budget<P: Policy, E: Effects>(
    budget: &Budget,
    mounts: OwnedMutexGuard<HashMap<String, ActiveMount>>,
    request: Request,
    admission: Admission<P>,
    effects: E,
) -> AppResult<()> {
    budget
        .asynchronous(move |cancel| async move {
            let result = transaction(mounts, &request, &admission, &cancel, &effects).await;
            admission.policy.settled(&result);
            result
        })
        .await
}
async fn transaction<P: Policy, E: Effects>(
    mut mounts: OwnedMutexGuard<HashMap<String, ActiveMount>>,
    request: &Request,
    admission: &Admission<P>,
    cancel: &Cancellation,
    effects: &E,
) -> AppResult<()> {
    let Request {
        owner,
        id,
        force,
        generation,
    } = request;
    let active = mounts
        .get_mut(id)
        .ok_or_else(|| AppError::NotFound("mounts.notFound".into()))?;
    if active.info.owner != *owner {
        return Err(AppError::validation("mounts.notOwned"));
    }
    if generation.is_some_and(|generation| active.generation != generation) {
        return Err(AppError::validation("plugin.resources.unavailable"));
    }
    admission.with_current(|| cancel.check())?;
    let present = effects.present(active).await?;
    if present && !effects.matches(active).await? {
        return Err(AppError::validation("mounts.mountPoint.changed"));
    }
    // A single metadata admission chooses the winner against cancellation,
    // document/view retirement, invocation expiry and runtime policy changes.
    // Once accepted, dismount + owned worker cleanup must settle even if the
    // requester disappears. No later lookup can adopt/replace this locked record.
    admission.commit(cancel)?;
    admission.policy.admitted();
    let _volume_lock = if present {
        effects.dismount(active, *force).await?
    } else {
        None
    };
    lifecycle::settle_process(active).await?;
    mounts.remove(id);
    Ok(())
}

/// Host-only seam for deterministic lifetime tests. Never a plugin backend or
/// an authority token; production always uses the system implementation.
trait Effects: Send + Sync + 'static {
    fn present(
        &self,
        active: &ActiveMount,
    ) -> impl std::future::Future<Output = AppResult<bool>> + Send;
    fn matches(
        &self,
        active: &ActiveMount,
    ) -> impl std::future::Future<Output = AppResult<bool>> + Send;
    fn dismount(
        &self,
        active: &ActiveMount,
        force: bool,
    ) -> impl std::future::Future<Output = AppResult<Option<std::fs::File>>> + Send;
}
struct SystemEffects;
impl Effects for SystemEffects {
    async fn present(&self, active: &ActiveMount) -> AppResult<bool> {
        lifecycle::filesystem_present(&active.info.mount_point).await
    }
    async fn matches(&self, active: &ActiveMount) -> AppResult<bool> {
        active.matches_mount_identity().await
    }
    async fn dismount(
        &self,
        active: &ActiveMount,
        force: bool,
    ) -> AppResult<Option<std::fs::File>> {
        #[cfg(windows)]
        {
            if force {
                return Ok(None);
            }
            static WORKERS: LazyLock<Budget> = LazyLock::new(|| {
                Budget::new(
                    4,
                    Errors {
                        domain: "mounts.unmount.volume",
                        busy: "mounts.operations.busy",
                        cancelled: "mounts.operations.cancelled",
                        failed: "mounts.operations.failed",
                    },
                )
            });
            let path = active.info.mount_point.clone();
            WORKERS
                .blocking(move |_| super::dismount_windows(&path))
                .await
                .map(Some)
        }
        #[cfg(not(windows))]
        {
            lifecycle::unmount_filesystem(&active.info.mount_point, force).await?;
            Ok(None)
        }
    }
}

// The map is shared solely so an owned guard, never a borrowed registry, can
// cross into the retained worker. No mutable mount record escapes its lock.
pub(super) type Mounts = Arc<Mutex<HashMap<String, ActiveMount>>>;

#[cfg(test)]
pub(crate) mod tests;
