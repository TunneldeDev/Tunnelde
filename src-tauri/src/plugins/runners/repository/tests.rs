use super::*;
use crate::plugins::runners::model::LaunchState;

struct Scratch(std::path::PathBuf);
impl Scratch {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("tunnelde-runner-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self) -> std::path::PathBuf {
        self.0.join("plugin.json")
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn record() -> Record {
    serde_json::from_value(serde_json::json!({
        "runnerId":"task", "stopPending":false,
        "deployment":{"hostId":"host","directory":"/runner","platform":"posix",
            "executable":"python","runner":"/runner/helper","entry":"entry"}
    }))
    .unwrap()
}

#[test]
fn legacy_records_have_stable_revisions_and_acknowledged_launches() {
    let first = record();
    let second = record();
    assert!(first.same_revision(&second));
    assert_eq!(first.revision, 0);
    assert!(first.launch_state == LaunchState::Confirmed);
    let scratch = Scratch::new();
    save(&scratch.file(), &[first]).unwrap();
    assert!(load(&scratch.file()).unwrap()[0].same_revision(&second));
}

#[test]
fn delayed_start_and_status_cannot_erase_a_newer_stop_or_replacement() {
    let scratch = Scratch::new();
    let observed = record();
    save(&scratch.file(), std::slice::from_ref(&observed)).unwrap();
    let mut current = load(&scratch.file()).unwrap();
    current[0].stop_pending = true;
    current[0].advance().unwrap();
    save(&scratch.file(), &current).unwrap();
    assert!(!update_observed(&mut current, &observed, |record| {
        record.stop_pending = false;
        record.advance()
    })
    .unwrap());
    assert!(current[0].stop_pending);
    assert!(!load(&scratch.file()).unwrap()[0].same_revision(&observed));
    let mut replacement = observed.clone();
    replacement.deployment.fingerprint = "replacement".into();
    assert!(!replacement.same_revision(&observed));
    replacement = observed.clone();
    replacement.deployment.directory = "/other".into();
    assert!(!replacement.same_revision(&observed));
    assert!(load(&scratch.file()).unwrap()[0].stop_pending);
}

#[test]
fn uncertain_launch_not_found_and_unresponsive_never_claim_exit() {
    let mut task = record();
    task.stop_pending = true;
    task.launch_state = LaunchState::Unconfirmed;
    task.settle("notFound").unwrap();
    assert!(task.stop_pending);
    assert!(task.launch_state == LaunchState::Unconfirmed);
    task.settle("unresponsive").unwrap();
    assert!(task.stop_pending);
    task.settle("running").unwrap();
    assert!(task.stop_pending);
    assert!(task.launch_state == LaunchState::Confirmed);
    task.settle("stopped").unwrap();
    assert!(!task.stop_pending);
}

#[test]
fn reserved_launch_can_settle_without_starting_and_unknown_status_does_not_settle() {
    let mut task = record();
    task.stop_pending = true;
    task.launch_state = LaunchState::Reserved;
    task.settle("stopping").unwrap();
    assert!(task.stop_pending);
    task.settle("notFound").unwrap();
    assert!(!task.stop_pending);
    task.stop_pending = true;
    task.settle("failed").unwrap();
    assert!(!task.stop_pending);
}

#[test]
fn bounded_reads_and_writes_preserve_the_previous_file() {
    let scratch = Scratch::new();
    let path = scratch.file();
    assert!(load(&path).unwrap().is_empty());
    save(&path, &[record()]).unwrap();
    let original = std::fs::read(&path).unwrap();
    let mut oversized = record();
    oversized.deployment.directory = "x".repeat(MAX_BYTES);
    assert!(save(&path, &[oversized]).is_err());
    assert!(save(&path, &vec![record(); MAX_RECORDS + 1]).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), original);
    std::fs::write(&path, vec![b' '; MAX_BYTES + 1]).unwrap();
    assert!(load(&path)
        .err()
        .unwrap()
        .to_string()
        .contains("metadataTooLarge"));
    std::fs::write(&path, b"not json").unwrap();
    assert!(load(&path).is_err());
}

#[test]
fn failed_replacement_removes_the_temporary_file() {
    let scratch = Scratch::new();
    let path = scratch.file();
    std::fs::create_dir(&path).unwrap();
    assert!(save(&path, &[record()]).is_err());
    assert_eq!(std::fs::read_dir(&scratch.0).unwrap().count(), 1);
}

#[test]
fn revision_never_wraps_back_to_an_older_snapshot() {
    let mut task = record();
    task.revision = u64::MAX;
    assert!(task.advance().is_err());
    assert_eq!(task.revision, u64::MAX);
}

#[test]
fn repeated_live_polling_does_not_advance_the_revision_or_change_metadata() {
    let mut task = record();
    let before = serde_json::to_vec(&task).unwrap();
    for _ in 0..100 {
        task.settle("running").unwrap();
    }
    assert_eq!(serde_json::to_vec(&task).unwrap(), before);
}

#[test]
fn duplicate_task_and_deployment_identities_are_preserved_and_rejected() {
    let scratch = Scratch::new();
    let task = record();
    std::fs::write(
        scratch.file(),
        serde_json::to_vec(&vec![task.clone(), task.clone()]).unwrap(),
    )
    .unwrap();
    assert!(load(&scratch.file()).is_err());
    let before = std::fs::read(scratch.file()).unwrap();
    assert!(save(&scratch.file(), &[task.clone(), task]).is_err());
    assert_eq!(before, std::fs::read(scratch.file()).unwrap());
    let mut first = record();
    first.runner_id = "deployment".into();
    let mut second = first.clone();
    second.deployment.fingerprint = "different".into();
    assert!(validate_keys(&[first.clone(), second.clone()]).is_err());
    second.deployment.directory = "/other".into();
    validate_keys(&[first, second]).unwrap();
}

#[test]
fn incomplete_deployment_survives_reload_and_stale_completion_cannot_replace_its_journal() {
    use crate::plugins::runners::deployment::journal::State;
    let scratch = Scratch::new();
    let mut pending = record();
    pending.runner_id = "deployment".into();
    pending.deployment_state = Some(State::Creating);
    save(&scratch.file(), std::slice::from_ref(&pending)).unwrap();
    let mut records = load(&scratch.file()).unwrap();
    assert!(!records[0].deployment_ready());
    assert_eq!(records[0].deployment_state, Some(State::Creating));
    records[0].deployment_state = Some(State::Uploading);
    records[0].advance().unwrap();
    assert!(!update_observed(&mut records, &pending, |record| {
        record.deployment_state = Some(State::Ready);
        record.advance()
    })
    .unwrap());
    assert!(!records[0].deployment_ready());
    save(&scratch.file(), &records).unwrap();
    assert_eq!(
        load(&scratch.file()).unwrap()[0].deployment_state,
        Some(State::Uploading)
    );
}

#[test]
fn configuration_journal_survives_restart_and_newer_stop_wins_over_a_late_close() {
    use crate::plugins::runners::operations::configuration::journal::State;
    let scratch = Scratch::new();
    let mut observed = record();
    observed.configuration_state = Some(State::Writing);
    observed.launch_state = LaunchState::Reserved;
    observed.stop_pending = true;
    save(&scratch.file(), std::slice::from_ref(&observed)).unwrap();
    let mut records = load(&scratch.file()).unwrap();
    assert_eq!(records[0].configuration_state, Some(State::Writing));
    records[0].advance().unwrap();
    assert!(!update_observed(&mut records, &observed, |record| {
        record.configuration_state = Some(State::Ready);
        record.advance()
    })
    .unwrap());
    assert!(records[0].configuration_uncertain());
    records[0].settle("notFound").unwrap();
    save(&scratch.file(), &records).unwrap();
    assert!(load(&scratch.file()).unwrap()[0].configuration_uncertain());
    assert!(record().configuration_state.is_none());
}
