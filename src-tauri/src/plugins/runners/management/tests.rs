use super::query;
use crate::plugins::runners::Record;

fn record() -> Record {
    serde_json::from_value(serde_json::json!({"runnerId":"task","stopPending":false,
    "deployment":{"hostId":"host","directory":"/runner","platform":"posix","executable":"node","runner":"helper","entry":"main"}})).unwrap()
}

#[test]
fn action_tokens_bind_all_private_metadata_and_never_reveal_it() {
    let original = record();
    let first = query::token(&original).unwrap();
    assert_eq!(first.len(), 64);
    assert!(first.bytes().all(|value| value.is_ascii_hexdigit()));
    for change in 0..5 {
        let mut changed = original.clone();
        match change {
            0 => changed.stop_pending = true,
            1 => changed.revision = 1,
            2 => changed.deployment.runner = "other".into(),
            3 => changed.controller_fingerprint = Some("next".into()),
            _ => changed.settle("stopped").unwrap(),
        }
        assert_ne!(first, query::token(&changed).unwrap());
    }
}

#[test]
fn recovery_paths_do_not_invent_unprepared_configs_or_accept_a_path_as_task_id() {
    let mut task = record();
    let project = |record: &Record| super::projection::entry(record, &[], None, false).unwrap();
    assert!(project(&task).configuration_path.is_none());
    assert!(!project(&task).can_browse);
    task.configuration_state =
        Some(crate::plugins::runners::operations::configuration::journal::State::Writing);
    assert_eq!(
        project(&task).configuration_path.as_deref(),
        Some("/runner/config-task.json")
    );
    task.runner_id = "../elsewhere".into();
    assert!(project(&task).configuration_path.is_none());
}

