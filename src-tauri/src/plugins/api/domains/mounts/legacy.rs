//! Explicit adoption never takes ownership of a terminal's SSH connection.
use super::{lease, HostContext};
use crate::{
    error::{AppError, AppResult},
    platform::panel_windows::plugin_views::origin::{self, Origin},
    plugins::{
        api::{field, optional},
        InvocationFence,
    },
    services::{
        mounts::{
            legacy::Conversion,
            runtime::{self, Authority},
        },
        operations::{Budget, Cancellation, Errors},
    },
    state::AppState,
};
use serde_json::{json, Value};
use std::{
    sync::LazyLock,
    time::{Duration, Instant},
};
use tauri::Manager;

struct Access {
    context: HostContext,
    origin: Option<Origin>,
    invocation: Option<InvocationFence>,
}
impl Access {
    fn capture(context: &HostContext) -> Self {
        Self {
            context: context.clone(),
            origin: origin::current(),
            invocation: crate::plugins::current_invocation_fence(),
        }
    }
    /// Retry only an unentered SQLite attempt. Never block on the DB mutex
    /// while holding a native, admission, policy or invocation lock.
    fn database<T>(
        &self,
        cancel: &Cancellation,
        write: bool,
        mut effect: impl FnMut(&rusqlite::Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let state = self.context.app.state::<AppState>();
        loop {
            cancel.check()?;
            let mut run = || {
                let attempt = || {
                    let mut database = || {
                        state.db.try_with(|conn| {
                            cancel.check()?;
                            effect(conn)
                        })
                    };
                    match &self.invocation {
                        Some(fence) => fence.with_live(database),
                        None => database(),
                    }
                };
                if write {
                    Authority(Some(lease(&self.context))).commit(&self.context.app, attempt)
                } else {
                    state.plugins.security.with_authorized(
                        &lease(&self.context),
                        &["mounts.read"],
                        attempt,
                    )
                }
            };
            let result = match &self.origin {
                Some(origin) => origin.with_current(run),
                None => run(),
            }?;
            if let Some(result) = result {
                return Ok(result);
            }
            if Instant::now() >= deadline {
                return Err(AppError::validation("mounts.operations.busy"));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
static WORKERS: LazyLock<Budget> = LazyLock::new(|| {
    Budget::new(
        4,
        Errors {
            domain: "mounts.legacy",
            busy: "mounts.operations.busy",
            cancelled: "mounts.operations.cancelled",
            failed: "mounts.operations.failed",
        },
    )
});

pub(super) async fn call(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let app = &context.app;
    let state = app.state::<AppState>();
    let access = Access::capture(context);
    match method {
        "legacy.list" => {
            let host: Option<String> = optional(&params, "hostId")?;
            let offset: usize = optional(&params, "offset")?.unwrap_or(0);
            let sessions = state.ssh.list();
            let mounts = state.mounts.list(None).await;
            WORKERS.blocking(move |cancel| {
                access.database(cancel, false, |conn| {
                    let mut stmt = conn.prepare("SELECT id FROM mount_legacy_dismissed")?;
                    let dismissed = stmt.query_map([], |row| row.get::<_, String>(0))?
                        .collect::<Result<std::collections::HashSet<_>, _>>()?;
                    let entries: Vec<_> = mounts.iter()
                        .filter(|m| m.owner != runtime::OWNER && !dismissed.contains(&m.id))
                        .filter_map(|m| sessions.iter().find(|s| s.id == m.session_id).map(|s| (m, &s.host_id)))
                        .filter(|(_, id)| host.as_ref().is_none_or(|h| h == *id))
                        .map(|(mount, host)| json!({"mount":mount,"hostId":host})).collect();
                    Ok(json!({"total":entries.len(),"items":entries.into_iter().skip(offset).take(32).collect::<Vec<_>>()}))
                })
            }).await
        }
        "legacy.dismiss" => {
            let id: String = field(&params, "id")?;
            if id.is_empty() || id.len() > 128 {
                return Err(AppError::validation("mounts.rules.invalid"));
            }
            WORKERS.blocking(move |cancel| {
                access.database(cancel, true, |conn| crate::db::atomic(conn, |conn| {
                    cancel.commit()?;
                    conn.execute("INSERT OR REPLACE INTO mount_legacy_dismissed(id,created_at) VALUES(?1,?2)", rusqlite::params![id,crate::models::now_ms()])?;
                    conn.execute("DELETE FROM mount_legacy_dismissed WHERE id NOT IN (SELECT id FROM mount_legacy_dismissed ORDER BY created_at DESC,id LIMIT 512)", [])?;
                    Ok(())
                }))?;
                runtime::changed(&access.context.app);
                Ok(Value::Null)
            }).await
        }
        "legacy.convert" => {
            let id: String = field(&params, "id")?;
            let conversion = Conversion {
                rule: field(&params, "ruleId")?,
                group: field(&params, "groupId")?,
                expected: field(&params, "expectedGroupRevision")?,
                name: field(&params, "name")?,
            };
            let gate = state.mount_runtime.gate(&conversion.group)?;
            let publish_app = app.clone();
            let result = state
                .mounts
                .adopt_managed(
                    id,
                    gate,
                    move |mount, cancel| {
                        access.database(cancel, true, |conn| {
                            let state = access.context.app.state::<AppState>();
                            state.mount_runtime.inactive(&conversion.rule)?;
                            let identity = state.ssh.identity(&mount.session_id)?;
                            conversion.save(conn, mount, &identity.host_id, cancel)
                        })
                    },
                    move |rule, mount| {
                        publish_app
                            .state::<AppState>()
                            .mount_runtime
                            .adopt_state(rule, mount);
                        runtime::changed(&publish_app);
                    },
                )
                .await?;
            Ok(serde_json::to_value(result)?)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
