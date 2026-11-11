use super::{
    super::{capabilities, transport, Record},
    contracts::*,
    observation, receipt,
};
use crate::error::AppError;
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

pub(super) fn record() -> Record {
    let mut record: Record = serde_json::from_value(json!({"runnerId":"task","stopPending":true,
        "launchState":"unconfirmed", "configurationTransport":"initialize-v1",
        "deployment":{"hostId":"host","directory":"/runner","platform":"posix","executable":"node","runner":"helper","entry":"main"}})).unwrap();
    record.admission = Some(super::super::admission::Permit::new());
    record
}

pub(super) fn value(record: &Record, nonce: &str) -> Value {
    json!({"schemaVersion":1,"runnerId":record.runner_id,"token":record.admission.as_ref().unwrap().token().unwrap(),
        "observationId":nonce,"admission":"cancelled","consistency":"pointInTime","cleanupAuthorized":false,
        "snapshot":{"status":"missing"}})
}

fn supported() -> capabilities::contracts::Result {
    capabilities::contracts::Result::Available {
        envelope: capabilities::contracts::Envelope {
            schema_version: 1,
            helper: "tunnelde-agent".into(),
            helper_version: "0.0.1".into(),
            runner_protocols: vec![1],
            features: vec![
                "runner.initialize-config.v1".into(),
                "runner.admission-fence.v1".into(),
                "runner.artifact-observation.v1".into(),
            ],
        },
    }
}

fn output(value: Value) -> std::result::Result<transport::Output, transport::Failure> {
    Ok(transport::Output {
        stdout: serde_json::to_vec(&value).unwrap(),
        stderr: Vec::new(),
        code: Some(0),
    })
}

#[test]
fn strict_receipts_bind_task_permit_nonce_and_never_grant_cleanup() {
    let record = record();
    let nonce = uuid::Uuid::new_v4().to_string();
    let original = value(&record, &nonce);
    assert!(receipt::decode(&serde_json::to_vec(&original).unwrap(), &record, &nonce).is_some());
    for (key, replacement) in [
        ("schemaVersion", json!(2)),
        ("runnerId", json!("other")),
        ("token", json!(uuid::Uuid::new_v4().to_string())),
        ("observationId", json!(uuid::Uuid::new_v4().to_string())),
        ("admission", json!("unknown")),
        ("admission", Value::Null),
        ("consistency", json!("atomic")),
        ("cleanupAuthorized", json!(true)),
        ("extra", json!("private-config")),
    ] {
        let mut wrong = original.clone();
        wrong[key] = replacement;
        assert!(
            receipt::decode(&serde_json::to_vec(&wrong).unwrap(), &record, &nonce).is_none(),
            "{key}"
        );
    }
    let text = serde_json::to_string(&original).unwrap();
    assert!(receipt::decode(
        text.replacen('{', "{\"schemaVersion\":1,", 1).as_bytes(),
        &record,
        &nonce
    )
    .is_none());
    assert!(receipt::decode(&vec![b' '; receipt::MAX_OUTPUT + 1], &record, &nonce).is_none());
    let mut missing = original.clone();
    missing.as_object_mut().unwrap().remove("admission");
    assert!(receipt::decode(&serde_json::to_vec(&missing).unwrap(), &record, &nonce).is_none());
}

