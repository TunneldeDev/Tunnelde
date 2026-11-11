//! Managed writers and plugin operations share the same lock and on-disk config.
use super::{contracts::*, projection};
use crate::{
    error::{AppError, AppResult},
    storage::{
        config::{self, Config},
        layout::Paths,
        migration, MUTATIONS,
    },
};

fn load(paths: &Paths) -> AppResult<Config> {
    config::load(&paths.home).map_err(|_| projection::invalid())
}
fn compare(paths: &Paths, config: &Config, expected: &str) -> AppResult<Snapshot> {
    let snapshot = projection::snapshot(paths, config)?;
    if snapshot.revision != expected {
        return Err(AppError::validation("storage.locations.conflict"));
    }
    Ok(snapshot)
}
fn lock() -> AppResult<std::sync::MutexGuard<'static, ()>> {
    MUTATIONS
        .lock()
        .map_err(|_| AppError::internal("storage.lock"))
}
fn native(changes: &[Change]) -> AppResult<Vec<config::Change>> {
    if changes.is_empty() || changes.len() > 8 {
        return Err(AppError::validation("storage.invalidPlan"));
    }
    changes
        .iter()
        .map(|item| {
            projection::text(&item.target)?;
            Ok(config::Change {
                category: item.category,
                target: item.target.clone().into(),
                migrate: item.migrate,
            })
        })
        .collect()
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
pub(crate) fn prepare_schedule(
    paths: &Paths,
    request: Schedule,
    authorize: impl Fn() -> AppResult<()>,
) -> AppResult<Schedule> {
    authorize()?;
    let _lock = lock()?;
    let config = load(paths)?;
    compare(paths, &config, &request.revision)?;
    if config.pending.is_some() {
        return Err(AppError::validation("storage.planPending"));
    }
    if config.last_error.is_some() {
        return Err(AppError::validation("storage.locations.recoveryRequired"));
    }
    let validated = migration::validate(paths, &native(&request.changes)?)?;
    drop(_lock);
    authorize()?;
    Ok(Schedule {
        revision: request.revision,
        changes: projection::changes(&validated)?,
    })
}
/// `persist` must provide the live permission fence around bounded metadata save.
pub(crate) fn schedule(
    paths: &Paths,
    request: Schedule,
    authorize: impl Fn() -> AppResult<()>,
    commit: impl Fn() -> AppResult<()>,
    persist: impl FnOnce(&dyn Fn() -> AppResult<()>) -> AppResult<()>,
) -> AppResult<Snapshot> {
    authorize()?;
    let config = {
        let _lock = lock()?;
        let mut config = load(paths)?;
        compare(paths, &config, &request.revision)?;
        if config.pending.is_some() {
            return Err(AppError::validation("storage.planPending"));
        }
        if config.last_error.is_some() {
            return Err(AppError::validation("storage.locations.recoveryRequired"));
        }
        let validated = migration::validate(paths, &native(&request.changes)?)?;
        if projection::changes(&validated)? != request.changes {
            return Err(AppError::validation("storage.locations.conflict"));
        }
        config.pending = Some(config::Pending {
            id: uuid::Uuid::new_v4().to_string(),
            changes: validated,
        });
        config.last_error = None;
        config
    };
    let snapshot = projection::snapshot(paths, &config)?;
    let prepared = config::prepare(&paths.home, &config)?;
    persist(&|| {
        let _lock = lock()?;
        compare(paths, &load(paths)?, &request.revision)?;
        commit()?;
        prepared.publish()
    })?;
    Ok(snapshot)
}
pub(crate) fn cancel(
    paths: &Paths,
    request: Cancel,
    authorize: impl Fn() -> AppResult<()>,
    commit: impl Fn() -> AppResult<()>,
    persist: impl FnOnce(&dyn Fn() -> AppResult<()>) -> AppResult<()>,
) -> AppResult<Snapshot> {
    authorize()?;
    let config = {
        let _lock = lock()?;
        let mut config = load(paths)?;
        compare(paths, &config, &request.revision)?;
        config
            .pending
            .as_ref()
            .ok_or_else(|| AppError::validation("storage.locations.noPendingPlan"))?;
        if projection::recovery_required(paths, &config)? {
            return Err(AppError::validation("storage.locations.recoveryRequired"));
        }
        config.pending = None;
        config
    };
    let snapshot = projection::snapshot(paths, &config)?;
    let prepared = config::prepare(&paths.home, &config)?;
    persist(&|| {
        let _lock = lock()?;
        compare(paths, &load(paths)?, &request.revision)?;
        commit()?;
        prepared.publish()
    })?;
    Ok(snapshot)
}
