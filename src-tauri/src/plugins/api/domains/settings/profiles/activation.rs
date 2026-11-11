//! Host-owned consent; no settings writer or policy lock held while awaiting UI.
use super::mutation::{lease, WRITE};
use crate::{
    error::{AppError, AppResult},
    plugins::api::{
        authorize, encode, frontend_request, transport::operation::Ticket, HostContext,
    },
    settings_profiles::{
        activation::publish,
        mutations::{
            self,
            contracts::{Activate, Activated},
        },
    },
    state::AppState,
};
use serde_json::{json, Value};
use tauri::Manager;

pub(super) async fn activate(
    context: &HostContext,
    params: Value,
    ticket: Ticket,
) -> AppResult<Value> {
    let request: Activate = super::parse(params)?;
    let pref = &request.preferences_revision;
    if pref.is_empty() || pref.len() > 128 || pref.chars().any(char::is_control) {
        return Err(AppError::validation("profiles.mutation.invalidRequest"));
    }
    let worker = context.clone();
    let captured_request = Activate {
        id: request.id.clone(),
        revision: request.revision.clone(),
        preferences_revision: request.preferences_revision.clone(),
    };
    let worker_ticket = ticket.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        mutations::activation(
            &worker.app.state::<AppState>().db,
            &captured_request,
            || {
                worker_ticket.check()?;
                authorize(&worker, WRITE)
            },
        )
    })
    .await
    .map_err(|_| AppError::internal("profiles.mutation.unavailable"))??;
    let state = context.app.state::<AppState>();
    let groups = {
        let writer = crate::services::settings::writer(&context.app, &state).await;
        ticket.check()?;
        authorize(context, WRITE)?;
        let current = writer.preferences()?;
        if current.revision != request.preferences_revision {
            return Err(AppError::validation("preferences.staleRevision"));
        }
        selected
            .values
            .as_object()
            .expect("validated public groups")
            .iter()
            .filter(|(id, value)| current.values[*id] != **value)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>()
    };
    let confirmed = frontend_request(
        context,
        "profiles.activate",
        json!({"name":selected.name,"groups":groups}),
    )
    .await?;
    if confirmed == Value::Bool(false) {
        return Err(AppError::validation("profiles.activation.denied"));
    }
    if confirmed != Value::Bool(true) {
        return Err(AppError::validation("plugin.api.invalidResponse"));
    }
    let writer = crate::services::settings::writer(&context.app, &state).await;
    ticket.check()?;
    authorize(context, WRITE)?;
    let mut prepared =
        writer.prepare_profile(&request.preferences_revision, selected.values.clone())?;
    state
        .plugins
        .security
        .with_authorized(&lease(context), WRITE, || {
            prepared.persist_guarded(
                Some(&request.preferences_revision),
                |conn| {
                    selected.compare(conn)?;
                    ticket.commit()
                },
                |conn| selected.select(conn),
            )
        })?;
    // There is deliberately no await between durable publication and effects.
    let preferences_revision = prepared.finish_profile_revision();
    publish(&context.app);
    encode(Activated {
        version: 1,
        id: selected.id,
        revision: selected.revision,
        preferences_revision,
    })
}