#[test]
fn metadata_rejects_arbitrary_names_counts_precision_loss_duplicates_and_nonfile_sizes() {
    let record = record();
    let nonce = uuid::Uuid::new_v4().to_string();
    let mut original = value(&record, &nonce);
    let entry = json!({"name":"storage.json","kind":"file","sizeBytes":"18446744073709551615"});
    original["snapshot"] = json!({"status":"present","entries":[entry],"otherEntries":255});
    assert!(receipt::decode(&serde_json::to_vec(&original).unwrap(), &record, &nonce).is_some());
    let mut missing = original.clone();
    missing["snapshot"]["entries"][0]
        .as_object_mut()
        .unwrap()
        .remove("sizeBytes");
    assert!(receipt::decode(&serde_json::to_vec(&missing).unwrap(), &record, &nonce).is_none());
    for replacement in [
        json!({"name":"private-config.json","kind":"file","sizeBytes":"1"}),
        json!({"name":"pid","kind":"file","sizeBytes":1}),
        json!({"name":"pid","kind":"file","sizeBytes":"01"}),
        json!({"name":"pid","kind":"file","sizeBytes":"18446744073709551616"}),
        json!({"name":"pid","kind":"file","sizeBytes":null}),
        json!({"name":"inbox","kind":"link","sizeBytes":"1"}),
        json!({"name":"pid","kind":"file","sizeBytes":"1","contents":"private-secret"}),
    ] {
        let mut wrong = original.clone();
        wrong["snapshot"]["entries"] = json!([replacement]);
        assert!(receipt::decode(&serde_json::to_vec(&wrong).unwrap(), &record, &nonce).is_none());
    }
    for snapshot in [
        json!({"status":"present","entries":[entry.clone(),entry],"otherEntries":0}),
        json!({"status":"present","entries":[],"otherEntries":257}),
        json!({"status":"missing","extra":true}),
        json!({"status":"unavailable","reason":"private-error"}),
    ] {
        let mut wrong = original.clone();
        wrong["snapshot"] = snapshot;
        assert!(receipt::decode(&serde_json::to_vec(&wrong).unwrap(), &record, &nonce).is_none());
    }
}

#[test]
fn transport_failures_are_bounded_redacted_and_not_process_observations() {
    let record = record();
    let nonce = uuid::Uuid::new_v4().to_string();
    let cases = [
        Err(transport::Failure::Connection(AppError::validation(
            "private-secret",
        ))),
        Err(transport::Failure::Timeout),
        Err(transport::Failure::OutputTooLarge),
        Ok(transport::Output {
            stdout: b"private-secret".to_vec(),
            stderr: b"private-secret".to_vec(),
            code: Some(17),
        }),
        Ok(transport::Output {
            stdout: vec![],
            stderr: b"private-secret".to_vec(),
            code: None,
        }),
        output(json!({"private":"secret"})),
    ];
    for (case, reason) in cases.into_iter().zip([
        "transport",
        "timeout",
        "outputTooLarge",
        "nonzeroExit",
        "missingExitStatus",
        "invalidResponse",
    ]) {
        let projected = serde_json::to_value(observation::classify(case, &record, &nonce)).unwrap();
        assert_eq!(projected["reason"], reason);
        assert!(!projected.to_string().contains("private-secret"));
    }
}

#[test]
fn capability_uses_exact_features_and_protocol_instead_of_binary_version() {
    assert!(observation::supports(&supported()));
    for feature in [
        "runner.initialize-config.v1",
        "runner.admission-fence.v1",
        "runner.artifact-observation.v1",
    ] {
        let capabilities::contracts::Result::Available { mut envelope } = supported() else {
            unreachable!()
        };
        envelope.features.retain(|value| value != feature);
        envelope.helper_version = "999.0.0".into();
        assert!(!observation::supports(
            &capabilities::contracts::Result::Available { envelope }
        ));
    }
    let capabilities::contracts::Result::Available { mut envelope } = supported() else {
        unreachable!()
    };
    envelope.runner_protocols = vec![2];
    assert!(!observation::supports(
        &capabilities::contracts::Result::Available { envelope }
    ));
}

#[tokio::test]
async fn historical_sftp_records_never_probe_and_unknown_effects_are_unchanged() {
    let mut record = record();
    record.configuration_state =
        Some(super::super::operations::configuration::journal::State::Writing);
    let original = record.clone();
    let requested = Cell::new(false);
    let result = observation::observe(
        &record,
        || Ok(()),
        async { panic!("Legacy task must not probe") },
        |_| async {
            requested.set(true);
            panic!("No task request")
        },
    )
    .await
    .unwrap();
    assert!(matches!(
        result,
        Result::Unsupported {
            reason: UnsupportedReason::LegacyTask
        }
    ));
    assert!(!requested.get());
    assert!(record.same_revision(&original));
    assert!(record.configuration_uncertain());
    let mut legacy = record.clone();
    legacy.configuration_state = None;
    legacy.admission = None;
    assert!(!observation::eligible(&legacy));
    legacy.admission = record.admission.clone();
    legacy.configuration_transport = None;
    assert!(!observation::eligible(&legacy));
}

