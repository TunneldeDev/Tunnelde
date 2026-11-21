//! Automatic starts use the same host/group pool as manual and plugin starts.
use super::*;
use crate::ssh::session::review::Target;

pub(super) async fn run(app: &AppHandle, ticket: &Ticket) -> AppResult<String> {
    let handle = app.clone();
    let id = ticket.id.clone();
    let revision = ticket.revision.clone();
    let (entry, target) = crate::services::credentials::inspect(move || {
        let entry = super::super::find(&handle, &id)?
            .ok_or_else(|| AppError::validation("forward.missing"))?;
        if entry.revision != revision {
            return Err(AppError::validation("forward.changed"));
        }
        let host = crate::services::hosts::resolve(&handle, &entry.info.rule.host_id)?;
        Ok((entry, Target::from_displayed(&handle, &host)?))
    })
    .await?;
    let state = app.state::<AppState>();
    let saved = super::super::repository::find_entry(app, &ticket.id)?;
    if saved.revision != ticket.revision {
        return Err(AppError::validation("forward.changed"));
    }
    let connection = state
        .forward_automation
        .connections
        .acquire(
            app,
            &saved,
            &target,
            super::super::connections::request(&saved.rule.host_id),
        )
        .await?;
    if state.forwards.automation_revision(&ticket.id)? != ticket.stop_revision {
        return Err(AppError::validation("forward.startCancelled"));
    }
    let pending = crate::ssh::forward::prepare_owned(
        &state.forwards,
        &entry.info.rule,
        &connection.info.id,
        state.ssh.handle(&connection.info.id)?,
        state.ssh.remote_routes(&connection.info.id)?,
        connection.clone(),
    )
    .await?;
    let book = state.forward_automation.lock();
    book.check(ticket)?;
    pending.commit(&state.forwards, || {
        target.with_current(app, |conn| {
            if state.forwards.automation_revision(&ticket.id)? != ticket.stop_revision {
                return Err(AppError::validation("forward.startCancelled"));
            }
            let saved = super::super::repository::find(conn, &ticket.id)?;
            if saved.as_ref().is_none_or(|saved| {
                saved.revision != ticket.revision || saved.rule != entry.info.rule
            }) {
                return Err(AppError::validation("forward.changed"));
            }
            state.ssh.publish(&connection.info.id)
        })
    })?;
    drop(book);
    let _ = app.emit(
        "plugin://domain-changed",
        serde_json::json!({"domain":"sessions"}),
    );
    Ok(connection.info.id.clone())
}
