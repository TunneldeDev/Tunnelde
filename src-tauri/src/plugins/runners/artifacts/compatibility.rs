//! Explicit binary only; no runtime discovery/download and no native confirmation.
use super::{
    super::{capabilities, transport},
    observation,
    tests::record,
};
use std::{path::PathBuf, process::Command};

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn command() -> Command {
    let mut command = Command::new(
        std::env::var_os("TUNNELDE_TEST_RUNNER_HELPER").expect("Select helper explicitly"),
    );
    command.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}
fn run(args: &[&str]) -> std::result::Result<transport::Output, transport::Failure> {
    let output = command().args(args).output().unwrap();
    assert!(output.stdout.len() + output.stderr.len() <= 16384);
    Ok(transport::Output {
        stdout: output.stdout,
        stderr: output.stderr,
        code: output.status.code().map(|value| value as u32),
    })
}

#[test]
#[ignore = "requires explicitly built artifact-observation helper; never selects a runtime"]
fn selected_helper_artifact_protocol_matches_host_contract() {
    assert!(observation::supports(&capabilities::classify(run(&[
        "--capabilities"
    ]))));
    let path =
        std::env::temp_dir().join(format!("tunnelde-host-artifacts-{}", uuid::Uuid::new_v4()));
    let builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    builder.create(&path).unwrap();
    let _fixture = Fixture(path.clone());
    let mut record = record();
    record.deployment.directory = path.to_string_lossy().into_owned();
    let original = record.clone();
    let nonce = uuid::Uuid::new_v4().to_string();
    let args = [
        "inspect-artifacts",
        "--directory",
        &record.deployment.directory,
        "--id",
        &record.runner_id,
        "--admission",
        record.admission.as_ref().unwrap().token().unwrap(),
        "--observation",
        &nonce,
    ];
    let observe =
        || serde_json::to_value(observation::classify(run(&args), &record, &nonce)).unwrap();
    assert_eq!(observe()["snapshot"]["reason"], "admissionUnavailable");
    assert_eq!(std::fs::read_dir(&path).unwrap().count(), 0);
    let mut reserve = vec!["reserve-fenced"];
    reserve.extend_from_slice(&args[1..7]);
    assert!(matches!(run(&reserve), Ok(output) if output.code == Some(0)));
    let journal = path.join(".admission-v1/task.jsonl");
    let before = std::fs::read(&journal).unwrap();
    assert_eq!(observe()["snapshot"]["status"], "missing");
    let task = path.join("task");
    builder.create(&task).unwrap();
    std::fs::write(task.join("storage.json"), "private-secret").unwrap();
    std::fs::write(task.join("private-secret-name"), "private-secret").unwrap();
    let result = observe();
    assert_eq!(result["status"], "observed");
    assert_eq!(result["cleanupAuthorized"], false);
    assert_eq!(result["snapshot"]["otherEntries"], 1);
    assert_eq!(result["snapshot"]["entries"][0]["sizeBytes"], "14");
    assert!(!result.to_string().contains("private-secret"));
    assert!(!result.to_string().contains(args[6]));
    assert_eq!(before, std::fs::read(&journal).unwrap());
    assert!(record.same_revision(&original));
    std::fs::write(&journal, "partial-private-journal").unwrap();
    assert_eq!(observe()["snapshot"]["reason"], "admissionUnavailable");
    assert_eq!(
        std::fs::read_to_string(&journal).unwrap(),
        "partial-private-journal"
    );
}

#[test]
#[ignore = "requires explicitly built historical initialized helper; never uses a version as authority"]
fn historical_selected_helper_does_not_support_artifact_observation() {
    assert!(!observation::supports(&capabilities::classify(run(&[
        "--capabilities"
    ]))));
}
