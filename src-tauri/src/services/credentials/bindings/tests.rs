use super::*;
use crate::db::Database;
use std::collections::BTreeMap;
use std::sync::{mpsc, Arc};
use std::time::Duration;

const AUTHORITY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHANGED: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn database() -> Database {
    let database = Database::in_memory().unwrap();
    database
        .with(|conn| {
            conn.execute_batch(SCHEMA)?;
            Ok(())
        })
        .unwrap();
    database
}

fn tx<T>(database: &Database, effect: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
    database.with(|conn| {
        let transaction = conn.unchecked_transaction()?;
        let value = effect(&transaction)?;
        transaction.commit()?;
        Ok(value)
    })
}

fn current(database: &Database, owner: &Owner) -> Binding {
    database.with(|conn| capture(conn, owner)).unwrap()
}

fn prepare(database: &Database, owner: &Owner, run: Uuid) -> Intent {
    tx(database, |conn| {
        begin(conn, &capture(conn, owner)?, AUTHORITY, run)
    })
    .unwrap()
}

fn install(database: &Database, intent: &Intent) {
    tx(database, |conn| {
        written(conn, intent)?;
        publish(conn, intent, AUTHORITY)
    })
    .unwrap();
}

fn take(database: &Database, run: Uuid) -> Retirement {
    tx(database, |conn| claim(conn, run)).unwrap().unwrap()
}

#[test]
fn untouched_legacy_and_forgotten_owner_have_distinct_durable_read_authority() {
    let db = database();
    let host = Owner::host("saved-host").unwrap();
    let legacy = current(&db, &host);
    assert_eq!(legacy.physical().unwrap().key(), "saved-host");
    tx(&db, |conn| invalidate(conn, &host)).unwrap();
    assert!(current(&db, &host).physical().is_none());
    let retirement = take(&db, Uuid::new_v4());
    assert_eq!(retirement.physical().key(), "saved-host");
    tx(&db, |conn| complete(conn, &retirement)).unwrap();
    assert!(current(&db, &host).physical().is_none());
    assert_eq!(
        db.with(|conn| verify(conn, &legacy))
            .unwrap_err()
            .to_string(),
        "credentials.changed"
    );
}

#[test]
fn delayed_old_cleanup_preserves_recreated_host_and_its_replacement_secret() {
    let db = database();
    let owner = Owner::host("same-id").unwrap();
    let run = Uuid::new_v4();
    let mut platform = BTreeMap::from([("same-id".to_owned(), "old password".to_owned())]);
    tx(&db, |conn| invalidate(conn, &owner)).unwrap();
    let old_cleanup = take(&db, run);
    // Recreate the same logical id while its old OS deletion is waiting.
    let deleted = current(&db, &owner);
    tx(&db, |conn| invalidate(conn, &owner)).unwrap();
    assert!(db.with(|conn| verify(conn, &deleted)).is_err());
    let intent = prepare(&db, &owner, run);
    platform.insert(intent.physical().key(), "replacement password".into());
    install(&db, &intent);
    platform.remove(&old_cleanup.physical().key());
    tx(&db, |conn| complete(conn, &old_cleanup)).unwrap();
    assert_eq!(
        platform
            .get(&current(&db, &owner).physical().unwrap().key())
            .unwrap(),
        "replacement password"
    );
    assert!(!platform.contains_key("same-id"));
}

#[test]
fn competing_saves_have_one_cas_winner_and_loser_retires_only_its_own_item() {
    let db = database();
    let owner = Owner::proxy("proxy-one").unwrap();
    let run = Uuid::new_v4();
    tx(&db, |conn| invalidate(conn, &owner)).unwrap();
    let legacy = take(&db, run);
    tx(&db, |conn| complete(conn, &legacy)).unwrap();
    let a = prepare(&db, &owner, run);
    let b = prepare(&db, &owner, run);
    install(&db, &a);
    tx(&db, |conn| written(conn, &b)).unwrap();
    assert_eq!(
        tx(&db, |conn| publish(conn, &b, AUTHORITY))
            .unwrap_err()
            .to_string(),
        "credentials.changed"
    );
    tx(&db, |conn| abandon(conn, &b)).unwrap();
    let loser = take(&db, run);
    assert!(loser.physical() == &b.physical());
    assert!(loser.physical() != &a.physical());
    tx(&db, |conn| complete(conn, &loser)).unwrap();
    assert!(current(&db, &owner).physical() == Some(a.physical()));
}

