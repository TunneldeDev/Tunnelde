use super::{contracts::Receipt, *};
use crate::plugins::runners::{
    model::{LaunchState, TerminalState},
    Record,
};
use serde_json::{json, Value};

fn record() -> Record {
    let mut record: Record = serde_json::from_value(json!({
        "runnerId":"task", "stopPending":true,"launchState":"unconfirmed",
        "deployment":{"hostId":"host","directory":"/runner","platform":"posix",
            "executable":"python","runner":"/runner/helper","entry":"entry"}
    }))
    .unwrap();
    record.admission = Some(Permit::new());
    record
}
fn value(record: &Record) -> Value {
    json!({"schemaVersion":1,"runnerId":record.runner_id,"token":record.admission.as_ref().unwrap().token().unwrap(),"admission":"cancelled","status":"notFound"})
}
fn receipt(record: &Record, value: Value) -> crate::error::AppResult<Receipt> {
    Receipt::parse(&serde_json::to_vec(&value).unwrap(), record)
}

#[test]
fn only_cancelled_task_bound_proof_settles_missing_unconfirmed_launch() {
    let mut record = record();
    let original = record.clone();
    record.settle("notFound").unwrap();
    assert!(record.same_revision(&original));
    for state in ["reserved", "launched"] {
        let mut value = value(&record);
        value["admission"] = json!(state);
        receipt(&record, value)
            .unwrap()
            .settle(&mut record)
            .unwrap();
        assert!(record.same_revision(&original));
    }
    let proof = receipt(&record, value(&record)).unwrap();
    proof.settle(&mut record).unwrap();
    assert!(!record.stop_pending);
    assert!(record.launch_state == LaunchState::Unconfirmed);
    assert!(record.terminal_status == Some(TerminalState::NotFound));
    let settled = record.clone();
    proof.settle(&mut record).unwrap();
    assert!(record.same_revision(&settled));
    let mut legacy = original;
    legacy.admission = None;
    legacy.settle("notFound").unwrap();
    assert!(legacy.stop_pending);
    legacy.launch_state = LaunchState::Confirmed;
    legacy.settle("notFound").unwrap();
    assert!(!legacy.stop_pending);
}

#[test]
fn cancellation_is_not_process_exit_or_historical_write_settlement() {
    let mut record = record();
    record.configuration_state =
        Some(crate::plugins::runners::operations::configuration::journal::State::Writing);
    let mut current = value(&record);
    current["status"] = json!("running");
    receipt(&record, current)
        .unwrap()
        .settle(&mut record)
        .unwrap();
    assert!(record.stop_pending);
    assert!(record.terminal_status.is_none());
    receipt(&record, value(&record))
        .unwrap()
        .settle(&mut record)
        .unwrap();
    assert!(record.configuration_uncertain());
}

#[test]
fn strict_receipts_reject_wrong_identity_schema_state_fields_and_duplicates() {
    let record = record();
    for (field, content) in [
        ("schemaVersion", json!(2)),
        ("runnerId", json!("other")),
        ("token", json!(uuid::Uuid::new_v4().to_string())),
        ("admission", json!("unknown")),
        ("status", json!("unknown")),
        ("unexpected", json!(true)),
    ] {
        let mut value = value(&record);
        value[field] = content;
        assert!(receipt(&record, value).is_err());
    }
    let mut impossible = value(&record);
    impossible["admission"] = json!("reserved");
    impossible["status"] = json!("running");
    assert!(receipt(&record, impossible).is_err());
    let text = serde_json::to_string(&value(&record)).unwrap();
    let duplicated = text.replacen("{", "{\"schemaVersion\":1,", 1);
    assert!(Receipt::parse(duplicated.as_bytes(), &record).is_err());
    assert!(Receipt::parse(&vec![b' '; 4097], &record).is_err());
    let mut wrong = record.clone();
    wrong.admission = Some(Permit::new());
    let proof = receipt(&record, value(&record)).unwrap();
    assert!(proof.settle(&mut wrong).is_err());
    assert!(wrong.stop_pending);
}

#[test]
fn admission_is_persisted_for_recovery_and_never_exported_in_sdk_snapshots() {
    let record = record();
    let persisted = serde_json::to_value(&record).unwrap();
    let restored: Record = serde_json::from_value(persisted).unwrap();
    assert!(restored.same_revision(&record));
    let public =
        serde_json::to_value(crate::plugins::runners::contracts::Snapshot::from(&record)).unwrap();
    assert!(public.get("admission").is_none());
    assert!(!serde_json::to_string(&public)
        .unwrap()
        .contains(record.admission.as_ref().unwrap().token().unwrap()));
    let mut changed = record.clone();
    changed.admission = Some(Permit::new());
    assert!(!record.same_revision(&changed));
}

#[test]
fn capability_requires_initialized_protocol_and_exact_feature_not_release_number() {
    for (protocols, features, expected) in [
        (
            vec![1],
            vec!["runner.initialize-config.v1", "runner.admission-fence.v1"],
            true,
        ),
        (vec![1], vec!["runner.initialize-config.v1"], false),
        (vec![1], vec!["runner.admission-fence.v1"], false),
        (
            vec![2],
            vec!["runner.initialize-config.v1", "runner.admission-fence.v1"],
            false,
        ),
        (
            vec![1],
            vec!["runner.initialize-config.v1", "runner.admission-fence.v2"],
            false,
        ),
    ] {
        let result = crate::plugins::runners::capabilities::contracts::Result::Available {
            envelope: crate::plugins::runners::capabilities::contracts::Envelope {
                schema_version: 1,
                helper: "tunnelde-agent".into(),
                helper_version: "999.0.0".into(),
                runner_protocols: protocols,
                features: features.into_iter().map(String::from).collect(),
            },
        };
        assert_eq!(supported(&result), expected);
    }
}

#[test]
#[ignore = "requires an explicitly built fenced helper; never selects a runtime"]
fn selected_helper_admission_protocol_matches_host_contract() {
    let helper =
        std::env::var_os("TUNNELDE_TEST_RUNNER_HELPER").expect("Select test helper explicitly");
    let root =
        std::env::temp_dir().join(format!("tunnelde-host-admission-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(root.clone());
    let mut record = record();
    record.deployment.directory = root.to_string_lossy().into_owned();
    let invoke = |operation: &str| {
        let output = std::process::Command::new(&helper)
            .args([
                operation,
                "--directory",
                &record.deployment.directory,
                "--id",
                &record.runner_id,
                "--admission",
                record.admission.as_ref().unwrap().token().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(output.stdout.len() + output.stderr.len() <= 4096);
        Receipt::parse(&output.stdout, &record).unwrap()
    };
    assert!(invoke("reserve-fenced").reserved());
    assert!(!invoke("stop-fenced").reserved());
    assert!(!invoke("reserve-fenced").reserved());
    let proof = invoke("status-fenced");
    proof.settle(&mut record).unwrap();
    assert!(!record.stop_pending);
    assert!(record.terminal_status == Some(TerminalState::NotFound));
    assert!(!root.join("task").exists());
}