#[tokio::test]
async fn checkpoints_discard_every_stale_success_and_failure_before_another_request() {
    for changed_at in 1..=3 {
        for failed in [false, true] {
            let record = record();
            let checkpoints = Cell::new(0);
            let requested = Cell::new(false);
            let check = || {
                let count = checkpoints.get() + 1;
                checkpoints.set(count);
                if count == changed_at {
                    Err(AppError::validation("plugin.runners.recordChanged"))
                } else {
                    Ok(())
                }
            };
            let response = observation::observe(&record, check, async { supported() }, |nonce| {
                requested.set(true);
                let packet = value(&record, &nonce);
                async move {
                    if failed {
                        Err(transport::Failure::Timeout)
                    } else {
                        output(packet)
                    }
                }
            })
            .await;
            assert!(response.is_err());
            assert_eq!(checkpoints.get(), changed_at);
            assert_eq!(requested.get(), changed_at == 3);
        }
    }
    let record = record();
    let checkpoints = Cell::new(0);
    let failed = capabilities::contracts::Result::Unavailable {
        reason: capabilities::contracts::Reason::Transport,
        exit_code: None,
    };
    let result = observation::observe(
        &record,
        || {
            checkpoints.set(checkpoints.get() + 1);
            if checkpoints.get() == 2 {
                Err(AppError::validation("plugin.runners.destinationChanged"))
            } else {
                Ok(())
            }
        },
        async { failed },
        |_| async { panic!("No request after failed discovery") },
    )
    .await;
    assert!(result.is_err());
    assert_eq!(checkpoints.get(), 2);
}

#[tokio::test]
async fn observation_projects_without_mutating_task_and_cancellation_prevents_second_read() {
    let record = record();
    let original = record.clone();
    let checks = Cell::new(0);
    let result = observation::observe(
        &record,
        || {
            checks.set(checks.get() + 1);
            Ok(())
        },
        async { supported() },
        |nonce| {
            let packet = value(&record, &nonce);
            async move { output(packet) }
        },
    )
    .await
    .unwrap();
    let public = serde_json::to_value(result).unwrap();
    assert_eq!(public["cleanupAuthorized"], false);
    assert!(!public
        .to_string()
        .contains(record.admission.as_ref().unwrap().token().unwrap()));
    assert!(record.same_revision(&original));
    assert!(record.stop_pending);
    assert!(record.terminal_status.is_none());
    assert_eq!(checks.get(), 3);
    let started = Rc::new(Cell::new(false));
    let requested = Rc::new(Cell::new(false));
    let flag = started.clone();
    let request_flag = requested.clone();
    let task = observation::observe(
        &record,
        || Ok(()),
        async move {
            flag.set(true);
            std::future::pending().await
        },
        move |_| async move {
            request_flag.set(true);
            panic!("Cancelled discovery must not request")
        },
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), task)
            .await
            .is_err()
    );
    assert!(started.get());
    assert!(!requested.get());
}

#[tokio::test]
async fn separate_requests_cannot_reuse_an_observation_nonce() {
    let record = record();
    let saved = RefCell::new(None);
    let first = observation::observe(
        &record,
        || Ok(()),
        async { supported() },
        |nonce| {
            let packet = value(&record, &nonce);
            *saved.borrow_mut() = Some(packet.clone());
            async move { output(packet) }
        },
    )
    .await
    .unwrap();
    assert!(matches!(first, Result::Observed { .. }));
    let second = observation::observe(
        &record,
        || Ok(()),
        async { supported() },
        |_| async { output(saved.borrow_mut().take().unwrap()) },
    )
    .await
    .unwrap();
    assert!(matches!(
        second,
        Result::Unavailable {
            reason: capabilities::contracts::Reason::InvalidResponse,
            ..
        }
    ));
}
