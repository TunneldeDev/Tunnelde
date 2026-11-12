use super::super::{
    contracts::{authority::Platform, receipt::Publication},
    testing::*,
};
use super::*;
use serde_json::{json, Value};

#[test]
fn decoder_binds_every_authority_field_and_operation_before_acceptance() {
    let authority = authority();
    let saved = prepared(&authority);
    let value = response(&authority, Some(&saved.control), "succeeded", 7);
    let parsed = operation(
        output(value.clone()),
        &authority,
        &saved.control,
        Platform::Posix,
    )
    .unwrap()
    .unwrap();
    assert_eq!(parsed.publication, Publication::Published);
    for path in [
        "/authority/authorityId",
        "/authority/context/hostKey",
        "/authority/context/account",
        "/authority/context/scope",
        "/authority/root/object",
        "/authority/storageRoot/object",
        "/observation/operationId",
        "/observation/generation",
        "/observation/intentSha256",
    ] {
        let mut changed = value.clone();
        *changed.pointer_mut(path).unwrap() = json!("changed");
        assert!(
            operation(output(changed), &authority, &saved.control, Platform::Posix).is_err(),
            "{path}"
        );
    }
    let other = prepared(&authority);
    assert!(operation(output(value), &authority, &other.control, Platform::Posix).is_err());
}
#[test]
fn rejects_unbounded_failed_missing_or_non_protocol_output_without_echoing_it() {
    let authority = authority();
    let value = response(&authority, None, "", 0);
    for code in [None, Some(1), Some(127)] {
        let mut packet = output(value.clone());
        packet.code = code;
        let failure = initialize(packet, &authority.context, Platform::Posix)
            .err()
            .unwrap();
        assert!(failure.dispatched);
        assert!(matches!(
            failure.reason,
            Reason::MissingExitStatus | Reason::RemoteRejected
        ));
    }
    let mut packet = output(value.clone());
    packet.stderr = vec![b'x'; MAX_OUTPUT];
    assert_eq!(
        initialize(packet, &authority.context, Platform::Posix)
            .err()
            .unwrap()
            .reason,
        Reason::OutputTooLarge
    );
    for bytes in [
        b"".as_slice(),
        b"{}",
        b"null",
        b"[]",
        b"{}{}",
        b"{bad}",
        b"\xff",
    ] {
        let packet = Output {
            stdout: bytes.into(),
            stderr: Vec::new(),
            code: Some(0),
        };
        assert_eq!(
            initialize(packet, &authority.context, Platform::Posix)
                .err()
                .unwrap()
                .reason,
            Reason::InvalidResponse
        );
    }
}
#[test]
fn rejects_cleanup_authority_version_extensions_and_contradictory_receipts() {
    let authority = authority();
    let saved = prepared(&authority);
    let value = response(&authority, Some(&saved.control), "succeeded", 2);
    for (path, next) in [
        ("/cleanupAuthorized", json!(true)),
        ("/schemaVersion", json!(2)),
        ("/protocol", json!("files.admission-ledger.v1")),
        ("/bindingSha256", json!("0".repeat(64))),
        ("/observation/revision", json!(0)),
        ("/observation/phase", json!("newUnknownState")),
        ("/observation/publication", json!("none")),
        ("/observation/cancellable", json!(true)),
        ("/observation/error", json!("private payload")),
    ] {
        let mut changed = value.clone();
        *changed.pointer_mut(path).unwrap() = next;
        assert!(
            operation(output(changed), &authority, &saved.control, Platform::Posix).is_err(),
            "{path}"
        );
    }
    let mut changed = value.clone();
    changed["unreviewed"] = json!(1);
    assert!(operation(output(changed), &authority, &saved.control, Platform::Posix).is_err());
    let mut changed = value;
    changed["observation"]["phase"] = json!("unknown");
    changed["observation"]["publication"] = json!("unknown");
    assert!(operation(
        output(changed.clone()),
        &authority,
        &saved.control,
        Platform::Posix
    )
    .is_err());
    changed["observation"]["backupRetained"] = Value::Null;
    changed["observation"]["live"] = Value::Null;
    let receipt = operation(output(changed), &authority, &saved.control, Platform::Posix)
        .unwrap()
        .unwrap();
    assert_eq!(receipt.live, None);
    assert_eq!(receipt.backup_retained, None);
    assert!(!receipt.releasable());
}
#[test]
fn initial_and_missing_receipts_are_distinct_from_settled_outcomes() {
    let authority = authority();
    let saved = prepared(&authority);
    let packet = response(&authority, None, "", 0);
    assert!(initialize(output(packet.clone()), &authority.context, Platform::Posix).is_ok());
    assert!(
        operation(output(packet), &authority, &saved.control, Platform::Posix)
            .unwrap()
            .is_none()
    );
    assert!(initialize(
        output(response(&authority, Some(&saved.control), "prepared", 1)),
        &authority.context,
        Platform::Posix
    )
    .is_err());
}

#[test]
fn nullable_fields_are_required_and_absence_never_becomes_false() {
    let authority = authority();
    let saved = prepared(&authority);
    for field in ["live", "backupRetained", "error"] {
        let mut value = response(&authority, Some(&saved.control), "succeeded", 2);
        value["observation"].as_object_mut().unwrap().remove(field);
        assert!(
            operation(output(value), &authority, &saved.control, Platform::Posix).is_err(),
            "{field}"
        );
    }
    let mut value = response(&authority, None, "", 0);
    value.as_object_mut().unwrap().remove("observation");
    assert!(initialize(output(value), &authority.context, Platform::Posix).is_err());
}
