//! Explicit adoption never takes ownership of a terminal's SSH connection.
use super::{lease, HostContext};
use crate::{
    error::{AppError, AppResult},
    plugins::api::{authorize, field, optional},
    services::mounts::{
        contract::{Group, Rule, Save},
        repository,
        runtime::{self, Authority},
    },
    state::AppState,
};
use serde_json::{json, Value};
use tauri::Manager;

pub(super) async fn call(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let app = &context.app;
    let state = app.state::<AppState>();
    match method {
        "legacy.list" => {
            let sessions = state.ssh.list();
            let mounts = state.mounts.list(None).await;
            let dismissed = state.db.with(|conn| {
                let mut stmt = conn.prepare("SELECT id FROM mount_legacy_dismissed")?;
                let ids = stmt
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<std::collections::HashSet<_>, _>>()?;
                Ok(ids)
            })?;
            let host: Option<String> = optional(&params, "hostId")?;
            let offset: usize = optional(&params, "offset")?.unwrap_or(0);
            let entries: Vec<_> = mounts
                .into_iter()
                .filter(|m| m.owner != runtime::OWNER && !dismissed.contains(&m.id))
                .filter_map(|m| {
                    sessions
                        .iter()
                        .find(|s| s.id == m.session_id)
                        .map(|s| (m, s.host_id.clone()))
                })
                .filter(|(_, id)| host.as_ref().is_none_or(|h| h == id))
                .map(|(mount, host)| json!({"mount":mount,"hostId":host}))
                .collect();
            authorize(context, &["mounts.read"])?;
            Ok(
                json!({"total":entries.len(),"items":entries.into_iter().skip(offset).take(32).collect::<Vec<_>>()}),
            )
        }
        "legacy.dismiss" => {
            let id: String = field(&params, "id")?;
            if id.len() > 128 {
                return Err(AppError::validation("mounts.rules.invalid"));
            }
            Authority(Some(lease(context))).commit(app, || state.db.with(|conn| crate::db::atomic(conn, |conn| {
                conn.execute("INSERT OR REPLACE INTO mount_legacy_dismissed(id,created_at) VALUES(?1,?2)", rusqlite::params![id,crate::models::now_ms()])?;
                conn.execute("DELETE FROM mount_legacy_dismissed WHERE id NOT IN (SELECT id FROM mount_legacy_dismissed ORDER BY created_at DESC,id LIMIT 512)", [])?;
                Ok(())
            })))?;
            runtime::changed(app);
            Ok(Value::Null)
        }
        "legacy.convert" => {
            let id: String = field(&params, "id")?;
            let rule_id: String = field(&params, "ruleId")?;
            let group_id: String = field(&params, "groupId")?;
            let expected: String = field(&params, "expectedGroupRevision")?;
            let name: String = field(&params, "name")?;
            let _gate = state.mount_runtime.gate(&group_id)?;
            let authority = Authority(Some(lease(context)));
            let mut adopted = None;
            let result = state
                .mounts
                .adopt_managed(&id, |mount| {
                    adopted = Some(mount.clone());
                    authority.commit(app, || {
                        state.db.with(|conn| {
                            crate::db::atomic(conn, |conn| {
                                let group = repository::get::<Group>(conn, &group_id)?
                                    .ok_or_else(repository::changed)?;
                                let sessions = state.ssh.list();
                                let session = sessions
                                    .iter()
                                    .find(|s| s.id == mount.session_id)
                                    .ok_or_else(repository::changed)?;
                                if group.revision != expected
                                    || session.host_id != group.value.host_id
                                {
                                    return Err(repository::changed());
                                }
                                let rule = repository::save(
                                    conn,
                                    Save {
                                        value: Rule {
                                            id: rule_id,
                                            host_id: group.value.host_id,
                                            group_id,
                                            name,
                                            remote_path: mount.remote_path.clone(),
                                            mount_point: mount.mount_point.clone(),
                                            read_only: mount.read_only,
                                            auto_mount: false,
                                        },
                                        expected_revision: None,
                                    },
                                )?;
                                Ok(rule)
                            })
                        })
                    })
                })
                .await?;
            runtime::adopt_state(app, &result, &adopted.expect("admitted live mount"));
            runtime::changed(app);
            Ok(serde_json::to_value(result)?)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
