use super::*;

fn open(security: &Arc<PluginSecurity>, lease: &Lease, token: &str) {
    let pending = security.begin_runtime(lease, &[], true).unwrap();
    security.native_ready(lease).unwrap();
    security.frontend_opened(lease, token).unwrap();
    security.frontend_ready(lease, token).unwrap();
    pending.commit();
}

#[test]
fn replacement_frontend_requires_new_ack_and_never_revives_previous_consumers() {
    let (security, db) = fixture();
    let dependency = grant(&security, &db, "dependency", &["ui.trusted"]);
    open(&security, &dependency, "first");
    let owner = grant(&security, &db, "owner", &[]);
    ready(&security, &owner, std::slice::from_ref(&dependency));
    security.frontend_opened(&dependency, "second").unwrap();
    assert!(!allowed(&security, &owner));
    assert!(security.frontend_ready(&dependency, "first").is_err());
    let fresh_owner = security
        .lease(&owner.id, owner.fingerprint.clone(), vec![])
        .unwrap();
    assert!(security
        .begin_runtime(&fresh_owner, std::slice::from_ref(&dependency), false)
        .is_err());
    security.frontend_ready(&dependency, "second").unwrap();
    assert!(!allowed(&security, &owner));
    ready(&security, &fresh_owner, &[dependency]);
}

#[test]
fn closing_frontend_retires_consumers_but_stale_close_cannot_retire_new_module() {
    let (security, db) = fixture();
    let dependency = grant(&security, &db, "dependency", &["ui.trusted"]);
    open(&security, &dependency, "first");
    security.frontend_opened(&dependency, "second").unwrap();
    security.frontend_ready(&dependency, "second").unwrap();
    let owner = grant(&security, &db, "owner", &[]);
    ready(&security, &owner, std::slice::from_ref(&dependency));
    security.frontend_closed(&dependency, "first");
    assert!(allowed(&security, &owner));
    security.frontend_closed(&dependency, "second");
    assert!(!allowed(&security, &owner));
    assert!(allowed(&security, &dependency));
    assert!(security.frontend_ready(&dependency, "second").is_err());
    security.frontend_opened(&dependency, "third").unwrap();
    security.frontend_ready(&dependency, "third").unwrap();
    assert!(!allowed(&security, &owner));
}

#[test]
fn native_only_runtime_cannot_be_promoted_by_frontend_commands() {
    let (security, db) = fixture();
    let owner = grant(&security, &db, "owner", &[]);
    ready(&security, &owner, &[]);
    assert!(security.frontend_opened(&owner, "unexpected").is_err());
    assert!(security.frontend_ready(&owner, "unexpected").is_err());
    security.frontend_closed(&owner, "unexpected");
    assert!(allowed(&security, &owner));
}
