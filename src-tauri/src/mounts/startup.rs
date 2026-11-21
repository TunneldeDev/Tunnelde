//! One-off acquisition retains its original authority and cleanup owner until
//! actual startup settles. A lost result disposes only its own mount, not SSH.
use super::*;
use crate::{
    plugins::security::Lease,
    services::operations::{Budget, Cancellation, Delivery, Errors, WorkLifetime},
    state::AppState,
};
use std::sync::LazyLock;
use unmount::{Admission, PluginPolicy};

const ERRORS: Errors = Errors {
    domain: "mounts.startup",
    busy: "mounts.operations.busy",
    cancelled: "mounts.operations.cancelled",
    failed: "mounts.operations.failed",
};

pub(super) trait Gate: Send + Sync {
    fn check(&self) -> AppResult<()>;
    fn handle(
        &self,
        ssh: &SshManager,
        session: &str,
    ) -> AppResult<std::sync::Arc<russh::client::Handle<crate::ssh::session::ClientHandler>>> {
        ssh.handle(session)
    }
    fn commit(&self) -> AppResult<()>;
}
pub(super) struct Host;
impl Gate for Host {
    fn check(&self) -> AppResult<()> {
        Ok(())
    }
    fn commit(&self) -> AppResult<()> {
        Ok(())
    }
}
struct Plugin {
    admission: Admission<PluginPolicy>,
    cancel: Cancellation,
    app: AppHandle,
    session: String,
    identity: crate::ssh::session::SessionIdentity,
    handle: std::sync::Arc<russh::client::Handle<crate::ssh::session::ClientHandler>>,
}
impl Gate for Plugin {
    fn check(&self) -> AppResult<()> {
        self.admission.with_current(|| {
            self.cancel.check()?;
            let state = self.app.state::<AppState>();
            if state.ssh.identity(&self.session)? != self.identity
                || !std::sync::Arc::ptr_eq(&state.ssh.handle(&self.session)?, &self.handle)
                || self.handle.is_closed()
            {
                return Err(AppError::validation("mounts.transportClosed"));
            }
            Ok(())
        })
    }
    fn handle(
        &self,
        _ssh: &SshManager,
        session: &str,
    ) -> AppResult<std::sync::Arc<russh::client::Handle<crate::ssh::session::ClientHandler>>> {
        if session != self.session {
            return Err(AppError::validation("mounts.transportClosed"));
        }
        self.check()?;
        Ok(self.handle.clone())
    }
    fn commit(&self) -> AppResult<()> {
        self.check()?;
        self.admission.commit(&self.cancel)
    }
}

pub(super) async fn prepare_path(mut request: MountRequest) -> AppResult<MountRequest> {
    static PATHS: LazyLock<Budget> = LazyLock::new(|| Budget::new(4, ERRORS));
    PATHS
        .blocking(move |cancel| {
            validate(&request)?;
            if !cfg!(windows) {
                request.mount_point = Path::new(&request.mount_point)
                    .canonicalize()?
                    .to_string_lossy()
                    .into();
            }
            cancel.check()?;
            Ok(request)
        })
        .await
}

pub(crate) async fn mount_plugin(
    app: AppHandle,
    lease: Lease,
    request: MountRequest,
) -> AppResult<MountInfo> {
    // Capture task-local origin and invocation BEFORE spawning. Worker tasks
    // must not discover a new main document or a newer plugin generation.
    let admission = Admission::capture(PluginPolicy {
        app: app.clone(),
        lease: lease.clone(),
    });
    admission.with_current(|| Ok(()))?;
    let identity = app.state::<AppState>().ssh.identity(&request.session_id)?;
    let handle = app.state::<AppState>().ssh.handle(&request.session_id)?;
    static STARTS: LazyLock<Budget> = LazyLock::new(|| Budget::new(4, ERRORS));
    let mounts = app.state::<AppState>().mounts.mounts.clone();
    deliver(&STARTS, mounts, move |cancel| async move {
        let state = app.state::<AppState>();
        let gate = Plugin {
            admission,
            cancel,
            app: app.clone(),
            session: request.session_id.clone(),
            identity,
            handle,
        };
        state
            .mounts
            .mount_gated(&state.ssh, &lease.id, lease.generation, request, &gate)
            .await
    })
    .await
}

async fn deliver<F, W>(budget: &Budget, mounts: unmount::Mounts, acquire: F) -> AppResult<MountInfo>
where
    F: FnOnce(Cancellation) -> W + Send + 'static,
    W: std::future::Future<Output = AppResult<MountInfo>> + Send + 'static,
{
    let delivery = budget
        .asynchronous(move |cancel| async move {
            let info = acquire(cancel).await?;
            // Lost worker outputs dispose only their own mount and retain the
            // effect fence through actual cleanup, not merely kill submission.
            Ok(Delivery::new(info, move |info: &MountInfo| {
                retire(mounts, info.clone());
            }))
        })
        .await?;
    Ok(delivery.accept())
}

/// Readiness is not publication. The final authority/cancellation winner is
/// decided before delivery; every rejected startup runs exact owned cleanup.
pub(super) async fn finish(
    ready: AppResult<()>,
    current: impl FnOnce() -> AppResult<()>,
    gate: &impl Gate,
    cleanup: impl std::future::Future<Output = ()>,
) -> AppResult<()> {
    let result = ready.and_then(|()| current()).and_then(|()| gate.commit());
    if result.is_err() {
        cleanup.await;
    }
    result
}

fn retire(mounts: unmount::Mounts, info: MountInfo) -> JoinHandle<()> {
    let lifetime = WorkLifetime::current().retirement();
    // A fresh task deliberately has no retired origin/invocation task-local.
    // Cleanup needs no fresh consent and must never disconnect the parent SSH.
    tokio::spawn(lifetime.scope(async move {
        let registry = MountRegistry {
            mounts,
            closed: Default::default(),
        };
        registry.stop_resource(&info).await;
    }))
}
impl MountRegistry {
    pub(super) async fn retire_startup(&self, info: MountInfo) {
        let _ = retire(self.mounts.clone(), info).await;
    }
}

#[cfg(test)]
mod tests;
