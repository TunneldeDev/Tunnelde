use super::*;

fn record() -> Record {
    serde_json::from_value(serde_json::json!({"runnerId":"task","stopPending":false,
        "deployment":{"hostId":"host","directory":"/runner","platform":"posix",
            "executable":"node","runner":"/runner/helper","entry":"entry","fingerprint":"old"}}))
    .unwrap()
}

fn destination() -> SessionIdentity {
    SessionIdentity {
        host_id: "host".into(),
        address: "user@server:22".into(),
        server_key: "SHA256:original".into(),
    }
}

#[test]
fn legacy_identity_requires_review_and_every_captured_identity_field_is_checked() {
    let mut task = record();
    let original = destination();
    assert!(verify(&task.deployment, &original).is_err());
    task.deployment.identity = Some(original.clone());
    verify(&task.deployment, &original).unwrap();
    for field in ["host", "address", "key"] {
        let mut changed = original.clone();
        match field {
            "host" => changed.host_id = "other".into(),
            "address" => changed.address = "user@other:22".into(),
            _ => changed.server_key = "SHA256:other".into(),
        }
        assert_eq!(
            verify(&task.deployment, &changed).unwrap_err().to_string(),
            "plugin.runners.destinationChanged"
        );
    }
}

#[test]
fn explicit_controller_is_independent_of_original_package_and_invalidates_stale_records() {
    let original = record();
    assert!(controller(&original, "old").is_ok());
    assert!(controller(&original, "new").is_err());
    assert!(controller(&original, "").is_err());
    let mut changed = original.clone();
    changed.controller_fingerprint = Some("new".into());
    assert!(controller(&changed, "new").is_ok());
    assert!(controller(&changed, "old").is_err());
    assert_eq!(changed.deployment.fingerprint, "old");
    assert!(!changed.same_revision(&original));
    changed = original.clone();
    changed.deployment.identity = Some(destination());
    assert!(!changed.same_revision(&original));
}

#[test]
fn connection_selection_never_retargets_a_known_identity_or_guesses_ambiguous_legacy_records() {
    let mut task = record();
    let first = destination();
    let mut other = first.clone();
    other.server_key = "SHA256:other".into();
    let same = vec![("one".into(), first.clone()), ("two".into(), first.clone())];
    assert!(select(&task, &same, false).is_err());
    assert_eq!(select(&task, &same, true).unwrap(), "one");
    let ambiguous = vec![
        ("one".into(), first.clone()),
        ("other".into(), other.clone()),
    ];
    assert_eq!(
        select(&task, &ambiguous, true).unwrap_err().to_string(),
        "plugin.runners.destinationAmbiguous"
    );
    task.deployment.identity = Some(first.clone());
    assert_eq!(select(&task, &ambiguous, false).unwrap(), "one");
    assert_eq!(
        select(&task, &[("other".into(), other)], true)
            .unwrap_err()
            .to_string(),
        "plugin.runners.destinationChanged"
    );
    let mut unrelated = first;
    unrelated.host_id = "elsewhere".into();
    assert_eq!(
        select(&task, &[("unrelated".into(), unrelated)], true)
            .unwrap_err()
            .to_string(),
        "ssh.sessionMissing"
    );
    assert!(select(&task, &[], true).is_err());
}
