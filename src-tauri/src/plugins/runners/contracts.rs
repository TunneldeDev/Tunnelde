//! Preserve the existing listing shape independently of persisted ownership.
use serde::Serialize;

use super::{Deployment, Record};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot<'a> {
    runner_id: &'a str,
    deployment: &'a Deployment,
    stop_pending: bool,
}

impl<'a> From<&'a Record> for Snapshot<'a> {
    fn from(record: &'a Record) -> Self {
        Self {
            runner_id: &record.runner_id,
            deployment: &record.deployment,
            stop_pending: record.stop_pending,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_runtime_ownership_never_leaks_into_the_existing_listing_contract() {
        let record: Record = serde_json::from_value(serde_json::json!({
            "runnerId":"task", "stopPending":true,
            "runtimeOwner": { "bootId":"internal-process", "generation":37 },
            "deployment": { "hostId":"host", "directory":"/tmp/plugin", "platform":"linux",
                "executable":"runtime", "runner":"runner", "entry":"main" },
        }))
        .unwrap();
        let snapshot = serde_json::to_value(Snapshot::from(&record)).unwrap();
        let mut expected = serde_json::to_value(&record).unwrap();
        expected.as_object_mut().unwrap().remove("runtimeOwner");
        expected.as_object_mut().unwrap().remove("revision");
        expected.as_object_mut().unwrap().remove("launchState");
        assert_eq!(snapshot, expected);
        assert!(snapshot.get("runtimeOwner").is_none());
    }
}
