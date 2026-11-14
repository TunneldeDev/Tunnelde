//! Only this broker creates these connections. Weak pool entries never retain
//! an idle transport; pending attempts and admitted exact instances own it.
use super::*;
use crate::ssh::{SessionInfo, SshConnectRequest};

pub(super) struct Connection {
    app: AppHandle,
    pub info: SessionInfo,
}
impl Drop for Connection {
    fn drop(&mut self) {
        let _ = crate::ssh::disconnect(&self.app, &self.info.id);
    }
}

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
    let key = op.captured.review.identity().to_owned();
    op.phase(Phase::Connecting)?;
    let pooled = op.with_current(|manager| {
        verify_rule(app, &op.captured)?;
        target.verify(app)?;
        manager.pool.retain(|_, entry| entry.strong_count() > 0);
        Ok(manager
            .pool
            .get(&key)
            .and_then(Weak::upgrade)
            .filter(|connection| state.ssh.is_active(&connection.info.id)))
    })?;
    let connection = match pooled {
        Some(connection) => connection,
        None => {
            op.guard(async {
                let info = target.connect(app.clone(), request, false, false).await?;
                // Arm cleanup within the same poll which produced SessionInfo.
                // A losing select branch cannot discard a bare private session.
                Ok(Arc::new(Connection {
                    app: app.clone(),
                    info,
                }))
            })
            .await?
        }
    };
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
        manager.pool.insert(key, Arc::downgrade(&connection));
        Ok(())
    })?;
    crate::logs::record(&state.db, "ssh.connect", Some(&op.captured.host.id));
    let _ = app.emit(
        "plugin://domain-changed",
        serde_json::json!({"domain":"sessions"}),
    );
    changed(app);
    Ok(connection.info.clone())
}
