mod connections;
mod forwarding;
mod mounts;
mod tasks;
mod transfers;

use super::{
    contracts::{
        handle::{Kind, Resource, State},
        release::Outcome,
    },
    identity,
};
use crate::{
    error::{AppError, AppResult},
    plugins::{api::HostContext, runtime::ownership::Ownership},
    state::AppState,
};
use tauri::Manager;

pub(super) enum Target {
    Connection { session: String, receipt: Ownership },
    Forward { rule: String, runtime: String },
    Mount(String),
    Task(String),
    Transfer { id: String, instance: String },
}
pub(super) struct Entry {
    pub resource: Resource,
    pub target: Target,
}
impl Entry {
    fn new(context: &HostContext, kind: Kind, state: State, id: &str, target: Target) -> Self {
        Self {
            resource: Resource {
                handle: identity::handle(context, kind, id),
                kind,
                state,
            },
            target,
        }
    }
}

fn immediate(context: &HostContext) -> AppResult<Vec<Entry>> {
    let mut result = connections::collect(context)?;
    result.extend(forwarding::collect(context)?);
    result.extend(tasks::collect(context)?);
    result.extend(transfers::collect(context)?);
    Ok(result)
}

/// A mount operation must not block disposal of an already-known task, socket
/// or transfer. Only consult the async mount registry when no other kind matches.
pub(super) async fn resolve(context: &HostContext, handle: &str) -> AppResult<Entry> {
    if let Some(entry) = immediate(context)?
        .into_iter()
        .find(|entry| entry.resource.handle == handle)
    {
        return Ok(entry);
    }
    mounts::collect(context)
        .await?
        .into_iter()
        .find(|entry| entry.resource.handle == handle)
        .ok_or_else(unavailable)
}

pub(super) async fn collect(context: &HostContext) -> AppResult<Vec<Entry>> {
    let mut result = immediate(context)?;
    result.extend(mounts::collect(context).await?);
    if result.len() > super::MAX_ITEMS {
        return Err(AppError::validation("plugin.resources.observationLimit"));
    }
    result.sort_by(|a, b| a.resource.handle.cmp(&b.resource.handle));
    Ok(result)
}

pub(super) async fn release(context: &HostContext, target: Target) -> AppResult<Outcome> {
    match target {
        Target::Connection { session, receipt } => {
            connections::release(context, &session, &receipt).await
        }
        Target::Forward { rule, runtime } => forwarding::release(context, &rule, &runtime).await,
        Target::Mount(id) => mounts::release(context, &id).await,
        Target::Task(id) => tasks::release(context, &id),
        Target::Transfer { id, instance } => transfers::release(context, &id, &instance),
    }
}

fn unavailable() -> AppError {
    AppError::validation("plugin.resources.unavailable")
}

fn authorized<T>(context: &HostContext, operation: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
    let lease = crate::plugins::security::Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    };
    context
        .app
        .state::<AppState>()
        .plugins
        .security
        .with_authorized(&lease, &[], operation)
}
