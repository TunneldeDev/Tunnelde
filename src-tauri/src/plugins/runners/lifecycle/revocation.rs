use super::super::{repository, HostContext, Record};

fn selected(record: &Record, boundary: u64) -> bool {
    record.runner_id != "deployment"
        && record.terminal_status.is_none()
        && record
            .runtime_owner
            .as_ref()
            .is_none_or(|owner| owner.retired_before(boundary))
}

/// Commit cancellation without waiting for any SSH operation. A delayed cleanup
/// must not select a replacement generation.
pub(in crate::plugins) async fn revoke_before(context: &HostContext, boundary: u64) {
    if !crate::plugins::manifest::valid_id(&context.id) {
        return;
    }
    if let Err(error) = repository::transaction(context, |records| {
        for record in records
            .iter_mut()
            .filter(|record| selected(record, boundary))
        {
            record.stop_pending = true;
            record.advance()?;
        }
        Ok(())
    }) {
        tracing::warn!(plugin_id = %context.id, %error, "could not persist runner stop requests");
        return;
    }
    super::request_recovery(&context.app);
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
        let mut completed = record("completed", None);
        completed.settle("stopped").unwrap();
        assert!(!selected(&completed, 10));
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
