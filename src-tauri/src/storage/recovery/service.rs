use super::{contracts::*, projection};
use crate::{
    error::{AppError, AppResult},
    storage::{
        config::{self, Config},
        layout::Paths,
        MUTATIONS,
    },
};

fn load(paths: &Paths) -> AppResult<Config> {
    config::load(&paths.home).map_err(|_| projection::invalid())
}
fn lock() -> AppResult<std::sync::MutexGuard<'static, ()>> {
    MUTATIONS
        .lock()
        .map_err(|_| AppError::internal("storage.lock"))
}
fn compare(paths: &Paths, state: &Config, expected: &str) -> AppResult<()> {
    if projection::snapshot(paths, state)?.revision != expected {
        return Err(AppError::validation("storage.recovery.conflict"));
    }
    Ok(())
}
pub(crate) fn observe(
    paths: &Paths,
    request: Observe,
    authorize: impl Fn() -> AppResult<()>,
) -> AppResult<Observation> {
    authorize()?;
    let snapshot = {
        let _lock = lock()?;
        projection::snapshot(paths, &load(paths)?)?
    };
    let changed = request.revision.as_ref() != Some(&snapshot.revision);
    authorize()?;
    Ok(Observation {
        version: 1,
        revision: snapshot.revision.clone(),
        changed,
        snapshot: changed.then_some(snapshot),
    })
}

/// Confirmation and permissions belong to the transport. Only a synced config
/// replacement is allowed under its final permission fence; no filesystem work.
pub(crate) fn request(
    paths: &Paths,
    request: Request,
    authorize: impl Fn() -> AppResult<()>,
    commit: impl Fn() -> AppResult<()>,
    persist: impl FnOnce(&dyn Fn() -> AppResult<()>) -> AppResult<()>,
) -> AppResult<Snapshot> {
    authorize()?;
    let next = {
        let _lock = lock()?;
        let mut next = load(paths)?;
        compare(paths, &next, &request.revision)?;
        let pending = next
            .pending
            .as_mut()
            .ok_or_else(|| AppError::validation("storage.recovery.noPendingPlan"))?;
        // Retry resumes the persisted direction. It can never reverse Cancel.
        if request.action == Action::Cancel {
            pending.action = config::Action::Cancel;
        }
        pending.restart_requested = true;
        next
    };
    let snapshot = projection::snapshot(paths, &next)?;
    let prepared = config::prepare(&paths.home, &next)?;
    persist(&|| {
        let _lock = MUTATIONS.try_lock().map_err(|error| match error {
            std::sync::TryLockError::WouldBlock => AppError::validation("storage.recovery.busy"),
            std::sync::TryLockError::Poisoned(_) => AppError::internal("storage.lock"),
        })?;
        compare(paths, &load(paths)?, &request.revision)?;
        commit()?;
        prepared.publish()
    })?;
    Ok(snapshot)
}
