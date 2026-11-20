//! Captured native origin covers metadata, never slow platform callbacks.
use super::*;
use crate::services::operations::{Authority, WorkLifetime};

struct Origin(Arc<Mutex<bool>>);
impl Authority for Origin {
    fn with_current(&self, operation: &mut dyn FnMut() -> AppResult<()>) -> AppResult<()> {
        let live = self.0.lock().unwrap();
        if !*live {
            return Err(AppError::validation("original origin retired"));
        }
        operation()
    }
}

#[tokio::test]
async fn captured_origin_survives_scope_and_revocation_during_read_discards_the_secret() {
    let (db, platform, owner, run) = fixture();
    let live = Arc::new(Mutex::new(true));
    let origin = Arc::new(Origin(live.clone()));
    let weak = Arc::downgrade(&origin);
    let service = Service::new(&db, &*platform, run).unwrap();
    let request = WorkLifetime::authorized(origin)
        .scope(async { service.capture(owner.clone(), || Ok(()), scope) })
        .await
        .unwrap();
    assert!(
        weak.upgrade().is_some(),
        "request must retain its original authority"
    );
    let checked_db = db.clone();
    let revoked = live.clone();
    *platform.hook.lock().unwrap() = Some(Arc::new(move |stage, _| {
        if stage == Stage::Read {
            assert!(
                checked_db.try_with(|_| Ok(())).unwrap().is_some(),
                "OS IO held DB guard"
            );
            *revoked.try_lock().expect("OS IO held origin guard") = false;
        }
        Ok(())
    }));
    assert_eq!(
        call(|job| service.read(&request, job))
            .unwrap_err()
            .to_string(),
        "original origin retired"
    );
    assert_eq!(platform.reads.load(Ordering::SeqCst), 1);
    assert!(call(|job| service.save(&request, "not-admitted", job)).is_err());
    assert!(call(|job| service.forget(&request, job)).is_err());
    assert_eq!(platform.writes.load(Ordering::SeqCst), 0);
    drop(request);
    assert!(weak.upgrade().is_none());
}

#[tokio::test]
async fn revoked_write_cannot_publish_and_exact_item_retirement_needs_no_replacement_consent() {
    let (db, platform, owner, run) = fixture();
    let live = Arc::new(Mutex::new(true));
    let service = Service::new(&db, &*platform, run).unwrap();
    let request = WorkLifetime::authorized(Arc::new(Origin(live.clone())))
        .scope(async { service.capture(owner.clone(), || Ok(()), scope) })
        .await
        .unwrap();
    let checked_db = db.clone();
    let revoked = live.clone();
    *platform.hook.lock().unwrap() = Some(Arc::new(move |stage, _| {
        if stage == Stage::Write {
            assert!(checked_db.try_with(|_| Ok(())).unwrap().is_some());
            *revoked
                .try_lock()
                .expect("OS write held original authority") = false;
        }
        Ok(())
    }));
    assert_eq!(
        call(|job| service.save(&request, "unpublished-secret", job))
            .unwrap_err()
            .to_string(),
        "original origin retired"
    );
    assert_eq!(item_count(&db), 1);
    assert!(call(|job| service.retire_one(job)).unwrap());
    assert_eq!(item_count(&db), 0);
    let current = service.capture(owner, || Ok(()), scope).unwrap();
    assert_eq!(
        call(|job| service.read(&current, job)).unwrap().as_deref(),
        Some("old-secret")
    );
    assert_eq!(platform.deletes.load(Ordering::SeqCst), 1);
    assert!(!platform
        .values
        .lock()
        .unwrap()
        .values()
        .any(|value| value == "unpublished-secret"));
}

#[test]
fn rule_edit_during_platform_write_rejects_publication_inside_the_original_binding_transaction() {
    use crate::services::forwarding::{automation::Options, contract::ForwardRule, repository};
    let (db, platform, _, run) = fixture();
    let entry = db
        .with(|conn| {
            let input: crate::models::HostInput = serde_json::from_value(
                serde_json::json!({"name":"Original", "host":"example.test", "username":"qa"}),
            )
            .unwrap();
            let host = crate::db::hosts::create_host(conn, &input.validate()?)?;
            repository::import_at(
                conn,
                &ForwardRule {
                    id: "reviewed".into(),
                    host_id: host.id,
                    name: "Rule".into(),
                    mode: "local".into(),
                    bind_host: "127.0.0.1".into(),
                    bind_port: 1480,
                    target_host: "127.0.0.1".into(),
                    target_port: 1479,
                },
                Options::default(),
                None,
            )?;
            Ok(repository::list_conn(conn)?.remove(0))
        })
        .unwrap();
    let service = Service::new(&db, &*platform, run).unwrap();
    let request = service
        .capture(
            Owner::host(&entry.rule.host_id).unwrap(),
            || Ok(()),
            |conn| {
                repository::require_reviewed_host(
                    conn,
                    &entry.rule.id,
                    &entry.revision,
                    &entry.rule.host_id,
                )?;
                scope(conn)
            },
        )
        .unwrap();
    let changed = db.clone();
    *platform.hook.lock().unwrap() = Some(Arc::new(move |stage, _| {
        if stage == Stage::Write {
            changed.with(|conn| {
                conn.execute("UPDATE settings SET value='\"replacement\"' WHERE key='forward-version:reviewed'", [])?;
                Ok(())
            })?;
        }
        Ok(())
    }));
    assert_eq!(
        call(|job| service.save(&request, "stale-secret", job))
            .unwrap_err()
            .to_string(),
        "forward.changed"
    );
    // New host creation also retires the historical logical-key alias. Drain
    // both exact records without assuming which the finite worker claims first.
    while call(|job| service.retire_one(job)).unwrap() {}
    let current = service
        .capture(Owner::host(&entry.rule.host_id).unwrap(), || Ok(()), scope)
        .unwrap();
    assert!(call(|job| service.read(&current, job)).unwrap().is_none());
    assert_eq!(item_count(&db), 0);
    assert!(!platform
        .values
        .lock()
        .unwrap()
        .values()
        .any(|value| value == "stale-secret"));
}
