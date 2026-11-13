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

#[test]
fn checked_edits_reject_stale_and_deleted_rules_without_publishing() {
    let db = Database::in_memory().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let changed = count.clone();
    let registry = ForwardRegistry::with_notifier(move || {
        changed.fetch_add(1, Ordering::SeqCst);
    });
    let service = Forwarding {
        db: &db,
        registry: &registry,
    };
    let first = service.save_checked(rule(host(&db)), None).unwrap();
    let mut edited = first.rule.clone();
    edited.name = "Concurrent edit".into();
    let current = service.save_checked(edited, Some(&first.revision)).unwrap();
    assert_ne!(current.revision, first.revision);
    assert_eq!(
        service
            .save_checked(first.rule.clone(), Some(&first.revision))
            .unwrap_err()
            .to_string(),
        "forward.changed"
    );
    assert_eq!(
        service
            .remove_checked(&first.rule.id, Some(&first.revision))
            .unwrap_err()
            .to_string(),
        "forward.changed"
    );
    assert_eq!(count.load(Ordering::SeqCst), 2);
    assert_eq!(service.list().unwrap()[0].rule, current.rule);
    // Returning to the original contents must not make an old approval valid again.
    let restored = service
        .save_checked(first.rule.clone(), Some(&current.revision))
        .unwrap();
    assert_ne!(restored.revision, first.revision);
    assert_eq!(
        service
            .remove_checked(&first.rule.id, Some(&first.revision))
            .unwrap_err()
            .to_string(),
        "forward.changed"
    );
    service
        .remove_checked(&restored.rule.id, Some(&restored.revision))
        .unwrap();
    assert!(service
        .save_checked(first.rule.clone(), Some(&current.revision))
        .is_err());
    let recreated = service.save_checked(first.rule, None).unwrap();
    assert_ne!(recreated.revision, current.revision);
    assert_ne!(recreated.revision, first.revision);
    assert!(service
        .remove_checked(&recreated.rule.id, Some(&current.revision))
        .is_err());
    assert_eq!(
        service.list_revisioned().unwrap()[0].revision,
        recreated.revision
    );
}

#[test]
fn legacy_rules_get_read_only_tokens_and_every_write_changes_the_version() {
    let db = Database::in_memory().unwrap();
    let registry = ForwardRegistry::default();
    let service = Forwarding {
        db: &db,
        registry: &registry,
    };
    let mut legacy = rule(host(&db));
    legacy.id = "legacy".into();
    db.with(|conn| {
        conn.execute(
            "INSERT INTO settings(key,value,updated_at) VALUES('forward:legacy',?1,1)",
            [serde_json::to_string(&legacy)?],
        )?;
        Ok(())
    })
    .unwrap();
    let read = service.list_revisioned().unwrap().remove(0);
    assert!(read.revision.starts_with("legacy:"));
    assert_eq!(
        service.list_revisioned().unwrap()[0].revision,
        read.revision
    );
    let saved = service
        .save_checked(legacy.clone(), Some(&read.revision))
        .unwrap();
    let again = service
        .save_checked(legacy.clone(), Some(&saved.revision))
        .unwrap();
    assert_ne!(read.revision, saved.revision);
    assert_ne!(saved.revision, again.revision);
    // Legacy RPC clients retain their unversioned shape and unconditional update behavior.
    assert_eq!(service.save(legacy.clone()).unwrap(), legacy);
    assert_eq!(service.list().unwrap()[0].rule, legacy);
}

#[test]
fn rule_and_version_changes_roll_back_together() {
    let db = Database::in_memory().unwrap();
    let registry = ForwardRegistry::default();
    let service = Forwarding {
        db: &db,
        registry: &registry,
    };
    let saved = service.save_checked(rule(host(&db)), None).unwrap();
    db.with(|conn| { conn.execute_batch("CREATE TRIGGER reject_version BEFORE UPDATE ON settings WHEN NEW.key LIKE 'forward-version:%' BEGIN SELECT RAISE(ABORT, 'version failure'); END;")?; Ok(()) }).unwrap();
    let mut next = saved.rule.clone();
    next.name = "Must roll back".into();
    assert!(service.save_checked(next, Some(&saved.revision)).is_err());
    let current = service.list_revisioned().unwrap().remove(0);
    assert_eq!(current.info.rule, saved.rule);
    assert_eq!(current.revision, saved.revision);
    db.with(|conn| { conn.execute_batch("CREATE TRIGGER reject_version_delete BEFORE DELETE ON settings WHEN OLD.key LIKE 'forward-version:%' BEGIN SELECT RAISE(ABORT, 'version failure'); END;")?; Ok(()) }).unwrap();
    assert!(service
        .remove_checked(&saved.rule.id, Some(&saved.revision))
        .is_err());
    assert_eq!(service.list_revisioned().unwrap()[0].info.rule, saved.rule);
}

