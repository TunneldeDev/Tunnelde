use super::*;

#[test]
fn required_runtime_must_be_activated_not_merely_approved_or_native_started() {
    let (security, db) = fixture();
    let dependency = grant(&security, &db, "dependency", &["ui.trusted"]);
    let owner = grant(&security, &db, "owner", &[]);
    assert!(security
        .begin_runtime(&owner, std::slice::from_ref(&dependency), false)
        .is_err());
    let pending = security.begin_runtime(&dependency, &[], true).unwrap();
    assert!(security.frontend_ready(&dependency, "first").is_err());
    security.native_ready(&dependency).unwrap();
    assert!(security
        .begin_runtime(&owner, std::slice::from_ref(&dependency), false)
        .is_err());
    security.frontend_opened(&dependency, "first").unwrap();
    security.frontend_ready(&dependency, "first").unwrap();
    pending.commit();
    ready(&security, &owner, &[dependency]);
    assert!(allowed(&security, &owner));
}

#[test]
fn owner_can_initialize_without_inheriting_dependency_permissions() {
    let (security, db) = fixture();
    let dependency = grant(&security, &db, "dependency", &["ssh.exec"]);
    ready(&security, &dependency, &[]);
    let owner = grant(&security, &db, "owner", &["log"]);
    let pending = security
        .begin_runtime(&owner, &[dependency], false)
        .unwrap();
    assert!(allowed(&security, &owner));
    assert!(security
        .authorize(
            &owner.id,
            &owner.fingerprint,
            &owner.permissions,
            Some("ssh.exec"),
            Some(owner.generation)
        )
        .is_err());
    security.native_ready(&owner).unwrap();
    pending.commit();
}

#[test]
fn repeated_ready_start_never_owns_rollback_of_existing_runtime() {
    let (security, db) = fixture();
    let owner = grant(&security, &db, "owner", &[]);
    ready(&security, &owner, &[]);
    drop(security.begin_runtime(&owner, &[], false).unwrap());
    assert!(allowed(&security, &owner));
    assert!(security.policy().runtimes.matches(&owner));
}

#[test]
fn duplicate_pending_start_is_rejected_and_only_original_can_commit() {
    let (security, db) = fixture();
    let owner = grant(&security, &db, "owner", &[]);
    let pending = security.begin_runtime(&owner, &[], false).unwrap();
    assert!(security.begin_runtime(&owner, &[], false).is_err());
    security.native_ready(&owner).unwrap();
    pending.commit();
    assert!(allowed(&security, &owner));
}

#[test]
fn dropping_pending_start_retires_that_generation_but_not_its_prerequisites() {
    let (security, db) = fixture();
    let dependency = grant(&security, &db, "dependency", &[]);
    ready(&security, &dependency, &[]);
    let owner = grant(&security, &db, "owner", &[]);
    drop(
        security
            .begin_runtime(&owner, std::slice::from_ref(&dependency), false)
            .unwrap(),
    );
    assert!(!allowed(&security, &owner));
    assert!(allowed(&security, &dependency));
    let replacement = security
        .lease(&owner.id, owner.fingerprint.clone(), vec![])
        .unwrap();
    ready(&security, &replacement, &[dependency]);
    assert!(allowed(&security, &replacement));
}

#[test]
fn late_pending_drop_cannot_revoke_a_replacement_generation() {
    let (security, db) = fixture();
    let owner = grant(&security, &db, "owner", &[]);
    let old = security.begin_runtime(&owner, &[], false).unwrap();
    security.invalidate_runtime(&owner.id);
    let replacement = security
        .lease(&owner.id, owner.fingerprint.clone(), vec![])
        .unwrap();
    ready(&security, &replacement, &[]);
    drop(old);
    assert!(allowed(&security, &replacement));
    assert!(security.frontend_ready(&owner, "expired").is_err());
    assert!(security.native_ready(&owner).is_err());
}

#[test]
fn bindings_normalize_permissions_and_cannot_be_rebound_within_one_generation() {
    let (security, db) = fixture();
    let mut dependency = grant(&security, &db, "dependency", &["log", "hosts.read"]);
    ready(&security, &dependency, &[]);
    let owner = grant(&security, &db, "owner", &[]);
    dependency.permissions.reverse();
    ready(&security, &owner, &[dependency.clone()]);
    dependency.permissions.reverse();
    drop(
        security
            .begin_runtime(&owner, &[dependency], false)
            .unwrap(),
    );
    assert!(allowed(&security, &owner));
    assert!(security.begin_runtime(&owner, &[], false).is_err());
    assert!(security.begin_runtime(&owner, &[], true).is_err());
}

#[test]
fn self_duplicate_unbound_and_excess_dependencies_are_rejected_without_poisoning_owner() {
    let (security, db) = fixture();
    let owner = grant(&security, &db, "owner", &[]);
    assert!(security
        .begin_runtime(&owner, std::slice::from_ref(&owner), false)
        .is_err());
    let dependency = grant(&security, &db, "dependency", &[]);
    ready(&security, &dependency, &[]);
    assert!(security
        .begin_runtime(&owner, &[dependency.clone(), dependency.clone()], false)
        .is_err());
    assert!(security
        .begin_runtime(&owner, &vec![dependency; 17], false)
        .is_err());
    assert!(allowed(&security, &owner));
    ready(&security, &owner, &[]);
}
