use super::{classify, contracts::*, decode, transport};
use serde_json::{json, Value};

fn envelope() -> Value {
    json!({"schemaVersion":1,"helper":"tunnelde-agent","helperVersion":"0.26.1",
        "runnerProtocols":[1],"features":["runner.control.v1"]})
}

#[test]
fn accepts_current_and_bounded_future_metadata_without_granting_future_features() {
    let mut value = envelope();
    value["futureField"] = json!({"optional":true});
    value["features"] = json!(["runner.control.v1", "runner.future.v2"]);
    let parsed = decode::decode(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(parsed.helper_version, "0.26.1");
    assert_eq!(parsed.runner_protocols, vec![1]);
    assert_eq!(
        parsed.features,
        vec!["runner.control.v1", "runner.future.v2"]
    );
}

#[test]
fn rejects_oversize_invalid_duplicate_and_inconsistent_metadata() {
    assert_eq!(
        decode::decode(&vec![b' '; 4097]).unwrap_err(),
        Reason::OutputTooLarge
    );
    for bytes in [b"0.26.1".as_slice(), b"{}", b"{}{}", b"\xff", br#"{"schemaVersion":1,"schemaVersion":1,"helper":"tunnelde-agent","helperVersion":"1","runnerProtocols":[1],"features":[]}"#] {
        assert_eq!(decode::decode(bytes).unwrap_err(), Reason::InvalidResponse);
    }
    for (key, value) in [
        ("helper", json!("another-helper")),
        ("helperVersion", json!("")),
        ("helperVersion", json!("x".repeat(65))),
        ("helperVersion", json!("line\nbreak")),
        ("runnerProtocols", json!([0])),
        ("runnerProtocols", json!([2])),
        ("runnerProtocols", json!([1, 1])),
        ("runnerProtocols", json!([1.5])),
        ("runnerProtocols", json!([4294967296_u64])),
        (
            "features",
            json!(["runner.control.v1", "runner.control.v1"]),
        ),
        ("features", json!(["x".repeat(65)])),
        ("features", json!(["invalid feature"])),
        ("features", json!(vec!["x"; 33])),
    ] {
        let mut changed = envelope();
        changed[key] = value;
        assert_eq!(
            decode::decode(&serde_json::to_vec(&changed).unwrap()).unwrap_err(),
            Reason::InvalidResponse,
            "{key}"
        );
    }
    let mut changed = envelope();
    changed["runnerProtocols"] = json!((1..=33).collect::<Vec<_>>());
    assert_eq!(
        decode::decode(&serde_json::to_vec(&changed).unwrap()).unwrap_err(),
        Reason::InvalidResponse
    );
}

#[test]
fn schema_support_is_independent_of_release_version() {
    let mut value = envelope();
    value["schemaVersion"] = json!(2);
    assert_eq!(
        decode::decode(&serde_json::to_vec(&value).unwrap()).unwrap_err(),
        Reason::UnsupportedSchema
    );
    value["schemaVersion"] = json!(1);
    value["helperVersion"] = json!("0.0.1");
    assert!(decode::decode(&serde_json::to_vec(&value).unwrap()).is_ok());
}

#[test]
fn legacy_nonzero_exit_is_not_inferred_as_version_or_supported_protocol() {
    let result = classify(Ok(transport::Output {
        code: Some(1),
        stdout: serde_json::to_vec(&envelope()).unwrap(),
        stderr: b"Expected --mcp-stdio, --version; private diagnostic".to_vec(),
    }));
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(
        value,
        json!({"status":"unavailable","reason":"nonzeroExit","exitCode":1})
    );
    assert!(!value.to_string().contains("private"));
    assert!(!value.to_string().contains("helperVersion"));
}

#[test]
fn preserves_failure_categories_without_exposing_remote_output() {
    for (input, reason) in [
        (Err(transport::Failure::Timeout), "timeout"),
        (Err(transport::Failure::OutputTooLarge), "outputTooLarge"),
        (
            Err(transport::Failure::Connection(
                crate::error::AppError::validation("secret"),
            )),
            "transport",
        ),
        (
            Ok(transport::Output {
                code: None,
                stdout: vec![],
                stderr: vec![],
            }),
            "missingExitStatus",
        ),
        (
            Ok(transport::Output {
                code: Some(0),
                stdout: b"private invalid response".to_vec(),
                stderr: vec![],
            }),
            "invalidResponse",
        ),
    ] {
        assert_eq!(
            serde_json::to_value(classify(input)).unwrap(),
            json!({"status":"unavailable","reason":reason})
        );
    }
}
