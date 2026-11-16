use super::*;
use crate::{db, error::AppError};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Instant,
};

#[path = "support.rs"]
mod support;
use support::*;

#[tokio::test(flavor = "current_thread")]
async fn snapshot_database_wait_keeps_the_runtime_heartbeat_responsive() {
    let db = Arc::new(Database::in_memory().unwrap());
    let held = HeldDatabase::lock(db.clone()).await;
    let (budget, _) = budget();
    let started = Instant::now();
    let heartbeat = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        started.elapsed()
    });
    let caller = tokio::spawn(async move {
        budget
            .blocking(move |cancel| capture(&db, || cancel.check(), || Ok(())))
            .await
    });
    let elapsed = heartbeat.await.unwrap();
    drop(held);
    let result = caller.await.unwrap().unwrap();
    assert!(result.hosts.is_empty() && result.groups.is_empty());
    assert!(
        elapsed < Duration::from_secs(1),
        "host snapshot stalled runtime heartbeat for {elapsed:?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_database_waiter_exits_without_unlock_or_late_sql() {
    let db = Arc::new(Database::in_memory().unwrap());
    db.with(|conn| {
        conn.execute_batch("DROP TABLE hosts")?;
        Ok(())
    })
    .unwrap();
    let held = HeldDatabase::lock(db.clone()).await;
    let (budget, capacity) = budget();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (finished, done) = tokio::sync::oneshot::channel();
    let worker_budget = budget.clone();
    let caller = tokio::spawn(async move {
        worker_budget
            .blocking(move |cancel| {
                let entered = std::sync::Mutex::new(Some(entered));
                let result = capture(
                    &db,
                    || cancel.check(),
                    || {
                        if let Some(entered) = entered.lock().unwrap().take() {
                            entered.send(()).unwrap();
                        }
                        Ok(())
                    },
                );
                finished.send(result.err().map(|e| e.to_string())).unwrap();
                Ok(())
            })
            .await
    });
    ready.await.unwrap();
    caller.abort();
    assert!(caller.await.err().unwrap().is_cancelled());
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), done)
            .await
            .unwrap()
            .unwrap()
            .as_deref(),
        Some(ERRORS.cancelled)
    );
    available(capacity).await;
    // The blocked DB owner has not been released; cancellation did not need it.
    drop(held);
}

#[tokio::test]
async fn revoked_waiter_exits_before_database_unlock() {
    let db = Arc::new(Database::in_memory().unwrap());
    let held = HeldDatabase::lock(db.clone()).await;
    let allowed = Arc::new(AtomicBool::new(true));
    let check_allowed = allowed.clone();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (budget, _) = budget();
    let caller = tokio::spawn(async move {
        budget
            .blocking(move |cancel| {
                let entered = std::sync::Mutex::new(Some(entered));
                capture(
                    &db,
                    || cancel.check(),
                    || {
                        if !check_allowed.load(Ordering::Acquire) {
                            return Err(AppError::validation("revoked"));
                        }
                        if let Some(entered) = entered.lock().unwrap().take() {
                            entered.send(()).unwrap();
                        }
                        Ok(())
                    },
                )
            })
            .await
    });
    ready.await.unwrap();
    allowed.store(false, Ordering::Release);
    let result = tokio::time::timeout(Duration::from_secs(1), caller)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.unwrap_err().to_string(), "revoked");
    drop(held);
}

#[tokio::test]
async fn cancelled_caller_keeps_actual_worker_capacity_and_owner_until_exit() {
    let db = Arc::new(Database::in_memory().unwrap());
    let owner = Arc::new(());
    let observed = Arc::downgrade(&owner);
    let (budget, capacity) = budget();
    let worker_budget = budget.clone();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let caller = tokio::spawn(async move {
        worker_budget
            .blocking(move |cancel| {
                let _owner = owner;
                let entered = std::sync::Mutex::new(Some(entered));
                capture(
                    &db,
                    || cancel.check(),
                    || {
                        if let Some(entered) = entered.lock().unwrap().take() {
                            entered.send(()).unwrap();
                            wait.recv_timeout(Duration::from_secs(5)).unwrap();
                        }
                        Ok(())
                    },
                )
            })
            .await
    });
    ready.await.unwrap();
    caller.abort();
    assert!(caller.await.err().unwrap().is_cancelled());
    assert!(observed.upgrade().is_some());
    assert_eq!(capacity.available_permits(), 0);
    let rejected = budget
        .blocking::<()>(|_| panic!("busy worker started"))
        .await
        .unwrap_err();
    assert_eq!(rejected.to_string(), ERRORS.busy);
    release.send(()).unwrap();
    available(capacity).await;
    assert!(observed.upgrade().is_none());
}

#[test]
fn authorization_runs_outside_database_and_rejects_post_read_revocation() {
    let db = Database::in_memory().unwrap();
    let checks = AtomicUsize::new(0);
    let result = capture(
        &db,
        || Ok(()),
        || {
            assert!(db.try_with(|_| Ok(())).unwrap().is_some());
            if checks.fetch_add(1, Ordering::SeqCst) == 1 {
                Err(AppError::validation("replaced-generation"))
            } else {
                Ok(())
            }
        },
    );
    assert_eq!(result.unwrap_err().to_string(), "replaced-generation");
    assert_eq!(checks.load(Ordering::SeqCst), 2);
}

#[test]
fn cancellation_between_table_reads_prevents_late_host_query() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        conn.execute_batch("DROP TABLE hosts")?;
        Ok(())
    })
    .unwrap();
    let checks = AtomicUsize::new(0);
    let result = capture(
        &db,
        || {
            if checks.fetch_add(1, Ordering::SeqCst) == 2 {
                Err(AppError::validation(ERRORS.cancelled))
            } else {
                Ok(())
            }
        },
        || Ok(()),
    );
    assert_eq!(result.unwrap_err().to_string(), ERRORS.cancelled);
}

#[test]
fn snapshot_preserves_native_and_plugin_fields_and_original_database_errors() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        let group = db::hosts::create_group(conn, "Group", None)?;
        let input: crate::models::HostInput = serde_json::from_value(serde_json::json!({
            "name":"Reader", "host":"127.0.0.1", "port":22,
            "username":"fixture", "groupId":group.id, "authMethod":"key",
            "keyPath":"/isolated/key", "note":"reader-note", "tags":["test"],
            "favorite":true
        }))?;
        db::hosts::create_host(conn, &input.validate()?)?;
        Ok(())
    })
    .unwrap();
    let actual = serde_json::to_value(capture(&db, || Ok(()), || Ok(())).unwrap()).unwrap();
    let expected = serde_json::to_value(super::super::snapshot(&db).unwrap()).unwrap();
    assert_eq!(actual, expected);
    assert_eq!(actual["hosts"][0]["keyPath"], "/isolated/key");
    assert_eq!(actual["hosts"][0]["note"], "reader-note");
    assert!(actual["hosts"][0].get("password").is_none());
    db.with(|conn| {
        conn.execute_batch("DROP TABLE hosts")?;
        Ok(())
    })
    .unwrap();
    let failure = capture(&db, || Ok(()), || Ok(())).unwrap_err();
    assert!(matches!(failure, AppError::Db(_)));
    assert!(failure.to_string().contains("no such table"));
}