#[test]
fn owner_discovery_includes_uninstalled_plugins_and_ignores_unrelated_files() {
    let directory =
        std::env::temp_dir().join(format!("tunnelde-recovery-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    for file in [
        "removed-plugin.json",
        "current.json",
        "bad name.json",
        "incomplete.tmp",
        "not-json",
    ] {
        std::fs::write(directory.join(file), []).unwrap();
    }
    std::fs::create_dir(directory.join("folder.json")).unwrap();
    let owners = query::owners(&directory).unwrap();
    assert_eq!(owners.ids, vec!["current", "removed-plugin"]);
    assert!(!owners.limited);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn late_confirmations_cannot_mutate_replaced_records_and_ambiguous_tokens_are_rejected() {
    use super::{contracts::Action, mutation};
    let original = record();
    let token = query::token(&original).unwrap();
    let mut newer = original.clone();
    newer.stop_pending = true;
    newer.advance().unwrap();
    let mut records = vec![newer.clone()];
    assert!(mutation::apply(&mut records, &token, Action::Stop).is_err());
    assert!(records[0] == newer);
    assert!(mutation::apply(&mut records, &token, Action::Forget).is_err());
    records = vec![original.clone(), original.clone()];
    assert!(mutation::apply(&mut records, &token, Action::Stop).is_err());
    assert_eq!(records.len(), 2);
    assert!(!records[0].stop_pending);
    records = vec![original];
    mutation::apply(&mut records, &token, Action::Stop).unwrap();
    assert!(records[0].stop_pending);
    assert_eq!(records[0].revision, 1);
    assert!(mutation::apply(&mut records, &token, Action::Forget).is_err());
}

#[test]
fn forgetting_requires_confirmed_exit_and_uncertain_launches_keep_their_stop_intent() {
    use super::{contracts::Action, mutation};
    use crate::plugins::runners::model::LaunchState;
    let mut records = vec![record()];
    for status in ["unresponsive", "stopping", "unknown"] {
        records[0].settle(status).unwrap();
        let token = query::token(&records[0]).unwrap();
        assert!(mutation::apply(&mut records, &token, Action::Forget).is_err());
    }
    records[0].launch_state = LaunchState::Unconfirmed;
    records[0].stop_pending = true;
    records[0].settle("notFound").unwrap();
    assert!(records[0].terminal_status.is_none());
    assert!(mutation::apply(
        &mut records,
        &query::token(&record()).unwrap(),
        Action::Forget
    )
    .is_err());
    records[0].settle("stopped").unwrap();
    let token = query::token(&records[0]).unwrap();
    assert!(mutation::apply(&mut records, &token, Action::Stop).is_err());
    mutation::apply(&mut records, &token, Action::Forget).unwrap();
    assert!(records.is_empty());
}

#[test]
fn capability_projection_distinguishes_original_offline_changed_and_legacy_destinations() {
    use super::projection::entry;
    use crate::ssh::session::SessionIdentity;
    let mut task = record();
    let original = SessionIdentity {
        host_id: "host".into(),
        address: "user@host:22".into(),
        server_key: "SHA256:original".into(),
    };
    let sessions = vec![("original".into(), original.clone())];
    let legacy = entry(&task, &sessions, Some("new"), true).unwrap();
    assert_eq!(legacy.connection, "legacy");
    assert!(legacy.can_review_destination);
    assert!(!legacy.can_inspect);
    assert!(!legacy.can_handoff);
    task.deployment.identity = Some(original.clone());
    let online = entry(&task, &sessions, Some("new"), true).unwrap();
    assert_eq!(online.connection, "connected");
    assert!(online.can_inspect);
    assert!(online.can_handoff);
    assert!(!online.can_forget);
    assert!(
        !entry(&task, &sessions, Some("new"), false)
            .unwrap()
            .can_handoff
    );
    assert_eq!(
        entry(&task, &[], None, false).unwrap().connection,
        "offline"
    );
    let mut changed = original;
    changed.address = "other@host:22".into();
    let sessions = vec![("changed".into(), changed)];
    let mismatch = entry(&task, &sessions, Some("new"), true).unwrap();
    assert_eq!(mismatch.connection, "changed");
    assert!(!mismatch.can_inspect);
    assert!(!mismatch.can_review_destination);
    assert!(!mismatch.can_handoff);
    task.deployment.identity = None;
    let ambiguous = vec![
        (
            "one".into(),
            SessionIdentity {
                host_id: "host".into(),
                address: "different".into(),
                server_key: "SHA256:different".into(),
            },
        ),
        sessions[0].clone(),
    ];
    let ambiguous = entry(&task, &ambiguous, None, false).unwrap();
    assert_eq!(ambiguous.connection, "ambiguous");
    assert!(!ambiguous.can_review_destination);
    task.settle("stopped").unwrap();
    let terminal = entry(&task, &[], None, false).unwrap();
    assert!(terminal.can_forget);
    assert!(!terminal.can_stop);
    assert!(!terminal.can_handoff);
    task.runner_id = "deployment".into();
    let deployment = entry(&task, &[], None, false).unwrap();
    assert!(!deployment.can_forget);
    assert!(!deployment.can_stop);
    assert!(!deployment.can_inspect);
}

#[test]
fn incomplete_deployment_is_visible_but_only_unsubmitted_reservations_can_be_forgotten() {
    use super::{contracts::Action, mutation, projection::entry};
    use crate::plugins::runners::deployment::journal::State;
    let mut pending = record();
    pending.runner_id = "deployment".into();
    for state in [
        State::Reserved,
        State::Creating,
        State::Uploading,
        State::Ready,
    ] {
        pending.deployment_state = Some(state);
        let view = entry(&pending, &[], None, false).unwrap();
        assert_eq!(view.deployment_state, Some(state.name()));
        assert_eq!(view.can_forget, state == State::Reserved);
        assert!(!view.can_inspect && !view.can_stop && !view.can_handoff);
        assert_eq!(
            mutation::validate(&pending, Action::Forget).is_ok(),
            state == State::Reserved
        );
    }
    pending.deployment_state = Some(State::Reserved);
    let old_token = query::token(&pending).unwrap();
    pending.deployment_state = Some(State::Creating);
    pending.advance().unwrap();
    let mut records = vec![pending];
    assert!(mutation::apply(&mut records, &old_token, Action::Forget).is_err());
    assert_eq!(records.len(), 1);
}

#[test]
fn terminal_task_status_does_not_prove_config_writes_have_settled() {
    use super::{contracts::Action, mutation, projection::entry};
    use crate::plugins::runners::operations::configuration::journal::State;
    let mut task = record();
    task.launch_state = crate::plugins::runners::model::LaunchState::Reserved;
    task.stop_pending = true;
    for state in [State::Creating, State::Writing] {
        task.configuration_state = Some(state);
        task.settle("notFound").unwrap();
        assert!(task.terminal_status.is_some());
        assert!(!task.stop_pending);
        let view = entry(&task, &[], None, false).unwrap();
        assert_eq!(view.configuration_state, Some(state.name()));
        assert!(!view.can_forget);
        assert!(mutation::validate(&task, Action::Forget).is_err());
    }
    for state in [Some(State::Reserved), Some(State::Ready), None] {
        task.configuration_state = state;
        assert!(entry(&task, &[], None, false).unwrap().can_forget);
        assert!(mutation::validate(&task, Action::Forget).is_ok());
    }
}
