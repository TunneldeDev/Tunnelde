use super::*;
use crate::ssh::session::SessionIdentity;

fn record() -> Record {
    serde_json::from_value(
        serde_json::json!({"runnerId":"task","stopPending":false,"revision":3,
        "deployment":{"hostId":"host","directory":"/runner","platform":"posix",
            "executable":"node","runner":"/runner/helper","entry":"entry","fingerprint":"old"}}),
    )
    .unwrap()
}
fn destination() -> SessionIdentity {
    SessionIdentity {
        host_id: "host".into(),
        address: "user@host:22".into(),
        server_key: "SHA256:key".into(),
    }
}

#[test]
fn destination_review_is_one_time_keeps_stop_intent_and_never_hands_over_control() {
    let mut task = record();
    task.stop_pending = true;
    transition::apply(&mut task, Kind::Destination, destination(), "new", 9).unwrap();
    assert_eq!(task.revision, 4);
    assert!(task.stop_pending);
    assert_eq!(task.controller(), "old");
    assert!(task.runtime_owner.is_none());
    assert!(transition::apply(&mut task, Kind::Destination, destination(), "new", 9).is_err());
    let mut other = destination();
    other.address = "user@other:22".into();
    assert!(transition::apply(&mut task, Kind::Destination, other, "new", 9).is_err());
}

#[test]
fn control_review_keeps_original_package_and_requires_bound_target_and_no_stop_intent() {
    let mut task = record();
    assert!(transition::apply(&mut task, Kind::Control, destination(), "new", 9).is_err());
    transition::apply(&mut task, Kind::Destination, destination(), "new", 9).unwrap();
    task.stop_pending = true;
    assert!(transition::apply(&mut task, Kind::Control, destination(), "new", 9).is_err());
    task.stop_pending = false;
    transition::apply(&mut task, Kind::Control, destination(), "new", 9).unwrap();
    assert_eq!(task.controller(), "new");
    assert_eq!(task.deployment.fingerprint, "old");
    assert!(task.runtime_owner.is_some());
    assert!(transition::apply(&mut task, Kind::Control, destination(), "new", 10).is_err());
    task.runner_id = "deployment".into();
    assert!(transition::apply(&mut task, Kind::Control, destination(), "other", 10).is_err());
}

#[test]
fn legacy_review_cannot_bind_an_unrelated_host() {
    let mut task = record();
    let mut actual = destination();
    actual.host_id = "other".into();
    assert!(transition::apply(&mut task, Kind::Destination, actual, "new", 9).is_err());
    assert_eq!(task.revision, 3);
    assert!(task.deployment.identity.is_none());
}
