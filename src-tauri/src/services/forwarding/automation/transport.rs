//! A weak per-route pool shares background SSH only while listeners retain it.
use super::*;
use crate::ssh::{session::review::Target, SessionInfo, SshConnectRequest};

pub(super) struct Connection {
    app: AppHandle,
    info: SessionInfo,
}
impl Drop for Connection {
    fn drop(&mut self) {
        let _ = crate::ssh::disconnect(&self.app, &self.info.id);
    }
}
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
    let slot = {
        let mut pool = state
            .forward_automation
            .connections
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        pool.retain(|_, slot| {
            Arc::strong_count(slot) > 1
                || slot
                    .try_lock()
                    .map_or(true, |connection| connection.strong_count() > 0)
        });
        pool.entry(target.review().identity().into())
            .or_default()
            .clone()
    };
    let connection = {
        let mut slot = slot.lock().await;
        if let Some(connection) = slot
            .upgrade()
            .filter(|connection| state.ssh.is_active(&connection.info.id))
        {
            connection
        } else {
            let info = target
                .connect(
                    app.clone(),
                    SshConnectRequest {
                        host_id: entry.info.rule.host_id.clone(),
                        background: true,
                        purpose: Some("forwarding".into()),
                        password: None,
                        passphrase: None,
                        jump_credentials: HashMap::new(),
                        cols: 80,
                        rows: 24,
                    },
                    false,
                    false,
                )
                .await?;
            let connection = Arc::new(Connection {
                app: app.clone(),
                info,
            });
            *slot = Arc::downgrade(&connection);
            connection
        }
    };
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