#[test]
fn concurrent_checked_writers_have_one_winner() {
    let db = Database::in_memory().unwrap();
    let registry = ForwardRegistry::default();
    let service = Forwarding {
        db: &db,
        registry: &registry,
    };
    let saved = service.save_checked(rule(host(&db)), None).unwrap();
    let barrier = std::sync::Barrier::new(2);
    let outcomes = std::thread::scope(|scope| {
        let writers: Vec<_> = (0..2)
            .map(|i| {
                let service = &service;
                let saved = &saved;
                let barrier = &barrier;
                scope.spawn(move || {
                    let mut next = saved.rule.clone();
                    next.name = format!("writer-{i}");
                    barrier.wait();
                    service.save_checked(next, Some(&saved.revision))
                })
            })
            .collect();
        writers
            .into_iter()
            .map(|writer| writer.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(outcomes.iter().filter(|result| result.is_err()).count(), 1);
    let accepted = outcomes.into_iter().find_map(Result::ok).unwrap();
    assert_eq!(
        service.list_revisioned().unwrap()[0].revision,
        accepted.revision
    );
}

#[test]
fn caller_chosen_creation_is_atomic_and_never_overwrites_after_a_lost_reply() {
    let db = Database::in_memory().unwrap();
    let registry = ForwardRegistry::default();
    let service = Forwarding {
        db: &db,
        registry: &registry,
    };
    let mut proposed = rule(host(&db));
    proposed.id = uuid::Uuid::new_v4().to_string();
    let barrier = std::sync::Barrier::new(2);
    let outcomes = std::thread::scope(|scope| {
        let writers: Vec<_> = (0..2)
            .map(|i| {
                let service = &service;
                let barrier = &barrier;
                let mut proposed = proposed.clone();
                proposed.name = format!("creator-{i}");
                scope.spawn(move || {
                    barrier.wait();
                    service.create(proposed)
                })
            })
            .collect();
        writers
            .into_iter()
            .map(|writer| writer.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(outcomes.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(outcomes.iter().filter(|r| r.is_err()).count(), 1);
    let accepted = outcomes.into_iter().find_map(Result::ok).unwrap();
    assert_eq!(
        service.find(&proposed.id).unwrap().unwrap().revision,
        accepted.revision
    );
    assert_eq!(
        service.create(proposed).unwrap_err().to_string(),
        "forward.changed"
    );
    assert_eq!(
        service.find(&accepted.rule.id).unwrap().unwrap().info.rule,
        accepted.rule
    );
    service
        .remove_inactive_checked(&accepted.rule.id, &accepted.revision)
        .unwrap();
    assert!(service.find(&accepted.rule.id).unwrap().is_none());
    assert!(service
        .remove_inactive_checked(&accepted.rule.id, &accepted.revision)
        .is_err());
}

#[test]
fn exact_reads_reject_oversized_or_misidentified_records_without_rewriting_them() {
    let db = Database::in_memory().unwrap();
    let registry = ForwardRegistry::default();
    let service = Forwarding {
        db: &db,
        registry: &registry,
    };
    let saved = service.save_checked(rule(host(&db)), None).unwrap();
    db.with(|conn| {
        conn.execute(
            "UPDATE settings SET value=?1 WHERE key=?2",
            rusqlite::params!["x".repeat(8193), format!("forward:{}", saved.rule.id)],
        )?;
        Ok(())
    })
    .unwrap();
    assert!(service.find(&saved.rule.id).is_err());
    let mut wrong = saved.rule.clone();
    wrong.id = "different-rule".into();
    db.with(|conn| {
        conn.execute(
            "UPDATE settings SET value=?1 WHERE key=?2",
            rusqlite::params![
                serde_json::to_string(&wrong)?,
                format!("forward:{}", saved.rule.id)
            ],
        )?;
        Ok(())
    })
    .unwrap();
    assert!(service.find(&saved.rule.id).is_err());
}
