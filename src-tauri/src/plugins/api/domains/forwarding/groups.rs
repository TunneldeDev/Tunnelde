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
    let permission = if method == "forwards.groups.list" {
        "forwards.read"
    } else {
        "forwards.write"
    };
    state
        .plugins
        .security
        .with_authorized(&lease, &[permission], || {
            let result = match method {
                "forwards.groups.list" => state.db.with(|conn| {
                    encode(groups::list(
                        conn,
                        optional::<String>(&params, "hostId")?.as_deref(),
                    )?)
                }),
                "forwards.groups.save" => state.db.with(|conn| {
                    crate::db::atomic(conn, |conn| {
                        encode(groups::save_at(
                            conn,
                            optional::<String>(&params, "id")?.as_deref(),
                            &field::<String>(&params, "hostId")?,
                            &field::<String>(&params, "name")?,
                            optional::<String>(&params, "expectedRevision")?.as_deref(),
                        )?)
                    })
                }),
                "forwards.groups.remove" => groups::remove(
                    &state.db,
                    &state.forwards,
                    &field::<String>(&params, "id")?,
                    &field::<String>(&params, "expectedRevision")?,
                )
                .map(|_| Value::Null),
                "forwards.move" => encode(groups::move_rule(
                    &state.db,
                    &state.forwards,
                    &field::<String>(&params, "id")?,
                    &field::<String>(&params, "expectedRevision")?,
                    optional::<String>(&params, "groupId")?.as_deref(),
                )?),
                _ => Err(AppError::validation("plugin.api.unknownMethod")),
            };
            if result.is_ok() && method != "forwards.groups.list" {
                forwarding::automation::changed(&context.app);
            }
            result
        })
}
