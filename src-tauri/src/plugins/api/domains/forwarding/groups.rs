use super::*;
use crate::plugins::api::optional;
use crate::services::forwarding::{self, groups};
pub(super) fn dispatch(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let state = context.app.state::<AppState>();
    let lease = Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    };
    if method == "forwards.groups.list" {
        return state
            .plugins
            .security
            .with_authorized(&lease, &["forwards.read"], || {
                crate::platform::panel_windows::plugin_views::origin::check(
                    crate::plugins::frontend::native::CallPolicy::StagedData,
                )?;
                let value = state.db.with(|conn| {
                    encode(groups::list(
                        conn,
                        optional::<String>(&params, "hostId")?.as_deref(),
                    )?)
                })?;
                crate::platform::panel_windows::plugin_views::origin::check(
                    crate::plugins::frontend::native::CallPolicy::StagedData,
                )?;
                Ok(value)
            });
    }
    let origin = crate::platform::panel_windows::plugin_views::origin::current();
    let mutation = || {
        state
            .plugins
            .security
            .with_authorized(&lease, &["forwards.write"], || {
                let result = match method {
                    "forwards.groups.save" => {
                        let id = optional::<String>(&params, "id")?;
                        let host_id = field::<String>(&params, "hostId")?;
                        let name = field::<String>(&params, "name")?;
                        let expected = optional::<String>(&params, "expectedRevision")?;
                        state.db.with(|conn| {
                            crate::db::atomic(conn, |conn| {
                                encode(groups::save_at(
                                    conn,
                                    id.as_deref(),
                                    &host_id,
                                    &name,
                                    expected.as_deref(),
                                )?)
                            })
                        })
                    }
                    "forwards.groups.remove" => {
                        let id = field::<String>(&params, "id")?;
                        let expected = field::<String>(&params, "expectedRevision")?;
                        groups::remove(&state.db, &state.forwards, &id, &expected)
                            .map(|_| Value::Null)
                    }
                    "forwards.move" => {
                        let id = field::<String>(&params, "id")?;
                        let expected = field::<String>(&params, "expectedRevision")?;
                        let group_id = optional::<String>(&params, "groupId")?;
                        encode(groups::move_rule(
                            &state.db,
                            &state.forwards,
                            &id,
                            &expected,
                            group_id.as_deref(),
                        )?)
                    }
                    _ => Err(AppError::validation("plugin.api.unknownMethod")),
                };
                if result.is_ok() {
                    forwarding::automation::changed(&context.app);
                }
                result
            })
    };
    match origin {
        Some(origin) => origin.with_current(mutation),
        None => mutation(),
    }
}
