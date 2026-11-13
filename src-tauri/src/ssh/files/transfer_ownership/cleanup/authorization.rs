//! Host-owned disposal preserves attribution without reviving the plugin lease.
use super::*;

#[derive(Clone, PartialEq, Eq)]
pub(in crate::ssh::files) struct Cleanup {
    projection: Projection,
    destination: native_save::runtime::TaskEndpoint,
}

#[derive(Clone, PartialEq, Eq)]
struct Projection {
    id: String,
    plugin_id: Option<String>,
    source: (String, Option<String>, Option<String>, bool),
    target: (String, Option<String>, Option<String>, bool),
    remove_source: bool,
    overwrite: bool,
    retained_creation: bool,
}

impl From<&durable::DurableTransfer> for Projection {
    fn from(row: &durable::DurableTransfer) -> Self {
        Self {
            id: row.id.clone(),
            plugin_id: row.plugin_id.clone(),
            source: (
                row.from_path.clone(),
                row.from_host_id.clone(),
                row.from_address.clone(),
                row.from_session.is_some(),
            ),
            target: (
                row.to_path.clone(),
                row.to_host_id.clone(),
                row.to_address.clone(),
                row.to_session.is_some(),
            ),
            remove_source: row.remove_source,
            overwrite: row.overwrite,
            retained_creation: row.retained_creation,
        }
    }
}

impl TransferRegistry {
    pub(in crate::ssh::files) fn install_cleanup(
        &self,
        row: &durable::DurableTransfer,
        destination: native_save::runtime::TaskEndpoint,
    ) -> AppResult<()> {
        if row.retained_creation
            || destination.path != row.to_path
            || !preparation::projected_endpoint_matches(
                &destination,
                row.to_host_id.as_deref(),
                row.to_session.as_deref(),
                row.to_address.as_deref(),
            )
        {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        let cleanup = Cleanup {
            projection: Projection::from(row),
            destination,
        };
        let mut registry = self
            .inner
            .lock()
            .map_err(|_| AppError::internal("sftp.transferRegistry"))?;
        let active = registry
            .active
            .get_mut(&row.id)
            .ok_or_else(|| AppError::validation("sftp.transferBusy"))?;
        if !active.cleanup_started
            || !active.observation.settled()
            || active.observation.closed()
            || active
                .owner
                .as_ref()
                .is_some_and(|owner| Some(&owner.plugin_id) != row.plugin_id.as_ref())
            || active
                .cleanup
                .as_ref()
                .is_some_and(|current| *current != cleanup)
        {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        active.event.plugin_id = row.plugin_id.clone();
        active.cleanup = Some(cleanup);
        Ok(())
    }

    pub(in crate::ssh::files::transfer_ownership) fn cleanup_task(
        &self,
        id: &str,
    ) -> AppResult<Option<(String, Cleanup)>> {
        let registry = self
            .inner
            .lock()
            .map_err(|_| AppError::internal("sftp.transferRegistry"))?;
        let active = registry
            .active
            .get(id)
            .ok_or_else(|| AppError::validation("sftp.transferBusy"))?;
        Ok(active
            .cleanup
            .as_ref()
            .map(|cleanup| (active.identity.clone(), cleanup.clone())))
    }
}

pub(in crate::ssh::files::transfer_ownership) fn authorize_mutation(
    app: &AppHandle,
    id: &str,
) -> AppResult<()> {
    let state = app.state::<AppState>();
    match state.transfers.cleanup_task(id)? {
        Some((_, cleanup)) => {
            // Internal disposal checks the immutable original operation against
            // the current projection. It does not ask a revoked runtime to run.
            let row = durable::Journal::get(app, id)?;
            if Projection::from(&row) != cleanup.projection {
                return Err(AppError::validation("editor.nativeChanged"));
            }
            Ok(())
        }
        None => authorize_task(app, id),
    }
}

pub(super) fn observe(
    app: &AppHandle,
    id: &str,
    to: &Endpoint,
    observation: native_save::runtime::MutationObservation,
) -> AppResult<native_save::runtime::MutationObservation> {
    let state = app.state::<AppState>();
    let (instance, task) = state
        .transfers
        .cleanup_task(id)?
        .ok_or_else(|| AppError::validation("editor.nativeChanged"))?;
    let session = to.session.clone();
    let app = app.clone();
    let id = id.to_owned();
    Ok(observation.guarded(move || {
        let state = app.state::<AppState>();
        if state.transfers.cleanup_task(&id)? != Some((instance.clone(), task.clone())) {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        authorize_mutation(&app, &id)?;
        if let Some(session) = &session {
            if Some(state.ssh.identity(session)?) != task.destination.remote {
                return Err(AppError::validation("editor.nativeChanged"));
            }
        }
        Ok(())
    }))
}

#[cfg(test)]
mod tests;
