use crate::{
    error::{AppError, AppResult},
    plugins::{
        api::{authorize, encode, transport::operation::Operation, HostContext},
        security::Lease,
    },
    settings_profiles::{
        activation::publish,
        mutations::{self, contracts::*, drafts::Owner},
    },
    state::AppState,
};
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};
use tauri::Manager;
use tokio::sync::Semaphore;

pub(super) const WRITE: &[&str] = &["settings.read", "settings.write"];
pub(super) fn lease(context: &HostContext) -> Lease {
    Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        generation: context.generation,
        permissions: context.permissions.clone(),
    }
}
fn owner(context: &HostContext) -> Owner {
    Owner {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        generation: context.generation,
    }
}

pub(super) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    static CAPACITY: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let operation = Operation::admit(CAPACITY.get_or_init(|| Arc::new(Semaphore::new(4))).clone())?;
    let ticket = operation.ticket();
    if method == "profiles.activate" {
        return super::activation::activate(context, params, ticket).await;
    }
    let worker = context.clone();
    let method = method.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker.app.state::<AppState>();
        let registry = state.plugins.profile_drafts.clone();
        let owner = owner(&worker);
        let lease = lease(&worker);
        let check = || {
            ticket.check()?;
            authorize(&worker, WRITE)
        };
        check()?;
        let change = match method.as_str() {
            "profiles.drafts.prepare" => {
                let request: Prepare = super::parse(params)?;
                revision(&request.revision)?;
                let current = crate::settings_profiles::content::catalogue(&state.db, check)?;
                if current.revision != request.revision {
                    return Err(AppError::validation("profiles.conflict"));
                }
                return state.plugins.security.with_authorized(&lease, WRITE, || {
                    ticket.commit()?;
                    encode(registry.prepare(owner, request.revision, request.total_bytes)?)
                });
            }
            "profiles.drafts.append" => {
                let request: Append = super::parse(params)?;
                return state.plugins.security.with_authorized(&lease, WRITE, || {
                    ticket.commit()?;
                    encode(registry.append(&owner, request)?)
                });
            }
            "profiles.drafts.discard" => {
                let request: Discard = super::parse(params)?;
                return state.plugins.security.with_authorized(&lease, WRITE, || {
                    ticket.commit()?;
                    registry.discard(&owner, &request.draft_id)?;
                    Ok(json!({"version":1}))
                });
            }
            "profiles.save" => {
                let request: Save = super::parse(params)?;
                let draft = registry.claim(&owner, &request.draft_id)?;
                // Keep the reservation alive through actual worker settlement.
                let change = mutations::save(&state.db, &draft, request, check)?;
                state.plugins.security.with_authorized(&lease, WRITE, || {
                    state
                        .db
                        .with(|conn| change.persist(conn, || ticket.commit()))
                })?;
                publish(&worker.app);
                return encode(change.result());
            }
            "profiles.rename" => mutations::rename(&state.db, super::parse(params)?, check)?,
            "profiles.delete" => mutations::delete(&state.db, super::parse(params)?, check)?,
            _ => return Err(AppError::validation("plugin.api.unknownMethod")),
        };
        state.plugins.security.with_authorized(&lease, WRITE, || {
            state
                .db
                .with(|conn| change.persist(conn, || ticket.commit()))
        })?;
        publish(&worker.app);
        encode(change.result())
    })
    .await
    .map_err(|_| AppError::internal("profiles.mutation.unavailable"))?
}
