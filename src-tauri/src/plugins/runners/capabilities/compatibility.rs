//! Opt-in compatibility tests execute only the helper explicitly supplied by CI/QA.
use super::{classify, contracts, transport};
use std::process::Command;

fn selected_helper() -> transport::Output {
    let helper = std::env::var_os("TUNNELDE_TEST_RUNNER_HELPER")
        .expect("Select a fixture binary with TUNNELDE_TEST_RUNNER_HELPER");
    let output = Command::new(helper)
        .arg("--capabilities")
        .output()
        .expect("Execute the explicitly selected test helper");
    assert!(output.stdout.len() + output.stderr.len() <= 4096);
    transport::Output {
        stdout: output.stdout,
        stderr: output.stderr,
        code: output.status.code().map(|code| code as u32),
    }
}

#[test]
#[ignore = "requires an explicitly built current helper; never discovers or downloads a runtime"]
fn current_selected_helper_discovery_matches_host_contract() {
    let contracts::Result::Available { envelope } = classify(Ok(selected_helper())) else {
        panic!("Current helper did not satisfy the host discovery contract");
    };
    assert_eq!(envelope.schema_version, 1);
    assert_eq!(envelope.helper, "tunnelde-agent");
    assert!(envelope.runner_protocols.contains(&1));
    assert!(envelope
        .features
        .iter()
        .any(|feature| feature == "runner.control.v1"));
}

#[test]
#[ignore = "requires an explicitly built historical helper; never infers support from a version"]
fn historical_selected_helper_discovery_remains_unavailable() {
    let value = serde_json::to_value(classify(Ok(selected_helper()))).unwrap();
    assert_eq!(
        value,
        serde_json::json!({"status":"unavailable", "reason":"nonzeroExit", "exitCode":1})
    );
}

#[test]
#[ignore = "requires an explicitly built initialized helper; never infers support from a version"]
fn initialized_selected_helper_declares_supported_configuration() {
    assert!(super::super::bootstrap::supports(&classify(Ok(
        selected_helper()
    ))));
}
