//! Actual task workers retain one durable owner and the registry's request epoch.
pub(super) mod checkpoint;
mod cleanup;
mod preparation;
pub(super) use cleanup::prepare_cleanup;
pub(super) use preparation::Endpoints;
#[cfg(test)]
mod tests;
use super::*;
use native_save::runtime::{MutationTarget, Transfer, TransferReference, TransferTask};

pub(super) type Shared = Arc<tokio::sync::Mutex<Option<Transfer>>>;

impl TransferState {
    pub(super) fn retain_ownership(&mut self, id: &str, ownership: Shared) {
        let retained = ownership.try_lock().map_or(true, |owner| owner.is_some());
        if retained {
            self.retained_ownership.insert(id.into(), ownership);
        }
    }
}

impl TransferRegistry {
    pub(super) fn ownership(&self, id: &str) -> AppResult<Shared> {
        self.inner
            .lock()
            .map_err(|_| AppError::internal("sftp.transferRegistry"))?
            .active
            .get(id)
            .map(|task| task.ownership.clone())
            .ok_or_else(|| AppError::validation("sftp.transferBusy"))
    }

    pub(super) async fn park_ownership(&self, id: &str) -> AppResult<()> {
        let ownership = self.ownership(id)?;
        let mut current = ownership.lock().await;
        if let Some(attempt) = current.as_mut() {
            attempt.park().await?;
            *current = None;
        }
        Ok(())
    }
}

/// Only an active original permit may enroll a task's generated paths. Falling
/// back to the generic recovery fence must never exempt an unrelated claim.
pub(super) async fn writable(
    app: &AppHandle,
    id: &str,
    session_id: &str,
    sftp: &SftpSession,
    paths: &[&str],
) -> AppResult<()> {
    let state = app.state::<AppState>();
    let ownership = state.transfers.ownership(id)?;
    let mut current = ownership.lock().await;
    let destination = state.ssh.identity(session_id)?;
    authorize_task(app, id)?;
    if let Some(attempt) = current.as_mut() {
        let paths = paths
            .iter()
            .map(|path| (*path).to_owned())
            .collect::<Vec<_>>();
        attempt.extend_paths(&destination, sftp, &paths).await?;
        if state.ssh.identity(session_id)? != destination {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        authorize_task(app, id)?;
        return Ok(());
    }
    state.native_saves.writable(&destination, sftp, paths).await
}

pub(super) fn authorize_task(app: &AppHandle, id: &str) -> AppResult<()> {
    let state = app.state::<AppState>();
    let (owner, lease) = {
        let registry = state
            .transfers
            .inner
            .lock()
            .map_err(|_| AppError::internal("sftp.transferRegistry"))?;
        let task = registry
            .active
            .get(id)
            .ok_or_else(|| AppError::validation("sftp.transferBusy"))?;
        (
            task.owner
                .as_ref()
                .map(|owner| (owner.plugin_id.clone(), owner.generation)),
            task.lease.clone(),
        )
    };
    if let Some((plugin_id, generation)) = owner {
        let lease = lease
            .filter(|lease| lease.id == plugin_id && lease.generation == generation)
            .ok_or_else(|| AppError::validation("pluginSecurity.changed"))?;
        state.plugins.security.authorize(
            &lease.id,
            &lease.fingerprint,
            &lease.permissions,
            None,
            Some(lease.generation),
        )?;
    }
    Ok(())
}

pub(super) async fn admit(
    manager: &native_save::runtime::Manager,
    ownership: &Shared,
    task: TransferTask,
    targets: &[MutationTarget<'_>],
    observation: native_save::runtime::MutationObservation,
    (require_existing, checkpoint): (bool, impl FnOnce(&TransferReference) -> AppResult<()>),
    authorize: impl Fn() -> AppResult<()>,
) -> AppResult<bool> {
    let mut current = ownership.lock().await;
    // Re-registration may follow the original late reply. Keep its actual
    // permit until that reply allows parking; a new caller cannot mint one.
    if let Some(previous) = current.as_mut() {
        previous.park().await?;
        *current = None;
    }
    let mutation = match manager.transfer_task_reference(&task).await? {
        Some(reference) => {
            manager
                .resume_transfer_mutation(&reference, targets)
                .await?
        }
        None if require_existing => {
            return Err(AppError::validation("editor.remoteOutcomeUnknown"))
        }
        None => match manager
            .reserve_transfer_task(targets, task, &uuid::Uuid::new_v4().to_string())
            .await?
        {
            Some(mutation) => mutation,
            None => return Ok(false),
        },
    };
    let reference = mutation.transfer_reference()?;
    checkpoint(&reference)?;
    *current = Some(
        mutation
            .dispatch_transfer_epoch(&reference, targets, observation, authorize)
            .await?,
    );
    Ok(true)
}
