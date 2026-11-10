use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn host(db: &Database) -> String {
    db.with(|conn| {
        let input: crate::models::HostInput = serde_json::from_value(serde_json::json!({
            "name":"Forwarding test", "host":"example.test", "username":"qa"
        }))
        .unwrap();
        crate::db::hosts::create_host(conn, &input.validate().unwrap())
    })
    .unwrap()
    .id
}
fn rule(host_id: String) -> ForwardRule {
    ForwardRule {
        id: String::new(),
        host_id,
        name: "Database".into(),
        mode: "local".into(),
        bind_host: "127.0.0.1".into(),
        bind_port: 15432,
        target_host: "::1".into(),
        target_port: 5432,
    }
}

#[test]
fn committed_mutations_keep_the_old_wire_shape_and_skip_absent_removals() {
    let db = Database::in_memory().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let record = count.clone();
    let registry = ForwardRegistry::with_notifier(move || {
        record.fetch_add(1, Ordering::SeqCst);
    });
    let service = Forwarding {
        db: &db,
        registry: &registry,
    };
    let saved = service.save(rule(host(&db))).unwrap();
    assert!(!saved.id.is_empty());
    let mut wire = serde_json::to_value(&saved).unwrap();
    wire["active"] = false.into();
    wire["sessionId"] = serde_json::Value::Null;
    assert_eq!(
        serde_json::to_value(service.list().unwrap()).unwrap(),
        serde_json::json!([wire])
    );
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let mut edited = saved.clone();
    edited.name = "Renamed".into();
    service.save(edited).unwrap();
    assert_eq!(service.list().unwrap()[0].rule.name, "Renamed");
    assert_eq!(count.load(Ordering::SeqCst), 2);
    service.remove(&saved.id).unwrap();
    service.remove(&saved.id).unwrap();
    assert!(service.list().unwrap().is_empty());
    assert_eq!(count.load(Ordering::SeqCst), 3);
}

#[test]
fn failed_validation_and_database_writes_do_not_announce_success() {
    let db = Database::in_memory().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let record = count.clone();
    let registry = ForwardRegistry::with_notifier(move || {
        record.fetch_add(1, Ordering::SeqCst);
    });
    let service = Forwarding {
        db: &db,
        registry: &registry,
    };
    let saved = service.save(rule(host(&db))).unwrap();
    assert!(service.save(rule("missing".into())).is_err());
    let mut invalid = saved.clone();
    invalid.bind_port = 0;
    assert!(service.save(invalid).is_err());
    db.with(|conn| { conn.execute_batch("CREATE TRIGGER refuse_forward_delete BEFORE DELETE ON settings BEGIN SELECT RAISE(ABORT, 'test failure'); END; CREATE TRIGGER refuse_forward_update BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'test failure'); END;")?; Ok(()) }).unwrap();
    let mut updated = saved.clone();
    updated.name = "Must not commit".into();
    assert!(service.save(updated).is_err());
    assert!(service.remove(&saved.id).is_err());
    assert_eq!(service.list().unwrap()[0].rule, saved);
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[test]
fn rule_input_still_rejects_unknown_runtime_status_fields() {
    let mut wire = serde_json::to_value(rule("host".into())).unwrap();
    wire["active"] = true.into();
    assert!(serde_json::from_value::<ForwardRule>(wire).is_err());
}
