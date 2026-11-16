use super::*;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

#[tokio::test(flavor = "current_thread")]
async fn settings_persistence_does_not_stall_runtime_heartbeat() {
    let db = Arc::new(Database::in_memory().unwrap());
    let blocker_db = db.clone();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let blocker = std::thread::spawn(move || {
        blocker_db
            .with(|_| {
                entered.send(()).unwrap();
                std::thread::sleep(Duration::from_secs(2));
                Ok(())
            })
            .unwrap();
    });
    ready.await.unwrap();
    let started = Instant::now();
    let heartbeat = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        started.elapsed()
    });
    let caller = tokio::spawn(async move {
        let budget = crate::services::operations::Budget::new(1, super::super::worker::ERRORS);
        budget
            .blocking(move |cancellation| {
                let serial = tokio::sync::Mutex::new(());
                super::super::worker::locked(&serial, cancellation, |_writer| {
                    let previous = Settings::default();
                    let mut next = previous.clone();
                    next.theme = "dark".into();
                    Write {
                        db: &db,
                        previous: &previous,
                        next: &next,
                        expected_preferences: None,
                    }
                    .save(cancellation, |_| Ok(()), |_| Ok(()))
                })
            })
            .await
    });
    let elapsed = heartbeat.await.unwrap();
    caller.await.unwrap().unwrap();
    blocker.join().unwrap();
    assert!(
        elapsed < Duration::from_secs(1),
        "settings persistence stalled heartbeat for {elapsed:?}"
    );
}
