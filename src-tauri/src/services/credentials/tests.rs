use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::sync::Semaphore;

#[tokio::test(flavor = "current_thread")]
async fn platform_work_leaves_the_runtime_thread_free_and_preserves_errors() {
    let budget = Arc::new(Budget::new(1, ERRORS));
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let owner_thread = std::thread::current().id();
    let owned = budget.clone();
    let request = tokio::spawn(async move {
        run(&owned, move || -> AppResult<()> {
            started.send(std::thread::current().id()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            Err(AppError::Ssh("vault.load: native failure".into()))
        })
        .await
    });
    let worker_thread = tokio::time::timeout(Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(worker_thread, owner_thread);
    // The platform fixture is still waiting; a single runtime thread can run
    // another request and a timer before it completes. No actual keyring here.
    tokio::time::timeout(Duration::from_secs(2), async {
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(1)).await;
    })
    .await
    .unwrap();
    release.send(()).unwrap();
    assert_eq!(
        request.await.unwrap().unwrap_err().to_string(),
        "vault.load: native failure"
    );
}

#[tokio::test]
async fn losing_the_caller_keeps_capacity_until_the_admitted_worker_settles() {
    let capacity = Arc::new(Semaphore::new(1));
    let budget = Arc::new(Budget::with_capacity(capacity.clone(), ERRORS));
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let owned = budget.clone();
    let request = tokio::spawn(async move {
        run(&owned, move || {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        })
        .await
    });
    ready.await.unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    assert_eq!(
        run(&budget, || Ok(())).await.unwrap_err().to_string(),
        "credentials.busy"
    );
    release.send(()).unwrap();
    wait_for_capacity(&capacity).await;
    run(&budget, || Ok(())).await.unwrap();
}

#[test]
fn a_cancelled_queued_request_cannot_start_a_late_platform_mutation() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let blocker = tokio::task::spawn_blocking(move || {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        ready.await.unwrap();
        let capacity = Arc::new(Semaphore::new(1));
        let budget = Arc::new(Budget::with_capacity(capacity.clone(), ERRORS));
        let mutated = Arc::new(AtomicBool::new(false));
        let owned = budget.clone();
        let changed = mutated.clone();
        let request = tokio::spawn(async move {
            run(&owned, move || {
                changed.store(true, Ordering::Release);
                Ok(())
            })
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while capacity.available_permits() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        assert_eq!(capacity.available_permits(), 0);
        release.send(()).unwrap();
        blocker.await.unwrap();
        wait_for_capacity(&capacity).await;
        assert!(!mutated.load(Ordering::Acquire));
        run(&budget, || Ok(())).await.unwrap();
    });
}

async fn wait_for_capacity(capacity: &Semaphore) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while capacity.available_permits() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

fn reviewed_database() -> Arc<crate::db::Database> {
    let database = Arc::new(crate::db::Database::in_memory().unwrap());
    database
        .with(|conn| {
            conn.execute_batch("CREATE TABLE read_review_fixture(revision INTEGER NOT NULL); INSERT INTO read_review_fixture VALUES(0);")?;
            Ok(())
        })
        .unwrap();
    database
}

fn check_review(database: &crate::db::Database) -> AppResult<()> {
    database.with(|conn| {
        let revision: i64 =
            conn.query_row("SELECT revision FROM read_review_fixture", [], |row| {
                row.get(0)
            })?;
        if revision == 0 {
            Ok(())
        } else {
            Err(AppError::Ssh("ssh.connectionChanged".into()))
        }
    })
}

fn change_review(database: &crate::db::Database) -> AppResult<()> {
    database.with(|conn| {
        conn.execute("UPDATE read_review_fixture SET revision=1", [])?;
        Ok(())
    })
}

#[tokio::test(flavor = "current_thread")]
async fn a_pending_read_releases_the_database_and_discards_a_changed_review() {
    let database = reviewed_database();
    let checked = database.clone();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let budget = Arc::new(Budget::new(1, ERRORS));
    let owned = budget.clone();
    let request = tokio::spawn(async move {
        read_checked(
            &owned,
            move || check_review(&checked),
            move || {
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok("fixture value must not reach authentication")
            },
        )
        .await
    });
    ready.await.unwrap();
    // This DB edit must complete while the real read closure remains pending.
    let mutation = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::task::spawn_blocking(move || change_review(&database)),
    )
    .await;
    release.send(()).unwrap();
    mutation.unwrap().unwrap().unwrap();
    assert_eq!(
        request.await.unwrap().unwrap_err().to_string(),
        "ssh.connectionChanged"
    );
}

#[test]
fn a_review_changed_while_queued_is_rejected_before_any_read() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let blocker = tokio::task::spawn_blocking(move || {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        ready.await.unwrap();
        let database = reviewed_database();
        let checked = database.clone();
        let read_started = Arc::new(AtomicBool::new(false));
        let observed = read_started.clone();
        let capacity = Arc::new(Semaphore::new(1));
        let budget = Arc::new(Budget::with_capacity(capacity.clone(), ERRORS));
        let request = tokio::spawn(async move {
            read_checked(
                &budget,
                move || check_review(&checked),
                move || {
                    observed.store(true, Ordering::Release);
                    Ok(())
                },
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while capacity.available_permits() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        change_review(&database).unwrap();
        release.send(()).unwrap();
        blocker.await.unwrap();
        assert_eq!(
            request.await.unwrap().unwrap_err().to_string(),
            "ssh.connectionChanged"
        );
        assert!(!read_started.load(Ordering::Acquire));
    });
}

#[tokio::test]
async fn cancellation_while_validating_cannot_start_a_late_read() {
    let capacity = Arc::new(Semaphore::new(1));
    let budget = Arc::new(Budget::with_capacity(capacity.clone(), ERRORS));
    let (started, ready) = tokio::sync::oneshot::channel();
    let started = std::sync::Mutex::new(Some(started));
    let (release, wait) = std::sync::mpsc::channel();
    let wait = std::sync::Mutex::new(wait);
    let read_started = Arc::new(AtomicBool::new(false));
    let observed = read_started.clone();
    let owned = budget.clone();
    let request = tokio::spawn(async move {
        read_checked(
            &owned,
            move || {
                if let Some(started) = started.lock().unwrap().take() {
                    started.send(()).unwrap();
                    wait.lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap();
                }
                Ok(())
            },
            move || {
                observed.store(true, Ordering::Release);
                Ok(())
            },
        )
        .await
    });
    ready.await.unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    release.send(()).unwrap();
    wait_for_capacity(&capacity).await;
    assert!(!read_started.load(Ordering::Acquire));
}

#[tokio::test]
async fn an_unchanged_review_returns_the_value_and_native_errors_are_preserved() {
    let budget = Budget::new(1, ERRORS);
    assert_eq!(
        read_checked(&budget, || Ok(()), || Ok(Some("owned fixture")))
            .await
            .unwrap(),
        Some("owned fixture")
    );
    assert_eq!(
        read_checked(
            &budget,
            || Ok(()),
            || -> AppResult<()> { Err(AppError::Ssh("vault.load: native failure".into())) }
        )
        .await
        .unwrap_err()
        .to_string(),
        "vault.load: native failure"
    );
}
