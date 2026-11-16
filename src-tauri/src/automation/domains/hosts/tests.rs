use super::*;
use crate::db::Database;
use std::time::{Duration, Instant};

fn capacity() -> Arc<Semaphore> {
    Arc::new(Semaphore::new(1))
}

struct HeldDatabase {
    release: Option<std::sync::mpsc::Sender<()>>,
    owner: Option<std::thread::JoinHandle<()>>,
}

impl HeldDatabase {
    async fn lock(db: Arc<Database>) -> Self {
        let (locked, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let owner = std::thread::spawn(move || {
            db.with(|_| {
                locked.send(()).unwrap();
                // The independent bound makes a runtime-blocking regression
                // fail rather than deadlocking the test's own cleanup.
                let _ = wait.recv_timeout(Duration::from_secs(2));
                Ok(())
            })
            .unwrap();
        });
        ready.await.unwrap();
        Self {
            release: Some(release),
            owner: Some(owner),
        }
    }
}

impl Drop for HeldDatabase {
    fn drop(&mut self) {
        let _ = self.release.take().unwrap().send(());
        self.owner.take().unwrap().join().unwrap();
    }
}

#[test]
fn saved_host_projection_does_not_expose_private_native_fields() {
    let db = Database::in_memory().unwrap();
    let input: crate::models::HostInput = serde_json::from_value(json!({
        "name":"QA", "host":"example.test", "username":"user", "keyPath":"/private/key", "note":"private note"
    })).unwrap();
    db.with(|conn| crate::db::hosts::create_host(conn, &input.validate()?))
        .unwrap();
    let value = project(&db, || Ok(())).unwrap();
    let host = &value["hosts"][0];
    assert_eq!(host["address"], "example.test");
    assert_eq!(host.as_object().unwrap().len(), 8);
    assert!(host.get("keyPath").is_none() && host.get("note").is_none());
    assert!(!value.to_string().contains("/private/key"));
}

#[tokio::test(flavor = "current_thread")]
async fn held_database_does_not_block_the_local_runtime_heartbeat() {
    let db = Arc::new(Database::in_memory().unwrap());
    let held = HeldDatabase::lock(db.clone()).await;
    let started = Instant::now();
    let heartbeat = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        started.elapsed()
    });
    let request = tokio::spawn(read(capacity(), move |ticket| {
        project(&db, || ticket.check())
    }));
    let elapsed = heartbeat.await.unwrap();
    drop(held);
    assert!(request.await.unwrap().is_ok());
    assert!(
        elapsed < Duration::from_secs(1),
        "a saved-host read stalled an independent runtime heartbeat for {elapsed:?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn timeout_retains_worker_capacity_and_cancels_before_late_queries() {
    let db = Arc::new(Database::in_memory().unwrap());
    // If either SQL table is queried after cancellation the error is internal,
    // so this also proves cancellation is checked inside the acquired DB lock.
    db.with(|conn| {
        conn.execute_batch("DROP TABLE hosts; DROP TABLE groups;")?;
        Ok(())
    })
    .unwrap();
    let held = HeldDatabase::lock(db.clone()).await;
    let capacity = capacity();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (finished, done) = tokio::sync::oneshot::channel();
    let admitted = capacity.clone();
    let (arm, armed) = tokio::sync::oneshot::channel();
    let (timed_out, deadline) = tokio::sync::oneshot::channel();
    let caller = tokio::spawn(async move {
        let operation = read(admitted, move |ticket| {
            entered.send(()).unwrap();
            let result = project(&db, || ticket.check());
            drop(ticket);
            finished.send(result).unwrap();
            Ok(json!({"hosts":[]}))
        });
        tokio::pin!(operation);
        tokio::select! {
            _ = &mut operation => panic!("read completed while the database was held"),
            _ = armed => {}
        }
        let result = tokio::time::timeout(Duration::from_millis(50), operation).await;
        timed_out.send(result.is_err()).unwrap();
    });
    ready.await.unwrap();
    let started = Instant::now();
    arm.send(()).unwrap();
    assert!(deadline.await.unwrap());
    assert!(started.elapsed() < Duration::from_secs(1));
    caller.await.unwrap();
    assert_eq!(capacity.available_permits(), 0);
    let rejected = read(capacity.clone(), |_| panic!("overload must not spawn work"))
        .await
        .unwrap_err();
    assert_eq!(rejected.code, "operation_rejected");
    drop(held);
    let cancelled = done.await.unwrap().unwrap_err();
    assert_eq!(cancelled.code, "operation_rejected");
    assert_eq!(cancelled.message, "Saved-host reading was cancelled");
    assert_eq!(capacity.available_permits(), 1);
    assert!(read(capacity, |_| Ok(json!({"hosts":[]}))).await.is_ok());
}

#[test]
fn cancellation_between_tables_stops_the_next_query() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        conn.execute_batch("DROP TABLE hosts;")?;
        Ok(())
    })
    .unwrap();
    let checks = std::cell::Cell::new(0);
    let failure = project(&db, || {
        checks.set(checks.get() + 1);
        if checks.get() == 2 {
            Err(AppError::validation(CANCELLED))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert_eq!(checks.get(), 2);
    assert_eq!(failure.code, "operation_rejected");
}

#[tokio::test]
async fn worker_preserves_saved_host_order_and_values() {
    let db = Arc::new(Database::in_memory().unwrap());
    for name in ["Zulu", "Alpha"] {
        let input: crate::models::HostInput = serde_json::from_value(json!({
            "name":name,"host":"example.test","username":"user","tags":["qa"],"favorite":true
        }))
        .unwrap();
        db.with(|conn| crate::db::hosts::create_host(conn, &input.validate()?))
            .unwrap();
    }
    let expected = project(&db, || Ok(())).unwrap();
    let actual = read(capacity(), move |ticket| project(&db, || ticket.check()))
        .await
        .unwrap();
    assert_eq!(actual, expected);
    assert_eq!(actual["hosts"][0]["name"], "Zulu");
    assert_eq!(actual["hosts"][1]["tags"], json!(["qa"]));
    assert_eq!(actual["hosts"][1]["favorite"], true);
}
