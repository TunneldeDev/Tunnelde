use super::*;

#[test]
fn invalid_plugin_ids_never_become_cleanup_owners() {
    let (security, _) = fixture();
    for id in ["", "../outside", "a/b", "a\\b", "C:\\outside", "."] {
        assert!(security.retire_runtime(id).is_empty(), "{id}");
    }
}

#[test]
fn reverse_closure_retires_only_consumers_and_never_shared_prerequisites() {
    let (security, db) = fixture();
    let shared = grant(&security, &db, "shared", &[]);
    ready(&security, &shared, &[]);
    let left = grant(&security, &db, "left", &[]);
    ready(&security, &left, std::slice::from_ref(&shared));
    let right = grant(&security, &db, "right", &[]);
    ready(&security, &right, std::slice::from_ref(&shared));
    let root = grant(&security, &db, "root", &[]);
    ready(&security, &root, &[left.clone(), right.clone()]);
    security.invalidate_runtime(&left.id);
    assert!(!allowed(&security, &left));
    assert!(!allowed(&security, &root));
    assert!(allowed(&security, &shared));
    assert!(allowed(&security, &right));
    security.invalidate_runtime(&shared.id);
    assert!(!allowed(&security, &right));
    assert!(security.policy().runtimes.0.is_empty());
}

#[test]
fn replacing_or_removing_approval_does_not_revive_consumers_of_old_identity() {
    for remove in [false, true] {
        let (security, db) = fixture();
        let dependency = grant(&security, &db, "dependency", &[]);
        ready(&security, &dependency, &[]);
        let owner = grant(&security, &db, "owner", &[]);
        ready(&security, &owner, std::slice::from_ref(&dependency));
        security
            .set_permissions(
                &db,
                &dependency.id,
                "b".repeat(64),
                &[],
                if remove { None } else { Some(vec![]) },
            )
            .unwrap();
        assert!(!allowed(&security, &owner));
        let replacement = grant(&security, &db, "dependency", &[]);
        ready(&security, &replacement, &[]);
        assert!(!allowed(&security, &owner));
        assert!(allowed(&security, &replacement));
    }
}

#[test]
fn restricted_mode_clears_relations_and_old_generations_cannot_return() {
    let (security, db) = fixture();
    let owner = grant(&security, &db, "owner", &[]);
    ready(&security, &owner, &[]);
    security.set_restricted(&db, true, false).unwrap();
    assert!(security.policy().runtimes.0.is_empty());
    security.set_restricted(&db, false, false).unwrap();
    assert!(!allowed(&security, &owner));
    let fresh = security
        .lease(&owner.id, owner.fingerprint, vec![])
        .unwrap();
    ready(&security, &fresh, &[]);
}

#[test]
fn captured_retirement_boundaries_do_not_expand_after_replacement() {
    let (security, db) = fixture();
    let old = grant(&security, &db, "old", &[]);
    ready(&security, &old, &[]);
    let consumer = grant(&security, &db, "consumer", &[]);
    ready(&security, &consumer, std::slice::from_ref(&old));
    let retired = security.retire_lease(&old);
    assert_eq!(
        retired
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["consumer", "old"]
    );
    let replacement = security
        .lease(&old.id, old.fingerprint.clone(), vec![])
        .unwrap();
    ready(&security, &replacement, &[]);
    assert!(retired
        .iter()
        .all(|item| old.generation < item.before_generation));
    assert!(retired
        .iter()
        .all(|item| replacement.generation >= item.before_generation));
    assert!(security.retire_lease(&old).is_empty());
    assert!(allowed(&security, &replacement));
}

#[test]
fn rollback_captures_consumers_and_invokes_cleanup_after_releasing_policy_lock() {
    let (security, db) = fixture();
    let dependency = grant(&security, &db, "dependency", &[]);
    let (sent, received) = std::sync::mpsc::channel();
    let pending = security
        .begin_runtime(&dependency, &[], false)
        .unwrap()
        .on_rollback({
            let security = security.clone();
            let dependency = dependency.clone();
            move |retired| {
                sent.send((allowed(&security, &dependency), retired))
                    .unwrap();
            }
        });
    security.native_ready(&dependency).unwrap();
    let consumer = grant(&security, &db, "consumer", &[]);
    ready(&security, &consumer, std::slice::from_ref(&dependency));
    let worker = std::thread::spawn(move || drop(pending));
    let (authorized, retired) = received
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    assert!(!authorized);
    assert_eq!(
        retired
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["consumer", "dependency"]
    );
    worker.join().unwrap();
}

#[test]
fn failed_revocation_persistence_still_runs_cleanup_but_failed_approval_does_not() {
    for revoke in [false, true] {
        let (security, db) = fixture();
        let dependency = grant(&security, &db, "dependency", &[]);
        ready(&security, &dependency, &[]);
        let consumer = grant(&security, &db, "consumer", &[]);
        ready(&security, &consumer, std::slice::from_ref(&dependency));
        db.with(|conn| {
            conn.pragma_update(None, "query_only", true)?;
            Ok(())
        })
        .unwrap();
        let mut captured = None;
        assert!(security
            .set_permissions_with_cleanup(
                &db,
                &dependency.id,
                dependency.fingerprint.clone(),
                &[],
                if revoke { None } else { Some(vec![]) },
                |retired| {
                    captured = Some(retired);
                }
            )
            .is_err());
        assert_eq!(captured.is_some(), revoke);
        assert_eq!(allowed(&security, &consumer), !revoke);
        if let Some(retired) = captured {
            assert_eq!(retired.len(), 2);
        }
    }
}
