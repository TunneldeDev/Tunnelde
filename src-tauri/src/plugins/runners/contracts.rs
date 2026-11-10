//! Preserve the existing listing shape independently of persisted ownership.
use serde::Serialize;

use super::{Deployment, Record};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot<'a> {
    runner_id: &'a str,
    deployment: PublicDeployment<'a>,
    stop_pending: bool,
}

impl<'a> From<&'a Record> for Snapshot<'a> {
    fn from(record: &'a Record) -> Self {
        Self {
            runner_id: &record.runner_id,
            deployment: PublicDeployment::from(&record.deployment),
            stop_pending: record.stop_pending,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicDeployment<'a> {
    host_id: &'a str,
    directory: &'a str,
    platform: &'a str,
    executable: &'a str,
    runner: &'a str,
    entry: &'a str,
    fingerprint: &'a str,
}

impl<'a> From<&'a Deployment> for PublicDeployment<'a> {
    fn from(value: &'a Deployment) -> Self {
        Self {
            host_id: &value.host_id,
            directory: &value.directory,
            platform: &value.platform,
            executable: &value.executable,
            runner: &value.runner,
            entry: &value.entry,
            fingerprint: &value.fingerprint,
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
            "controllerFingerprint":"private-controller", "terminalStatus":"failed",
            "deployment": { "hostId":"host", "directory":"/tmp/plugin", "platform":"linux",
                "executable":"runtime", "runner":"runner", "entry":"main",
                "identity":{"hostId":"host","address":"private-address","serverKey":"private-key"} },
        }))
        .unwrap();
        let snapshot = serde_json::to_value(Snapshot::from(&record)).unwrap();
        let mut expected = serde_json::to_value(&record).unwrap();
        expected.as_object_mut().unwrap().remove("runtimeOwner");
        expected.as_object_mut().unwrap().remove("revision");
        expected.as_object_mut().unwrap().remove("launchState");
        expected
            .as_object_mut()
            .unwrap()
            .remove("controllerFingerprint");
        expected.as_object_mut().unwrap().remove("terminalStatus");
        expected["deployment"]
            .as_object_mut()
            .unwrap()
            .remove("identity");
        assert_eq!(snapshot, expected);
        assert!(snapshot.get("runtimeOwner").is_none());
    }
}
