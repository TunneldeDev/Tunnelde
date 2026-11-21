//! Interactive external requests acquire the same host/group transport.
use super::*;
use crate::ssh::{SessionInfo, SshConnectRequest};

pub(super) async fn connect(
    op: &operation::Operation,
    mut request: SshConnectRequest,
) -> AppResult<SessionInfo> {
    if request.host_id != op.captured.host.id {
        return Err(AppError::validation("ssh.connectionChanged"));
    }
    request.background = true;
    request.purpose = Some("forwarding".into());
    let app = &op.app;
    let state = app.state::<AppState>();
    let target = Target::capture(app, &op.captured.review)?;
    op.phase(Phase::Connecting)?;
    let connection = op
        .guard(state.forward_automation.connections.acquire(
            app,
            &op.captured.entry,
            &target,
            request,
        ))
        .await?;
    op.phase(Phase::Preparing)?;
    let (handle, routes) = op.with_current(|_| {
        verify_rule(app, &op.captured)?;
        target.verify(app)?;
        Ok((
            state.ssh.handle(&connection.info.id)?,
            state.ssh.remote_routes(&connection.info.id)?,
        ))
    })?;
    let pending = op
        .guard(crate::ssh::forward::prepare_owned(
            &state.forwards,
            &op.captured.entry.rule,
            &connection.info.id,
            handle,
            routes,
            connection.clone(),
        ))
        .await?;
    op.with_current(|manager| {
        let entry = manager.book.get(&op.id, Instant::now())?;
        // request -> forward -> DB -> SSH. Duplicate and cancellation-ticket
        // checks precede this final callback; no fallible admission follows it.
        pending.commit(&state.forwards, || {
            target.with_current(app, |conn| {
                entry.authorize_ui(&op.ui, Instant::now())?;
                let saved = super::super::repository::find(conn, &op.captured.entry.rule.id)?;
                if saved.as_ref().is_none_or(|entry| {
                    entry.rule != op.captured.entry.rule
                        || entry.revision != op.captured.entry.revision
                }) {
                    return Err(AppError::validation("forward.changed"));
                }
                state.ssh.publish(&connection.info.id)
            })
        })?;
        entry.finish(Phase::Running, None, Instant::now());
        Ok(())
    })?;
    super::super::automation::started(app, &op.captured.entry.rule.id, &connection.info.id);
    crate::logs::record(&state.db, "ssh.connect", Some(&op.captured.host.id));
    let _ = app.emit(
        "plugin://domain-changed",
        serde_json::json!({"domain":"sessions"}),
    );
    changed(app);
    Ok(connection.info.clone())
}
