//! Opening a mount is an owned registry transaction, not an unreserved snapshot
//! followed by a late OS launch. No original SSH session is owned here.
use super::*;
use crate::services::{
    mounts::runtime::OWNER,
    operations::{Budget, Cancellation, Errors, WorkLifetime},
};
use std::sync::LazyLock;
use unmount::{Admission, Policy};

const ERRORS: Errors = Errors {
    domain: "mounts.managed.open",
    busy: "mounts.pathBusy",
    cancelled: "mounts.operations.cancelled",
    failed: "mounts.operations.failed",
};
struct Request {
    id: String,
    owner: String,
    generation: u64,
    // Persistent callers bind the displayed session too. The legacy ID-only
    // API binds its exact owner/generation under the same held registry lock.
    session: Option<String>,
    path: Option<String>,
    reveal: bool,
}

pub(crate) async fn open_managed(
    app: AppHandle,
    id: String,
    session: String,
    path: Option<String>,
    reveal: bool,
    policy: impl Policy,
) -> AppResult<()> {
    open(
        app,
        Request {
            id,
            owner: OWNER.into(),
            generation: 0,
            session: Some(session),
            path,
            reveal,
        },
        policy,
    )
    .await
}

pub(crate) async fn open_plugin(
    app: AppHandle,
    owner: String,
    generation: u64,
    id: String,
    policy: impl Policy,
) -> AppResult<()> {
    open(
        app,
        Request {
            id,
            owner,
            generation,
            session: None,
            path: None,
            reveal: false,
        },
        policy,
    )
    .await
}

async fn open(app: AppHandle, request: Request, policy: impl Policy) -> AppResult<()> {
    // Capture the original task-local gates BEFORE waiting or spawning.
    let admission = Admission::capture(policy);
    let mounts = app
        .state::<crate::state::AppState>()
        .mounts
        .mounts
        .clone()
        .lock_owned()
        .await;
    static WORKERS: LazyLock<Budget> = LazyLock::new(|| Budget::new(4, ERRORS));
    run(&WORKERS, mounts, request, admission, SystemEffects(app)).await
}
async fn run<P: Policy, E: Effects>(
    budget: &Budget,
    mounts: tokio::sync::OwnedMutexGuard<HashMap<String, ActiveMount>>,
    request: Request,
    admission: Admission<P>,
    effects: E,
) -> AppResult<()> {
    budget
        .asynchronous(move |cancel| async move {
            let reservation = std::sync::Arc::new(tokio::sync::Mutex::new(mounts));
            let admission = std::sync::Arc::new(admission);
            // A timed-out nested filesystem worker also owns these exact
            // reservations, not only the native movement fence. The inner
            // mutex never escapes this transaction; its value keeps the
            // original registry guard alive until the last worker settles.
            // Drop the registry/group reservation BEFORE releasing the outer
            // native effect, including on the last detached worker's thread.
            let lifetime = WorkLifetime::new((
                reservation.clone(),
                admission.clone(),
                WorkLifetime::current(),
            ));
            lifetime
                .scope(async move {
                    transaction(
                        reservation.lock_owned().await,
                        request,
                        admission,
                        effects,
                        cancel,
                    )
                    .await
                })
                .await
        })
        .await
}
fn active<'a>(
    mounts: &'a mut HashMap<String, ActiveMount>,
    request: &Request,
) -> AppResult<&'a mut ActiveMount> {
    let mount = mounts
        .get_mut(&request.id)
        .ok_or_else(|| AppError::NotFound("mounts.notFound".into()))?;
    if mount.info.owner != request.owner || mount.generation != request.generation {
        return Err(AppError::validation("mounts.notOwned"));
    }
    if request
        .session
        .as_ref()
        .is_some_and(|session| mount.info.session_id != *session)
        || mount.info.cleanup_error.is_some()
        || mount.bridge.is_finished()
        || mount.child.try_wait()?.is_some()
    {
        return Err(AppError::validation("mounts.transportClosed"));
    }
    Ok(mount)
}
type Reservation =
    tokio::sync::OwnedMutexGuard<tokio::sync::OwnedMutexGuard<HashMap<String, ActiveMount>>>;
async fn transaction<P: Policy, E: Effects>(
    mut mounts: Reservation,
    request: Request,
    admission: std::sync::Arc<Admission<P>>,
    effects: E,
    cancel: Cancellation,
) -> AppResult<()> {
    admission.with_current(|| cancel.check())?;
    let mount = active(&mut mounts, &request)?;
    effects.probe(mount).await?;
    admission.with_current(|| cancel.check())?;
    let relative = mounted_relative_path(
        &mount.info.remote_path,
        request.path.as_deref().unwrap_or(&mount.info.remote_path),
    )?;
    let target = effects.resolve(&mount.info, relative).await?;
    admission.with_current(|| cancel.check())?;
    effects.probe(active(&mut mounts, &request)?).await?;
    // Move BOTH guards into the actual OS worker. Its inherited lifetime and
    // registry/group reservation survive cancellation after effect admission.
    static OPENERS: LazyLock<Budget> = LazyLock::new(|| Budget::new(4, ERRORS));
    OPENERS
        .blocking(move |worker| {
            active(&mut mounts, &request)?;
            worker.check()?;
            admission.commit(&cancel)?;
            // No filesystem/process launch belongs inside origin/policy/invocation
            // metadata gates. Once admitted, finish it without reauthorization.
            effects.open(target, request.reveal)
        })
        .await
}

/// Only the host's SystemEffects is used by production; tests can pause the
/// exact transaction without pretending an ordinary subprocess is a FUSE mount.
trait Effects: Send + Sync + 'static {
    fn probe(
        &self,
        active: &ActiveMount,
    ) -> impl std::future::Future<Output = AppResult<()>> + Send;
    fn resolve(
        &self,
        mount: &MountInfo,
        relative: PathBuf,
    ) -> impl std::future::Future<Output = AppResult<PathBuf>> + Send;
    fn open(&self, path: PathBuf, reveal: bool) -> AppResult<()>;
}
struct SystemEffects(AppHandle);
impl Effects for SystemEffects {
    async fn probe(&self, active: &ActiveMount) -> AppResult<()> {
        if !mount_visible(&active.info.mount_point).await?
            || !active.matches_mount_identity().await?
        {
            return Err(AppError::validation("mounts.transportClosed"));
        }
        Ok(())
    }
    async fn resolve(&self, mount: &MountInfo, relative: PathBuf) -> AppResult<PathBuf> {
        let target = resolve_mounted_target(PathBuf::from(&mount.mount_point), relative).await?;
        #[cfg(target_os = "linux")]
        {
            let table = filesystem::mount_table().await?;
            if nested_mount_on_path(&table, Path::new(&mount.mount_point), &target) {
                return Err(AppError::validation("mounts.remotePath.outsideMount"));
            }
        }
        Ok(target)
    }
    fn open(&self, target: PathBuf, reveal: bool) -> AppResult<()> {
        if reveal {
            tauri_plugin_opener::reveal_item_in_dir(target)
                .map_err(|e| AppError::internal(e.to_string()))
        } else {
            self.0
                .opener()
                .open_path(target.to_string_lossy().into_owned(), None::<&str>)
                .map_err(|e| AppError::internal(e.to_string()))
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