#[test]
fn slow_platform_write_does_not_hold_database_and_cannot_publish_after_owner_invalidation() {
    let db = Arc::new(database());
    let owner = Owner::host("concurrent-host").unwrap();
    let run = Uuid::new_v4();
    let intent = prepare(&db, &owner, run);
    let physical = intent.physical();
    let (entered, ready) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let worker_db = db.clone();
    let worker = std::thread::spawn(move || {
        // Controlled platform IO between committed intent and publication.
        entered.send(()).unwrap();
        wait.recv_timeout(Duration::from_secs(5)).unwrap();
        tx(&worker_db, |conn| written(conn, &intent)).unwrap();
        let result = tx(&worker_db, |conn| publish(conn, &intent, AUTHORITY));
        assert_eq!(result.unwrap_err().to_string(), "credentials.changed");
        tx(&worker_db, |conn| abandon(conn, &intent)).unwrap();
    });
    ready.recv_timeout(Duration::from_secs(2)).unwrap();
    // Actual concurrent DB access completes while the platform callback waits.
    assert!(db.try_with(|conn| invalidate(conn, &owner)).is_err()); // requires transaction
    tx(&db, |conn| invalidate(conn, &owner)).unwrap();
    db.with(|conn| {
        conn.execute(
            "INSERT INTO settings VALUES ('unrelated','responsive',0)",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    release.send(()).unwrap();
    worker.join().unwrap();
    assert!(current(&db, &owner).physical().is_none());
    let mut retired_written = false;
    while let Some(retirement) = tx(&db, |conn| claim(conn, run)).unwrap() {
        retired_written |= retirement.physical() == &physical;
        tx(&db, |conn| complete(conn, &retirement)).unwrap();
    }
    assert!(retired_written);
}

#[test]
fn changed_route_authority_cannot_publish_even_when_logical_binding_is_unchanged() {
    let db = database();
    let owner = Owner::host("route-host").unwrap();
    let original = current(&db, &owner);
    let intent = prepare(&db, &owner, Uuid::new_v4());
    tx(&db, |conn| written(conn, &intent)).unwrap();
    assert!(tx(&db, |conn| publish(conn, &intent, CHANGED)).is_err());
    assert!(current(&db, &owner) == original);
    tx(&db, |conn| abandon(conn, &intent)).unwrap();
    assert!(tx(&db, |conn| publish(conn, &intent, AUTHORITY)).is_err());
}

#[test]
fn original_authority_transaction_rolls_back_pointer_and_cleanup_on_failure() {
    let db = database();
    let owner = Owner::host("rollback-host").unwrap();
    let original = current(&db, &owner);
    let intent = prepare(&db, &owner, Uuid::new_v4());
    tx(&db, |conn| written(conn, &intent)).unwrap();
    let failed: AppResult<()> = tx(&db, |conn| {
        publish(conn, &intent, AUTHORITY)?;
        Err(AppError::validation("controlled companion commit failure"))
    });
    assert!(failed.is_err());
    assert!(current(&db, &owner) == original);
    assert!(tx(&db, |conn| claim(conn, Uuid::new_v4()))
        .unwrap()
        .is_none());
    tx(&db, |conn| publish(conn, &intent, AUTHORITY)).unwrap();
    assert!(current(&db, &owner).physical() == Some(intent.physical()));
}

#[test]
fn startup_recovers_unknown_item_by_original_identity_without_replaying_write() {
    let directory =
        std::env::temp_dir().join(format!("tunnelde-credential-journal-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("test.db");
    let owner = Owner::host("restart-host").unwrap();
    let old_run = Uuid::new_v4();
    let orphan;
    {
        let db = Database::open(&path).unwrap();
        db.with(|conn| {
            conn.execute_batch(SCHEMA)?;
            Ok(())
        })
        .unwrap();
        orphan = prepare(&db, &owner, old_run).physical();
        // The OS write may have succeeded, but its reply was lost before written.
    }
    {
        let db = Database::open(&path).unwrap();
        let run = Uuid::new_v4();
        assert_eq!(tx(&db, |conn| recover(conn, run, 32)).unwrap(), 1);
        let retirement = take(&db, run);
        assert!(retirement.physical() == &orphan);
        tx(&db, |conn| complete(conn, &retirement)).unwrap();
        assert_eq!(tx(&db, |conn| recover(conn, run, 32)).unwrap(), 0);
        assert!(matches!(
            current(&db, &owner).physical(),
            Some(Physical::Legacy(_))
        ));
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn restart_does_not_retire_successfully_published_item_when_reply_was_lost() {
    let db = database();
    let owner = Owner::host("published-host").unwrap();
    let intent = prepare(&db, &owner, Uuid::new_v4());
    install(&db, &intent);
    let published = current(&db, &owner);
    tx(&db, |conn| abandon(conn, &intent)).unwrap();
    let new_run = Uuid::new_v4();
    assert_eq!(tx(&db, |conn| recover(conn, new_run, 32)).unwrap(), 0);
    let old_legacy = take(&db, new_run);
    assert!(matches!(old_legacy.physical(), Physical::Legacy(_)));
    tx(&db, |conn| complete(conn, &old_legacy)).unwrap();
    assert!(tx(&db, |conn| claim(conn, new_run)).unwrap().is_none());
    assert!(current(&db, &owner) == published);
}

#[test]
fn malformed_metadata_fails_closed_instead_of_reviving_legacy_credential() {
    let db = database();
    let owner = Owner::host("malformed-host").unwrap();
    tx(&db, |conn| invalidate(conn, &owner)).unwrap();
    db.with(|conn| {
        conn.execute(
            "UPDATE credential_bindings SET revision=?1",
            ["x".repeat(36)],
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        db.with(|conn| capture(conn, &owner))
            .err()
            .unwrap()
            .to_string(),
        "credentials.invalidMetadata"
    );
    db.with(|conn| {
        // Controlled corruption fixture; production enables foreign keys.
        conn.pragma_update(None, "foreign_keys", false)?;
        conn.execute(
            "UPDATE credential_bindings SET revision=?1,item=?2",
            params![Uuid::new_v4().to_string(), Uuid::new_v4().to_string()],
        )?;
        conn.pragma_update(None, "foreign_keys", true)?;
        Ok(())
    })
    .unwrap();
    assert!(db.with(|conn| capture(conn, &owner)).is_err());
}

#[test]
fn tombstone_creation_and_deletion_require_the_owners_atomic_transaction() {
    let db = database();
    let owner = Owner::host("atomic-owner").unwrap();
    assert_eq!(
        db.with(|conn| invalidate(conn, &owner))
            .unwrap_err()
            .to_string(),
        "credentials.transactionRequired"
    );
    let failed: AppResult<()> = tx(&db, |conn| {
        invalidate(conn, &owner)?;
        Err(AppError::validation("host delete failed"))
    });
    assert!(failed.is_err());
    assert!(current(&db, &owner).revision.is_none());
    assert!(tx(&db, |conn| claim(conn, Uuid::new_v4()))
        .unwrap()
        .is_none());
}

#[test]
fn recovery_is_bounded_and_never_adopts_or_retires_this_runs_pending_operations() {
    let db = database();
    let owner = Owner::proxy("bounded-proxy").unwrap();
    let run = Uuid::new_v4();
    let active = prepare(&db, &owner, run);
    let _old_a = prepare(&db, &owner, Uuid::new_v4());
    let _old_b = prepare(&db, &owner, Uuid::new_v4());
    assert!(tx(&db, |conn| recover(conn, run, 33)).is_err());
    assert_eq!(tx(&db, |conn| recover(conn, run, 1)).unwrap(), 1);
    assert_eq!(tx(&db, |conn| recover(conn, run, 1)).unwrap(), 1);
    assert_eq!(tx(&db, |conn| recover(conn, run, 1)).unwrap(), 0);
    install(&db, &active);
    assert!(current(&db, &owner).physical() == Some(active.physical()));
}

#[test]
fn cleanup_claims_are_exclusive_and_lost_replies_recover_same_item_identity() {
    let db = database();
    let owner = Owner::proxy("retry-proxy").unwrap();
    tx(&db, |conn| invalidate(conn, &owner)).unwrap();
    let original_run = Uuid::new_v4();
    let original = take(&db, original_run);
    assert!(tx(&db, |conn| claim(conn, original_run)).unwrap().is_none());
    let restart = Uuid::new_v4();
    tx(&db, |conn| recover(conn, restart, 32)).unwrap();
    let recovered = take(&db, restart);
    assert!(recovered.physical() == original.physical());
    assert!(tx(&db, |conn| complete(conn, &original)).is_err());
    tx(&db, |conn| complete(conn, &recovered)).unwrap();
}

#[test]
fn host_and_proxy_owners_are_distinct_and_records_never_accept_secret_payloads() {
    let db = database();
    let host = Owner::host("shared-id").unwrap();
    let proxy = Owner::proxy("shared-id").unwrap();
    let h = prepare(&db, &host, Uuid::new_v4());
    let p = prepare(&db, &proxy, Uuid::new_v4());
    install(&db, &h);
    assert!(current(&db, &proxy).revision.is_none());
    install(&db, &p);
    assert!(current(&db, &host).physical() != current(&db, &proxy).physical());
    let binding = current(&db, &host);
    assert!(tx(&db, |conn| begin(
        conn,
        &binding,
        "do not store this password",
        Uuid::new_v4()
    ))
    .is_err());
    for id in ["", "\0", "a\nb"] {
        assert!(Owner::host(id).is_err());
    }
    let columns = db
        .with(|conn| {
            let mut stmt =
                conn.prepare("SELECT name FROM pragma_table_info('credential_operations')")?;
            let columns = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(columns)
        })
        .unwrap();
    assert!(!columns
        .iter()
        .any(|c| c.contains("password") || c.contains("value") || c.contains("url")));
}

#[test]
fn password_changes_preserve_review_identity_and_owner_recreation_invalidates_it() {
    let db = database();
    let owner = Owner::host("review-host").unwrap();
    let original_incarnation = current(&db, &owner).incarnation();
    let first = prepare(&db, &owner, Uuid::new_v4());
    install(&db, &first);
    assert_eq!(current(&db, &owner).incarnation(), original_incarnation);
    let before_forget = current(&db, &owner);
    tx(&db, |conn| forget(conn, &before_forget)).unwrap();
    assert_eq!(current(&db, &owner).incarnation(), original_incarnation);
    assert!(current(&db, &owner).physical().is_none());
    tx(&db, |conn| invalidate(conn, &owner)).unwrap();
    let recreated = current(&db, &owner).incarnation();
    assert_ne!(recreated, original_incarnation);
    let second = prepare(&db, &owner, Uuid::new_v4());
    install(&db, &second);
    assert_eq!(current(&db, &owner).incarnation(), recreated);
}

#[test]
fn configuration_renewal_retains_explicit_legacy_or_immutable_source_without_reviving_tombstone() {
    let db = database();
    let owner = Owner::proxy("renew-proxy").unwrap();
    let old = current(&db, &owner);
    let waiting = prepare(&db, &owner, Uuid::new_v4());
    tx(&db, |conn| renew(conn, &owner)).unwrap();
    let renewed = current(&db, &owner);
    assert!(renewed.physical() == old.physical());
    assert_ne!(renewed.incarnation(), old.incarnation());
    tx(&db, |conn| written(conn, &waiting)).unwrap();
    assert!(tx(&db, |conn| publish(conn, &waiting, AUTHORITY)).is_err());
    let saved = prepare(&db, &owner, Uuid::new_v4());
    install(&db, &saved);
    tx(&db, |conn| renew(conn, &owner)).unwrap();
    assert!(current(&db, &owner).physical() == Some(saved.physical()));
    let expected = current(&db, &owner);
    tx(&db, |conn| forget(conn, &expected)).unwrap();
    tx(&db, |conn| renew(conn, &owner)).unwrap();
    assert!(current(&db, &owner).physical().is_none());
}

#[test]
fn cleanup_never_grants_deletion_authority_for_injected_unowned_or_other_owner_items() {
    for another_owner in [false, true] {
        let db = database();
        let owner = Owner::host("cleanup-owner").unwrap();
        tx(&db, |conn| invalidate(conn, &owner)).unwrap();
        let run = Uuid::new_v4();
        let legacy = take(&db, run);
        tx(&db, |conn| complete(conn, &legacy)).unwrap();
        let injected = if another_owner {
            let other = Owner::host("other-owner").unwrap();
            let intent = prepare(&db, &other, run);
            install(&db, &intent);
            match intent.physical() {
                Physical::Immutable(id) => id,
                _ => unreachable!(),
            }
        } else {
            Uuid::new_v4()
        };
        db.with(|conn| {
            // Simulate database corruption, bypassing production foreign keys.
            conn.pragma_update(None, "foreign_keys", false)?;
            conn.execute(
                "INSERT INTO credential_cleanup
                (id,kind,owner,item,legacy,created_at) VALUES (?1,'host','cleanup-owner',?2,0,-1)",
                params![Uuid::new_v4().to_string(), injected.to_string()],
            )?;
            conn.pragma_update(None, "foreign_keys", true)?;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            tx(&db, |conn| claim(conn, run)).err().unwrap().to_string(),
            "credentials.invalidMetadata"
        );
    }
}

#[test]
fn stale_forget_cannot_erase_a_competing_published_password() {
    let db = database();
    let owner = Owner::host("forget-cas-host").unwrap();
    let old = current(&db, &owner);
    let intent = prepare(&db, &owner, Uuid::new_v4());
    install(&db, &intent);
    assert_eq!(
        tx(&db, |conn| forget(conn, &old)).unwrap_err().to_string(),
        "credentials.changed"
    );
    assert!(current(&db, &owner).physical() == Some(intent.physical()));
}

#[test]
fn successful_owned_retirement_discards_obsolete_metadata_but_keeps_owner_tombstone() {
    let db = database();
    let owner = Owner::host("retention-host").unwrap();
    let run = Uuid::new_v4();
    for _ in 0..20 {
        let intent = prepare(&db, &owner, run);
        install(&db, &intent);
        while let Some(retirement) = tx(&db, |conn| claim(conn, run)).unwrap() {
            tx(&db, |conn| complete(conn, &retirement)).unwrap();
        }
    }
    assert_eq!(
        db.with(|conn| Ok(conn.query_row(
            "SELECT COUNT(*) FROM credential_operations",
            [],
            |r| r.get::<_, i64>(0)
        )?))
        .unwrap(),
        1
    );
    let last = current(&db, &owner);
    tx(&db, |conn| forget(conn, &last)).unwrap();
    let last_item = take(&db, run);
    tx(&db, |conn| complete(conn, &last_item)).unwrap();
    assert_eq!(
        db.with(|conn| Ok(conn.query_row(
            "SELECT COUNT(*) FROM credential_operations",
            [],
            |r| r.get::<_, i64>(0)
        )?))
        .unwrap(),
        0
    );
    assert!(current(&db, &owner).revision.is_some());
    assert!(current(&db, &owner).physical().is_none());
}

#[test]
fn pending_operation_quota_preserves_unknown_evidence_and_still_allows_forget() {
    let db = database();
    let owner = Owner::host("quota-host").unwrap();
    let run = Uuid::new_v4();
    let mut pending = Vec::new();
    for _ in 0..4 {
        pending.push(prepare(&db, &owner, run));
    }
    let snapshot = current(&db, &owner);
    assert_eq!(
        tx(&db, |conn| begin(conn, &snapshot, AUTHORITY, run))
            .err()
            .unwrap()
            .to_string(),
        "credentials.cleanupRequired"
    );
    assert_eq!(
        db.with(|conn| Ok(conn.query_row(
            "SELECT COUNT(*) FROM credential_operations",
            [],
            |r| r.get::<_, i64>(0)
        )?))
        .unwrap(),
        4
    );
    tx(&db, |conn| forget(conn, &snapshot)).unwrap();
    assert!(current(&db, &owner).physical().is_none());
    // Original operations remain discoverable for controlled cleanup.
    for intent in pending {
        tx(&db, |conn| abandon(conn, &intent)).unwrap();
    }
}

#[test]
fn corrupted_host_cleanup_cannot_alias_proxy_plugin_or_immutable_namespaces() {
    for prefix in ["proxy:", "plugin:", "tunnelde."] {
        let db = database();
        let id = format!("{prefix}other-owner");
        assert!(Owner::host(&id).is_err());
        db.with(|conn| {
            conn.execute(
                "INSERT INTO credential_cleanup
                (id,kind,owner,item,legacy,created_at) VALUES (?1,'host',?2,NULL,1,0)",
                params![Uuid::new_v4().to_string(), id],
            )?;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            tx(&db, |conn| claim(conn, Uuid::new_v4()))
                .err()
                .unwrap()
                .to_string(),
            "credentials.invalidMetadata"
        );
    }
}
