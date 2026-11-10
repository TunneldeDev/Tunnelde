use super::super::{flush_selected, load, save, HostContext, Record, MUTATIONS};

fn selected(record: &Record, boundary: u64) -> bool {
    record.runner_id != "deployment"
        && record
            .runtime_owner
            .as_ref()
            .is_none_or(|owner| owner.retired_before(boundary))
}

/// Record cancellation while holding the same metadata mutex as launch. Tasks
/// created by a replacement generation remain untouched even if this waits.
pub(in crate::plugins) async fn revoke_before(context: &HostContext, boundary: u64) {
    if !crate::plugins::manifest::valid_id(&context.id) {
        return;
    }
    let _mutation = MUTATIONS.lock().await;
    let mut records = match load(context) {
        Ok(records) => records,
        Err(error) => {
            tracing::warn!(plugin_id = %context.id, %error, "could not read runner records for revocation");
            return;
        }
    };
    if !records.iter().any(|record| selected(record, boundary)) {
        return;
    }
    for record in records
        .iter_mut()
        .filter(|record| selected(record, boundary))
    {
        record.stop_pending = true;
    }
    if let Err(error) = save(context, &records) {
        tracing::warn!(plugin_id = %context.id, %error, "could not persist runner stop requests");
        return;
    }
    flush_selected(context, &mut records, |record| selected(record, boundary)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::runners::lifecycle::Owner;

    fn record(id: &str, owner: Option<Owner>) -> Record {
        serde_json::from_value(serde_json::json!({
            "runnerId": id, "runtimeOwner": owner, "stopPending": false,
            "deployment": { "hostId": "host", "directory": "/tmp/plugin", "platform": "linux",
                "executable": "runtime", "runner": "runner", "entry": "main" },
        }))
        .unwrap()
    }

    #[test]
    fn legacy_metadata_can_be_stopped_without_selecting_deployments_or_replacements() {
        assert!(selected(&record("old", None), 10));
        assert!(selected(&record("old", Some(Owner::current(9))), 10));
        assert!(!selected(
            &record("replacement", Some(Owner::current(10))),
            10
        ));
        assert!(!selected(&record("deployment", None), 10));
        let legacy: Record = serde_json::from_value(serde_json::json!({
            "runnerId":"legacy", "stopPending":true,
            "deployment": { "hostId":"host", "directory":"/tmp/plugin", "platform":"linux",
                "executable":"runtime", "runner":"runner", "entry":"main" },
        }))
        .unwrap();
        assert!(selected(&legacy, 10));
        assert!(legacy.runtime_owner.is_none());
    }
}
