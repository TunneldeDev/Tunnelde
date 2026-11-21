//! Exact builtin forwarding-session retirement. Caller holds original native
//! authority over the short automation -> registry -> DB -> SSH transaction.
use super::{automation, contract::RevisionedRule, repository};
use crate::{error::AppResult, state::AppState};
use std::collections::HashSet;
use tauri::{AppHandle, Emitter, Manager};

struct Retirement {
    app: AppHandle,
    session: String,
    transport: crate::ssh::session::DetachedSession,
    listeners: Vec<crate::ssh::forward::StoppedForward>,
}
fn affected(rows: &[RevisionedRule], host: &str, active: &[String]) -> Vec<String> {
    let groups: HashSet<_> = rows
        .iter()
        .filter(|row| row.rule.host_id == host && active.contains(&row.rule.id))
        .filter_map(|row| row.group_id.as_deref())
        .collect();
    rows.iter()
        .filter(|row| {
            row.rule.host_id == host
                && (active.contains(&row.rule.id)
                    || row
                        .group_id
                        .as_deref()
                        .is_some_and(|id| groups.contains(id)))
        })
        .map(|row| row.rule.id.clone())
        .collect()
}
pub(crate) fn take(app: &AppHandle, host: &str, session: &str) -> AppResult<Stopping> {
    let state = app.state::<AppState>();
    let retired = state.forward_automation.pause_session_after(session, || {
        let ((transport, ids), listeners) = state.forwards.take_session(session, |active| {
            state.db.with(|conn| {
                // A provider-only/unrelated host cannot be selected through this
                // builtin gateway. No OS credential/route observation is needed.
                crate::db::hosts::find_host(conn, host)?;
                let ids = affected(&repository::list_conn(conn)?, host, active);
                let transport = state.ssh.take_forwarding(host, session)?;
                Ok((transport, ids))
            })
        })?;
        Ok((
            Retirement {
                app: app.clone(),
                session: session.into(),
                transport,
                listeners,
            },
            ids,
        ))
    })?;
    let work = crate::services::operations::WorkLifetime::current();
    Ok(Stopping(tauri::async_runtime::spawn(
        work.retirement().scope(retired.finish()),
    )))
}
pub(crate) struct Stopping(tauri::async_runtime::JoinHandle<AppResult<()>>);
impl Stopping {
    pub(crate) async fn finish(self) -> AppResult<()> {
        self.0
            .await
            .map_err(|_| crate::error::AppError::internal("forward.stopFailed"))?
    }
}
impl Retirement {
    pub(crate) async fn finish(self) -> AppResult<()> {
        let Self {
            app,
            session,
            transport,
            listeners,
        } = self;
        automation::changed(&app);
        let state = app.state::<AppState>();
        state.monitor.forget(&session);
        state.plugins.forget_connection(&session);
        let _ = app.emit(
            crate::ssh::session::CLOSED_EVENT,
            serde_json::json!({"sessionId": session, "reason": "closed"}),
        );
        // Exact admitted cleanup only, outside ownership/automation/DB locks.
        state.mounts.stop_session(&session).await;
        let mut failure = state
            .mounts
            .list(None)
            .await
            .iter()
            .any(|mount| mount.session_id == session)
            .then(|| crate::error::AppError::validation("plugin.resources.cleanupIncomplete"));
        for listener in listeners {
            if let Err(error) = listener.finish().await {
                failure.get_or_insert(error);
            }
        }
        // Continue transport retirement even when a remote CANCEL failed.
        if let Err(error) = transport.finish().await {
            failure.get_or_insert(error);
        }
        crate::logs::record(&state.db, "ssh.disconnect", None);
        failure.map_or(Ok(()), Err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(host: &str, id: &str, group: Option<&str>) -> RevisionedRule {
        RevisionedRule {
            rule: serde_json::from_value(serde_json::json!({"id":id,"hostId":host,"name":id,"mode":"local","bindHost":"127.0.0.1","bindPort":8080,"targetHost":"localhost","targetPort":80})).unwrap(),
            group_id: group.map(str::to_owned), revision: "reviewed".into(),
        }
    }
    #[test]
    fn explicit_disconnect_pauses_pending_siblings_but_never_other_groups_hosts_or_ungrouped_rules()
    {
        let rows = vec![
            row("h", "one", Some("group")),
            row("h", "pending", Some("group")),
            row("h", "two", Some("other")),
            row("h", "group", None),
            row("h", "unclassified", None),
            row("foreign", "another", Some("group")),
        ];
        assert_eq!(affected(&rows, "h", &["one".into()]), ["one", "pending"]);
        assert_eq!(affected(&rows, "h", &["group".into()]), ["group"]);
        assert!(affected(&rows, "h", &["missing".into()]).is_empty());
        assert!(affected(&rows, "foreign", &["one".into()]).is_empty());
    }
}
